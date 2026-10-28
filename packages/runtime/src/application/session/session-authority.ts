import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import { validateCanonicalSessionContract } from "@ag2cli/core/session/canonical-session.js"
import { validateCanonicalSession } from "@ag2cli/core/session/canonical-invariants.js"
import {
  EventStoreDurabilityError,
  EventStoreWriterConflictError,
  EventStoreWriterFenceError,
  type EventStore,
  type EventStoreWriter,
} from "../../ports/event-store.js"
import { OrderedLane } from "../../concurrency/ordered-lane.js"
import { SessionRevisionConflictError } from "./revision-conflict.js"

export interface SessionWriter {
  readonly sessionId: SessionId
  readonly writerEpoch: number
  readonly ownerNonce: string
  readonly storeWriter: EventStoreWriter
}

export interface SessionCommitResult {
  readonly sessionId: SessionId
  readonly writerEpoch: number
  readonly transitionId: string
  readonly events: readonly AgentEvent[]
  readonly replayed?: boolean
}

export async function commitSessionEvents(input: {
  readonly authority: SessionAuthority
  readonly events: readonly AgentEvent[]
  readonly expectedRevision?: number
  readonly transitionId?: string
  readonly onCommitted?: (events: readonly AgentEvent[], replayed: boolean) => Promise<void> | void
}): Promise<SessionCommitResult> {
  const result = await input.authority.appendAtRevision(input.events, input.expectedRevision, input.transitionId)
  try {
    // A replay can be the only delivery that ever ran: the original attempt
    // may die after the durable append but before observers execute, so
    // replays must fan out too. Delivery is at-least-once; observers filter
    // duplicates with the replayed flag.
    await input.onCommitted?.(result.events, result.replayed === true)
  } catch {
    // Observers are reconstructable from the canonical store and cannot veto a commit.
  }
  return result
}

export class StaleSessionWriterError extends Error {
  readonly code = "stale_session_writer"

  constructor(
    readonly sessionId: SessionId,
    readonly writerEpoch: number,
  ) {
    super(`Session writer is stale: ${sessionId} epoch ${writerEpoch}`)
    this.name = "StaleSessionWriterError"
  }
}

export class SessionWriterConflictError extends Error {
  readonly code = "reservation_conflict"

  constructor(readonly sessionId: SessionId) {
    super(`Another writer already owns the current Session: ${sessionId}`)
    this.name = "SessionWriterConflictError"
  }
}

export class SessionAuthority {
  private readonly commitLane = new OrderedLane<string>()
  // Bespoke join-and-mirror guard, deliberately not an OrderedLane: the map
  // stores the raw openWriterNow promise, awaiters await-then-recheck the
  // synchronous writers cache, and close() drains it — resolved-value cache
  // semantics a keyed FIFO tail cannot express.
  private readonly opening = new Map<string, Promise<SessionWriter>>()
  private readonly currentEpoch = new Map<string, number>()
  private readonly writers = new Map<string, SessionWriter>()
  private readonly acquiredPendingRelease = new Set<EventStoreWriter>()
  private closed = false
  private closing: Promise<void> | undefined

  constructor(private readonly eventStore: EventStore) {}

  async openWriter(sessionId: SessionId): Promise<SessionWriter> {
    this.assertOpen()
    const key = sessionId.toString()
    const previousOpening = this.opening.get(key)
    if (previousOpening !== undefined) {
      await previousOpening
      const existing = this.writers.get(key)
      if (existing !== undefined) return existing
    }
    const existing = this.writers.get(key)
    if (existing !== undefined) return existing
    const operation = this.openWriterNow(sessionId)
    this.opening.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.opening.get(key) === operation) this.opening.delete(key)
    }
  }

  async append(events: readonly AgentEvent[], transitionId = defaultTransitionId(events)): Promise<SessionCommitResult> {
    return this.appendAtRevision(events, undefined, transitionId)
  }

  async appendAtRevision(
    events: readonly AgentEvent[],
    expectedRevision: number | undefined,
    transitionId = defaultTransitionId(events),
  ): Promise<SessionCommitResult> {
    this.assertOpen()
    if (events.length === 0) throw new Error("Session authority cannot commit an empty event batch")
    const sessionId = events[0]!.sessionId
    let writer = this.writers.get(sessionId.toString())
    if (writer === undefined) writer = await this.openWriter(sessionId)
    return this.commit(writer, expectedRevision, transitionId, events)
  }

  async revoke(writer: SessionWriter): Promise<void> {
    if (this.writers.get(writer.sessionId)?.ownerNonce !== writer.ownerNonce) return
    await this.eventStore.releaseWriter(writer.storeWriter)
    if (this.writers.get(writer.sessionId)?.ownerNonce === writer.ownerNonce) this.writers.delete(writer.sessionId)
  }

  async close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closed = true
    const operation = (async () => {
      const opening = await Promise.allSettled([...this.opening.values()])
      const failures = opening.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      await Promise.allSettled(this.commitLane.tails())
      const pendingReleases = await Promise.allSettled([...this.acquiredPendingRelease].map((writer) => this.releaseAcquiredWriter(writer)))
      failures.push(...pendingReleases.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])))
      const releases = await Promise.allSettled([...this.writers.values()].map((writer) => this.revoke(writer)))
      failures.push(...releases.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])))
      const failure = failures[0]
      if (failure !== undefined) throw failure
    })()
    let tracked!: Promise<void>
    tracked = operation.catch((error: unknown) => {
      if (this.closing === tracked) this.closing = undefined
      throw error
    })
    this.closing = tracked
    return tracked
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    this.assertOpen()
    const writer = this.writers.get(sessionId.toString()) ?? (await this.openWriter(sessionId))
    await this.commit(writer, undefined, `delete:${sessionId}:${writer.writerEpoch}`, [])
    await this.eventStore.delete(sessionId, writer.storeWriter)
    await this.revoke(writer)
  }

  async commit(
    writer: SessionWriter,
    expectedRevision: number | undefined,
    transitionId: string,
    events: readonly AgentEvent[],
  ): Promise<SessionCommitResult> {
    if (events.length === 0) {
      return {
        sessionId: writer.sessionId,
        writerEpoch: writer.writerEpoch,
        transitionId,
        events: [],
      }
    }
    if (events.some((event) => event.sessionId !== writer.sessionId)) throw new Error("Session authority scope mismatch")
    return this.commitLane.run(writer.sessionId.toString(), () => this.commitNow(writer, expectedRevision, transitionId, events))
  }

  private async commitNow(
    writer: SessionWriter,
    expectedRevision: number | undefined,
    transitionId: string,
    events: readonly AgentEvent[],
  ): Promise<SessionCommitResult> {
    for (let retry = 0; retry < 3; retry += 1) {
      this.assertCurrentWriter(writer)
      const current = await this.eventStore.read(writer.sessionId)
      const replay = findReplay(current, events, transitionId)
      if (replay !== undefined) {
        await this.eventStore.confirmDurable(writer.sessionId, writer.storeWriter)
        return {
          sessionId: writer.sessionId,
          writerEpoch: writer.writerEpoch,
          transitionId,
          events: replay,
          replayed: true,
        }
      }
      if (expectedRevision !== undefined && current.length !== expectedRevision) {
        throw new SessionRevisionConflictError(writer.sessionId, expectedRevision)
      }
      const baseRevision = current.length
      const stamped = events.map((event, index) => ({
        ...event,
        revision: baseRevision + index + 1,
        transitionId,
        writerEpoch: writer.writerEpoch,
      }))
      const candidate = [...current, ...stamped]
      validateCanonicalSession(candidate)
      validateCanonicalSessionContract(candidate)
      let committed: boolean
      try {
        committed = await this.eventStore.appendIfRevision(writer.sessionId, baseRevision, stamped, writer.storeWriter)
      } catch (error) {
        if (error instanceof EventStoreDurabilityError) throw error
        if (error instanceof EventStoreWriterFenceError) {
          this.invalidateWriter(writer)
          throw new StaleSessionWriterError(writer.sessionId, writer.writerEpoch)
        }
        const afterFailure = await this.eventStore.read(writer.sessionId)
        const replay = findReplay(afterFailure, stamped, transitionId)
        if (replay !== undefined) {
          return {
            sessionId: writer.sessionId,
            writerEpoch: writer.writerEpoch,
            transitionId,
            events: replay,
            replayed: true,
          }
        }
        throw error
      }
      if (committed) {
        return {
          sessionId: writer.sessionId,
          writerEpoch: writer.writerEpoch,
          transitionId,
          events: stamped,
        }
      }
      if (expectedRevision !== undefined) throw new SessionRevisionConflictError(writer.sessionId, expectedRevision)
    }
    throw new SessionRevisionConflictError(writer.sessionId, expectedRevision ?? -1)
  }

  private assertCurrentWriter(writer: SessionWriter): void {
    const current = this.writers.get(writer.sessionId)
    if (current?.ownerNonce !== writer.ownerNonce || current.writerEpoch !== writer.writerEpoch) {
      throw new StaleSessionWriterError(writer.sessionId, writer.writerEpoch)
    }
  }

  private invalidateWriter(writer: SessionWriter): void {
    const current = this.writers.get(writer.sessionId.toString())
    if (current?.ownerNonce === writer.ownerNonce && current.writerEpoch === writer.writerEpoch) {
      this.writers.delete(writer.sessionId.toString())
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Session authority is closed")
  }

  private async openWriterNow(sessionId: SessionId): Promise<SessionWriter> {
    const key = sessionId.toString()
    const previous = this.writers.get(key)
    // A no-op entrant waits for exactly the commits already admitted on this
    // key, so a new epoch's first read cannot overlap a revoked writer's
    // in-flight read/append window.
    if (previous === undefined) await this.commitLane.run(key, async () => undefined)
    if (previous !== undefined) return previous
    const nextEpoch = (this.currentEpoch.get(key) ?? 0) + 1
    const ownerNonce = `${sessionId}:${nextEpoch}:${globalThis.crypto.randomUUID()}`
    let storeWriter: EventStoreWriter
    try {
      storeWriter = await this.eventStore.acquireWriter(sessionId, ownerNonce)
    } catch (error) {
      if (error instanceof EventStoreWriterConflictError) throw new SessionWriterConflictError(sessionId)
      throw error
    }
    this.acquiredPendingRelease.add(storeWriter)
    if (this.closed) {
      await this.releaseAcquiredWriter(storeWriter)
      throw new Error("Session authority is closed")
    }
    const writer: SessionWriter = {
      sessionId,
      writerEpoch: storeWriter.writerEpoch,
      ownerNonce: storeWriter.ownerNonce,
      storeWriter,
    }
    this.currentEpoch.set(key, writer.writerEpoch)
    this.acquiredPendingRelease.delete(storeWriter)
    this.writers.set(key, writer)
    return writer
  }

  private async releaseAcquiredWriter(writer: EventStoreWriter): Promise<void> {
    await this.eventStore.releaseWriter(writer)
    this.acquiredPendingRelease.delete(writer)
  }
}

function defaultTransitionId(events: readonly AgentEvent[]): string {
  const first = events[0]
  if (first === undefined) throw new Error("Session authority cannot derive a transition from an empty batch")
  if (first.transitionId !== undefined) return first.transitionId
  const payload = first.payload as Record<string, unknown>
  const commandEvents = new Set<AgentEvent["type"]>([
    "CommandAccepted",
    "InputAccepted",
    "SessionTitleSet",
    "SessionArchived",
    "RunStarted",
    "RunStopRequested",
    "RunRetryRequested",
    "ForkRequested",
  ])
  const commandId = payload.commandId
  if (commandEvents.has(first.type) && typeof commandId === "string") return `command:${commandId}`
  const identity = [payload.attemptId, payload.toolUseId, payload.inputId, payload.runId, payload.planId, payload.id].find(
    (value) => value !== undefined,
  )
  return `event:${first.type}:${String(identity ?? first.eventId)}`
}

function findReplay(
  current: readonly AgentEvent[],
  incoming: readonly AgentEvent[],
  transitionId: string,
): readonly AgentEvent[] | undefined {
  const ranges: Array<{ readonly start: number; readonly end: number }> = []
  for (const [index, event] of current.entries()) {
    if (event.transitionId !== transitionId) continue
    const previous = current[index - 1]
    if (previous?.transitionId === transitionId) continue
    let end = index
    while (current[end + 1]?.transitionId === transitionId) end += 1
    ranges.push({ start: index, end })
  }
  if (ranges.length === 0) return undefined
  if (ranges.length !== 1) throw new SessionTransitionConflictError(transitionId)
  const range = ranges[0]!
  if (range.end - range.start + 1 !== incoming.length) {
    throw new SessionTransitionConflictError(transitionId)
  }
  const existing = current.slice(range.start, range.end + 1)
  if (!existing.every((event, index) => sameReplayEvent(event, incoming[index]!))) {
    throw new SessionTransitionConflictError(transitionId)
  }
  return existing
}

export class SessionTransitionConflictError extends Error {
  readonly code = "session_transition_conflict"

  constructor(readonly transitionId: string) {
    super(`Session transition already exists with different events: ${transitionId}`)
    this.name = "SessionTransitionConflictError"
  }
}

function sameReplayEvent(left: AgentEvent, right: AgentEvent): boolean {
  return left.type === right.type && stableJson(left.payload) === stableJson(right.payload)
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`
}
