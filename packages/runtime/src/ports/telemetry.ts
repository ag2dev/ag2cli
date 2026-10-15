import type { EventTrace } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"

export const TELEMETRY_SCHEMA_VERSION = 1 as const

export type TelemetrySeverity = "debug" | "info" | "warn" | "error"
export type TelemetryAttribute = string | number | boolean

/** OTel-compatible log-shaped envelope without depending on an OTel SDK. */
export interface TelemetryRecord {
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
  readonly channel: "ledger"
  readonly name: string
  readonly severity: TelemetrySeverity
  readonly sessionId: SessionId
  readonly timestamp: string
  readonly trace: EventTrace
  readonly attributes: Readonly<Record<string, TelemetryAttribute>>
  readonly body?: unknown
}

/** Optional exporter boundary. Implementations must never change the domain outcome. */
export interface TelemetrySink {
  emit(record: TelemetryRecord): void
  flush?(): void | Promise<void>
  shutdown?(): void | Promise<void>
}

export interface TelemetryStore extends TelemetrySink {
  read(sessionId: SessionId): readonly TelemetryRecord[]
}

export const noopTelemetrySink: TelemetrySink = {
  emit: () => undefined,
}
