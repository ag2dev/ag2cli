import {
  DEFAULT_INCLUDE_RECENT_MESSAGES,
  DEFAULT_REPLAY_LIMIT,
  DEFAULT_REPLAY_MAX_BYTES,
} from "@ag2cli/app-server-protocol/dto/recovery-methods.js"
import { DEFAULT_MESSAGES_LIMIT } from "@ag2cli/app-server-protocol/dto/write-methods.js"
import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicSessionSnapshot } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type {
  JsonValue,
  SessionAttachResult,
  SessionDetachResult,
  SessionGetResult,
  SessionListResult,
  SessionMessagesResult,
  SessionReplayResult,
  SessionResyncResult,
  SessionSnapshotMethodResult,
} from "@ag2cli/app-server-protocol/types.js"
import {
  parseSessionAttachParams,
  parseSessionDetachParams,
  parseSessionGetParams,
  parseSessionListParams,
  parseSessionMessagesParams,
  parseSessionModelCallsParams,
  parseSessionReplayParams,
  parseSessionResyncParams,
  parseSessionSnapshotParams,
  parseSessionTraceParams,
} from "@ag2cli/app-server-protocol/validation.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import { sessionId, type SessionId } from "@ag2cli/core/ids.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import type { SessionRecord } from "@ag2cli/runtime/ports/session-catalog.js"
import type { MethodContext, RpcSubscription } from "./method-context.js"
import { toPublicSessionSummary } from "./catalog-projection.js"
import {
  assemblePublicSessionSnapshot,
  modelCallsResultFrom,
  publicWorkspaceFor,
  RpcApplicationError,
  traceResultFrom,
} from "../public-session-command-mapping.js"
import { PublicSessionProjector, projectTransientEvent } from "../public-projection.js"

export class SessionReadMethods {
  constructor(private readonly context: MethodContext) {}

  /** Archived sessions stay listed and are marked by `archivedAt`; there is
   * no `includeArchived` toggle and no pagination in v1. */
  async listSessions(value: unknown): Promise<SessionListResult> {
    this.context.requireScope("session:read")
    const catalog = this.context.requireCatalog()
    const params = parseSessionListParams(value)
    const summaries: SessionListResult = []
    for (const record of await catalog.list()) {
      summaries.push(await toPublicSessionSummary(this.context, record))
    }
    const workspaceId = params?.workspaceId
    return workspaceId === undefined ? summaries : summaries.filter((summary) => summary.workspace.workspaceId === workspaceId)
  }

  async getSession(value: unknown): Promise<SessionGetResult> {
    this.context.requireScope("session:read")
    const catalog = this.context.requireCatalog()
    const params = parseSessionGetParams(value)
    const record = await catalog.get(sessionId(params.sessionId))
    if (!record) {
      throw new RpcApplicationError("session_not_found", `Session does not exist: ${params.sessionId}`)
    }
    return { summary: await toPublicSessionSummary(this.context, record) }
  }

  async attachSession(value: unknown): Promise<SessionAttachResult> {
    this.context.requireScope("session:read")
    const params = parseSessionAttachParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const attachment = await this.attachLiveProjection(id, params.includeRecentMessages ?? DEFAULT_INCLUDE_RECENT_MESSAGES)
    this.context.presenceRegistration?.attach(id.toString())
    return { snapshot: attachment.snapshot, barrierRevision: attachment.barrierRevision }
  }

  async detach(value: unknown): Promise<SessionDetachResult> {
    this.context.requireScope("session:read")
    const params = parseSessionDetachParams(value)
    const id = sessionId(params.sessionId)
    const detached = this.context.subscriptions.has(id.toString())
    this.context.detachSession(id)
    return { sessionId: id, detached }
  }

  async snapshot(value: unknown): Promise<SessionSnapshotMethodResult> {
    this.context.requireScope("session:read")
    const params = parseSessionSnapshotParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const internal = await this.context.readSnapshot(id)
    const record = await this.sessionRecord(id, internal, await this.context.readEvents(id, 0))
    return { snapshot: await assemblePublicSessionSnapshot(this.context, record, { recentMessagesLimit: 0 }) }
  }

  /** Deep-history paging over the durable stream: a fresh projection per
   * call, one chronological page per request; the snapshot's bounded
   * recentMessages preview never limits this window. */
  async messages(value: unknown): Promise<SessionMessagesResult> {
    this.context.requireScope("session:read")
    const params = parseSessionMessagesParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const projector = new PublicSessionProjector()
    for (const event of await this.context.readEvents(id, 0)) projector.apply(event)
    return projector.messagePage(params.before, params.limit ?? DEFAULT_MESSAGES_LIMIT)
  }

  async replay(value: unknown): Promise<SessionReplayResult> {
    this.context.requireScope("session:read")
    const params = parseSessionReplayParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const internal = await this.context.readSnapshot(id)
    if (params.afterRevision > internal.lastRevision) {
      throw new RpcApplicationError(
        "revision_ahead",
        `afterRevision exceeds the current Session revision: ${params.afterRevision} > ${internal.lastRevision}`,
      )
    }
    const events = await this.context.readEvents(id, 0)
    // Projection state accumulates across events (inputs, runs, messages),
    // so every page re-projects the stream from the start and only collects
    // public events past afterRevision: a page walk and a one-shot replay
    // always project the same events.
    const projector = new PublicSessionProjector()
    const page: PublicSessionEvent[] = []
    const limit = params.limit ?? DEFAULT_REPLAY_LIMIT
    const maxBytes = params.maxBytes ?? DEFAULT_REPLAY_MAX_BYTES
    let bytes = 0
    let scannedThroughRevision = params.afterRevision
    let hasMore = false
    for (const event of events) {
      const projected = projector.apply(event)
      if (event.revision <= params.afterRevision) continue
      const projectedBytes = projected.reduce((total, entry) => total + JSON.stringify(entry).length, 0)
      // An empty page always includes the next projection so the cursor can
      // never stall on a single oversized event.
      if (page.length > 0 && (page.length + projected.length > limit || bytes + projectedBytes > maxBytes)) {
        hasMore = true
        break
      }
      page.push(...projected)
      bytes += projectedBytes
      scannedThroughRevision = event.revision
    }
    return {
      events: page,
      scannedThroughRevision,
      ...(hasMore ? { nextAfterRevision: scannedThroughRevision } : {}),
      hasMore,
    }
  }

  async trace(value: unknown): Promise<JsonValue> {
    this.context.requireScope("session:read")
    const params = parseSessionTraceParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const result = await this.context.sessionServer.execute(id, {
      protocolVersion: 1,
      type: "read_trace",
    })
    return traceResultFrom(id, result)
  }

  async modelCalls(value: unknown): Promise<JsonValue> {
    this.context.requireScope("session:read")
    const params = parseSessionModelCallsParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const result = await this.context.sessionServer.execute(id, {
      protocolVersion: 1,
      type: "read_model_calls",
      ...(params.includePayload === undefined ? {} : { includePayload: params.includePayload }),
    })
    return modelCallsResultFrom(id, result)
  }

  async resync(value: unknown): Promise<SessionResyncResult> {
    this.context.requireScope("session:read")
    const params = parseSessionResyncParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    // Resync rebuilds the live barrier through the attach path so the
    // authoritative snapshot and the live stream can never disagree.
    const attachment = await this.attachLiveProjection(id, DEFAULT_INCLUDE_RECENT_MESSAGES)
    return { snapshot: attachment.snapshot }
  }

  private async attachLiveProjection(id: SessionId, recentMessagesLimit: number): Promise<LiveAttachment> {
    this.context.detachSession(id)
    const projector = new PublicSessionProjector()
    const durableBuffer: AgentEvent[] = []
    const transientBuffer: TransientStreamEvent[] = []
    let installedSubscription: RpcSubscription | undefined
    let ready = false
    const emitDurable = (events: readonly AgentEvent[]): void => {
      for (const event of events) {
        for (const publicEvent of projector.apply(event, { skipUnmapped: true })) {
          this.context.emit("session.event", { event: publicEvent })
        }
      }
    }
    const durable = this.context.sessionServer.subscribe(
      id,
      0,
      (events) => {
        if (!ready) {
          durableBuffer.push(...events)
          return
        }
        emitDurable(events)
      },
      {
        onOverflow: ({ cursor: overflowCursor }) => {
          if (this.context.subscriptions.get(id.toString()) !== installedSubscription) return
          this.context.detachSession(id)
          this.context.emit("session.resyncRequired", {
            sessionId: id,
            minimumRevision: overflowCursor + 1,
            reason: "queue_overflow",
          })
        },
      },
    )
    const subscription: RpcSubscription = {
      unsubscribe: () => durable.unsubscribe(),
      // Connected sessions always receive the live transient channel; it is a
      // display projection and never part of a recovery result.
      unsubscribeTransient: this.context.sessionServer.subscribeTransient
        ? this.context.sessionServer.subscribeTransient(id, (event) => {
            if (!ready) {
              transientBuffer.push(event)
              return
            }
            this.emitTransientEvent(projector, event)
          })
        : () => {},
    }
    installedSubscription = subscription
    this.context.subscriptions.set(id.toString(), subscription)
    try {
      // The barrier read may only run once the live subscription is
      // registered: a publish landing between the subscribe call and the
      // hub registration reaches no subscriber and is lost for good.
      await durable.installed
      const internal = await this.context.readSnapshot(id)
      const events = await this.context.readEvents(id, 0)
      for (const event of events) projector.apply(event)
      // The projector head after the full replay is the barrier; events
      // appended during the replay drain after it, deduped by revision.
      const barrierRevision = projector.currentRevision
      const record = await this.sessionRecord(id, internal, events)
      const assembled = projector.snapshot(internal, {
        ...(record.title === undefined ? {} : { title: record.title }),
        workspace: await publicWorkspaceFor(this.context, record),
        selectableModes: this.context.selectableModes,
        recentMessagesLimit,
      })
      ready = true
      emitDurable(durableBuffer)
      for (const event of transientBuffer) this.emitTransientEvent(projector, event)
      return { snapshot: { ...assembled, asOfRevision: barrierRevision }, barrierRevision }
    } catch (error) {
      if (this.context.subscriptions.get(id.toString()) === subscription) this.context.detachSession(id)
      throw error
    }
  }

  private emitTransientEvent(projector: PublicSessionProjector, event: TransientStreamEvent): void {
    const publicEvent = projectTransientEvent(event, projector.activeRunId)
    if (publicEvent !== undefined) this.context.emit("session.transient", { event: publicEvent })
  }

  private async sessionRecord(id: SessionId, internal: SessionSnapshot, events: readonly AgentEvent[]): Promise<SessionRecord> {
    const catalog = this.context.catalog
    if (catalog === undefined) return syntheticRecord(id, internal, events)
    const record = await catalog.get(id)
    if (record === undefined) throw new RpcApplicationError("session_not_found", `Session does not exist: ${id}`)
    return record
  }
}

interface LiveAttachment {
  readonly snapshot: PublicSessionSnapshot
  readonly barrierRevision: number
}

/** Hosts without a catalog still serve their live sessions; the fresh snapshot stands in for the record's reducer facts. */
function syntheticRecord(id: SessionId, snapshot: SessionSnapshot, events: readonly AgentEvent[]): SessionRecord {
  return {
    sessionId: id,
    snapshot,
    createdAt: events[0]?.timestamp ?? "1970-01-01T00:00:00.000Z",
    updatedAt: events.at(-1)?.timestamp ?? "1970-01-01T00:00:00.000Z",
    archived: false,
  }
}
