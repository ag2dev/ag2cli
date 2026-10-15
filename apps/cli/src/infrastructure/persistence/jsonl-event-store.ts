import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { sessionId, type SessionId } from "@ag2cli/core/ids.js"
import type { AgentEvent, AgentEventType } from "@ag2cli/core/events/event.js"
import { validateCanonicalSessionContract } from "@ag2cli/core/session/canonical-session.js"
import { validateCanonicalSession } from "@ag2cli/core/session/canonical-invariants.js"
import {
  EventStoreDurabilityError,
  EventStoreWriterConflictError,
  EventStoreWriterFenceError,
  type EventStore,
  type EventStoreWriter,
} from "@ag2cli/runtime/ports/event-store.js"
import { acquireFileLock, readFileLockMetadata, replaceFileAtomically, syncDirectory, type FileLock } from "./file-coordination.js"

const EVENT_TYPES: ReadonlySet<AgentEventType> = new Set([
  "SessionCreated",
  "SessionTitleSet",
  "SessionArchived",
  "CommandAccepted",
  "InputAccepted",
  "InputCancellationRequested",
  "InputConsumed",
  "RunStopRequested",
  "RunRetryRequested",
  "ModelAttemptStarted",
  "ModelAttemptAbandoned",
  "ModelResponseCommitted",
  "ToolAttemptStarted",
  "ToolAttemptAbandoned",
  "ToolResultCommitted",
  "HeadMoved",
  "BranchCreated",
  "ForkRequested",
  "ForkCompleted",
  "ForkRejected",
  "SessionAdditionalDirectoryAdded",
  "SessionPermissionModeSet",
  "SessionPermissionRulesSet",
  "SessionCheckpointCreated",
  "PlanCreated",
  "PlanGenerationFailed",
  "PlanGenerationCancelled",
  "RunStarted",
  "ContextCompacted",
  "SessionContextCompacted",
  "SessionContextWindowSet",
  "SessionContextWindowCleared",
  "SessionAgentSelected",
  "SessionGoalUpdated",
  "ModelRetryScheduled",
  "ToolCallRequested",
  "ToolCallPrepared",
  "ToolApprovalRequested",
  "ToolApprovalResolved",
  "ToolCallExecutionStarted",
  "RunCompleted",
  "RunFailed",
  "RunCancelled",
  "BackgroundTaskCreated",
  "BackgroundTaskStarted",
  "BackgroundTaskOutputAppended",
  "BackgroundTaskCompleted",
  "BackgroundTaskFailed",
  "BackgroundTaskCancelled",
])

const EVENT_STORE_SCHEMA_VERSION = 1
const EVENT_LOCK_OPTIONS = {
  failClosedOnCorruptMetadata: true,
  metadataTrailingNewline: false,
  timeoutError: (path: string) => new Error(`EventStore lock wait timeout: ${path}`),
} as const

export interface JsonlEventStoreOptions {
  readonly scopeId?: string
  readonly modeScope?: "serve" | "local-tui" | "local-run" | "ephemeral"
  readonly workspaceIdentity?: string
}

function eventPath(root: string, id: SessionId): string {
  return join(root, `${encodeURIComponent(id)}.events.jsonl`)
}

function lockPath(root: string, id: SessionId): string {
  return join(root, `${encodeURIComponent(id)}.events.lock`)
}

function epochPath(root: string, id: SessionId): string {
  return join(root, `${encodeURIComponent(id)}.events.epoch`)
}

function writerLeasePath(root: string, id: SessionId): string {
  return join(root, `${encodeURIComponent(id)}.events.writer.json`)
}

type StoredEvent = {
  readonly schemaVersion: typeof EVENT_STORE_SCHEMA_VERSION
  readonly event: AgentEvent
  readonly scopeId?: string
  readonly modeScope?: JsonlEventStoreOptions["modeScope"]
  readonly workspaceIdentity?: string
  readonly transitionId?: string
  readonly writerEpoch: number
  readonly recordHash: string
  readonly previousRecordHash?: string
}

type StoredEventWithoutHash = Omit<StoredEvent, "recordHash">

type ParsedRecords = {
  readonly records: readonly StoredEvent[]
  readonly events: readonly AgentEvent[]
}

type StoredWriterLease = {
  readonly pid: number
  readonly ownerId: string
  readonly ownerNonce: string
  readonly writerEpoch: number
  readonly active: boolean
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.eventId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.revision === "number" &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision > 0 &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.type === "string" &&
    EVENT_TYPES.has(candidate.type as AgentEventType) &&
    isEventTrace(candidate.trace) &&
    "payload" in candidate
  )
}

function isEventTrace(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const trace = value as Record<string, unknown>
  return (
    typeof trace.traceId === "string" &&
    typeof trace.operationId === "string" &&
    (trace.causationId === undefined || typeof trace.causationId === "string")
  )
}

/** Durable canonical Session storage. Every successful write replaces a complete file. */
export class JsonlEventStore implements EventStore {
  private readonly pending = new Map<string, Promise<void>>()

  constructor(
    private readonly root: string,
    private readonly options: JsonlEventStoreOptions = {},
  ) {}

  async acquireWriter(id: SessionId, ownerId: string): Promise<EventStoreWriter> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const lock = await acquireFileLock(lockPath(this.root, id), EVENT_LOCK_OPTIONS)
    try {
      const current = await this.readWriterLease(id)
      if (current?.active && current.ownerNonce !== ownerId && isProcessAlive(current.pid)) {
        throw new EventStoreWriterConflictError(id)
      }
      const writerEpoch = Math.max(current?.writerEpoch ?? 0, await this.readWriterEpoch(id)) + 1
      const ownerNonce = `${ownerId}:${randomUUID()}`
      const lease: StoredWriterLease = { pid: process.pid, ownerId, ownerNonce, writerEpoch, active: true }
      let leaseInstalled = false
      try {
        await replaceFileAtomically(writerLeasePath(this.root, id), JSON.stringify(lease) + "\n")
        leaseInstalled = true
        await replaceFileAtomically(epochPath(this.root, id), JSON.stringify({ writerEpoch }) + "\n")
        return { sessionId: id, writerEpoch, ownerNonce }
      } catch (error) {
        if (leaseInstalled) await this.clearWriterLeaseIfOwned(id, lease).catch(() => {})
        throw new EventStoreDurabilityError(id, writerEpoch, error)
      }
    } finally {
      await lock.release()
    }
  }

  async releaseWriter(writer: EventStoreWriter): Promise<void> {
    const lock = await acquireFileLock(lockPath(this.root, writer.sessionId), EVENT_LOCK_OPTIONS)
    try {
      const current = await this.readWriterLease(writer.sessionId)
      if (current?.ownerNonce !== writer.ownerNonce || current.writerEpoch !== writer.writerEpoch) return
      if (!current.active) {
        await syncDirectory(this.root)
        return
      }
      try {
        await replaceFileAtomically(writerLeasePath(this.root, writer.sessionId), JSON.stringify({ ...current, active: false }) + "\n")
      } catch (error) {
        throw new EventStoreDurabilityError(writer.sessionId, writer.writerEpoch, error)
      }
    } finally {
      await lock.release()
    }
  }

  async confirmDurable(id: SessionId, writer: EventStoreWriter): Promise<void> {
    assertWriterScope(id, writer)
    const previous = this.pending.get(id)
    if (previous) await previous
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const lock = await acquireFileLock(lockPath(this.root, id), EVENT_LOCK_OPTIONS)
    try {
      await assertLockOwner(lockPath(this.root, id), lock.ownerNonce)
      await this.assertWriterLease(id, writer)
      await this.readRecordsNow(id)
      try {
        await syncDirectory(this.root)
      } catch (error) {
        throw new EventStoreDurabilityError(id, writer.writerEpoch, error)
      }
    } finally {
      await lock.release()
    }
  }

  async appendIfRevision(
    id: SessionId,
    expectedRevision: number,
    events: readonly AgentEvent[],
    writer: EventStoreWriter,
  ): Promise<boolean> {
    assertWriterScope(id, writer)
    if (events.some((event) => event.sessionId !== id)) {
      throw new Error("one commit may contain one Session only")
    }
    const previous = this.pending.get(id) ?? Promise.resolve()
    const operation = previous.then(() => this.commitNow(id, expectedRevision, events, writer))
    return this.track(id, operation)
  }

  async read(id: SessionId): Promise<AgentEvent[]> {
    const previous = this.pending.get(id)
    if (previous) await previous
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const lock = await acquireFileLock(lockPath(this.root, id), EVENT_LOCK_OPTIONS)
    try {
      return [...(await this.readRecordsNow(id)).events]
    } finally {
      await lock.release()
    }
  }

  async readSince(id: SessionId, revision: number): Promise<AgentEvent[]> {
    return (await this.read(id)).filter((event) => event.revision > revision)
  }

  async listSessions(): Promise<readonly SessionId[]> {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }
    return names
      .filter((name) => name.endsWith(".events.jsonl"))
      .map((name) => name.slice(0, -".events.jsonl".length))
      .map((value) => {
        try {
          return sessionId(decodeURIComponent(value))
        } catch {
          return undefined
        }
      })
      .filter((value): value is SessionId => value !== undefined)
  }

  async delete(id: SessionId, writer: EventStoreWriter): Promise<void> {
    assertWriterScope(id, writer)
    const previous = this.pending.get(id)
    if (previous) await previous
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const lock = await acquireFileLock(lockPath(this.root, id), EVENT_LOCK_OPTIONS)
    try {
      await assertLockOwner(lockPath(this.root, id), lock.ownerNonce)
      await this.assertWriterLease(id, writer)
      await rm(eventPath(this.root, id), { force: true })
      await rm(epochPath(this.root, id), { force: true })
      await rm(writerLeasePath(this.root, id), { force: true })
      await syncDirectory(this.root)
    } finally {
      await lock.release()
    }
  }

  private async track<T>(id: SessionId, operation: Promise<T>): Promise<T> {
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    )
    this.pending.set(id, tracked)
    try {
      return await operation
    } finally {
      if (this.pending.get(id) === tracked) this.pending.delete(id)
    }
  }

  private async commitNow(
    id: SessionId,
    expectedRevision: number | undefined,
    events: readonly AgentEvent[],
    writer: EventStoreWriter,
  ): Promise<boolean> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const lock = await acquireFileLock(lockPath(this.root, id), EVENT_LOCK_OPTIONS)
    try {
      const current = await this.readRecordsNow(id)
      const currentRevision = current.events.at(-1)?.revision ?? 0
      if (expectedRevision !== undefined && currentRevision !== expectedRevision) return false
      const all = [...current.events, ...events]
      validateEventBatch(current.events, events, id)
      validateCanonicalSession(all)
      validateCanonicalSessionContract(all)
      await this.assertWriterLease(id, writer)
      const writerEpoch = writer.writerEpoch
      await this.replaceCanonicalFile(id, current.records, events, writerEpoch, lock, writer)
      return true
    } finally {
      await lock.release()
    }
  }

  private async replaceCanonicalFile(
    id: SessionId,
    current: readonly StoredEvent[],
    appended: readonly AgentEvent[],
    writerEpoch: number,
    lock: FileLock,
    writer: EventStoreWriter,
  ): Promise<void> {
    let previousRecordHash: string | undefined
    const stored: StoredEvent[] = []
    for (const existing of current) {
      stored.push(existing)
      previousRecordHash = existing.recordHash
    }
    for (const event of appended) {
      const recordWithoutHash: StoredEventWithoutHash = {
        schemaVersion: EVENT_STORE_SCHEMA_VERSION,
        event: stripStoredEventFields(event),
        ...((this.options.scopeId ?? event.scopeId) === undefined ? {} : { scopeId: this.options.scopeId ?? event.scopeId }),
        ...((this.options.modeScope ?? event.modeScope) === undefined ? {} : { modeScope: this.options.modeScope ?? event.modeScope }),
        ...((this.options.workspaceIdentity ?? event.workspaceIdentity) === undefined
          ? {}
          : { workspaceIdentity: this.options.workspaceIdentity ?? event.workspaceIdentity }),
        ...(event.transitionId === undefined ? {} : { transitionId: event.transitionId }),
        writerEpoch,
        ...(previousRecordHash === undefined ? {} : { previousRecordHash }),
      }
      const record: StoredEvent = { ...recordWithoutHash, recordHash: hashRecord(recordWithoutHash) }
      stored.push(record)
      previousRecordHash = record.recordHash
    }
    const target = eventPath(this.root, id)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeDurableFile(temporary, stored.map((record) => JSON.stringify(record)).join("\n") + "\n")
      await assertLockOwner(lockPath(this.root, id), lock.ownerNonce)
      await this.assertWriterLease(id, writer)
      try {
        await rename(temporary, target)
        await syncDirectory(this.root)
      } catch (error) {
        throw new EventStoreDurabilityError(id, writerEpoch, error)
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }

  private async readRecordsNow(id: SessionId): Promise<ParsedRecords> {
    let raw: string
    try {
      raw = await readFile(eventPath(this.root, id), "utf8")
    } catch (error) {
      if (isMissingFile(error)) return { records: [], events: [] }
      throw error
    }
    if (!raw.endsWith("\n")) throw new Error("EventStore JSONL canonical file must end with a newline")
    const lines = raw.split("\n")
    lines.pop()
    const records: StoredEvent[] = []
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) throw new Error(`EventStore JSONL invalid blank line at ${index + 1}`)
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`EventStore JSONL corrupt: line ${index + 1} is not valid JSON`)
      }
      if (!isStoredEvent(value) || value.event.sessionId !== id) {
        throw new Error(`EventStore JSONL corrupt: invalid event record at line ${index + 1}`)
      }
      this.validateStoredIdentity(value)
      records.push(value)
    }
    const events = records.map((record) => hydrateStoredEvent(record))
    validateEventStream(events, id)
    validateRecordChain(records)
    validateCanonicalSession(events)
    validateCanonicalSessionContract(events)
    return { records, events }
  }

  private async readWriterEpoch(id: SessionId): Promise<number> {
    try {
      const value = JSON.parse(await readFile(epochPath(this.root, id), "utf8")) as { readonly writerEpoch?: unknown }
      if (typeof value.writerEpoch !== "number" || !Number.isSafeInteger(value.writerEpoch) || value.writerEpoch < 0) {
        throw new Error(`EventStore writer epoch corrupt: ${id}`)
      }
      return value.writerEpoch
    } catch (error) {
      if (isMissingFile(error)) return 0
      throw error
    }
  }

  private async readWriterLease(id: SessionId): Promise<StoredWriterLease | undefined> {
    try {
      const value = JSON.parse(await readFile(writerLeasePath(this.root, id), "utf8")) as Partial<StoredWriterLease>
      if (
        typeof value.pid !== "number" ||
        typeof value.ownerId !== "string" ||
        typeof value.ownerNonce !== "string" ||
        typeof value.writerEpoch !== "number" ||
        typeof value.active !== "boolean"
      ) {
        throw new Error(`EventStore writer lease corrupt: ${id}`)
      }
      return value as StoredWriterLease
    } catch (error) {
      if (isMissingFile(error)) return undefined
      throw error
    }
  }

  private async assertWriterLease(id: SessionId, writer: EventStoreWriter): Promise<void> {
    const current = await this.readWriterLease(id)
    if (!current?.active || current.ownerNonce !== writer.ownerNonce || current.writerEpoch !== writer.writerEpoch) {
      throw new EventStoreWriterFenceError(id, writer.writerEpoch)
    }
  }

  private async clearWriterLeaseIfOwned(id: SessionId, expected: StoredWriterLease): Promise<void> {
    const current = await this.readWriterLease(id)
    if (current?.ownerNonce !== expected.ownerNonce || current.writerEpoch !== expected.writerEpoch) return
    await rm(writerLeasePath(this.root, id), { force: true })
    await syncDirectory(this.root)
  }

  private validateStoredIdentity(record: StoredEvent): void {
    if (this.options.scopeId !== undefined && record.scopeId !== this.options.scopeId) {
      throw new Error("EventStore scope identity mismatch")
    }
    if (this.options.modeScope !== undefined && record.modeScope !== this.options.modeScope) {
      throw new Error("EventStore mode scope mismatch")
    }
    if (this.options.workspaceIdentity !== undefined && record.workspaceIdentity !== this.options.workspaceIdentity) {
      throw new Error("EventStore workspace identity mismatch")
    }
  }
}

function assertWriterScope(session: SessionId, writer: EventStoreWriter): void {
  if (writer.sessionId !== session) throw new Error("EventStore writer scope mismatch")
}

function isStoredEvent(value: unknown): value is StoredEvent {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.schemaVersion === EVENT_STORE_SCHEMA_VERSION &&
    isAgentEvent(candidate.event) &&
    typeof candidate.writerEpoch === "number" &&
    Number.isSafeInteger(candidate.writerEpoch) &&
    candidate.writerEpoch > 0 &&
    typeof candidate.recordHash === "string" &&
    candidate.recordHash.length > 0 &&
    (candidate.previousRecordHash === undefined || typeof candidate.previousRecordHash === "string")
  )
}

function validateEventBatch(current: readonly AgentEvent[], appended: readonly AgentEvent[], session: SessionId): void {
  let expectedRevision = (current.at(-1)?.revision ?? 0) + 1
  const knownIds = new Set(current.map((event) => event.eventId))
  for (const event of appended) {
    if (event.sessionId !== session) throw new Error("event Session mismatch")
    if (event.revision !== expectedRevision)
      throw new Error(`Session revision conflict: expected ${expectedRevision}, got ${event.revision}`)
    if (knownIds.has(event.eventId)) throw new Error(`duplicate eventId: ${event.eventId}`)
    knownIds.add(event.eventId)
    expectedRevision += 1
  }
}

function validateEventStream(events: readonly AgentEvent[], session: SessionId): void {
  const eventIds = new Set<string>()
  for (const [index, event] of events.entries()) {
    const expectedRevision = index + 1
    if (event.revision !== expectedRevision) {
      throw new Error(`EventStore JSONL corrupt: revision expected ${expectedRevision}, got ${event.revision}`)
    }
    if (event.sessionId !== session) throw new Error("EventStore JSONL corrupt: Session mismatch")
    if (eventIds.has(event.eventId)) throw new Error(`EventStore JSONL corrupt: duplicate eventId ${event.eventId}`)
    eventIds.add(event.eventId)
  }
}

function validateRecordChain(records: readonly StoredEvent[]): void {
  let previous: string | undefined
  for (const [index, record] of records.entries()) {
    if (record.previousRecordHash !== previous) throw new Error(`EventStore record hash chain broken at line ${index + 1}`)
    if (hashRecord(record) !== record.recordHash) {
      throw new Error(`EventStore record hash invalid at line ${index + 1}`)
    }
    previous = record.recordHash
  }
}

function hashRecord(record: StoredEventWithoutHash): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: record.schemaVersion,
        event: stripStoredEventFields(record.event),
        scopeId: record.scopeId ?? null,
        modeScope: record.modeScope ?? null,
        workspaceIdentity: record.workspaceIdentity ?? null,
        transitionId: record.transitionId ?? null,
        writerEpoch: record.writerEpoch,
        previousRecordHash: record.previousRecordHash ?? null,
      }),
      "utf8",
    )
    .digest("hex")
}

function hydrateStoredEvent(record: StoredEvent): AgentEvent {
  const event = record.event
  if (
    (event.scopeId !== undefined && event.scopeId !== record.scopeId) ||
    (event.modeScope !== undefined && event.modeScope !== record.modeScope) ||
    (event.workspaceIdentity !== undefined && event.workspaceIdentity !== record.workspaceIdentity) ||
    (event.transitionId !== undefined && event.transitionId !== record.transitionId) ||
    (event.writerEpoch !== undefined && event.writerEpoch !== record.writerEpoch) ||
    (event.recordHash !== undefined && event.recordHash !== record.recordHash) ||
    (event.previousRecordHash !== undefined && event.previousRecordHash !== record.previousRecordHash)
  ) {
    throw new Error(`EventStore envelope mismatch: ${event.eventId}`)
  }
  return {
    ...event,
    ...(record.scopeId === undefined ? {} : { scopeId: record.scopeId }),
    ...(record.modeScope === undefined ? {} : { modeScope: record.modeScope }),
    ...(record.workspaceIdentity === undefined ? {} : { workspaceIdentity: record.workspaceIdentity }),
    ...(record.transitionId === undefined ? {} : { transitionId: record.transitionId }),
    writerEpoch: record.writerEpoch,
    recordHash: record.recordHash,
    ...(record.previousRecordHash === undefined ? {} : { previousRecordHash: record.previousRecordHash }),
  }
}

function stripStoredEventFields(event: AgentEvent): AgentEvent {
  const {
    scopeId: _scopeId,
    modeScope: _modeScope,
    workspaceIdentity: _workspaceIdentity,
    transitionId: _transitionId,
    writerEpoch: _writerEpoch,
    recordHash: _recordHash,
    previousRecordHash: _previousRecordHash,
    ...base
  } = event
  return base as AgentEvent
}

async function writeDurableFile(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function assertLockOwner(path: string, ownerNonce: string): Promise<void> {
  const metadata = await readFileLockMetadata(path)
  if (metadata.ownerNonce !== ownerNonce) throw new Error("EventStore writer fence lost before rename")
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM")
  }
}

/** Runtime-safe conversion for data read from a transport or file. */
export function parseSessionId(value: string): SessionId {
  return sessionId(value)
}
