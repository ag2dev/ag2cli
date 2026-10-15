/**
 * WorkspacePolicy confines file tools to admitted roots and rejects sensitive paths.
 * All checks use canonical paths to prevent traversal and symlink escapes. Sensitive
 * paths are rejected before boundary checks. This is a policy boundary, not an OS
 * sandbox; Bash authorization is handled by the canonical permission judgment.
 */

import { lstat, realpath, stat } from "node:fs/promises"
import { mkdirSync, realpathSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, normalize, resolve, sep } from "node:path"
import type { PermissionDenialCode } from "@ag2cli/core/tool-facts.js"
import type { WriteTargetClassification } from "@ag2cli/runtime/ports/workspace.js"
import { NotRegularFileError } from "./file-kind.js"
import { registerScratchRoot } from "./scratch.js"

/** Stable local/session identity derived from a canonical workspace root. */
export function workspaceIdForRoot(workspaceRoot: string): string {
  let canonical = resolve(workspaceRoot)
  try {
    canonical = realpathSync(canonical)
  } catch {
    // A deleted workspace still needs a stable identity for degraded attach.
  }
  return `ws_${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32)}`
}

export class WorkspaceUnavailableError extends Error {
  readonly code = "workspace_unavailable"
  constructor(readonly workspaceRoot: string) {
    super(`Workspace is unavailable: ${workspaceRoot}`)
    this.name = "WorkspaceUnavailableError"
  }
}

class NotDirectoryError extends Error {
  constructor() {
    super("Expected a directory")
    this.name = "NotDirectoryError"
  }
}

/** Workspace-boundary rejection: out-of-root target or a dangling symlink. */
export class OutsideWorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "OutsideWorkspaceError"
  }
}

/** Sensitive-path rejection: a hard policy deny issued before boundary checks. */
export class SensitivePathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SensitivePathError"
  }
}

/**
 * Stable denial code for a caught security-layer error; undefined = the error
 * is not in the closed first-release vocabulary. Boundary and read-side
 * rejections converge on `outside_workspace`; sensitive-path refusals are
 * rule denials.
 */
export function securityDenialCode(error: unknown): PermissionDenialCode | undefined {
  if (error instanceof OutsideWorkspaceError || error instanceof NotRegularFileError) return "outside_workspace"
  if (error instanceof SensitivePathError) return "denied_by_rule"
  return undefined
}

/**
 * Access modes for path admission: read (file reads), write (file writes),
 * traverse (recursive search roots — external roots allowed), bash-cwd (the
 * cwd a bash process starts in — restricted to admitted roots).
 */
export type AccessMode = "read" | "write" | "traverse" | "bash-cwd"

/** Sensitive file and directory rules; reject before boundary checks. */
const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "identity",
  ".git-credentials",
])
const SENSITIVE_NAME_PATTERNS = [
  /^\.env(\..+)?$/i, // .env and .env.* variants
  /^id_(rsa|ed25519|ecdsa|dsa|dsa1)$/, // SSH private keys
  /^\.?_?netrc$/i, // netrc credential file in all dot/underscore spellings
  /\.pem$/i, // PEM private keys and certificates
]
const SENSITIVE_DIR_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".config", // May contain credentials; conservative by default.
  ".docker",
  ".gcloud",
  ".kube",
])

function isSensitiveSegment(segment: string): boolean {
  const lower = segment.toLowerCase()
  return SENSITIVE_BASENAMES.has(lower) || SENSITIVE_NAME_PATTERNS.some((re) => re.test(segment)) || SENSITIVE_DIR_SEGMENTS.has(lower)
}

/**
 * Ask-side dangerous write list, independent of the sensitive hard-deny
 * groups: editor/IDE settings directories and shell rc files. A hit never
 * blocks admission — it only upgrades the canonical judgment's mode default
 * to an ask, so explicit allow rules and full-access still pass.
 */
const DANGEROUS_WRITE_DIR_SEGMENTS = new Set([".vscode", ".idea"])
const DANGEROUS_WRITE_BASENAMES = new Set([".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".zshenv"])

function isDangerousWritePath(canonical: string): boolean {
  const segments = normalize(canonical).split(sep).filter(Boolean)
  return segments.some((segment) => {
    const lower = segment.toLowerCase()
    return DANGEROUS_WRITE_DIR_SEGMENTS.has(lower) || DANGEROUS_WRITE_BASENAMES.has(lower)
  })
}

/**
 * Explicit regex→glob translation for the name patterns that cannot be mapped
 * mechanically. Keep in lockstep with SENSITIVE_NAME_PATTERNS; the equivalence
 * test in workspace.test.ts enumerates every member.
 */
const SENSITIVE_PATTERN_RIPGREP_GLOBS: readonly string[] = [
  "!**/.env*", // /^\.env(\..+)?$/i — superset: also hides e.g. `.envelope`
  "!**/id_rsa", // /^id_(rsa|ed25519|ecdsa|dsa|dsa1)$/
  "!**/id_ed25519",
  "!**/id_ecdsa",
  "!**/id_dsa",
  "!**/id_dsa1",
  "!**/.netrc", // /^\.?_?netrc$/i — all four spellings, incl. bare `netrc`
  "!**/_netrc",
  "!**/._netrc",
  "!**/netrc",
  "!**/*.pem", // /\.pem$/i
]

/**
 * Ripgrep exclusion globs derived from the sensitive constants above: one glob
 * per sensitive basename, two per directory segment (the dir itself and its
 * contents), plus the explicit pattern translation table. This is the single
 * derivation point for search-side exclusions — glob/grep must consume it
 * instead of keeping inline copies.
 *
 * The derived surface is a deliberate conservative superset of
 * `isSensitivePath` (e.g. the `.env*` glob also hides `.envelope`), and
 * ripgrep globs are case-sensitive where the deny list is not — search
 * results stay strictly more hidden than the deny list, never less.
 */
export function sensitiveRipgrepExclusions(): string[] {
  const basenames = [...SENSITIVE_BASENAMES].map((name) => `!**/${name}`)
  const directories = [...SENSITIVE_DIR_SEGMENTS].flatMap((segment) => [`!**/${segment}`, `!**/${segment}/**`])
  return [...basenames, ...directories, ...SENSITIVE_PATTERN_RIPGREP_GLOBS]
}

/** Return whether an absolute path is sensitive by checking each segment. */
export function isSensitivePath(absPath: string): boolean {
  const norm = normalize(absPath)
  const segments = norm.split(sep).filter(Boolean)
  return segments.some((segment) => isSensitiveSegment(segment))
}

/**
 * Check path tokens in command arguments. Git revision:path uses a colon
 * separator, so splitting only on OS path boundaries would miss `HEAD:.env`.
 */
export function isSensitivePathToken(pathToken: string): boolean {
  return pathToken
    .split(/[\\/:]/)
    .filter(Boolean)
    .some((segment) => isSensitiveSegment(segment))
}

export interface WorkspacePolicyOptions {
  /** Session project identity. It is immutable for the lifetime of a policy. */
  workspaceRoot: string
  /** Explicitly authorized directories; these never replace workspaceRoot. */
  additionalDirectories?: readonly string[]
  /**
   * Session identity scoping the per-session scratch zone. Absent on the
   * directly constructed instances that legitimately have no scratch.
   */
  sessionId?: string
}

/**
 * Resolve a target, which may not exist, to a canonical absolute path. Existing
 * targets use realpath. For missing targets, resolve the nearest existing
 * ancestor and append the remaining segments without following the target's symlink.
 */
async function resolveCanonical(target: string, baseDir = process.cwd()): Promise<string> {
  const abs = isAbsolute(target) ? target : join(baseDir, target)
  try {
    return await realpath(abs)
  } catch {
    // Find the nearest existing ancestor.
  }
  const normalized = normalize(abs)
  const parts = normalized.split(sep)
  // Find the index of the nearest existing ancestor.
  let existsIdx = parts.length
  for (let i = parts.length; i > 0; i--) {
    const candidate = i === 1 ? sep : parts.slice(0, i).join(sep)
    try {
      await stat(candidate)
      existsIdx = i
      break
    } catch {
      // Continue toward the root.
    }
  }
  const existingPart = existsIdx <= 1 ? sep : parts.slice(0, existsIdx).join(sep)
  const realExisting = await realpath(existingPart).catch(() => existingPart)
  const tail = parts.slice(existsIdx).join(sep)
  return tail ? join(realExisting, tail) : realExisting
}

/** Return whether a canonical path is within an admitted root, including the root itself. */
export function isWithinWorkspaceRoot(canonical: string, canonicalDirectories: readonly string[]): boolean {
  for (const root of canonicalDirectories) {
    if (canonical === root) return true
    if (canonical.startsWith(root + sep)) return true
    // Handle the root "/" boundary defensively.
  }
  return false
}

export class WorkspacePolicy {
  private readonly root: string
  private additional: string[]
  private revision = 0
  private readonly scratch: string | undefined

  constructor(opts: WorkspacePolicyOptions) {
    this.root = canonicalDirectory(opts.workspaceRoot)
    this.additional = normalizeAdditionalDirectories(opts.additionalDirectories ?? [], this.root)
    this.scratch = createSessionScratchRoot(opts.sessionId)
  }

  get workspaceRoot(): string {
    return this.root
  }

  get additionalDirectories(): readonly string[] {
    return [...this.additional]
  }

  /** Effective scope used by path tools. */
  get effectiveDirectories(): readonly string[] {
    return [this.root, ...this.additional]
  }

  get scopeRevision(): number {
    return this.revision
  }

  get scopeDigest(): string {
    return computeWorkspaceScopeDigest(this.root, this.additional)
  }

  get scratchRoot(): string | undefined {
    return this.scratch
  }

  /**
   * Add one existing directory to this session's additional scope.
   *
   * Canonicalize first, require an existing directory, reject sensitive paths,
   * and reject overlap with an existing root so a typo cannot silently broaden
   * the workspace.
   */
  async addAdditionalDirectory(directoryPath: string): Promise<{ readonly canonical: string; readonly changed: boolean }> {
    this.assertAvailable()
    const value = directoryPath.trim()
    if (value.length === 0) throw new Error("add_additional_directory requires a directory path")
    let canonical: string
    try {
      canonical = await realpath(value)
      const fileStat = await stat(canonical)
      if (!fileStat.isDirectory()) throw new NotDirectoryError()
    } catch (error) {
      if (error instanceof NotDirectoryError) {
        throw new Error(`Working directory is invalid: ${value} is not a directory`, { cause: error })
      }
      throw new Error(`Working directory is missing or inaccessible: ${value}`, { cause: error })
    }
    canonical = normalize(canonical)
    if (isSensitivePath(canonical)) throw new SensitivePathError(`Working directory must not be a sensitive path: ${value}`)
    if (isWithinWorkspaceRoot(canonical, this.effectiveDirectories)) {
      return { canonical, changed: false }
    }
    const covered = this.additional.filter((directory) => isWithinWorkspaceRoot(directory, [canonical]))
    this.additional = [...this.additional.filter((directory) => !covered.includes(directory)), canonical]
    this.revision++
    return { canonical, changed: true }
  }

  /** Validate and return the canonical path to reduce the symlink TOCTOU window before process launch. */
  async resolveWithin(targetPath: string, mode: AccessMode): Promise<string> {
    this.assertAvailable()
    if (isSensitivePathToken(targetPath)) {
      throw new SensitivePathError(`Workspace policy: sensitive path denied: ${targetPath}`)
    }
    const absForSensitive = isAbsolute(targetPath) ? targetPath : join(this.root, targetPath)
    if (isSensitivePath(absForSensitive)) {
      throw new SensitivePathError(`Workspace policy: sensitive path denied: ${targetPath}`)
    }
    const canonical = await resolveCanonical(targetPath, this.root)
    await rejectDanglingSymlink(absForSensitive, targetPath)
    if (isSensitivePath(canonical)) {
      throw new SensitivePathError(`Workspace policy: canonical sensitive path denied: ${canonical}`)
    }
    if (!isWithinWorkspaceRoot(canonical, this.effectiveDirectories) && !this.isScratchTarget(canonical)) {
      // External zone: reads and recursive search roots pass silently; file
      // writes and bash cwd admission are rejected. Policy layer only — the
      // three zones are not an OS-enforced sandbox.
      if (mode === "write" || mode === "bash-cwd") {
        throw new OutsideWorkspaceError(`Workspace policy: path escapes the workspace: ${targetPath} (resolved to ${canonical})`)
      }
    }
    return canonical
  }

  /** Validate that a target is accessible in the requested mode; reject sensitive paths before boundary escapes. */
  async assertWithin(targetPath: string, mode: AccessMode): Promise<void> {
    await this.resolveWithin(targetPath, mode)
  }

  /** Non-throwing variant for callers that need a boolean result, such as Glob. */
  async isAllowed(targetPath: string, mode: AccessMode): Promise<boolean> {
    try {
      await this.assertWithin(targetPath, mode)
      return true
    } catch {
      return false
    }
  }

  /**
   * Non-throwing write-target zone label consumed by preparation facts.
   * Scratch wins over the dangerous list (mutual exclusion); the dangerous
   * zone applies only inside the admitted roots. Admission (resolveWithin)
   * stays the enforcer; errors degrade to external.
   */
  async classifyWriteTarget(targetPath: string): Promise<WriteTargetClassification> {
    try {
      const canonical = await resolveCanonical(targetPath, this.root)
      if (this.isScratchTarget(canonical)) return "scratch"
      if (isWithinWorkspaceRoot(canonical, this.effectiveDirectories)) {
        return isDangerousWritePath(canonical) ? "dangerous" : "workspace"
      }
    } catch {
      // classification degrades to external; admission stays the enforcer
    }
    return "external"
  }

  get available(): boolean {
    try {
      return statSync(this.root).isDirectory()
    } catch {
      return false
    }
  }

  private isScratchTarget(canonical: string): boolean {
    return this.scratch !== undefined && isWithinWorkspaceRoot(canonical, [this.scratch])
  }

  private assertAvailable(): void {
    if (!this.available) throw new WorkspaceUnavailableError(this.root)
  }

  /** Replace this policy's additional scope with an already validated snapshot. */
  setAdditionalDirectories(directories: readonly string[]): void {
    const normalized = normalizeAdditionalDirectories(directories, this.root)
    if (normalized.join("\0") === this.additional.join("\0")) return
    this.additional = normalized
    this.revision++
  }
}

export function computeWorkspaceScopeDigest(workspaceRoot: string, additionalDirectories: readonly string[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        workspaceRoot: normalize(workspaceRoot),
        additionalDirectories: [...new Set(additionalDirectories.map(normalize))].sort(),
      }),
      "utf8",
    )
    .digest("hex")
}

function normalizeAdditionalDirectories(directories: readonly string[], workspaceRoot: string): string[] {
  const candidates = deduplicateDirectories(directories.map((directory) => canonicalDirectory(directory))).filter(
    (directory) => !isWithinWorkspaceRoot(directory, [workspaceRoot]),
  )
  // Keep the least-specific directory when an initial snapshot contains
  // overlaps. This is only effective-scope normalization; workspaceRoot
  // remains the immutable project identity.
  return candidates
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .filter((directory, index, all) => !all.slice(0, index).some((parent) => isWithinWorkspaceRoot(directory, [parent])))
}

/** Canonicalize and validate an existing directory without changing a policy. */
export async function canonicalizeExistingDirectory(directoryPath: string): Promise<string> {
  const value = directoryPath.trim()
  if (value.length === 0) throw new Error("Working directory path is required")
  const expanded = expandHomeDirectory(value)
  let canonical: string
  try {
    canonical = await realpath(expanded)
    const fileStat = await stat(canonical)
    if (!fileStat.isDirectory()) throw new NotDirectoryError()
  } catch (error) {
    if (error instanceof NotDirectoryError) throw new Error(`Working directory is invalid: ${value} is not a directory`, { cause: error })
    throw new Error(`Working directory is missing or inaccessible: ${value}`, { cause: error })
  }
  canonical = normalize(canonical)
  if (isSensitivePath(canonical)) throw new SensitivePathError(`Working directory must not be a sensitive path: ${value}`)
  return canonical
}

function scratchUidSegment(): string {
  return process.getuid === undefined ? "shared" : String(process.getuid())
}

/**
 * Eagerly create and canonicalize the per-session scratch zone. Failure
 * degrades to "no scratch zone" — it never blocks policy construction.
 */
export function createSessionScratchRoot(sessionId: string | undefined): string | undefined {
  if (sessionId === undefined || sessionId.length === 0) return undefined
  try {
    const root = join(tmpdir(), `ag2cli-${scratchUidSegment()}`, sessionId)
    mkdirSync(root, { recursive: true })
    const canonical = normalize(realpathSync(root))
    registerScratchRoot(canonical)
    return canonical
  } catch {
    return undefined
  }
}

function expandHomeDirectory(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

/**
 * `realpath` cannot distinguish a missing path from a dangling final symlink.
 * Check the lexical target separately so a broken link is not treated as a
 * normal new file by a later write.
 */
async function rejectDanglingSymlink(targetPath: string, displayPath: string): Promise<void> {
  let targetStat
  try {
    targetStat = await lstat(targetPath)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  if (!targetStat.isSymbolicLink()) return
  try {
    await realpath(targetPath)
  } catch (error) {
    if (isMissingPathError(error))
      throw new OutsideWorkspaceError(`Workspace policy: dangling symbolic link denied: ${displayPath}`, { cause: error })
    throw error
  }
}

function canonicalDirectory(value: string): string {
  let canonical: string
  try {
    canonical = normalize(realpathSync(value))
    if (!statSync(canonical).isDirectory()) throw new NotDirectoryError()
  } catch (error) {
    throw new Error(`Working directory is invalid: ${value}${error instanceof Error ? ` (${error.message})` : ""}`, { cause: error })
  }
  if (isSensitivePath(canonical)) throw new SensitivePathError(`Working directory must not be a sensitive path: ${value}`)
  return canonical
}

function deduplicateDirectories(directories: readonly string[]): string[] {
  return [...new Set(directories)]
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
