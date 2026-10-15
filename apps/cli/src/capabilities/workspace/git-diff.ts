/**
 * Working-tree git diff data source for the TUI: shells out to git with a
 * sanitized environment, suppresses transient states (merge/rebase/...),
 * appends untracked files as synthetic entries, and caps output at the
 * legacy budgets (total bytes, file count, per-file lines and bytes).
 * Verbatim port of the frozen baseline letter (ui/tui/git.ts).
 */
import { access } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"

export interface GitDiffFile {
  readonly path: string
  readonly diff: string
  readonly additions: number
  readonly deletions: number
  readonly binary: boolean
  readonly untracked?: boolean
  readonly truncated?: boolean
}

const MAX_DIFF_OUTPUT_LENGTH = 1_000_000
const MAX_DIFF_FILES = 50
const MAX_DIFF_FILE_BYTES = 1_000_000
const MAX_DIFF_FILE_LINES = 400
const MAX_UNTRACKED_FILES = 50
const TRANSIENT_GIT_MARKERS = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"] as const

export async function readGitDiff(cwd: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  if (await isTransientGitState(cwd, signal)) return ""

  const tracked = await runGit(cwd, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"], signal)
  let trackedDiff = tracked.stdout
  if (tracked.exitCode !== 0) {
    // An unborn repository has no HEAD yet. Keep the command useful there by
    // combining its staged and unstaged views; regular repositories use the
    // single HEAD-based view above so a path is not emitted twice.
    const [staged, unstaged] = await Promise.all([
      runGit(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--"], signal),
      runGit(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--"], signal),
    ])
    if (staged.exitCode !== 0 && unstaged.exitCode !== 0) {
      throw new Error(staged.stderr.trim() || unstaged.stderr.trim() || "git diff failed")
    }
    trackedDiff = [staged.stdout, unstaged.stdout].filter(Boolean).join("\n")
  }

  const untracked = await readUntrackedFiles(cwd, signal)
  const untrackedDiff = untracked.map(formatUntrackedDiff).join("\n")
  return [trackedDiff.slice(0, MAX_DIFF_OUTPUT_LENGTH), untrackedDiff].filter(Boolean).join("\n")
}

/** Split a git unified diff into the file-level entries needed by the TUI. */
export function parseGitDiff(text: string): readonly GitDiffFile[] {
  const lines = text.split("\n")
  const starts = lines.flatMap((line, index) => (line.startsWith("diff --git ") ? [index] : []))
  return starts
    .slice(0, MAX_DIFF_FILES)
    .map((start, index) => {
      const end = starts[index + 1] ?? lines.length
      const diff = lines.slice(start, end).join("\n").trimEnd()
      return parseGitDiffFile(diff, lines[start] ?? "")
    })
    .filter((file): file is GitDiffFile => file !== undefined)
}

function parseGitDiffFile(diff: string, header: string): GitDiffFile | undefined {
  const path = parseGitPath(header)
  if (!path) return undefined
  const lines = diff.split("\n")
  const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).length
  const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("--- ")).length
  const binary = lines.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch")
  const untracked = lines.some((line) => line === "untracked file")
  const limited = limitDiff(diff)
  return {
    path,
    diff: limited.text,
    additions,
    deletions,
    binary,
    ...(untracked ? { untracked: true } : {}),
    ...(limited.truncated ? { truncated: true } : {}),
  }
}

function limitDiff(diff: string): { readonly text: string; readonly truncated: boolean } {
  const lines = diff.split("\n")
  const kept: string[] = []
  let bodyLines = 0
  let bytes = 0
  let inHunk = false
  let truncated = false

  for (const line of lines) {
    if (line.startsWith("@@ ")) inHunk = true
    const isBodyLine = inHunk && (line === "" || line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))
    const lineBytes = Buffer.byteLength(line) + (kept.length > 0 ? 1 : 0)
    if (isBodyLine && (bodyLines >= MAX_DIFF_FILE_LINES || bytes + lineBytes > MAX_DIFF_FILE_BYTES)) {
      truncated = true
      continue
    }
    if (bytes + lineBytes > MAX_DIFF_FILE_BYTES) {
      truncated = true
      continue
    }
    kept.push(line)
    bytes += lineBytes
    if (isBodyLine) bodyLines++
  }

  if (truncated) kept.push(`… diff truncated (over ${MAX_DIFF_FILE_LINES} lines or ${MAX_DIFF_FILE_BYTES / 1_000_000} MB)`)
  return { text: kept.join("\n"), truncated }
}

async function isTransientGitState(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--git-dir"], signal)
  if (result.exitCode !== 0) return false
  const rawGitDir = result.stdout.trim()
  if (!rawGitDir) return false
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(cwd, rawGitDir)
  const markers = await Promise.all(
    TRANSIENT_GIT_MARKERS.map(async (marker) => {
      try {
        await access(join(gitDir, marker))
        return true
      } catch {
        return false
      }
    }),
  )
  return markers.some(Boolean)
}

async function readUntrackedFiles(cwd: string, signal?: AbortSignal): Promise<readonly string[]> {
  const result = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], signal)
  if (result.exitCode !== 0) return []
  return result.stdout.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED_FILES)
}

function formatUntrackedDiff(path: string): string {
  const oldPath = quoteGitPath(`a/${path}`)
  const newPath = quoteGitPath(`b/${path}`)
  return `diff --git ${oldPath} ${newPath}\nnew file mode 100644\nuntracked file`
}

function quoteGitPath(path: string): string {
  return `"${path
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\t", "\\011")
    .replaceAll("\n", "\\012")
    .replaceAll("\r", "\\015")}"`
}

async function runGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
  throwIfAborted(signal)
  const env = { ...process.env }
  delete env.GIT_EXTERNAL_DIFF
  delete env.GIT_DIFF_OPTS
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    ...(signal ? { signal } : {}),
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const exitCode = await child.exited
  throwIfAborted(signal)
  return { stdout, stderr, exitCode }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException("git diff cancelled", "AbortError")
}

function parseGitPath(header: string): string | undefined {
  const rest = header.slice("diff --git ".length)
  if (rest.startsWith('"')) {
    const first = readQuotedGitToken(rest)
    const second = first ? readQuotedGitToken(rest.slice(first.end).trimStart()) : undefined
    if (first && second && first.value.startsWith("a/") && second.value.startsWith("b/")) {
      return decodeGitPath(second.value.slice(2)) || decodeGitPath(first.value.slice(2))
    }
    return undefined
  }
  const match = /^a\/(.+?) b\/(.+)$/.exec(rest)
  if (!match) return undefined
  return decodeGitPath(match[2]!) || decodeGitPath(match[1]!)
}

function readQuotedGitToken(value: string): { readonly value: string; readonly end: number } | undefined {
  if (!value.startsWith('"')) return undefined
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== '"' || value[index - 1] === "\\") continue
    return { value: value.slice(1, index), end: index + 1 }
  }
  return undefined
}

function decodeGitPath(value: string): string {
  return value
    .replace(/\\([\\"])/g, "$1")
    .replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
}
