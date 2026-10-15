import type { EventTrace } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"

export type TracePhase = "started" | "succeeded" | "failed" | "cancelled"
export type TraceName =
  "session.command" | "plan.provider" | "protocol.adapter" | "execution.model" | "execution.context" | "execution.tool" | "execution.hook"

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
