import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { ObservabilityPolicy } from "@ag2cli/runtime/ports/observability.js"
import { redactForExport, serializedByteLength } from "@ag2cli/runtime/ports/observability.js"
import type { TelemetryAttribute, TelemetryRecord, TelemetrySink } from "@ag2cli/runtime/ports/telemetry.js"
import { TELEMETRY_SCHEMA_VERSION } from "@ag2cli/runtime/ports/telemetry.js"

/** Project one canonical event into an OTel-compatible, redacted log envelope. */
export function projectEventToTelemetry(event: AgentEvent, policy: ObservabilityPolicy): TelemetryRecord {
  const attributes: Record<string, TelemetryAttribute> = {
    "session.id": event.sessionId,
    "event.id": event.eventId,
    "event.revision": event.revision,
    "event.type": event.type,
    "trace.id": event.trace.traceId,
    "operation.id": event.trace.operationId,
    ...(event.trace.causationId ? { "causation.id": event.trace.causationId } : {}),
  }
  const payload: unknown = event.payload
  if (isRecord(payload)) {
    if (typeof payload.runId === "string") attributes["run.id"] = payload.runId
    if (typeof payload.turn === "number") attributes["run.turn"] = payload.turn
    if (typeof payload.callId === "string") attributes["model.call.id"] = payload.callId
    if (typeof payload.purpose === "string") attributes["model.call.purpose"] = payload.purpose
    if (event.type === "ModelRetryScheduled") {
      if (typeof payload.category === "string") attributes["model.retry.category"] = payload.category
      if (typeof payload.attempt === "number") attributes["model.retry.attempt"] = payload.attempt
      if (typeof payload.delayMs === "number") attributes["model.retry.delay_ms"] = payload.delayMs
    }
    if (typeof payload.status === "string" && (event.type === "ModelAttemptStarted" || event.type === "ModelResponseCommitted")) {
      attributes["model.call.status"] = event.type === "ModelAttemptStarted" ? "started" : "succeeded"
    }
    const metadata = isRecord(payload.metadata) ? payload.metadata : undefined
    if (metadata && typeof metadata.protocol === "string") attributes["model.protocol"] = metadata.protocol
    if (metadata && typeof metadata.model === "string") attributes["model.name"] = metadata.model
  }

  const exported = redactForExport(event)
  const body =
    serializedByteLength(exported) <= policy.maxPayloadBytes
      ? exported
      : {
          truncated: true,
          originalByteLength: serializedByteLength(exported),
          eventType: event.type,
        }
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    channel: "ledger",
    name: "ag2cli.event",
    severity: eventSeverity(event),
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    trace: event.trace,
    attributes,
    body,
  }
}

/** Best-effort export: a telemetry backend cannot fail a durable operation. */
export function emitEventsToTelemetry(sink: TelemetrySink | undefined, policy: ObservabilityPolicy, events: readonly AgentEvent[]): void {
  if (!sink || !policy.exportTelemetry) return
  for (const event of events) {
    try {
      sink.emit(projectEventToTelemetry(event, policy))
    } catch {
      // Observability is explicitly non-authoritative.
    }
  }
}

function eventSeverity(event: AgentEvent): TelemetryRecord["severity"] {
  if (event.type === "PlanGenerationFailed" || event.type === "RunFailed") return "error"
  if (event.type === "ToolApprovalRequested") return "warn"
  if (event.type === "ModelAttemptStarted") return "debug"
  if (event.type === "ModelRetryScheduled") return "warn"
  return "info"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
