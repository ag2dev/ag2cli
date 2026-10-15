import { resolve } from "node:path"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { HistoryCursor } from "@ag2cli/core/events/event.js"
import {
  SessionIdConflictError,
  type SessionCatalog,
  type SessionCatalogOptions,
  type SessionCreateOptions,
  type SessionRecord,
} from "@ag2cli/runtime/ports/session-catalog.js"
import type { EventStore } from "@ag2cli/runtime/ports/event-store.js"
import { SessionAuthority } from "@ag2cli/runtime/application/session/session-authority.js"
import { JsonlSessionCatalog } from "./jsonl-session-catalog.js"
import { JsonlEventStore } from "./jsonl-event-store.js"
import { emptySessionSnapshot, replaySession } from "@ag2cli/core/session/session-snapshot.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import { resolveServeStorage } from "./storage-resolver.js"
import type { JsonServeWorkspaceRegistry, ServeWorkspaceRegistration } from "./serve-workspace-registry.js"

/**
 * Catalog projection for a multi-workspace serve root.
 *
 * Each workspace has its own event/catalog directory. The registry is the
 * only source of workspace identity; Session snapshots are descriptive data.
 */
export class ServeSessionCatalog implements SessionCatalog {
  private readonly catalogs = new Map<string, JsonlSessionCatalog>()
  private readonly eventStores = new Map<string, JsonlEventStore>()
  private readonly authorities = new Map<string, SessionAuthority>()
  private mutationChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly serverRoot: string,
    private readonly registry: JsonServeWorkspaceRegistry,
  ) {}

  async list(options?: SessionCatalogOptions): Promise<readonly SessionRecord[]> {
    const workspaces = await this.registry.list()
    const records = await Promise.all(
      workspaces.map(async (workspace) => {
        // The registry root, not the Session snapshot root, is the current
        // workspace identity. Never let an old snapshot path hide history
        // after a workspace move.
        const workspaceRecords = await this.catalogFor(workspace).list({ ...options, workspaceRoot: undefined })
        return workspaceRecords.map((record) => ({ ...record, workspaceId: workspace.workspaceId }))
      }),
    )
    return records.flat().sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async get(id: SessionId, options?: SessionCatalogOptions): Promise<SessionRecord | undefined> {
    for (const workspace of await this.registry.list()) {
      const record = await this.catalogFor(workspace).get(id, { ...options, workspaceRoot: undefined })
      if (record !== undefined) return { ...record, workspaceId: workspace.workspaceId }
    }
    return undefined
  }

  async create(id: SessionId, workspaceRoot: string, options?: SessionCreateOptions): Promise<SessionRecord> {
    return this.mutate(async () => {
      const workspaceId = options?.workspaceId
      if (workspaceId === undefined) throw new Error("serve Session must use workspaceId")
      const workspace = await this.registry.get(workspaceId)
      if (workspace === undefined) throw new Error(`workspaceId does not exist: ${workspaceId}`)
      // The wire methods address a Session by sessionId alone. Keep that
      // identity unambiguous across registry namespaces even though each
      // workspace has independent files on disk.
      if (await this.get(id)) throw new SessionIdConflictError(id)
      const expectedRoot = resolve(workspace.workspaceRoot)
      if (resolve(workspaceRoot) !== expectedRoot) throw new Error("Session workspaceRoot must be provided by the workspace registry")
      return this.catalogFor(workspace).create(id, workspace.workspaceRoot, { ...options, workspaceId })
    })
  }

  async fork(source: SessionId, target: SessionId, title?: string, options?: SessionCatalogOptions): Promise<SessionRecord> {
    return this.mutate(async () => {
      const located = await this.locate(source, options)
      if (located === undefined) throw new Error(`Session does not exist: ${source}`)
      if (await this.get(target)) throw new SessionIdConflictError(target)
      const record = await this.catalogFor(located.workspace).fork(source, target, title, options)
      return { ...record, workspaceId: located.workspace.workspaceId }
    })
  }

  async forkAtCursor(
    source: SessionId,
    target: SessionId,
    cursor: HistoryCursor,
    title?: string,
    options?: SessionCatalogOptions,
  ): Promise<SessionRecord> {
    return this.mutate(async () => {
      const located = await this.locate(source, options)
      if (located === undefined) throw new Error(`Session does not exist: ${source}`)
      if (await this.get(target)) throw new SessionIdConflictError(target)
      const record = await this.catalogFor(located.workspace).forkAtCursor(source, target, cursor, title, options)
      return { ...record, workspaceId: located.workspace.workspaceId }
    })
  }

  async archive(id: SessionId, options?: SessionCatalogOptions): Promise<SessionRecord> {
    const located = await this.locate(id, options)
    if (located === undefined) throw new Error(`Session does not exist: ${id}`)
    const record = await this.catalogFor(located.workspace).archive(id, options)
    return { ...record, workspaceId: located.workspace.workspaceId }
  }

  async delete(id: SessionId, options?: SessionCatalogOptions): Promise<void> {
    const located = await this.locate(id, options)
    if (located === undefined) throw new Error(`Session does not exist: ${id}`)
    await this.catalogFor(located.workspace).delete(id, options)
  }

  async workspaceForSession(id: SessionId): Promise<ServeWorkspaceRegistration | undefined> {
    return (await this.locate(id))?.workspace
  }

  async eventStoreForSession(id: SessionId): Promise<EventStore | undefined> {
    const located = await this.locate(id)
    return located === undefined ? undefined : this.eventStoreFor(located.workspace)
  }

  async authorityForSession(id: SessionId): Promise<SessionAuthority | undefined> {
    const located = await this.locate(id)
    return located === undefined ? undefined : this.authorityForWorkspaceRegistration(located.workspace)
  }

  async readEvents(id: SessionId): Promise<readonly AgentEvent[]> {
    const located = await this.locate(id)
    if (located === undefined) return []
    return this.eventStoreFor(located.workspace).read(id)
  }

  async readSnapshot(id: SessionId) {
    const events = await this.readEvents(id)
    return events.length === 0 ? emptySessionSnapshot(id) : replaySession(events)
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(operation)
    this.mutationChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async locate(
    id: SessionId,
    options?: SessionCatalogOptions,
  ): Promise<{ workspace: ServeWorkspaceRegistration; record: SessionRecord } | undefined> {
    for (const workspace of await this.registry.list()) {
      const record = await this.catalogFor(workspace).get(id, { ...options, workspaceRoot: undefined })
      if (record !== undefined) return { workspace, record }
    }
    return undefined
  }

  private catalogFor(workspace: ServeWorkspaceRegistration): JsonlSessionCatalog {
    const existing = this.catalogs.get(workspace.workspaceId)
    if (existing !== undefined) return existing
    const catalog = new JsonlSessionCatalog(this.eventStoreFor(workspace), this.authorityForWorkspaceRegistration(workspace))
    this.catalogs.set(workspace.workspaceId, catalog)
    return catalog
  }

  private eventStoreFor(workspace: ServeWorkspaceRegistration): JsonlEventStore {
    const existing = this.eventStores.get(workspace.workspaceId)
    if (existing !== undefined) return existing
    const root = resolveServeStorage({ serverRoot: this.serverRoot, workspaceId: workspace.workspaceId }).root
    const events = new JsonlEventStore(root, {
      modeScope: "serve",
      scopeId: `serve:${workspace.workspaceId}`,
      workspaceIdentity: workspace.workspaceId,
    })
    this.eventStores.set(workspace.workspaceId, events)
    return events
  }

  authorityForWorkspace(workspaceId: string): SessionAuthority {
    const workspace = { workspaceId } as ServeWorkspaceRegistration
    return this.authorityForWorkspaceRegistration(workspace)
  }

  private authorityForWorkspaceRegistration(workspace: ServeWorkspaceRegistration): SessionAuthority {
    const existing = this.authorities.get(workspace.workspaceId)
    if (existing !== undefined) return existing
    const authority = new SessionAuthority(this.eventStoreFor(workspace))
    this.authorities.set(workspace.workspaceId, authority)
    return authority
  }
}
