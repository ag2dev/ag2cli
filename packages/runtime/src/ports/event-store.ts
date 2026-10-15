import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"

export interface EventStoreWriter {
  readonly sessionId: SessionId
  readonly writerEpoch: number
  readonly ownerNonce: string
}

export class EventStoreWriterFenceError extends Error {
  readonly code = "event_store_writer_fence_lost"

  constructor(
    readonly sessionId: SessionId,
    readonly writerEpoch: number,
  ) {
    super(`EventStore writer fence lost: ${sessionId} epoch ${writerEpoch}`)
    this.name = "EventStoreWriterFenceError"
  }
}

export class EventStoreWriterConflictError extends Error {
  readonly code = "event_store_writer_conflict"

  constructor(readonly sessionId: SessionId) {
    super(`EventStore writer already active: ${sessionId}`)
    this.name = "EventStoreWriterConflictError"
  }
}

export class EventStoreDurabilityError extends Error {
  readonly code = "event_store_durability_failure"

  constructor(
    readonly sessionId: SessionId,
    readonly writerEpoch: number,
    cause?: unknown,
  ) {
    super(`EventStore durability boundary failed: ${sessionId} epoch ${writerEpoch}`, cause === undefined ? undefined : { cause })
    this.name = "EventStoreDurabilityError"
  }
}

export interface EventStore {
  /** Acquire the persistent scope fence required for every canonical write. */
  acquireWriter(sessionId: SessionId, ownerId: string): Promise<EventStoreWriter>
  /** Release a persistent scope fence without deleting its epoch history. */
  releaseWriter(writer: EventStoreWriter): Promise<void>
  /** Reconfirm the directory/file durability boundary before replaying a prior commit. */
  confirmDurable(sessionId: SessionId, writer: EventStoreWriter): Promise<void>
  /**
   * Append one contiguous batch only when the durable stream is still at
   * `expectedRevision`. A revision mismatch is a normal lost-race result and
   * returns false; malformed input, corruption and I/O failures still reject.
   */
  appendIfRevision(
    sessionId: SessionId,
    expectedRevision: number,
    events: readonly AgentEvent[],
    writer: EventStoreWriter,
  ): Promise<boolean>
  read(sessionId: SessionId): Promise<AgentEvent[]>
  /** Read events strictly after a known revision for client synchronization. */
  readSince(sessionId: SessionId, revision: number): Promise<AgentEvent[]>
  listSessions(): Promise<readonly SessionId[]>
  /** Delete a complete session only while holding its durable writer fence. */
  delete(sessionId: SessionId, writer: EventStoreWriter): Promise<void>
}
