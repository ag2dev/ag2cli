import type { AgentEvent } from "@ag2cli/core/events/event.js"
import { sessionId as makeSessionId, type SessionId } from "@ag2cli/core/ids.js"
import {
  EventStoreWriterConflictError,
  EventStoreWriterFenceError,
  type EventStore,
  type EventStoreWriter,
} from "@ag2cli/runtime/ports/event-store.js"

/** Deterministic EventStore for unit tests and in-process clients. */
export class MemoryEventStore implements EventStore {
  private readonly events = new Map<string, AgentEvent[]>()
  private readonly epochs = new Map<string, number>()
  private readonly writers = new Map<string, EventStoreWriter>()

  constructor(initialEvents: readonly AgentEvent[] = []) {
    for (const event of initialEvents) {
      const key = String(event.sessionId)
      const current = this.events.get(key) ?? []
      current.push(event)
      this.events.set(key, current)
      this.epochs.set(key, Math.max(this.epochs.get(key) ?? 0, event.writerEpoch ?? 0))
    }
  }

  async acquireWriter(sessionId: SessionId, ownerId: string): Promise<EventStoreWriter> {
    const key = String(sessionId)
    if (this.writers.has(key)) throw new EventStoreWriterConflictError(sessionId)
    const writerEpoch = (this.epochs.get(key) ?? 0) + 1
    const writer = { sessionId, writerEpoch, ownerNonce: `${ownerId}:${writerEpoch}` }
    this.epochs.set(key, writerEpoch)
    this.writers.set(key, writer)
    return writer
  }

  async releaseWriter(writer: EventStoreWriter): Promise<void> {
    const current = this.writers.get(String(writer.sessionId))
    if (current?.ownerNonce === writer.ownerNonce && current.writerEpoch === writer.writerEpoch) {
      this.writers.delete(String(writer.sessionId))
    }
  }

  async confirmDurable(sessionId: SessionId, writer: EventStoreWriter): Promise<void> {
    if (writer.sessionId !== sessionId) throw new Error("EventStore durability scope mismatch")
    this.assertWriter(writer)
  }

  async appendIfRevision(
    sessionId: SessionId,
    expectedRevision: number,
    events: readonly AgentEvent[],
    writer: EventStoreWriter,
  ): Promise<boolean> {
    this.assertWriterScope(sessionId, writer)
    if (events.some((event) => event.sessionId !== sessionId)) {
      throw new Error("A single append may write to only one Session")
    }
    this.assertWriter(writer)
    const current = this.events.get(sessionId) ?? []
    if ((current.at(-1)?.revision ?? 0) !== expectedRevision) return false
    const next = [...current]
    for (const event of events) {
      const expected = (next.at(-1)?.revision ?? 0) + 1
      if (event.revision !== expected) throw new Error(`Session revision conflict: expected ${expected}, got ${event.revision}`)
      if (next.some((item) => item.eventId === event.eventId)) throw new Error(`Duplicate eventId: ${event.eventId}`)
      next.push(event)
    }
    this.events.set(String(sessionId), next)
    return true
  }

  async read(sessionId: SessionId): Promise<AgentEvent[]> {
    return [...(this.events.get(sessionId) ?? [])]
  }

  async readSince(sessionId: SessionId, revision: number): Promise<AgentEvent[]> {
    return (await this.read(sessionId)).filter((event) => event.revision > revision)
  }

  async listSessions(): Promise<readonly SessionId[]> {
    return [...this.events.keys()].map(makeSessionId)
  }

  async delete(sessionId: SessionId, writer: EventStoreWriter): Promise<void> {
    this.assertWriterScope(sessionId, writer)
    this.assertWriter(writer)
    this.events.delete(String(sessionId))
  }

  private assertWriterScope(sessionId: SessionId, writer: EventStoreWriter): void {
    if (writer.sessionId !== sessionId) throw new Error("EventStore writer scope mismatch")
  }

  private assertWriter(writer: EventStoreWriter): void {
    const current = this.writers.get(String(writer.sessionId))
    if (current === undefined || current.ownerNonce !== writer.ownerNonce || current.writerEpoch !== writer.writerEpoch) {
      throw new EventStoreWriterFenceError(writer.sessionId, writer.writerEpoch)
    }
  }
}
