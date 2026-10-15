import type { SessionId } from "@ag2cli/core/ids.js"
import { sanitizeTraceRecord, type TraceRecord, type TraceStore } from "@ag2cli/runtime/ports/trace-sink.js"

/** Deterministic trace collector for tests and local diagnostics. */
export class MemoryTraceSink implements TraceStore {
  readonly records: TraceRecord[] = []

  record(record: TraceRecord): void {
    this.records.push(sanitizeTraceRecord(record))
  }

  read(sessionId: SessionId): readonly TraceRecord[] {
    return this.records.filter((record) => record.sessionId === sessionId)
  }
}
