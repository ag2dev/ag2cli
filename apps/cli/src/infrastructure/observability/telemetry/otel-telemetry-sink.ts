import type { TelemetryAttribute, TelemetryRecord, TelemetrySink } from "@ag2cli/runtime/ports/telemetry.js"

export interface OtelSpanLike {
  setAttribute(key: string, value: TelemetryAttribute): void
  addEvent?(name: string, attributes?: Readonly<Record<string, TelemetryAttribute>>, timestamp?: number): void
  recordException?(error: Error): void
  end(timestamp?: number): void
}

export interface OtelTracerLike {
  startSpan(
    name: string,
    options?: {
      readonly startTime?: number
      readonly attributes?: Readonly<Record<string, TelemetryAttribute>>
    },
  ): OtelSpanLike
}

/** Optional OTel bridge. It exports bounded metadata and never becomes authoritative. */
export class OtelTelemetrySink implements TelemetrySink {
  constructor(
    private readonly tracer: OtelTracerLike,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  emit(record: TelemetryRecord): void {
    try {
      const timestamp = Date.parse(record.timestamp)
      const span = this.tracer.startSpan(record.name, {
        ...(Number.isFinite(timestamp) ? { startTime: timestamp } : {}),
        attributes: {
          ...record.attributes,
          "telemetry.severity": record.severity,
          "telemetry.channel": record.channel,
        },
      })
      span.addEvent?.(
        "ag2cli.event",
        {
          "event.type": record.attributes["event.type"] ?? record.name,
          "session.id": record.sessionId,
        },
        Number.isFinite(timestamp) ? timestamp : undefined,
      )
      span.end(Number.isFinite(timestamp) ? timestamp : undefined)
    } catch (error) {
      this.onError(error)
    }
  }
}
