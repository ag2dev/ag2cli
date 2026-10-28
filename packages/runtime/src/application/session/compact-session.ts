import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import { messagesFromSessionEvents } from "@ag2cli/core/session/message-history.js"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import type { ContextCompactor } from "../../ports/context-compactor.js"
import type { EventStore } from "../../ports/event-store.js"
import type { ObservabilityPolicy } from "../../ports/observability.js"
import type { SessionExecutionReservation } from "../../ports/session-execution-reservation.js"
import { commitSessionEvents, SessionAuthority } from "./session-authority.js"
import { commandIdempotencyConflictError, resolveCommandIdempotency, type CommandIdempotencyFamily } from "./command-idempotency.js"

export const COMPACT_FAMILY = "compact"

type CompactFingerprint = { readonly instructions: string | null }

export const COMPACT_IDEMPOTENCY_FAMILY: CommandIdempotencyFamily<CompactFingerprint> = {
  family: COMPACT_FAMILY,
  findAnchor(events, commandId) {
    const event = events.find(
      (candidate): candidate is Extract<AgentEvent, { type: "SessionContextCompacted" }> =>
        candidate.type === "SessionContextCompacted" && candidate.payload.commandId === commandId,
    )
    if (event === undefined) return undefined
    return {
      event,
      inputFingerprint: { instructions: event.payload.instructions ?? null },
    }
  },
}

export interface CompactSessionInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly instructions?: string
  readonly signal?: AbortSignal
}

export interface CompactSessionResult {
  readonly changed: boolean
  readonly inputMessageCount: number
  readonly outputMessageCount: number
  readonly inputTokens?: number
}

export interface CompactSessionDependencies {
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly compactor: ContextCompactor
  readonly identity: {
    nextEventId(): string
    nextRunId(): import("@ag2cli/core/ids.js").RunId
    now(): string
  }
  readonly observability: ObservabilityPolicy
  /** Optional cross-process guard used by local durable compositions. */
  readonly executionReservation?: SessionExecutionReservation
  readonly reservationOwnerId?: string
  readonly onEventsAppended?: (events: readonly AgentEvent[], replayed: boolean) => Promise<void> | void
}

/** Server-independent application operation for explicit session compaction. */
export class CompactSessionUseCase {
  private readonly authority: SessionAuthority

  constructor(private readonly deps: CompactSessionDependencies) {
    this.authority = deps.authority ?? new SessionAuthority(deps.eventStore)
  }

  async execute(input: CompactSessionInput): Promise<CompactSessionResult> {
    validateInput(input)
    if (this.deps.executionReservation !== undefined) {
      const initial = await this.deps.eventStore.read(input.sessionId)
      const idempotency = resolveCommandIdempotency(COMPACT_IDEMPOTENCY_FAMILY, initial, {
        family: COMPACT_FAMILY,
        commandId: input.commandId,
        inputFingerprint: { instructions: input.instructions ?? null },
      })
      if (idempotency.status === "replay" || idempotency.status === "conflict") return this.executeNow(input)
      const messages = messagesFromSessionEvents(initial)
      if (messages.length > 3) {
        const lease = await this.deps.executionReservation.acquire({
          sessionId: input.sessionId,
          commandId: `compact:${input.commandId}`,
          ownerId: this.deps.reservationOwnerId ?? `pid-${process.pid}`,
          baseRevision: initial.length,
          // A compaction whose external model/hook side effect is interrupted
          // must only be retried explicitly with the same command identity.
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
        try {
          return await this.executeNow(input)
        } catch (error) {
          await lease.release("aborted").catch(() => {})
          throw error
        } finally {
          await lease.release(input.signal?.aborted ? "aborted" : "released").catch(() => {})
        }
      }
    }
    return this.executeNow(input)
  }

  private async executeNow(input: CompactSessionInput): Promise<CompactSessionResult> {
    validateInput(input)
    const events = await this.deps.eventStore.read(input.sessionId)
    const idempotency = resolveCommandIdempotency(COMPACT_IDEMPOTENCY_FAMILY, events, {
      family: COMPACT_FAMILY,
      commandId: input.commandId,
      inputFingerprint: { instructions: input.instructions ?? null },
    })
    if (idempotency.status === "conflict") throw commandIdempotencyConflictError(idempotency.record)
    if (idempotency.status === "replay") {
      if (idempotency.terminal.type !== "SessionContextCompacted") {
        throw new Error("compact receipt has an invalid terminal event")
      }
      const prior = idempotency.terminal
      return {
        changed: prior.payload.changed,
        inputMessageCount: prior.payload.inputMessageCount,
        outputMessageCount: prior.payload.outputMessageCount,
        ...(prior.payload.inputTokens === undefined ? {} : { inputTokens: prior.payload.inputTokens }),
      }
    }
    const snapshot = events.length === 0 ? undefined : replaySession(events)
    if (snapshot?.currentRun?.status === "running") {
      throw new Error("The current Session is running; context cannot be compacted")
    }

    const messages = messagesFromSessionEvents(events)
    if (messages.length <= 3) {
      const traceId = `session-compact:${input.commandId}`
      const event: AgentEvent = {
        eventId: this.deps.identity.nextEventId(),
        sessionId: input.sessionId,
        revision: events.length + 1,
        type: "SessionContextCompacted",
        timestamp: this.deps.identity.now(),
        trace: {
          traceId,
          operationId: traceId,
          ...(events.at(-1)?.eventId ? { causationId: events.at(-1)!.eventId } : {}),
        },
        payload: {
          commandId: input.commandId,
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          changed: false,
          compactId: `noop:${input.commandId}`,
          inputMessageCount: messages.length,
          outputMessageCount: messages.length,
          messages: structuredClone(messages),
        },
      }
      await commitSessionEvents({
        authority: this.authority,
        expectedRevision: events.length,
        transitionId: traceId,
        events: [event],
        onCommitted: this.deps.onEventsAppended,
      })
      return {
        changed: false,
        inputMessageCount: messages.length,
        outputMessageCount: messages.length,
      }
    }

    const compacted = await this.deps.compactor.compact({
      sessionId: input.sessionId,
      runId: this.deps.identity.nextRunId(),
      messages,
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      signal: input.signal,
    })
    if (compacted.inputMessageCount !== messages.length) {
      throw new Error("The context compactor returned an inconsistent inputMessageCount")
    }
    if (compacted.outputMessageCount !== compacted.messages.length) {
      throw new Error("The context compactor returned an inconsistent outputMessageCount")
    }

    const traceId = `session-compact:${input.commandId}`
    const operationId = traceId
    const compactEventId = this.deps.identity.nextEventId()
    const baseRevision = events.length + 1
    const compactEvent: AgentEvent = {
      eventId: compactEventId,
      sessionId: input.sessionId,
      revision: baseRevision,
      type: "SessionContextCompacted",
      timestamp: this.deps.identity.now(),
      trace: {
        traceId,
        operationId,
        ...(events.at(-1)?.eventId === undefined ? {} : { causationId: events.at(-1)!.eventId }),
      },
      payload: {
        commandId: input.commandId,
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        changed: true,
        compactId: compacted.compactId,
        inputMessageCount: compacted.inputMessageCount,
        outputMessageCount: compacted.outputMessageCount,
        messages: structuredClone(compacted.messages),
        ...(compacted.inputTokens === undefined ? {} : { inputTokens: compacted.inputTokens }),
      },
    }
    await commitSessionEvents({
      authority: this.authority,
      expectedRevision: events.length,
      transitionId: traceId,
      events: [compactEvent],
      onCommitted: this.deps.onEventsAppended,
    })
    return {
      changed: true,
      inputMessageCount: compacted.inputMessageCount,
      outputMessageCount: compacted.outputMessageCount,
      ...(compacted.inputTokens === undefined ? {} : { inputTokens: compacted.inputTokens }),
    }
  }
}

function validateInput(input: CompactSessionInput): void {
  if (input.commandId.trim().length === 0) throw new Error("commandId must not be empty")
  if (input.instructions !== undefined && input.instructions.trim().length === 0) {
    throw new Error("compact.instructions must be a non-empty string")
  }
  if (input.instructions !== undefined && input.instructions.length > 4_096) {
    throw new Error("compact.instructions must not exceed 4,096 characters")
  }
}
