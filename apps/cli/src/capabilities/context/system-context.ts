/**
 * System Context — runtime snapshot injection.
 *
 * Generate runtime context such as the date and a bounded directory summary for model requests. The caller decides where to inject it;
 * the current composition regenerates this short snapshot for every model turn.
 *
 * Key design points:
 *  - This is a point-in-time snapshot, rebuilt for each model turn and never written to canonical history.
 *  - The directory summary is bounded: when the number of directories exceeds the limit, additional directories
 *    are collapsed into a count and representative entries to keep large add-dir lists from bloating the prompt.
 *  - The negative summary applies only to the three-zone rules for dedicated file tools; it makes no absolute promises about Bash or the environment.
 *  - Do not inject lists of sensitive paths, Bash templates, or summary-level execution details.
 *
 * Collect the Git section independently: if Git is unavailable (not a Git repository or Git is missing), return an empty array silently.
 * Runtime context is supplemental and must never prevent the agent from starting; failures do not throw, and any Git
 * subcommand error degrades the whole section to an empty array without affecting session startup. Currently only branch and status are included.
 */

import { isAbsolute } from "node:path"
import { createSessionScratchRoot } from "../security/workspace.js"

/** Optional Git context settings. */
export interface GitContextOptions {
  /** Working directory (defaults to process.cwd()). */
  cwd?: string
  /** Optional injected timeout; defaults to 5 seconds so slow Git commands do not block startup. */
  timeoutMs?: number
}

/** Run a Git subprocess and return stdout with trailing newlines removed. Throws on failure. */
async function git(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
  }, timeoutMs)
  try {
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exit ${exitCode}`)
    return stdout.trim()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Collect a repository environment snapshot for prompt assembly. Return [] outside a Git repository or on error.
 * The section order is fixed: description, branch, status.
 */
export async function getGitContext(options: GitContextOptions = {}): Promise<string[]> {
  const cwd = options.cwd ?? process.cwd()
  const timeoutMs = options.timeoutMs ?? 5000
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd, timeoutMs)
    const status = await git(["--no-optional-locks", "status", "--short"], cwd, timeoutMs)
    const parts = ["Repository context for this model turn:", `Branch: ${branch}`, status ? `Status:\n${status}` : "Status: (clean)"]
    return parts
  } catch {
    // Not a Git repository, Git unavailable, or timeout: degrade silently.
    return []
  }
}

/** Maximum number of directories to list in full; collapse additional directories beyond this limit. */
const DIRECTORY_LIST_LIMIT = 8
/** Number of representative additional directories to show when collapsing. */
const DIRECTORY_SAMPLE_COUNT = 3

/**
 * Negative summary: describe only the three-zone enforcement used by dedicated file tools, without making environment-wide promises
 * (Bash commands are not covered; see the Bash tool's own instructions).
 */
const FILE_TOOL_ZONE_SENTENCE =
  "Dedicated file tools enforce the three-zone policy: paths outside the directories above are read-only (non-sensitive targets may be read and searched recursively), writes are limited to those directories, and sensitive paths are denied."

export interface RuntimeContextOptions {
  /** Workspace root; omit the entire line when missing. */
  workspaceRoot?: string
  /** Directories additionally authorized for this session; omit the entire line when empty or absent. */
  additionalDirectories?: readonly string[]
  /** Session-level scratch root; omit the entire line when missing. */
  scratchRoot?: string
  /** Injected clock for tests; defaults to the current time. */
  now?: Date
  /** Time zone for deterministic dates in tests and across environments. */
  timeZone?: string
}

function formatDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

/**
 * Generate a runtime snapshot for model context: date line + bounded directory summary + negative summary.
 * Omit a line when its corresponding fact is missing; obtain exact time through the environment tool rather than injecting it here.
 */
export function getRuntimeContext(options: RuntimeContextOptions = {}): string[] {
  const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local"
  const additional = options.additionalDirectories ?? []
  const hasWorkspace = options.workspaceRoot !== undefined
  const hasScratch = options.scratchRoot !== undefined
  const total = (hasWorkspace ? 1 : 0) + additional.length + (hasScratch ? 1 : 0)
  const lines: string[] = [`Today's date is ${formatDate(options.now ?? new Date(), zone)}`]
  if (hasWorkspace) lines.push(`Workspace root: ${options.workspaceRoot}`)
  if (additional.length > 0) {
    lines.push(
      total > DIRECTORY_LIST_LIMIT
        ? `Additional directories: ${additional.length} (examples: ${additional.slice(0, DIRECTORY_SAMPLE_COUNT).join(", ")})`
        : `Additional directories: ${additional.join(", ")}`,
    )
  }
  if (hasScratch) lines.push(`Session scratch directory: ${options.scratchRoot}`)
  lines.push(FILE_TOOL_ZONE_SENTENCE)
  return lines
}

/**
 * Composition glue: render runtime environment facts passed in each turn as directory-summary text.
 * Use payload.workspaceRoot only when it is an absolute path; if it is relative (such as "." in an older event stream)
 * or missing, fall back to the composition's canonical workspace root. Derive scratch from sessionId
 * so different sessions cannot see one another's scratch directories.
 */
export function buildRuntimeEnvironmentContext(
  environment: { readonly sessionId: string; readonly workspaceRoot?: string; readonly additionalDirectories?: readonly string[] },
  fallbackWorkspaceRoot: string,
): string[] {
  const payloadRoot = environment.workspaceRoot
  const workspaceRoot = payloadRoot !== undefined && isAbsolute(payloadRoot) ? payloadRoot : fallbackWorkspaceRoot
  const scratchRoot = createSessionScratchRoot(environment.sessionId)
  return getRuntimeContext({
    workspaceRoot,
    ...(environment.additionalDirectories === undefined ? {} : { additionalDirectories: environment.additionalDirectories }),
    ...(scratchRoot === undefined ? {} : { scratchRoot }),
  })
}
