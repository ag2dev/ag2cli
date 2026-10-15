import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { DEFAULT_EVENT_ROOT } from "../../config/runtime.js"

/**
 * Storage identities are deliberately separate from permission identities.
 * `computeWorkspaceScopeDigest` may include additional directories; changing
 * those directories must not make a local Session disappear from `/resume`.
 */
export interface LocalStorageResolution {
  readonly workspaceRoot: string
  readonly root: string
  readonly workspaceStorageDigest: string
}

export type LocalStorageMode = "local-tui" | "local-run"

export interface ServeStorageResolution {
  readonly root: string
  readonly workspaceRoot?: string
}

export function canonicalWorkspaceRoot(value: string): string {
  const resolved = resolve(value)
  try {
    return realpathSync(resolved)
  } catch {
    throw new Error(`workspace does not exist or is inaccessible: ${resolved}`)
  }
}

export function workspaceStorageDigest(workspaceRoot: string): string {
  const canonical = canonicalWorkspaceRoot(workspaceRoot)
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, workspaceRoot: canonical }), "utf8")
    .digest("hex")
}

/** Stable wire identity for a registered workspace. Serve persists this value in catalog metadata. */
/** Resolve the local history root for one local runtime mode. */
export function resolveLocalStorage(options: {
  readonly workspaceRoot: string
  readonly configuredRoot?: string
  readonly explicitRoot?: boolean
  readonly mode?: LocalStorageMode
}): LocalStorageResolution {
  const workspaceRoot = canonicalWorkspaceRoot(options.workspaceRoot)
  const configuredRoot = options.configuredRoot?.trim() || DEFAULT_EVENT_ROOT
  const base = isAbsolute(configuredRoot) ? configuredRoot : resolve(workspaceRoot, configuredRoot)
  // The default project-local root is intentionally kept readable and stable.
  // Explicit global roots are namespaced so two projects cannot share a flat
  // Session-id filename.
  const baseRoot =
    options.explicitRoot && isAbsolute(configuredRoot) ? resolve(base, "local", "workspaces", workspaceStorageDigest(workspaceRoot)) : base
  const root = options.mode === undefined ? baseRoot : resolve(baseRoot, "modes", options.mode)
  return { workspaceRoot, root, workspaceStorageDigest: workspaceStorageDigest(workspaceRoot) }
}

/** Resolve serve storage independently from the process cwd/workspace. */
export function resolveServeStorage(options: {
  readonly serverRoot: string
  readonly workspaceId?: string
  readonly workspaceRoot?: string
}): ServeStorageResolution {
  const root = resolve(options.serverRoot)
  return {
    root: options.workspaceId === undefined ? root : resolve(root, "workspaces", options.workspaceId),
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: canonicalWorkspaceRoot(options.workspaceRoot) }),
  }
}
