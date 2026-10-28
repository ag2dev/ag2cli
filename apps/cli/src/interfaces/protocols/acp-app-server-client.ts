import type { AppServerRpcClient } from "@ag2cli/app-server-client/client.js"
import { type JsonRpcNotification, type JsonValue, type SessionSubmitResult } from "@ag2cli/app-server-protocol/types.js"
import { asRecord, assertJsonValue, parseNonEmptyString, parseNonNegativeInteger } from "@ag2cli/app-server-protocol/validation.js"

export interface AcpAppServerSnapshot {
  readonly sessionId: string
  readonly asOfRevision: number
}

export interface AcpAppServerEvent {
  readonly eventId: string
  readonly sessionId: string
  readonly revision: number
  readonly type: string
  readonly payload: Record<string, unknown>
}

export interface AcpAppServerSessionClient {
  createSession(sessionId: string, workspaceId: string, signal?: AbortSignal): Promise<void>
  snapshot(sessionId: string, signal?: AbortSignal): Promise<AcpAppServerSnapshot>
  attach(sessionId: string, afterRevision: number, signal?: AbortSignal): Promise<readonly AcpAppServerEvent[]>
  plan(
    sessionId: string,
    commandId: string,
    text: string,
    context: readonly string[],
    workspace: string,
    signal?: AbortSignal,
  ): Promise<JsonValue>
  submit(sessionId: string, commandId: string, text: string, context: readonly string[], signal?: AbortSignal): Promise<SessionSubmitResult>
  resolveToolApproval(
    params: {
      readonly sessionId: string
      readonly interactionId: string
      readonly decision: "approved" | "denied"
      readonly expectedScopeRevision?: number
      readonly expectedPolicyRevision?: number
    },
    signal?: AbortSignal,
  ): Promise<void>
  cancelInput(sessionId: string, inputId: string, signal?: AbortSignal): Promise<void>
  cancelRun(sessionId: string, runId: string, signal?: AbortSignal): Promise<void>
  subscribe(sessionId: string, listener: (event: AcpAppServerEvent) => void): () => void
  dispose(): void
}

/**
 * The ACP edge's only view of a Host. It deliberately exposes protocol DTOs,
 * not the internal SessionClient, SessionServer, event union or command codec.
 */
export function createAcpAppServerSessionClient(rpc: AppServerRpcClient): AcpAppServerSessionClient {
  const listeners = new Map<string, Set<(event: AcpAppServerEvent) => void>>()
  const removeNotification = rpc.onNotification((notification) => dispatchNotification(notification))
  let disposed = false

  return {
    createSession: async (sessionId, workspaceId, signal) => {
      await request(rpc, "session.create", { sessionId, workspaceId }, signal)
    },

    snapshot: async (sessionId, signal) => {
      const result = asRecord(await request(rpc, "session.snapshot", { sessionId }, signal), "session.snapshot.result")
      const snapshot = asRecord(result.snapshot, "session.snapshot.result.snapshot")
      assertSessionId(snapshot, sessionId, "session.snapshot.result.snapshot")
      return {
        sessionId,
        asOfRevision: parseNonNegativeInteger(snapshot.asOfRevision, "session.snapshot.result.snapshot.asOfRevision"),
      }
    },

    attach: async (sessionId, afterRevision, signal) => {
      // v1 attach carries no cursor: it subscribes and returns the barrier.
      // The catch-up itself rides session.replay pages from the caller's baseline.
      const attached = asRecord(await request(rpc, "session.attach", { sessionId }, signal), "session.attach.result")
      const snapshot = asRecord(attached.snapshot, "session.attach.result.snapshot")
      assertSessionId(snapshot, sessionId, "session.attach.result.snapshot")
      const barrierRevision = parseNonNegativeInteger(attached.barrierRevision, "session.attach.result.barrierRevision")
      if (afterRevision >= barrierRevision) return []
      const events: AcpAppServerEvent[] = []
      for (;;) {
        const page = asRecord(await request(rpc, "session.replay", { sessionId, afterRevision }, signal), "session.replay.result")
        const listed = page.events
        if (!Array.isArray(listed)) throw new Error("session.replay.result.events must be an array")
        listed.forEach((event, index) => {
          const parsed = parseEvent(event, `session.replay.result.events[${index}]`)
          assertSessionId(parsed, sessionId, `session.replay.result.events[${index}]`)
          events.push(parsed)
        })
        if (page.hasMore !== true) break
        const next = parseNonNegativeInteger(page.nextAfterRevision, "session.replay.result.nextAfterRevision")
        // A page that claims more without advancing the cursor would loop forever.
        if (next <= afterRevision) break
        afterRevision = next
      }
      return events
    },

    plan: async (sessionId, commandId, text, context, workspace, signal) => {
      const result = asRecord(
        await request(
          rpc,
          "session.plan",
          {
            sessionId,
            commandId,
            text,
            ...(context.length === 0 ? {} : { context }),
            workspace,
          },
          signal,
        ),
        "session.plan.result",
      )
      assertAccepted(result, sessionId, commandId, "plan")
      if (result.result === undefined) throw new Error("session.plan.result.result is missing")
      return assertJsonValue(result.result, "session.plan.result.result")
    },

    submit: async (sessionId, commandId, text, context, signal) => {
      const result = asRecord(
        await request(
          rpc,
          "session.submit",
          {
            sessionId,
            commandId,
            text,
            ...(context.length === 0 ? {} : { context }),
          },
          signal,
        ),
        "session.submit.result",
      )
      assertAccepted(result, sessionId, commandId, "submit")
      return {
        accepted: true,
        sessionId,
        commandId,
        inputId: parseNonEmptyString(result.inputId, "session.submit.result.inputId"),
        queued: result.queued === true,
      }
    },

    resolveToolApproval: async (params, signal) => {
      const optionId = params.decision === "approved" ? "approve_once" : "deny"
      const result = asRecord(
        await request(
          rpc,
          "session.resolveInteraction",
          {
            sessionId: params.sessionId,
            resolutionId: `acp:${params.interactionId}`,
            kind: "tool_approval",
            interactionId: params.interactionId,
            optionId,
            ...(params.expectedScopeRevision === undefined ? {} : { expectedScopeRevision: params.expectedScopeRevision }),
            ...(params.expectedPolicyRevision === undefined ? {} : { expectedPolicyRevision: params.expectedPolicyRevision }),
          },
          signal,
        ),
        "session.resolveInteraction.result",
      )
      if (parseNonEmptyString(result.interactionId, "session.resolveInteraction.result.interactionId") !== params.interactionId) {
        throw new Error("session.resolveInteraction.result.interactionId does not match the request")
      }
    },

    cancelInput: async (sessionId, inputId, signal) => {
      await request(rpc, "session.cancelInput", { sessionId, inputId }, signal)
    },

    cancelRun: async (sessionId, runId, signal) => {
      await request(rpc, "session.cancelRun", { sessionId, runId }, signal)
    },

    subscribe: (sessionId, listener) => {
      const sessionListeners = listeners.get(sessionId) ?? new Set()
      sessionListeners.add(listener)
      listeners.set(sessionId, sessionListeners)
      return () => {
        sessionListeners.delete(listener)
        if (sessionListeners.size === 0) listeners.delete(sessionId)
      }
    },

    dispose: () => {
      if (disposed) return
      disposed = true
      removeNotification()
      listeners.clear()
    },
  }

  function dispatchNotification(notification: JsonRpcNotification): void {
    try {
      if (notification.method === "session.event") {
        const params = asRecord(notification.params, "session.event.params")
        const event = parseEvent(params.event, "session.event.params.event")
        for (const listener of [...(listeners.get(event.sessionId) ?? [])]) {
          try {
            listener(event)
          } catch {
            // One ACP projection listener must not stop the other listeners.
          }
        }
      }
    } catch {
      // A malformed notification must not break the ACP transport. The next
      // snapshot/replay remains the recovery source of truth.
    }
  }
}

async function request(rpc: AppServerRpcClient, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<JsonValue> {
  return rpc.request(method, assertJsonValue(params, `${method}.params`), signal === undefined ? {} : { signal })
}

function assertAccepted(result: Record<string, unknown>, sessionId: string, commandId: string, name: string): void {
  if (result.accepted !== true) throw new Error(`session.${name}.result.accepted must be true`)
  assertSessionId(result, sessionId, `session.${name}.result`)
  if (parseNonEmptyString(result.commandId, `session.${name}.result.commandId`) !== commandId) {
    throw new Error(`session.${name}.result.commandId does not match the request`)
  }
}

function assertSessionId(record: { readonly sessionId?: unknown }, sessionId: string, name: string): void {
  if (parseNonEmptyString(record.sessionId, `${name}.sessionId`) !== sessionId) {
    throw new Error(`${name}.sessionId does not match the target Session`)
  }
}

const EVENT_ENVELOPE_KEYS = new Set(["eventId", "sessionId", "revision", "type", "timestamp", "criticality"])

/** Parses one public durable event into the ACP adapter's envelope + payload shape. */
function parseEvent(value: unknown, name: string): AcpAppServerEvent {
  const event = asRecord(value, name)
  const payload: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(event)) {
    if (!EVENT_ENVELOPE_KEYS.has(key)) payload[key] = field
  }
  return {
    eventId: parseNonEmptyString(event.eventId, `${name}.eventId`),
    sessionId: parseNonEmptyString(event.sessionId, `${name}.sessionId`),
    revision: parseNonNegativeInteger(event.revision, `${name}.revision`),
    type: parseNonEmptyString(event.type, `${name}.type`),
    payload,
  }
}
