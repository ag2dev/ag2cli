/**
 * Structured workspace inspection for the App Server read-only face
 * (contract §12). Unlike the TUI's patch-text view (`git-diff.ts`), entries
 * are authoritative structured operations derived from git plumbing; patch
 * text is bounded display data only. Path policy mirrors the file tools'
 * security posture: workspace-relative resolution, sensitive-path denial,
 * and symlink-escape rejection, all confined to the workspace root.
 */
import { createHash } from "node:crypto"
import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { isSensitivePath, isSensitivePathToken, isWithinWorkspaceRoot } from "../security/workspace.js"
import { runGit } from "./git-diff.js"

export type WorkspaceChangeOperation = "add" | "delete" | "modify" | "move" | "copy"
export type WorkspaceFileKind = "text" | "binary" | "symlink" | "directory" | "unknown"

export interface WorkspaceDiffEntryData {
  readonly operation: WorkspaceChangeOperation
  readonly path: string
  readonly oldPath?: string
  readonly fileKind: WorkspaceFileKind
  readonly additions?: number
  readonly deletions?: number
  readonly truncated: boolean
  readonly gitPatch?: string
}

export interface WorkspaceDiffState {
  readonly head?: string
  readonly workingTreeDigest: string
}

export interface WorkspaceReadFileData {
  readonly kind: "text" | "binary"
  readonly sizeBytes: number
  readonly digest: string
  readonly totalLines?: number
  readonly startLine?: number
  readonly content?: string
  readonly nextStartLine?: number
}

export type WorkspaceInspectionFailureCode = "workspace_unavailable" | "workspace_path_denied"

export type WorkspaceDiffOutcome =
  | { readonly ok: true; readonly state: WorkspaceDiffState; readonly changes: readonly WorkspaceDiffEntryData[] }
  | { readonly ok: false; readonly code: WorkspaceInspectionFailureCode; readonly message: string }

export type WorkspaceReadFileOutcome =
  | { readonly ok: true; readonly file: WorkspaceReadFileData }
  | { readonly ok: false; readonly code: WorkspaceInspectionFailureCode; readonly message: string }

/** Per-file patch byte bound; a longer patch is cut and flagged truncated. */
const MAX_PATCH_BYTES_PER_FILE = 64 * 1024
/** Total patch bytes one diff call may assemble before further patches are dropped. */
const MAX_PATCH_BYTES_TOTAL = 512 * 1024
/** Bytes of the head of a file inspected for the NUL binary marker. */
const BINARY_SNIFF_BYTES = 8192
const WORKSPACE_READ_FILE_DEFAULT_MAX_LINES = 2000
const WORKSPACE_READ_FILE_MAX_LINES = 5000

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex")
}

/** Decode one C-quoted porcelain path field; unquoted fields pass through verbatim. */
function parsePorcelainPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw
  const inner = raw.slice(1, -1)
  const encoder = new TextEncoder()
  const bytes: number[] = []
  for (let index = 0; index < inner.length; index++) {
    const character = inner[index]!
    if (character !== "\\") {
      bytes.push(...encoder.encode(character))
      continue
    }
    const escape = inner[++index]
    switch (escape) {
      case undefined:
        return raw
      case "a":
        bytes.push(0x07)
        break
      case "b":
        bytes.push(0x08)
        break
      case "f":
        bytes.push(0x0c)
        break
      case "n":
        bytes.push(0x0a)
        break
      case "r":
        bytes.push(0x0d)
        break
      case "t":
        bytes.push(0x09)
        break
      case "v":
        bytes.push(0x0b)
        break
      case '"':
        bytes.push(0x22)
        break
      case "\\":
        bytes.push(0x5c)
        break
      default: {
        // Git C-quotes any byte outside printable ASCII as a three-digit octal
        // escape, so one UTF-8 rune arrives as consecutive escapes. Bytes must
        // accumulate before decoding; per-escape string conversion would split
        // multi-byte sequences.
        const triplet = inner.slice(index, index + 3)
        if (/^[0-7]{3}$/.test(triplet)) {
          bytes.push(parseInt(triplet, 8))
          index += 2
        } else {
          return raw
        }
      }
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

interface PorcelainEntry {
  readonly xy: string
  readonly path: string
  readonly oldPath?: string
  readonly untracked: boolean
}

/** `git status --porcelain=v2 --branch` entries plus the branch head, if born. */
async function readStatus(root: string): Promise<{ readonly entries: readonly PorcelainEntry[]; readonly head?: string }> {
  const result = await runGit(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"])
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git status failed")
  const entries: PorcelainEntry[] = []
  let head: string | undefined
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length)
      if (!oid.startsWith("(")) head = oid
      continue
    }
    if (line.startsWith("? ")) {
      entries.push({ xy: "?", path: parsePorcelainPath(line.slice(2)), untracked: true })
      continue
    }
    if (line.startsWith("u ")) {
      // Unmerged (conflict) states are reported as modifications of the path.
      const fields = line.split(" ")
      const path = fields.at(-1)
      if (path === undefined) continue
      entries.push({ xy: "UU", path: parsePorcelainPath(path), untracked: false })
      continue
    }
    if (line.startsWith("1 ")) {
      const fields = line.split(" ")
      const xy = fields[1]
      const path = fields.at(-1)
      if (xy === undefined || path === undefined) continue
      entries.push({ xy, path: parsePorcelainPath(path), untracked: false })
      continue
    }
    if (line.startsWith("2 ")) {
      // Format: `2 <XY> ... <path>\t<origPath>`; the new path precedes the tab.
      const tab = line.lastIndexOf("\t")
      if (tab === -1) continue
      const fields = line.slice(0, tab).split(" ")
      const xy = fields[1]
      const path = fields.at(-1)
      if (xy === undefined || path === undefined) continue
      entries.push({
        xy,
        path: parsePorcelainPath(path),
        oldPath: parsePorcelainPath(line.slice(tab + 1)),
        untracked: false,
      })
    }
  }
  return { entries, ...(head === undefined ? {} : { head }) }
}

async function isGitRepository(root: string): Promise<boolean> {
  const result = await runGit(root, ["rev-parse", "--is-inside-work-tree"])
  return result.exitCode === 0 && result.stdout.trim() === "true"
}

function classifyOperation(entry: PorcelainEntry): WorkspaceChangeOperation {
  if (entry.oldPath !== undefined) return entry.xy[0] === "C" ? "copy" : "move"
  const [x, y] = [entry.xy[0] ?? " ", entry.xy[1] ?? " "]
  if (x === "A" || entry.untracked) return "add"
  if (x === "D" || y === "D") return "delete"
  return "modify"
}

/** A symlink untracked entry never has its content read: kind stays "symlink". */
async function classifyFileKind(root: string, entry: PorcelainEntry, numstatIsBinary: boolean): Promise<WorkspaceFileKind> {
  const info = await lstat(join(root, entry.path)).catch(() => undefined)
  if (info !== undefined) {
    if (info.isSymbolicLink()) return "symlink"
    if (info.isDirectory()) return "directory"
  }
  if (classifyOperation(entry) === "delete") {
    // The worktree no longer has the file; only numstat can testify it was text.
    return numstatIsBinary ? "binary" : "text"
  }
  if (info === undefined) return "unknown"
  if (numstatIsBinary) return "binary"
  const buffer = await readFile(join(root, entry.path)).catch(() => undefined)
  if (buffer === undefined) return "unknown"
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0) ? "binary" : "text"
}

interface Numstat {
  readonly additions?: number
  readonly deletions?: number
  readonly binary: boolean
}

/** Map of path -> additions/deletions vs HEAD (HEAD, or the index when unborn). */
async function readNumstat(root: string, head: string | undefined): Promise<Map<string, Numstat>> {
  const args = head === undefined ? ["diff", "--numstat", "--cached", "-M"] : ["diff", "--numstat", "HEAD", "-M"]
  const result = await runGit(root, args)
  const map = new Map<string, Numstat>()
  if (result.exitCode !== 0) return map
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue
    const firstTab = line.indexOf("\t")
    const secondTab = line.indexOf("\t", firstTab + 1)
    if (firstTab === -1 || secondTab === -1) continue
    const added = line.slice(0, firstTab)
    const deleted = line.slice(firstTab + 1, secondTab)
    const binary = added === "-" || deleted === "-"
    map.set(parsePorcelainPath(line.slice(secondTab + 1)), {
      ...(binary ? {} : { additions: Number(added) }),
      ...(binary ? {} : { deletions: Number(deleted) }),
      binary,
    })
  }
  return map
}

function patchSegmentPath(segment: string): string | undefined {
  const lines = segment.split("\n")
  for (const [marker, side] of [
    ["+++", "b/"],
    ["---", "a/"],
  ] as const) {
    for (const line of lines) {
      if (!line.startsWith(`${marker} `)) continue
      const token = line.slice(4)
      // Git C-quotes the whole token, a/ or b/ prefix included, once the path
      // contains bytes outside printable ASCII.
      const decoded = token.startsWith('"') ? parsePorcelainPath(token) : token
      if (decoded.startsWith(side)) return decoded.slice(2)
    }
  }
  return undefined
}

/** Per-file patch text vs HEAD for the given tracked paths, keyed by path. */
async function readPatches(root: string, head: string | undefined, paths: readonly string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (paths.length === 0) return map
  const base =
    head === undefined
      ? ["diff", "--no-ext-diff", "--no-textconv", "--cached", "-M"]
      : ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "-M"]
  const result = await runGit(root, [...base, "--", ...paths])
  if (result.exitCode !== 0) return map
  const lines = result.stdout.split("\n")
  const starts = lines.flatMap((line, index) => (line.startsWith("diff --git ") ? [index] : []))
  starts.forEach((start, position) => {
    const end = starts[position + 1] ?? lines.length
    const segment = lines.slice(start, end).join("\n")
    const path = patchSegmentPath(segment)
    if (path !== undefined && !map.has(path)) map.set(path, segment)
  })
  return map
}

function synthesizeUntrackedPatch(content: string): string {
  const lines = content === "" ? [] : content.split("\n")
  const body = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines
  return ["--- /dev/null", `@@ -0,0 +1,${body.length} @@`, ...body.map((line) => `+${line}`)].join("\n")
}

function boundPatch(patch: string): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.from(patch, "utf-8")
  if (bytes.byteLength <= MAX_PATCH_BYTES_PER_FILE) return { text: patch, truncated: false }
  const cut = bytes.subarray(0, MAX_PATCH_BYTES_PER_FILE)
  // Walk back over a trailing partial UTF-8 sequence so the cut cannot split a rune.
  let end = cut.byteLength
  while (end > 0 && (cut[end - 1]! & 0xc0) === 0x80) end--
  if (end > 0 && (cut[end - 1]! & 0x80) !== 0) {
    const lead = cut[end - 1]!
    const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
    if (cut.byteLength - (end - 1) < width) end--
  }
  return { text: cut.subarray(0, end).toString("utf-8"), truncated: true }
}

/** Sensitive or policy-denied paths never appear in diff output at all. */
function isDiffEntryDenied(root: string, path: string): boolean {
  if (isSensitivePathToken(path)) return true
  return isSensitivePath(join(root, path))
}

function countUntrackedAdditions(buffer: Buffer): number | undefined {
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined
  const text = buffer.toString("utf-8")
  if (text === "") return 0
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
}

/** Digest input binding the full porcelain status (branch head, index, worktree, untracked). */
function workingTreeStateFingerprint(status: { readonly entries: readonly PorcelainEntry[]; readonly head?: string }): string {
  return JSON.stringify({
    head: status.head ?? null,
    entries: status.entries.map((entry) => [entry.xy, entry.path, entry.oldPath ?? null]),
  })
}

export class WorkspaceInspector {
  async diff(root: string, options?: { readonly includePatch?: boolean }): Promise<WorkspaceDiffOutcome> {
    const availability = await this.checkRoot(root)
    if (availability !== undefined) return availability
    if (!(await isGitRepository(root).catch(() => false))) {
      return { ok: false, code: "workspace_unavailable", message: `Workspace is not a git repository: ${root}` }
    }
    let status: Awaited<ReturnType<typeof readStatus>>
    try {
      status = await readStatus(root)
    } catch (error) {
      return { ok: false, code: "workspace_unavailable", message: (error as Error).message }
    }
    const numstat = await readNumstat(root, status.head)
    const permitted = status.entries.filter(
      (entry) => !isDiffEntryDenied(root, entry.path) && (entry.oldPath === undefined || !isDiffEntryDenied(root, entry.oldPath)),
    )

    let changes: WorkspaceDiffEntryData[] = []
    for (const entry of permitted) {
      const operation = classifyOperation(entry)
      const stats = numstat.get(entry.path)
      const fileKind = await classifyFileKind(root, entry, stats?.binary ?? false)
      let additions = stats?.additions
      let deletions = stats?.deletions
      if (entry.untracked && fileKind === "text") {
        const buffer = await readFile(join(root, entry.path)).catch(() => undefined)
        if (buffer !== undefined) additions = countUntrackedAdditions(buffer)
      }
      changes.push({
        operation,
        path: entry.path,
        ...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
        fileKind,
        ...(additions === undefined ? {} : { additions }),
        ...(deletions === undefined ? {} : { deletions }),
        truncated: false,
      })
    }

    if (options?.includePatch === true) {
      const trackedPaths = permitted.filter((entry) => !entry.untracked).map((entry) => entry.path)
      const patches = await readPatches(root, status.head, trackedPaths)
      let totalPatchBytes = 0
      const patched: WorkspaceDiffEntryData[] = []
      for (const change of changes) {
        if (
          totalPatchBytes >= MAX_PATCH_BYTES_TOTAL ||
          change.fileKind === "binary" ||
          change.fileKind === "symlink" ||
          change.fileKind === "directory"
        ) {
          patched.push(change)
          continue
        }
        const raw = permitted.find((candidate) => candidate.path === change.path)?.untracked
          ? await readFile(join(root, change.path))
              .then((buffer) => synthesizeUntrackedPatch(buffer.toString("utf-8")))
              .catch(() => undefined)
          : patches.get(change.path)
        if (raw === undefined) {
          patched.push(change)
          continue
        }
        const { text, truncated } = boundPatch(raw)
        totalPatchBytes += Buffer.byteLength(text)
        patched.push({ ...change, gitPatch: text, truncated: truncated || change.truncated })
      }
      changes = patched
    }

    return {
      ok: true,
      state: {
        ...(status.head === undefined ? {} : { head: status.head }),
        workingTreeDigest: sha256Hex(workingTreeStateFingerprint(status)),
      },
      changes,
    }
  }

  async readFile(
    root: string,
    path: string,
    window?: { readonly startLine?: number; readonly maxLines?: number },
  ): Promise<WorkspaceReadFileOutcome> {
    const availability = await this.checkRoot(root)
    if (availability !== undefined) return availability
    if (isAbsolute(path) || isSensitivePathToken(path) || isSensitivePath(join(root, path))) {
      return { ok: false, code: "workspace_path_denied", message: `Workspace path denied: ${path}` }
    }
    const target = join(root, path)
    const original = await lstat(target).catch(() => undefined)
    if (original === undefined) {
      return { ok: false, code: "workspace_path_denied", message: `Workspace path does not exist: ${path}` }
    }
    if (!original.isSymbolicLink() && !original.isFile()) {
      return { ok: false, code: "workspace_path_denied", message: `Workspace path is not a regular file: ${path}` }
    }
    // Containment and sensitivity are enforced on the fully resolved path: a
    // symlinked intermediate directory escapes just as much as a final-component
    // link, and a lexical alias (env-link -> .env) must not dodge the deny list.
    const canonical = await realpath(target).catch(() => undefined)
    const canonicalRoot = await realpath(root).catch(() => root)
    if (canonical === undefined) {
      return { ok: false, code: "workspace_path_denied", message: `Workspace path is a dangling symlink: ${path}` }
    }
    if (!isWithinWorkspaceRoot(canonical, [canonicalRoot])) {
      return { ok: false, code: "workspace_path_denied", message: `Workspace path escapes the workspace: ${path}` }
    }
    if (isSensitivePath(canonical)) {
      return { ok: false, code: "workspace_path_denied", message: `Workspace path denied: ${path}` }
    }

    let buffer: Buffer
    try {
      buffer = await readFile(target)
    } catch {
      return { ok: false, code: "workspace_path_denied", message: `Workspace path is not readable: ${path}` }
    }
    const digest = sha256Hex(buffer)
    const sizeBytes = buffer.byteLength
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { ok: true, file: { kind: "binary", sizeBytes, digest } }
    }
    const text = buffer.toString("utf-8")
    const totalLines = text === "" ? 0 : text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length
    if (totalLines === 0) {
      return { ok: true, file: { kind: "text", sizeBytes, digest } }
    }
    const startLine = window?.startLine ?? 1
    const maxLines = Math.min(window?.maxLines ?? WORKSPACE_READ_FILE_DEFAULT_MAX_LINES, WORKSPACE_READ_FILE_MAX_LINES)
    const windowLines =
      text === ""
        ? []
        : (text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")).slice(startLine - 1, startLine - 1 + maxLines)
    const lastLineOfWindow = startLine - 1 + windowLines.length
    return {
      ok: true,
      file: {
        kind: "text",
        sizeBytes,
        digest,
        totalLines,
        startLine,
        ...(windowLines.length === 0 ? {} : { content: windowLines.join("\n") }),
        ...(lastLineOfWindow < totalLines ? { nextStartLine: lastLineOfWindow + 1 } : {}),
      },
    }
  }

  private async checkRoot(
    root: string,
  ): Promise<{ readonly ok: false; readonly code: "workspace_unavailable"; readonly message: string } | undefined> {
    const info = await stat(root).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) {
      return { ok: false, code: "workspace_unavailable", message: `Workspace is unavailable: ${root}` }
    }
    return undefined
  }
}
