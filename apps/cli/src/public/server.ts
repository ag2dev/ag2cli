/** Public composition entrypoints for local agent servers. */
export { buildPlanServer } from "../composition/plan-server.js"
export type { BuildPlanServerOptions } from "../composition/plan-server.js"
export type { SessionServerDependencies } from "../interfaces/transport/in-process-session-server.js"
export type { SessionCatalog, SessionCatalogOptions, SessionRecord } from "@ag2cli/runtime/ports/session-catalog.js"
export type { SessionSnapshotStore, StoredSessionSnapshot } from "@ag2cli/runtime/ports/session-snapshot-store.js"
export type { TraceName, TracePhase, TraceRecord, TraceSink, TraceStore } from "@ag2cli/runtime/ports/trace-sink.js"
export type {
  TelemetryAttribute,
  TelemetryRecord,
  TelemetrySeverity,
  TelemetrySink,
  TelemetryStore,
} from "@ag2cli/runtime/ports/telemetry.js"
export { OtelTelemetrySink } from "../infrastructure/observability/telemetry/otel-telemetry-sink.js"
export type { OtelSpanLike, OtelTracerLike } from "../infrastructure/observability/telemetry/otel-telemetry-sink.js"
