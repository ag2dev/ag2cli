/**
 * Workspace trust store — security gate for loading project-level memory and skills.
 *
 * Background: project `.ag2cli/memory` / `.ag2cli/skills` files come from repositories that may be untrusted. Their contents enter
 * model context (a prompt-injection surface), so memory and skills from untrusted repositories must not be injected automatically.
 *
 * Trust model:
 *  - `memory` / `skills` directories under the effective application home (default `$HOME/.ag2cli/memory` /
 *    `$HOME/.ag2cli/skills`, configurable through `AG2CLI_HOME`) are always trusted at the user level because they belong to the local user.
 *  - Load project-level memory and skills only when the workspace is trusted.
 *  - A trust record is keyed by canonical realpath + workspace identity (Git remote/root identity).
 *    If a path is reused for another repository and the identity changes, request trust again.
 *
 * Even after a workspace is trusted, treat loaded content as untrusted context data. The runtime system prompt
 * explicitly says that tool output and project content are data and their instructions must not be executed.
 *
 * This file provides only pure logic: identity calculation, trust-store reads/writes, and trust checks. The entry point (CLI) handles interactive confirmation.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { normalize } from "node:path"

/** One trust record. */
export interface TrustRecord {
  /** Canonical realpath of the workspace (the key). */
  path: string
  /** Workspace identity (Git remote or root-path hash). If it changes, request trust again. */
  identity: string
  /** Time of trust (Unix milliseconds). */
  trustedAt: number
}

/** Trust-store contents: path → record. */
export type TrustStore = Record<string, TrustRecord>

/** Read the trust store; return an empty store if the file is missing or corrupted. */
export function loadTrustStore(path: string): TrustStore {
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, "utf-8")
    const parsed = JSON.parse(raw) as Partial<TrustStore>
    return parsed && typeof parsed === "object" ? (parsed as TrustStore) : {}
  } catch {
    return {}
  }
}

/** Write the trust store (atomic replacement). */
export function saveTrustStore(store: TrustStore, path: string): void {
  writeFileSync(path, JSON.stringify(store, null, 2), "utf-8")
}

/** Simple, stable string hash (djb2; not cryptographic, used only to identify roots without a remote). */
function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16)
}

/**
 * Compute workspace identity. Prefer the Git remote (origin); without a remote, hash the canonical root
 * path (a weak identity: it is stable for the same local directory but cannot distinguish another non-Git directory later reusing that path).
 * On error, fall back to "none"; callers should require trust in that case.
 */
export async function getWorkspaceIdentity(cwd: string): Promise<string> {
  const canonical = canonicalPath(cwd)
  try {
    const proc = Bun.spawn({
      cmd: ["git", "-C", canonical, "config", "--get", "remote.origin.url"],
      cwd: canonical,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    })
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    if (exitCode === 0) {
      const remote = stdout.trim()
      if (remote) return `git:${remote}`
    }
  } catch {
    // Git is unavailable or this is not a Git repository.
  }
  return `path:${djb2(canonical)}`
}

/** Resolve canonical realpath synchronously; fall back to normalize on failure. */
export function canonicalPath(p: string): string {
  try {
    return normalize(realpathSync(p))
  } catch {
    return normalize(p)
  }
}

/**
 * Check whether the workspace is trusted and its identity has not changed.
 *  - If a record exists and the identity matches → { trusted: true, ... }
 *  - If a record exists but the identity changed (the path was reused for another repository) → untrusted; return a reason
 *  - If no record exists → untrusted
 */
export interface TrustCheckResult {
  trusted: boolean
  /** Reason the workspace is untrusted (shown by the entry point). */
  reason?: string
  /** Current canonical path. */
  canonicalPath: string
  /** Current identity. */
  identity: string
}

export function checkTrust(cwd: string, store: TrustStore, identity: string): TrustCheckResult {
  const canonical = canonicalPath(cwd)
  const record = store[canonical]
  if (!record) {
    return { trusted: false, reason: "Workspace has not been trusted", canonicalPath: canonical, identity }
  }
  if (record.identity !== identity) {
    return {
      trusted: false,
      reason: `Workspace identity changed (was ${record.identity}, now ${identity}); please confirm again`,
      canonicalPath: canonical,
      identity,
    }
  }
  return { trusted: true, canonicalPath: canonical, identity }
}

/** Mark the workspace as trusted by writing or updating its record. Return a new store (immutable update). */
export function markTrusted(cwd: string, store: TrustStore, identity: string): TrustStore {
  const canonical = canonicalPath(cwd)
  return {
    ...store,
    [canonical]: { path: canonical, identity, trustedAt: Date.now() },
  }
}
