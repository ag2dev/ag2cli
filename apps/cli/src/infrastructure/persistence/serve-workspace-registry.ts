import { randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { existsSync, realpathSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { OrderedLane } from "@ag2cli/runtime/concurrency/ordered-lane.js"
import { replaceFileAtomically } from "./file-coordination.js"

const REGISTRY_SCHEMA_VERSION = 1 as const
export const SERVE_WORKSPACE_REGISTRY_FILE = "workspaces.json"

export interface ServeWorkspaceRegistration {
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface StoredRegistry {
  readonly schemaVersion: typeof REGISTRY_SCHEMA_VERSION
  readonly workspaces: readonly ServeWorkspaceRegistration[]
}

/**
 * Durable identity registry for serve workspaces.
 *
 * A workspace ID is allocated once and remains the storage/routing identity
 * even when its physical root changes. The registry is intentionally separate
 * from Session events: a deleted root is still a valid history-only entry.
 */
export class JsonServeWorkspaceRegistry {
  readonly path: string
  private state?: StoredRegistry
  private loadPromise?: Promise<StoredRegistry>
  private readonly mutationLane = new OrderedLane<string>()

  constructor(private readonly serverRoot: string) {
    this.path = join(resolve(serverRoot), SERVE_WORKSPACE_REGISTRY_FILE)
  }

  async list(): Promise<readonly ServeWorkspaceRegistration[]> {
    const state = await this.load(true)
    return state.workspaces.map((workspace) => ({ ...workspace }))
  }

  async get(workspaceId: string): Promise<ServeWorkspaceRegistration | undefined> {
    const state = await this.load(true)
    const value = state.workspaces.find((workspace) => workspace.workspaceId === workspaceId)
    return value === undefined ? undefined : { ...value }
  }

  async findByRoot(workspaceRoot: string): Promise<ServeWorkspaceRegistration | undefined> {
    const canonical = canonicalRoot(workspaceRoot)
    const state = await this.load(true)
    const value = state.workspaces.find((workspace) => workspace.workspaceRoot === canonical)
    return value === undefined ? undefined : { ...value }
  }

  /** Register a new root, or update an existing ID after a workspace move. */
  async register(workspaceRoot: string, workspaceId?: string): Promise<ServeWorkspaceRegistration> {
    const root = canonicalRoot(workspaceRoot)
    return this.mutate(async (current) => {
      const now = new Date().toISOString()
      const existing =
        workspaceId === undefined
          ? current.workspaces.find((workspace) => workspace.workspaceRoot === root)
          : current.workspaces.find((workspace) => workspace.workspaceId === workspaceId)
      if (existing !== undefined) {
        if (current.workspaces.some((workspace) => workspace.workspaceId !== existing.workspaceId && workspace.workspaceRoot === root)) {
          throw new Error(`workspaceRoot is already registered: ${root}`)
        }
        const updated = { ...existing, workspaceRoot: root, updatedAt: now }
        const next = replaceWorkspace(current, updated)
        await this.persist(next)
        return { state: next, result: updated }
      }
      const created: ServeWorkspaceRegistration = {
        workspaceId: workspaceId ?? `ws_${randomUUID()}`,
        workspaceRoot: root,
        createdAt: now,
        updatedAt: now,
      }
      if (current.workspaces.some((workspace) => workspace.workspaceId === created.workspaceId)) {
        throw new Error(`workspaceId already exists: ${created.workspaceId}`)
      }
      if (current.workspaces.some((workspace) => workspace.workspaceRoot === root)) {
        throw new Error(`workspaceRoot is already registered: ${root}`)
      }
      const next: StoredRegistry = { schemaVersion: REGISTRY_SCHEMA_VERSION, workspaces: [...current.workspaces, created] }
      await this.persist(next)
      return { state: next, result: created }
    })
  }

  /** Register a missing root only when its ID was already known. */
  async updateRoot(workspaceId: string, workspaceRoot: string): Promise<ServeWorkspaceRegistration> {
    const existing = await this.get(workspaceId)
    if (existing === undefined) throw new Error(`workspaceId does not exist: ${workspaceId}`)
    // A known workspace may temporarily point at a deleted or not-yet-created
    // directory. Keep its stable identity so history-only attach can continue;
    // new registrations still require an existing canonical directory.
    const resolved = resolve(workspaceRoot)
    const root = existsSync(resolved) ? canonicalRoot(resolved) : resolved
    return this.mutate(async (current) => {
      if (current.workspaces.some((workspace) => workspace.workspaceId !== workspaceId && workspace.workspaceRoot === root)) {
        throw new Error(`workspaceRoot is already registered: ${root}`)
      }
      const now = new Date().toISOString()
      const updated = { ...existing, workspaceRoot: root, updatedAt: now }
      const next = replaceWorkspace(current, updated)
      await this.persist(next)
      return { state: next, result: updated }
    })
  }

  private async load(force = false): Promise<StoredRegistry> {
    if (!force && this.state !== undefined) return this.state
    if (this.loadPromise !== undefined) return this.loadPromise
    const pending = (async () => {
      try {
        return parseRegistry(await readFile(this.path, "utf8"), this.path)
      } catch (error) {
        if (isMissing(error)) return emptyRegistry()
        throw error
      }
    })()
    this.loadPromise = pending
    try {
      const loaded = await pending
      this.state = loaded
      return loaded
    } finally {
      if (this.loadPromise === pending) this.loadPromise = undefined
    }
  }

  private mutate<T>(mutation: (current: StoredRegistry) => Promise<{ readonly state: StoredRegistry; readonly result: T }>): Promise<T> {
    return this.mutationLane.run("mutations", async () => {
      const current = await this.load(true)
      const changed = await mutation(current)
      this.state = changed.state
      return changed.result
    })
  }

  private async persist(value: StoredRegistry): Promise<void> {
    await mkdir(resolve(this.serverRoot), { recursive: true, mode: 0o700 })
    await replaceFileAtomically(this.path, `${JSON.stringify(value)}\n`)
  }
}

function canonicalRoot(value: string): string {
  const resolved = resolve(value)
  try {
    const canonical = realpathSync(resolved)
    if (!existsSync(canonical) || !statSync(canonical).isDirectory()) {
      throw new Error(`workspace is not a directory: ${resolved}`)
    }
    return canonical
  } catch {
    // A deleted workspace remains addressable for history-only attach. For a
    // new registration this is rejected so a typo cannot create an identity.
    if (!existsSync(resolved)) throw new Error(`workspace does not exist or is inaccessible: ${resolved}`)
    throw new Error(`workspace does not exist or is inaccessible: ${resolved}`)
  }
}

function replaceWorkspace(state: StoredRegistry, value: ServeWorkspaceRegistration): StoredRegistry {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    workspaces: state.workspaces.map((workspace) => (workspace.workspaceId === value.workspaceId ? value : workspace)),
  }
}

function emptyRegistry(): StoredRegistry {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, workspaces: [] }
}

function parseRegistry(raw: string, path: string): StoredRegistry {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`serve workspace registry is corrupted: ${path}`, { cause: error })
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`serve workspace registry has an invalid structure: ${path}`)
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(record.workspaces)) {
    throw new Error(`serve workspace registry schema is unsupported: ${path}`)
  }
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    workspaces: record.workspaces.map((item, index) => parseWorkspace(item, `${path}#workspaces[${index}]`)),
  }
}

function parseWorkspace(value: unknown, path: string): ServeWorkspaceRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`workspace registry entry is invalid: ${path}`)
  const record = value as Record<string, unknown>
  if (
    typeof record.workspaceId !== "string" ||
    !record.workspaceId.startsWith("ws_") ||
    typeof record.workspaceRoot !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  )
    throw new Error(`workspace registry entry has invalid fields: ${path}`)
  return {
    workspaceId: record.workspaceId,
    workspaceRoot: record.workspaceRoot,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}
