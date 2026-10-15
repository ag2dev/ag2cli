import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import { materializeSessionAtCursor } from "@ag2cli/core/session/session-fork.js"
import { reduceCanonicalSession, sameHistoryCursor } from "@ag2cli/core/session/canonical-session.js"
import { DEFAULT_SESSION_PERMISSION_MODE, IncompatibleSessionEventError } from "@ag2cli/core/session/session-security.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { AgentEvent, HistoryCursor } from "@ag2cli/core/events/event.js"
import type { EventStore } from "@ag2cli/runtime/ports/event-store.js"
import { SessionAuthority } from "@ag2cli/runtime/application/session/session-authority.js"
import {
  type SessionCatalog,
  type SessionCatalogOptions,
  type SessionCreateOptions,
  type SessionRecord,
} from "@ag2cli/runtime/ports/session-catalog.js"
import { JsonlEventStore, type JsonlEventStoreOptions } from "./jsonl-event-store.js"

/** JSONL-backed catalog whose lifecycle projection is derived only from canonical events. */
export class JsonlSessionCatalog implements SessionCatalog {
  readonly authority: SessionAuthority

  constructor(eventsOrRoot: EventStore | string, authority?: SessionAuthority, options?: JsonlEventStoreOptions) {
    const events = typeof eventsOrRoot === "string" ? new JsonlEventStore(eventsOrRoot, options) : eventsOrRoot
    this.events = events
    this.authority = authority ?? new SessionAuthority(events)
  }

  private readonly events: EventStore

  static fromRoot(root: string, authority?: SessionAuthority, options?: JsonlEventStoreOptions): JsonlSessionCatalog {
    const events = new JsonlEventStore(root, options)
    return new JsonlSessionCatalog(events, authority, options)
  }

  async list(options?: SessionCatalogOptions): Promise<readonly SessionRecord[]> {
    throwIfAborted(options?.signal)
    const ids = await this.events.listSessions()
    const records = await Promise.all(
      ids.map((id) =>
        this.get(id, options).catch((error: unknown) => {
          // One pre-policy file must not blank every listing surface; direct
          // get() keeps reporting the incompatibility.
          if (error instanceof IncompatibleSessionEventError) return undefined
          throw error
        }),
      ),
    )
    const workspace = options?.workspaceRoot === undefined ? undefined : resolve(options.workspaceRoot)
    return records.filter(
      (record): record is SessionRecord =>
        record !== undefined &&
        (workspace === undefined || (record.snapshot.workspaceRoot !== undefined && resolve(record.snapshot.workspaceRoot) === workspace)),
    )
  }

  async get(id: SessionId, options?: SessionCatalogOptions): Promise<SessionRecord | undefined> {
    throwIfAborted(options?.signal)
    const events = await this.events.read(id)
    if (events.length === 0) return undefined
    const state = reduceCanonicalSession(events)
    const snapshot = replaySession(events)
    return {
      sessionId: id,
      ...(state.workspaceId === undefined ? {} : { workspaceId: state.workspaceId }),
      snapshot,
      createdAt: events[0]!.timestamp,
      archived: state.archivedAt !== undefined,
      ...(state.title === undefined ? {} : { title: state.title }),
      ...(state.archivedAt === undefined ? {} : { archivedAt: state.archivedAt }),
    }
  }

  async create(id: SessionId, workspace: string, options?: SessionCreateOptions): Promise<SessionRecord> {
    throwIfAborted(options?.signal)
    if (await this.get(id, options)) throw new Error(`Session already exists: ${id}`)
    const title = normalizeTitle(options?.title)
    const timestamp = new Date().toISOString()
    const createdId = randomUUID()
    const created: Extract<AgentEvent, { type: "SessionCreated" }> = {
      eventId: createdId,
      sessionId: id,
      revision: 1,
      type: "SessionCreated",
      timestamp,
      trace: { traceId: createdId, operationId: createdId },
      payload: {
        workspaceRoot: workspace.trim() || ".",
        ...(options?.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
        permissionMode: DEFAULT_SESSION_PERMISSION_MODE,
        permissionRules: [],
        policyRevision: 0,
        scopeRevision: 0,
      },
    }
    const events: AgentEvent[] = [created]
    if (title !== undefined) {
      const titleId = randomUUID()
      events.push({
        eventId: titleId,
        sessionId: id,
        revision: 2,
        type: "SessionTitleSet",
        timestamp,
        trace: { traceId: createdId, operationId: titleId, causationId: createdId },
        payload: { commandId: `session:title:${id}`, title },
      })
    }
    await this.authority.append(events, `session:create:${id}`)
    return (await this.get(id, options))!
  }

  async fork(sourceId: SessionId, targetId: SessionId, title?: string, options?: SessionCatalogOptions): Promise<SessionRecord> {
    const source = await this.events.read(sourceId)
    if (source.length === 0) throw new Error(`Source Session does not exist: ${sourceId}`)
    const cursor = reduceCanonicalSession(source).activeHead
    if (cursor === undefined) throw new Error(`Source Session is missing an active head: ${sourceId}`)
    return this.forkAtCursor(sourceId, targetId, cursor, title, options)
  }

  async forkAtCursor(
    sourceId: SessionId,
    targetId: SessionId,
    cursor: HistoryCursor,
    title?: string,
    options?: SessionCatalogOptions,
  ): Promise<SessionRecord> {
    return this.forkInternal(sourceId, targetId, cursor, normalizeTitle(title), options)
  }

  private async forkInternal(
    sourceId: SessionId,
    targetId: SessionId,
    cursor: HistoryCursor,
    title: string | undefined,
    options?: SessionCatalogOptions,
  ): Promise<SessionRecord> {
    throwIfAborted(options?.signal)
    const existing = await this.get(targetId, options)
    if (existing !== undefined) {
      const existingEvents = await this.events.read(targetId)
      const completed = existingEvents.find((event) => event.type === "ForkCompleted")
      if (
        completed?.type === "ForkCompleted" &&
        completed.payload.sourceSessionId === sourceId &&
        completed.payload.targetSessionId === targetId &&
        sameHistoryCursor(completed.payload.sourceCursor, cursor)
      ) {
        if (title !== undefined && existing.title !== title) {
          await this.appendTitle(targetId, title, existingEvents.at(-1)!.revision)
          return (await this.get(targetId, options))!
        }
        return existing
      }
      throw new Error(`Target Session already exists: ${targetId}`)
    }
    const source = await this.events.read(sourceId)
    if (source.length === 0) throw new Error(`Source Session does not exist: ${sourceId}`)
    // Forking a pre-policy source must reject before any target file exists.
    replaySession(source)
    const materialized = materializeSessionAtCursor(source, targetId, cursor, randomUUID)
    await this.authority.append(materialized.events, `fork:${targetId}:${sourceId}:${cursor.nodeId}:${cursor.physicalRevision}`)
    if (title !== undefined) {
      const targetEvents = await this.events.read(targetId)
      await this.appendTitle(targetId, title, targetEvents.at(-1)!.revision)
    }
    return (await this.get(targetId, options))!
  }

  async archive(id: SessionId, options?: SessionCatalogOptions): Promise<SessionRecord> {
    throwIfAborted(options?.signal)
    const current = await this.get(id, options)
    if (!current) throw new Error(`Session does not exist: ${id}`)
    if (current.archived) return current
    const timestamp = new Date().toISOString()
    const eventId = randomUUID()
    await this.authority.append(
      [
        {
          eventId,
          sessionId: id,
          revision: current.snapshot.lastRevision + 1,
          type: "SessionArchived",
          timestamp,
          trace: { traceId: eventId, operationId: eventId },
          payload: { commandId: `session:archive:${id}`, archivedAt: timestamp },
        },
      ],
      `session:archive:${id}`,
    )
    return (await this.get(id, options))!
  }

  async delete(id: SessionId, options?: SessionCatalogOptions): Promise<void> {
    throwIfAborted(options?.signal)
    if (!(await this.get(id, options))) throw new Error(`Session does not exist: ${id}`)
    await this.authority.deleteSession(id)
  }

  private async appendTitle(id: SessionId, title: string, revision: number): Promise<void> {
    const eventId = randomUUID()
    await this.authority.append(
      [
        {
          eventId,
          sessionId: id,
          revision: revision + 1,
          type: "SessionTitleSet",
          timestamp: new Date().toISOString(),
          trace: { traceId: eventId, operationId: eventId },
          payload: { commandId: `session:title:${id}`, title },
        },
      ],
      `session:title:${id}`,
    )
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException("session catalog cancelled", "AbortError")
}

function normalizeTitle(value: string | undefined): string | undefined {
  const title = value?.trim()
  if (title && title.length > 160) throw new Error("Session title must not exceed 160 characters")
  return title || undefined
}
