import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sessionId, type SessionId } from "@ag2cli/core/ids.js"
import {
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryAttribute,
  type TelemetryRecord,
  type TelemetryStore,
} from "@ag2cli/runtime/ports/telemetry.js"

function telemetryPath(root: string, id: SessionId): string {
  return join(root, `${encodeURIComponent(id)}.telemetry.jsonl`)
}

type StoredTelemetry = {
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
  readonly record: TelemetryRecord
}

/** Local opt-in telemetry persistence; it never sends data to a remote service. */
export class JsonlTelemetrySink implements TelemetryStore {
  constructor(private readonly root: string) {}

  emit(record: TelemetryRecord): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const stored: StoredTelemetry = { schemaVersion: TELEMETRY_SCHEMA_VERSION, record }
    appendFileSync(telemetryPath(this.root, record.sessionId), `${JSON.stringify(stored)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "a",
    })
  }

  read(id: SessionId): readonly TelemetryRecord[] {
    let raw: string
    try {
      raw = readFileSync(telemetryPath(this.root, id), "utf8")
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => parseTelemetryLine(line, index, id))
  }
}

function parseTelemetryLine(line: string, index: number, expectedSessionId: SessionId): TelemetryRecord {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error(`TelemetryStore JSONL is corrupted: cannot parse line ${index + 1}`)
  }
  if (!value || typeof value !== "object") throw new Error(`TelemetryStore JSONL is corrupted: line ${index + 1} has an invalid structure`)
  const stored = value as Record<string, unknown>
  if (stored.schemaVersion !== TELEMETRY_SCHEMA_VERSION || !stored.record || typeof stored.record !== "object") {
    throw new Error(`TelemetryStore JSONL is corrupted: line ${index + 1} has an unsupported schema`)
  }
  const record = stored.record as Record<string, unknown>
  const recordSessionId = typeof record.sessionId === "string" ? sessionId(record.sessionId) : undefined
  if (
    record.schemaVersion !== TELEMETRY_SCHEMA_VERSION ||
    record.channel !== "ledger" ||
    typeof record.name !== "string" ||
    !isSeverity(record.severity) ||
    recordSessionId !== expectedSessionId ||
    typeof record.timestamp !== "string" ||
    !isTrace(record.trace) ||
    !isAttributes(record.attributes)
  ) {
    throw new Error(`TelemetryStore JSONL is corrupted: line ${index + 1} has an invalid structure`)
  }
  return record as unknown as TelemetryRecord
}

function isSeverity(value: unknown): boolean {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
}

function isTrace(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const trace = value as Record<string, unknown>
  return typeof trace.traceId === "string" && typeof trace.operationId === "string"
}

function isAttributes(value: unknown): value is Readonly<Record<string, TelemetryAttribute>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).every(
    (item) => typeof item === "string" || (typeof item === "number" && Number.isFinite(item)) || typeof item === "boolean",
  )
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}
