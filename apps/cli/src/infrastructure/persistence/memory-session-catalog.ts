import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { SessionId } from "@ag2cli/core/ids.js"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import { materializeSessionAtCursor } from "@ag2cli/core/session/session-fork.js"
import { reduceCanonicalSession, sameHistoryCursor } from "@ag2cli/core/session/canonical-session.js"
import { DEFAULT_SESSION_PERMISSION_MODE, IncompatibleSessionEventError } from "@ag2cli/core/session/session-security.js"
import type { AgentEvent, HistoryCursor } from "@ag2cli/core/events/event.js"
import type { EventStore } from "@ag2cli/runtime/ports/event-store.js"
import { SessionAuthority } from "@ag2cli/runtime/application/session/session-authority.js"
import type { SessionCatalog, SessionCatalogOptions, SessionCreateOptions, SessionRecord } from "@ag2cli/runtime/ports/session-catalog.js"

/** In-memory catalog for deterministic transport and application tests. */
export class MemorySessionCatalog implements SessionCatalog {
  readonly authority: SessionAuthority

  constructor(
    private readonly events: EventStore,
    authority?: SessionAuthority,
  ) {
    this.authority = authority ?? new SessionAuthority(events)
  }

  async list(options?: SessionCatalogOptions): Promise<readonly SessionRecord[]> {
    throwIfAborted(options?.signal)
    const records = await Promise.all(
      (await this.events.listSessions()).map((id) =>
        this.get(id, options).catch((error: unknown) => {
          // One pre-policy session must not blank every listing surface;
          // direct get() keeps reporting the incompatibility.
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
    const workspaceId = state.workspaceId
    return {
      sessionId: id,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      snapshot,
      createdAt: events[0]!.timestamp,
      updatedAt: events.at(-1)!.timestamp,
      ...(state.title === undefined ? {} : { title: state.title }),
      archived: state.archivedAt !== undefined,
      ...(state.archivedAt === undefined ? {} : { archivedAt: state.archivedAt }),
    }
  }

  async create(id: SessionId, workspace: string, options?: SessionCreateOptions): Promise<SessionRecord> {
    throwIfAborted(options?.signal)
    if (await this.get(id, options)) throw new Error(`Session already exists: ${id}`)
    const timestamp = new Date().toISOString()
    const createdId = randomUUID()
    const events: AgentEvent[] = [
      {
        eventId: createdId,
        sessionId: id,
        revision: 1,
        type: "SessionCreated",
        timestamp,
        trace: { traceId: createdId, operationId: createdId },
        payload: {
          workspaceRoot: workspace,
          ...(options?.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
          permissionMode: DEFAULT_SESSION_PERMISSION_MODE,
          permissionRules: [],
          policyRevision: 0,
          scopeRevision: 0,
        },
      },
    ]
    const title = normalizeTitle(options?.title)
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

  async setTitleIfAbsent(id: SessionId, value: string, options?: SessionCatalogOptions): Promise<SessionRecord> {
    throwIfAborted(options?.signal)
    const title = normalizeTitle(value)
    if (title === undefined) throw new Error("Session title must not be empty")
    const record = await this.get(id, options)
    if (record === undefined) throw new Error(`Session does not exist: ${id}`)
    if (record.title !== undefined) return record
    try {
      await this.appendTitle(id, title, record.snapshot.lastRevision)
    } catch (error) {
      const raced = await this.get(id, options)
      if (raced?.title !== undefined) return raced
      throw error
    }
    return (await this.get(id, options))!
  }

  async fork(source: SessionId, target: SessionId, title?: string, options?: SessionCatalogOptions): Promise<SessionRecord> {
    const sourceEvents = await this.events.read(source)
    if (sourceEvents.length === 0) throw new Error(`Source Session does not exist: ${source}`)
    const cursor = reduceCanonicalSession(sourceEvents).activeHead
    if (cursor === undefined) throw new Error(`Source Session is missing an active head: ${source}`)
    return this.forkAtCursor(source, target, cursor, title, options)
  }

  async forkAtCursor(
    source: SessionId,
    target: SessionId,
    cursor: HistoryCursor,
    title?: string,
    options?: SessionCatalogOptions,
  ): Promise<SessionRecord> {
    throwIfAborted(options?.signal)
    const normalized = normalizeTitle(title)
    const existing = await this.get(target, options)
    if (existing !== undefined) {
      const existingEvents = await this.events.read(target)
      const completed = existingEvents.find((event) => event.type === "ForkCompleted")
      // Retry idempotency is payload-symmetric with create: only the exact
      // same (source, cursor, title) replays; a divergent title conflicts
      // instead of mutating the existing target.
      if (
        completed?.type === "ForkCompleted" &&
        completed.payload.sourceSessionId === source &&
        sameHistoryCursor(completed.payload.sourceCursor, cursor) &&
        existing.title === normalized
      ) {
        return existing
      }
      throw new Error(`Target Session already exists: ${target}`)
    }
    const sourceEvents = await this.events.read(source)
    if (sourceEvents.length === 0) throw new Error(`Source Session does not exist: ${source}`)
    // Forking a pre-policy source must reject before any target events exist.
    replaySession(sourceEvents)
    const materialized = materializeSessionAtCursor(sourceEvents, target, cursor, randomUUID)
    await this.authority.append(materialized.events, `fork:${target}:${source}:${cursor.nodeId}:${cursor.physicalRevision}`)
    if (normalized !== undefined) {
      const targetEvents = await this.events.read(target)
      await this.appendTitle(target, normalized, targetEvents.at(-1)!.revision)
    }
    return (await this.get(target, options))!
  }

  async archive(id: SessionId, options?: SessionCatalogOptions): Promise<SessionRecord> {
    throwIfAborted(options?.signal)
    const record = await this.get(id, options)
    if (!record) throw new Error(`Session does not exist: ${id}`)
    if (!record.archived) {
      const timestamp = new Date().toISOString()
      const eventId = randomUUID()
      await this.authority.append(
        [
          {
            eventId,
            sessionId: id,
            revision: record.snapshot.lastRevision + 1,
            type: "SessionArchived",
            timestamp,
            trace: { traceId: eventId, operationId: eventId },
            payload: { commandId: `session:archive:${id}`, archivedAt: timestamp },
          },
        ],
        `session:archive:${id}`,
      )
    }
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
