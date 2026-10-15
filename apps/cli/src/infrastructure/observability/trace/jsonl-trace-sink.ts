import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sessionId, type SessionId } from "@ag2cli/core/ids.js"
import {
  isTraceName,
  sanitizeTraceAttributes,
  sanitizeTraceRecord,
  type TraceRecord,
  type TraceStore,
} from "@ag2cli/runtime/ports/trace-sink.js"

function tracePath(root: string, id: SessionId): string {
  return join(root, `${encodeURIComponent(id)}.trace.jsonl`)
}

const TRACE_STORE_SCHEMA_VERSION = 1

type StoredTrace = {
  readonly schemaVersion: typeof TRACE_STORE_SCHEMA_VERSION
  readonly record: TraceRecord
}

/** Append-only diagnostic trace persistence, separate from authoritative events. */
export class JsonlTraceSink implements TraceStore {
  constructor(private readonly root: string) {}

  record(record: TraceRecord): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const stored: StoredTrace = {
      schemaVersion: TRACE_STORE_SCHEMA_VERSION,
      record: sanitizeTraceRecord(record),
    }
    appendFileSync(tracePath(this.root, record.sessionId), `${JSON.stringify(stored)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "a",
    })
  }

  read(id: SessionId): readonly TraceRecord[] {
    let raw: string
    try {
      raw = readFileSync(tracePath(this.root, id), "utf8")
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }

    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => parseTraceLine(line, index, id))
  }
}

function parseTraceLine(line: string, index: number, expectedSessionId: SessionId): TraceRecord {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error(`TraceStore JSONL is corrupted: cannot parse line ${index + 1}`)
  }
  if (!value || typeof value !== "object") throw new Error(`TraceStore JSONL is corrupted: line ${index + 1} has an invalid structure`)
  const stored = value as Record<string, unknown>
  if (stored.schemaVersion !== TRACE_STORE_SCHEMA_VERSION || !stored.record || typeof stored.record !== "object") {
    throw new Error(`TraceStore JSONL is corrupted: line ${index + 1} has an unsupported schema`)
  }
  const record = stored.record as Record<string, unknown>
  if (
    !isTraceName(record.name) ||
    !isTracePhase(record.phase) ||
    typeof record.sessionId !== "string" ||
    sessionId(record.sessionId) !== expectedSessionId ||
    !isEventTrace(record.trace) ||
    typeof record.timestamp !== "string" ||
    (record.durationMs !== undefined &&
      (typeof record.durationMs !== "number" || !Number.isFinite(record.durationMs) || record.durationMs < 0))
  ) {
    throw new Error(`TraceStore JSONL is corrupted: line ${index + 1} has an invalid structure`)
  }
  const attributes = record.attributes
  if (attributes !== undefined && !isTraceAttributes(attributes)) {
    throw new Error(`TraceStore JSONL is corrupted: line ${index + 1} has invalid attributes structure`)
  }
  return sanitizeTraceRecord({
    ...(record as unknown as TraceRecord),
    ...(attributes === undefined
      ? {}
      : { attributes: sanitizeTraceAttributes(attributes as Readonly<Record<string, string | number | boolean>>) }),
  })
}

function isTraceAttributes(value: unknown): value is Readonly<Record<string, string | number | boolean>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).every(
    (item) =>
      (typeof item === "string" && item.length <= 128) || (typeof item === "number" && Number.isFinite(item)) || typeof item === "boolean",
  )
}

function isTracePhase(value: unknown): boolean {
  return value === "started" || value === "succeeded" || value === "failed" || value === "cancelled"
}

function isEventTrace(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const trace = value as Record<string, unknown>
  return typeof trace.traceId === "string" && typeof trace.operationId === "string"
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}
