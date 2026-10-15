/**
 * Observability policy port: mode parsing, payload limits, and export redaction.
 *
 * Canonical observability facts (requests, usage, and call records) are in
 * domain/model/observation. This module contains only policy contracts and pure
 * functions; collection is implemented in adapters/telemetry.
 */

import type { ModelCallObservation, ObservabilityMode, TelemetryMode } from "@ag2cli/core/model/observation.js"

export const OBSERVABILITY_SCHEMA_VERSION = 1 as const

export interface ObservabilityPolicy {
  readonly mode: ObservabilityMode
  readonly telemetry: TelemetryMode
  readonly captureModelPayload: boolean
  readonly exportTelemetry: boolean
  readonly maxPayloadBytes: number
}

export interface ObservabilityPolicyInput {
  readonly mode?: ObservabilityMode
  readonly telemetry?: TelemetryMode
  readonly maxPayloadBytes?: number
}

/** Error carrying a complete local model-call observation for a failed adapter call. */
export class ModelCallObservationError extends Error {
  constructor(
    message: string,
    readonly observation: ModelCallObservation,
  ) {
    super(message)
    this.name = "ModelCallObservationError"
  }
}

const DEFAULT_MAX_PAYLOAD_BYTES = 512_000
const MIN_MAX_PAYLOAD_BYTES = 4_096
const MAX_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024

/** Load local observability policy without reading provider credentials. */
export function loadObservabilityPolicy(env: Readonly<Record<string, string | undefined>> = {}): ObservabilityPolicy {
  return createObservabilityPolicy({
    mode: parseObservabilityMode(env.AG2CLI_OBSERVABILITY),
    telemetry: parseTelemetryMode(env.AG2CLI_TELEMETRY),
    maxPayloadBytes: parseMaxPayloadBytes(env.AG2CLI_OBSERVABILITY_MAX_BYTES),
  })
}

export function createObservabilityPolicy(input: ObservabilityPolicyInput = {}): ObservabilityPolicy {
  const mode = input.mode ?? "metadata"
  const telemetry = input.telemetry ?? "disabled"
  const maxPayloadBytes = input.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES
  return {
    mode,
    telemetry,
    captureModelPayload: mode === "local-full",
    exportTelemetry: telemetry === "redacted",
    maxPayloadBytes,
  }
}

export function parseObservabilityMode(value: unknown): ObservabilityMode {
  if (value === undefined || value === "") return "metadata"
  if (value === "disabled" || value === "metadata" || value === "local-full") return value
  throw new Error(`AG2CLI_OBSERVABILITY does not support: ${String(value)}`)
}

export function parseTelemetryMode(value: unknown): TelemetryMode {
  if (value === undefined || value === "") return "disabled"
  if (value === "disabled" || value === "redacted") return value
  throw new Error(`AG2CLI_TELEMETRY does not support: ${String(value)}`)
}

export function parseMaxPayloadBytes(value: unknown): number {
  if (value === undefined || value === "") return DEFAULT_MAX_PAYLOAD_BYTES
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < MIN_MAX_PAYLOAD_BYTES || parsed > MAX_MAX_PAYLOAD_BYTES) {
    throw new Error(`AG2CLI_OBSERVABILITY_MAX_BYTES must be an integer between ${MIN_MAX_PAYLOAD_BYTES} and ${MAX_MAX_PAYLOAD_BYTES}`)
  }
  return parsed
}

const SENSITIVE_FIELD = /^(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|password|secret|cookie|set[-_]?cookie)$/i
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const ENV_SECRET = /\b(?:AG2CLI|ANTHROPIC|OPENAI)_(?:API_)?KEY\s*=\s*[^\s,;]+/g
const API_TOKEN = /\bsk-[A-Za-z0-9_-]{16,}/g

/**
 * Redact an outbound copy. The canonical local event must never be passed here
 * and is never mutated by this function.
 */
export function redactForExport(value: unknown): unknown {
  if (typeof value === "string") return redactString(value)
  if (Array.isArray(value)) return value.map((item) => redactForExport(item))
  if (!value || typeof value !== "object") return value

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_FIELD.test(key) ? "[REDACTED]" : redactForExport(item)
  }
  return output
}

export function redactString(value: string): string {
  return value
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(ENV_SECRET, (match) => `${match.slice(0, match.indexOf("=") + 1)}[REDACTED]`)
    .replace(API_TOKEN, "[REDACTED]")
}

export function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
