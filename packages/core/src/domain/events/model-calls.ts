import type { AgentEvent } from "./event.js"
import type { ModelCallRecord, ModelRetrySummary } from "../model/observation.js"
import type { SessionId } from "../ids.js"

/** Project canonical model events into a safe read model for clients and telemetry. */
export function projectModelCalls(
  sessionId: SessionId,
  events: readonly AgentEvent[],
  options: { readonly includePayload: boolean },
): readonly ModelCallRecord[] {
  const records = new Map<string, ModelCallRecord>()
  const retries = new Map<string, ModelRetrySummary[]>()
  for (const event of events) {
    if (event.type !== "ModelRetryScheduled") continue
    const callId = event.payload.callId ?? `${event.payload.runId}:${event.payload.turn}`
    const values = retries.get(callId) ?? []
    values.push({
      attempt: event.payload.attempt,
      nextAttempt: event.payload.nextAttempt,
      delayMs: event.payload.delayMs,
      category: event.payload.category,
    })
    retries.set(callId, values)
  }
  for (const event of events) {
    if (event.type === "ModelAttemptStarted") {
      const callId = `${event.payload.runId}:${event.payload.turn}`
      records.set(callId, {
        sessionId,
        callId,
        purpose: "execution",
        runId: event.payload.runId,
        turn: event.payload.turn,
        trace: event.trace,
        status: "started",
        startedAt: event.timestamp,
        ...(options.includePayload && event.payload.request !== undefined ? { request: event.payload.request } : {}),
        ...(event.payload.context === undefined ? {} : { context: event.payload.context }),
        ...(retries.get(callId)?.length ? { retries: retries.get(callId) } : {}),
      })
      continue
    }
    if (event.type === "ModelAttemptAbandoned") {
      const callId = `${event.payload.runId}:${event.payload.turn}`
      const previous = records.get(callId)
      records.set(callId, {
        sessionId,
        callId,
        purpose: previous?.purpose ?? "execution",
        runId: event.payload.runId,
        turn: event.payload.turn,
        trace: previous?.trace ?? event.trace,
        status: "failed",
        startedAt: previous?.startedAt ?? event.timestamp,
        completedAt: event.timestamp,
        ...(options.includePayload && previous?.request ? { request: previous.request } : {}),
        ...(previous?.context === undefined ? {} : { context: previous.context }),
        ...(retries.get(callId)?.length ? { retries: retries.get(callId) } : {}),
      })
      continue
    }
    if (event.type === "ModelResponseCommitted") {
      const callId = `${event.payload.runId}:${event.payload.turn}`
      const previous = records.get(callId)
      const metadata = event.payload.metadata
      records.set(callId, {
        sessionId,
        callId,
        purpose: previous?.purpose ?? "execution",
        runId: event.payload.runId,
        turn: event.payload.turn,
        trace: previous?.trace ?? event.trace,
        status: "succeeded",
        startedAt: previous?.startedAt ?? event.timestamp,
        completedAt: event.timestamp,
        ...(event.payload.durationMs === undefined ? {} : { durationMs: event.payload.durationMs }),
        ...(options.includePayload && previous?.request ? { request: previous.request } : {}),
        ...(previous?.context === undefined ? {} : { context: previous.context }),
        ...(retries.get(callId)?.length ? { retries: retries.get(callId) } : {}),
        response: {
          ...(options.includePayload ? { content: event.payload.content } : {}),
          ...(event.payload.stopReason ? { stopReason: event.payload.stopReason } : {}),
          ...(metadata ? { metadata } : {}),
        },
      })
    }
  }
  return [...records.values()]
}
