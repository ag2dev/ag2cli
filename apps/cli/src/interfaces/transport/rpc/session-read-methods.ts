import { type JsonValue } from "@ag2cli/app-server-protocol/types.js"
import {
  parseSessionAttachParams,
  parseSessionDetachParams,
  parseSessionGetParams,
  parseSessionListParams,
  parseSessionModelCallsParams,
  parseSessionReplayParams,
  parseSessionResyncParams,
  parseSessionSnapshotParams,
  parseSessionTraceParams,
} from "@ag2cli/app-server-protocol/validation.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import { sessionId } from "@ag2cli/core/ids.js"
import type { SessionRecord } from "@ag2cli/runtime/ports/session-catalog.js"
import { RpcApplicationError } from "./method-context.js"
import { defaultLeases, toJson, type MethodContext, type RpcSubscription } from "./method-context.js"
import { statSync } from "node:fs"
import { resolve } from "node:path"

export class SessionReadMethods {
  constructor(private readonly context: MethodContext) {}

  async listSessions(value: unknown): Promise<readonly SessionRecord[]> {
    this.context.requireScope("session:read")
    const catalog = this.context.requireCatalog()
    const params = parseSessionListParams(value)
    const sessions = await catalog.list()
    return params.includeArchived ? sessions : sessions.filter((session) => !session.archived)
  }

  async getSession(value: unknown): Promise<SessionRecord> {
    this.context.requireScope("session:read")
    const catalog = this.context.requireCatalog()
    const params = parseSessionGetParams(value)
    const record = await catalog.get(sessionId(params.sessionId))
    if (!record || (record.archived && params.includeArchived !== true)) {
      throw new RpcApplicationError("session_not_found", `Session does not exist: ${params.sessionId}`)
    }
    return record
  }

  async attachSession(value: unknown): Promise<JsonValue> {
    this.context.requireScope("session:read")
    const params = parseSessionAttachParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const catalogRecord = this.context.catalog === undefined ? undefined : await this.context.catalog.get(id)
    const snapshot = await this.context.readSnapshot(id)
    if (params.afterRevision !== undefined && params.afterRevision > snapshot.lastRevision) {
      throw new RpcApplicationError(
        "revision_ahead",
        `afterRevision exceeds the current Session revision: ${params.afterRevision} > ${snapshot.lastRevision}`,
      )
    }
    this.context.detachSession(id)
    const durableBuffer: AgentEvent[] = []
    const transientBuffer: TransientStreamEvent[] = []
    let ready = false
    // Attach returns the current authoritative snapshot. `afterRevision` is a
    // recovery guard; live events are delivered only after the subscription
    // barrier below, so clients never apply a second copy of old events.
    let cursor = snapshot.lastRevision
    let installedSubscription: RpcSubscription | undefined
    const subscription: RpcSubscription = {
      unsubscribe: this.context.sessionServer.subscribe(
        id,
        cursor,
        (events) => {
          if (!ready) {
            durableBuffer.push(...events)
            return
          }
          for (const event of events) {
            if (event.revision <= cursor) continue
            cursor = event.revision
            this.context.emit("session.event", { sessionId: id, revision: event.revision, event: toJson(event) })
          }
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
      ),
      unsubscribeTransient:
        params.includeTransient && this.context.sessionServer.subscribeTransient
          ? this.context.sessionServer.subscribeTransient(id, (event) => {
              if (!ready) {
                transientBuffer.push(event)
                return
              }
              this.context.emit("session.transient", { sessionId: id, event: toJson(event) })
            })
          : () => {},
    }
    installedSubscription = subscription
    this.context.subscriptions.set(id.toString(), subscription)
    try {
      const catchup = await this.context.readEvents(id, snapshot.lastRevision)
      const catchupCursor = catchup.at(-1)?.revision ?? snapshot.lastRevision
      cursor = catchupCursor
      ready = true
      for (const event of durableBuffer) {
        if (event.revision <= cursor) continue
        cursor = event.revision
        this.context.emit("session.event", { sessionId: id, revision: event.revision, event: toJson(event) })
      }
      const transientEvents = params.includeTransient
        ? pruneCompletedTransientEvents(mergeTransientEvents(this.context.readTransient?.(id) ?? [], transientBuffer), [
            ...catchup,
            ...durableBuffer,
          ])
        : undefined
      const presenceState = this.context.presenceRegistration?.attach(id.toString())
      return {
        sessionId: id,
        snapshot: toJson(snapshot),
        events: toJson(catchup),
        ...(catalogRecord?.workspaceId === undefined && snapshot.workspaceRoot === undefined
          ? {}
          : {
              workspace: await workspaceDescriptor(this.context, catalogRecord?.workspaceId, snapshot.workspaceRoot),
            }),
        ...(transientEvents === undefined ? {} : { transientEvents: toJson(transientEvents) }),
        presence: toJson({
          sessionId: id,
          clients: presenceState?.presence ?? [],
          leases: presenceState?.leases ?? defaultLeases(),
        }),
      }
    } catch (error) {
      if (this.context.subscriptions.get(id.toString()) === subscription) this.context.detachSession(id)
      throw error
    }
  }

  async detach(value: unknown): Promise<JsonValue> {
    this.context.requireScope("session:read")
    const params = parseSessionDetachParams(value)
    const id = sessionId(params.sessionId)
    const detached = this.context.subscriptions.has(id.toString())
    this.context.detachSession(id)
    return { sessionId: id, detached }
  }

  async snapshot(value: unknown): Promise<JsonValue> {
    this.context.requireScope("session:read")
    const params = parseSessionSnapshotParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    return { sessionId: params.sessionId, snapshot: toJson(await this.context.readSnapshot(id)) }
  }

  async replay(value: unknown): Promise<JsonValue> {
    this.context.requireScope("session:read")
    const params = parseSessionReplayParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const afterRevision = params.afterRevision ?? 0
    const events = await this.context.readEvents(id, afterRevision)
    return {
      sessionId: params.sessionId,
      events: toJson(events),
      nextRevision: events.at(-1)?.revision ?? afterRevision,
      complete: true,
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
    if (result.type !== "trace") throw new RpcApplicationError("invalid_host_result", "Host did not return a trace")
    return { sessionId: id, records: toJson(result.records) }
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
    if (result.type !== "model_calls") throw new RpcApplicationError("invalid_host_result", "Host did not return model_calls")
    return { sessionId: id, records: toJson(result.records) }
  }

  async resync(value: unknown): Promise<JsonValue> {
    this.context.requireScope("session:read")
    const params = parseSessionResyncParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    return { sessionId: id, snapshot: toJson(await this.context.readSnapshot(id)) }
  }
}

function mergeTransientEvents(
  existing: readonly TransientStreamEvent[],
  incoming: readonly TransientStreamEvent[],
): readonly TransientStreamEvent[] {
  const byId = new Map<string, TransientStreamEvent>()
  for (const event of existing) byId.set(event.eventId, event)
  for (const event of incoming) byId.set(event.eventId, event)
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence).slice(-512)
}

function pruneCompletedTransientEvents(
  transientEvents: readonly TransientStreamEvent[],
  durableEvents: readonly AgentEvent[],
): readonly TransientStreamEvent[] {
  const completedRuns = new Set(
    durableEvents.flatMap((event) =>
      event.type === "RunCompleted" || event.type === "RunFailed" || event.type === "RunCancelled" ? [event.payload.runId.toString()] : [],
    ),
  )
  // Run-scoped kinds clear with their run.
  return transientEvents.filter((event) => !("runId" in event.payload && completedRuns.has(event.payload.runId.toString())))
}

async function workspaceDescriptor(
  context: MethodContext,
  workspaceId: string | undefined,
  snapshotRoot: string | undefined,
): Promise<JsonValue> {
  if (context.workspaceRegistry !== undefined) {
    if (workspaceId === undefined) throw new RpcApplicationError("workspace_access_denied", "Session is missing workspaceId")
    const workspace = await context.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new RpcApplicationError("workspace_access_denied", `workspaceId does not exist: ${workspaceId}`)
    return {
      workspaceId: workspace.workspaceId,
      workspaceRoot: workspace.workspaceRoot,
      availability: isDirectory(workspace.workspaceRoot) ? "available" : "unavailable",
    }
  }
  if (snapshotRoot === undefined) throw new RpcApplicationError("workspace_access_denied", "Session is missing the workspace root")
  return {
    workspaceId: workspaceId ?? context.workspaceIdForRoot(snapshotRoot),
    workspaceRoot: resolve(snapshotRoot),
    availability: isDirectory(snapshotRoot) ? "available" : "unavailable",
  }
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}
