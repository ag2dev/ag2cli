import type { EventTrace } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"

export type TracePhase = "started" | "succeeded" | "failed" | "cancelled"
export type TraceName =
  "session.command" | "plan.provider" | "protocol.adapter" | "execution.model" | "execution.context" | "execution.tool" | "execution.hook"

/** Diagnostic record for one non-authoritative runtime operation. */
export interface TraceRecord {
  readonly name: TraceName
  readonly phase: TracePhase
  readonly sessionId: SessionId
  readonly trace: EventTrace
  readonly timestamp: string
  readonly durationMs?: number
  readonly attributes?: Readonly<Record<string, string | number | boolean>>
}

const SAFE_STRING_ATTRIBUTE_KEYS = new Set([
  "adapter",
  "commandType",
  "commandRisk",
  "errorCode",
  "eventType",
  "executionMode",
  "executionStatus",
  "exitCode",
  "stage",
  "provider",
  "toolName",
  "hookEvent",
  "hookType",
  "notes",
  "outcome",
])

export function isTraceName(value: unknown): value is TraceName {
  return (
    value === "session.command" ||
    value === "plan.provider" ||
    value === "protocol.adapter" ||
    value === "execution.model" ||
    value === "execution.context" ||
    value === "execution.tool" ||
    value === "execution.hook"
  )
}

/** Keep only explicitly safe diagnostic strings; numeric counters are safe by construction. */
export function sanitizeTraceAttributes(
  attributes: Readonly<Record<string, string | number | boolean>> | undefined,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (!attributes) return undefined
  const safe: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string") {
      if (SAFE_STRING_ATTRIBUTE_KEYS.has(key) && value.length <= 128) safe[key] = value
      continue
    }
    if (typeof value === "number" && Number.isFinite(value)) safe[key] = value
    if (typeof value === "boolean") safe[key] = value
  }
  return Object.keys(safe).length > 0 ? safe : undefined
}

const TOOL_TRACE_METADATA_KEYS = ["commandRisk", "executionMode", "executionStatus", "exitCode"] as const

/**
 * Copy only the bounded, non-content fields a tool explicitly exposes for
 * execution diagnostics. Tool output and arbitrary metadata remain outside
 * the trace side channel.
 */
export function traceAttributesFromToolMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!metadata) return undefined
  const attributes: Record<string, string> = {}
  for (const key of TOOL_TRACE_METADATA_KEYS) {
    const value = metadata[key]
    if (typeof value === "string" && value.length <= 128) attributes[key] = value
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined
}

export function sanitizeTraceRecord(record: TraceRecord): TraceRecord {
  const attributes = sanitizeTraceAttributes(record.attributes)
  return { ...record, ...(attributes === undefined ? {} : { attributes }) }
}

/** Observability boundary; implementations must not change domain outcomes. */
export interface TraceSink {
  record(record: TraceRecord): void
}

export interface TraceStore extends TraceSink {
  read(sessionId: SessionId): readonly TraceRecord[]
}

export const noopTraceSink: TraceSink = {
  record: () => undefined,
}

/**
 * Make diagnostic writes non-authoritative at the port boundary.
 *
 * Trace collection is deliberately best effort: a full disk, malformed
 * exporter, or user-provided test sink must never change a session outcome.
 * Reads remain explicit so a damaged trace store can still be reported to the
 * caller of a diagnostic command instead of being mistaken for an empty trace.
 */
export function safeTraceSink(sink?: TraceSink): TraceSink {
  if (!sink) return noopTraceSink
  return {
    record(record) {
      try {
        sink.record(record)
      } catch {
        // Trace is a diagnostic side channel, never an application outcome.
      }
    },
  }
}

/** Preserve TraceStore reads while isolating all record writes. */
export function safeTraceStore(store?: TraceStore): TraceStore | undefined {
  if (!store) return undefined
  const sink = safeTraceSink(store)
  return {
    record: sink.record,
    read: (sessionId) => store.read(sessionId),
  }
}
