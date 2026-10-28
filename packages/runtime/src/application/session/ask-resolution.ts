import type { AgentEvent, EventTrace } from "@ag2cli/core/events/event.js"
import type { RunId, SessionId } from "@ag2cli/core/ids.js"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import type { AskBroker, AskOutcome } from "../../ports/ask-broker.js"
import { isResolvableAskBroker } from "../../ports/ask-broker.js"
import type { AskUserAnswer } from "../../ports/ask-user.js"
import type { EventStore } from "../../ports/event-store.js"
import { OrderedLane } from "../../concurrency/ordered-lane.js"
import { commitSessionEvents, SessionAuthority } from "./session-authority.js"
import { SessionRevisionConflictError } from "./revision-conflict.js"

type AskRequestedEvent = Extract<AgentEvent, { type: "AskUserRequested" }>
type AskResolutionEvent = Extract<AgentEvent, { type: "AskUserResolved" }>

export type AskResolutionErrorCode = "stale_ask" | "ask_already_resolved" | "invalid_answers"

export class AskResolutionError extends Error {
  constructor(
    readonly code: AskResolutionErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = "AskResolutionError"
  }
}

export interface AskResolutionInput {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly turn: number
  readonly toolUseId: string
  readonly outcome: Exclude<AskOutcome, "expired">
  readonly answers?: readonly AskUserAnswer[]
  readonly contextAnswers?: readonly AskUserAnswer[]
}

export interface AskExpiryInput {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly turn: number
  readonly toolUseId: string
}

export interface AskResolutionOutcome {
  readonly status: "committed" | "replayed"
  readonly event: AskResolutionEvent
}

export interface AskResolutionResolver {
  resolve(input: AskResolutionInput): Promise<AskResolutionOutcome>
}

export interface AskResolutionWriter {
  record(input: AskResolutionInput): Promise<AskResolutionOutcome>
}

/** System-side convergence of asks left dangling by a host restart. */
export interface AskExpirySweeper {
  expire(input: AskExpiryInput): Promise<AskResolutionOutcome>
}

export interface AskResolutionServiceDependencies {
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly identity: {
    nextEventId(): string
    now(): string
  }
  /** Local broker used only to wake an executor after the event is durable. */
  readonly broker?: AskBroker
  readonly onEventsAppended?: (events: readonly AgentEvent[], replayed: boolean) => Promise<void> | void
}

const MAX_CAS_RETRIES = 8

/**
 * Canonical ask decision boundary.
 *
 * The broker is deliberately not the source of truth: an answer becomes
 * visible only after `appendIfRevision` succeeds. `resolve` is the transport
 * side of the boundary; `record` is the executor side and adopts an already
 * durable canonical decision instead of creating a competing event. `expire`
 * is system-only and converges asks whose run already ended unanswered.
 */
export class AskResolutionService implements AskResolutionResolver, AskResolutionWriter, AskExpirySweeper {
  private readonly lane = new OrderedLane<string>()
  private readonly authority: SessionAuthority

  constructor(private readonly deps: AskResolutionServiceDependencies) {
    this.authority = deps.authority ?? new SessionAuthority(deps.eventStore)
  }

  resolve(input: AskResolutionInput): Promise<AskResolutionOutcome> {
    return this.enqueue(input, "remote")
  }

  record(input: AskResolutionInput): Promise<AskResolutionOutcome> {
    return this.enqueue(input, "executor")
  }

  expire(input: AskExpiryInput): Promise<AskResolutionOutcome> {
    return this.enqueueExpiry(input)
  }

  private enqueue(input: AskResolutionInput, source: "remote" | "executor"): Promise<AskResolutionOutcome> {
    return this.lane.run(askResourceKey(input), () => this.resolveNow(input, source))
  }

  private enqueueExpiry(input: AskExpiryInput): Promise<AskResolutionOutcome> {
    return this.lane.run(askResourceKey(input), () => this.expireNow(input))
  }

  private async resolveNow(input: AskResolutionInput, source: "remote" | "executor"): Promise<AskResolutionOutcome> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const events = await this.deps.eventStore.read(input.sessionId)
      const requested = findAskRequested(events, input)
      const existing = findAskResolution(events, input)

      if (existing) {
        if (source === "remote") {
          if (existing.payload.outcome !== input.outcome) {
            this.wakeBroker(input, existing.payload)
            throw new AskResolutionError(
              "ask_already_resolved",
              `ask_already_resolved: this ask was already resolved as ${existing.payload.outcome}`,
              { outcome: existing.payload.outcome },
            )
          }
          this.wakeBroker(input, existing.payload)
        }
        // A replayed resolution may be the only fan-out that ever ran: the
        // first attempt can die after its durable append but before publish,
        // so the replay must still notify. Delivery is at-least-once.
        await this.deps.onEventsAppended?.([existing], true)
        return { status: "replayed", event: existing }
      }

      if (!requested) throw staleAsk("the current Session has no matching pending ask")
      if (hasAskToolTerminal(events, requested, input)) throw staleAsk("the current ask is already terminal")
      replaySession(events)

      const answers = validateAnswers(requested, input)
      const contextAnswers = validateContextAnswers(requested, input)

      const event = this.makeResolutionEvent(input, requested, events.length + 1, {
        outcome: input.outcome,
        ...(input.outcome === "answered" ? { answers } : {}),
        ...(input.outcome === "chat" && contextAnswers !== undefined ? { contextAnswers } : {}),
      })
      try {
        const committed = await commitSessionEvents({
          authority: this.authority,
          expectedRevision: events.length,
          events: [event],
          onCommitted: this.deps.onEventsAppended,
        })
        const committedEvent = committed.events.find((candidate): candidate is AskResolutionEvent => candidate.type === "AskUserResolved")
        if (committedEvent === undefined) throw new Error("ask resolution commit returned no resolution event")
        if (source === "remote") this.wakeBroker(input, committedEvent.payload)
        return { status: committed.replayed ? "replayed" : "committed", event: committedEvent }
      } catch (error) {
        if (error instanceof SessionRevisionConflictError) continue
        throw error
      }
    }

    throw staleAsk("ask resolution cannot be committed at the current Session revision")
  }

  private async expireNow(input: AskExpiryInput): Promise<AskResolutionOutcome> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const events = await this.deps.eventStore.read(input.sessionId)
      const requested = findAskRequested(events, input)
      const existing = findAskResolution(events, input)

      if (existing) {
        // Same crash window as the resolve path: the replay is the sweep's
        // only chance to fan out a resolution the first attempt committed.
        await this.deps.onEventsAppended?.([existing], true)
        return { status: "replayed", event: existing }
      }
      if (!requested) throw staleAsk("the current Session has no matching pending ask")
      if (hasAskToolTerminal(events, requested, input)) throw staleAsk("the current ask is already terminal")
      // Only a ended run may leave its ask to the sweep: a live run still
      // owns the question and its executor may be waiting on the broker.
      if (!hasRunTerminal(events, input)) throw staleAsk("the run is still active")
      // replaySession security checks mirror the resolution path.
      replaySession(events)

      const event = this.makeResolutionEvent(input, requested, events.length + 1, {
        outcome: "expired",
        resolvedBy: "system",
      })
      try {
        const committed = await commitSessionEvents({
          authority: this.authority,
          expectedRevision: events.length,
          events: [event],
          onCommitted: this.deps.onEventsAppended,
        })
        const committedEvent = committed.events.find((candidate): candidate is AskResolutionEvent => candidate.type === "AskUserResolved")
        if (committedEvent === undefined) throw new Error("ask expiry commit returned no resolution event")
        return { status: committed.replayed ? "replayed" : "committed", event: committedEvent }
      } catch (error) {
        if (error instanceof SessionRevisionConflictError) continue
        throw error
      }
    }

    throw staleAsk("ask expiry cannot be committed at the current Session revision")
  }

  private makeResolutionEvent(
    input: AskExpiryInput,
    requested: AskRequestedEvent,
    revision: number,
    payload:
      | {
          readonly outcome: Exclude<AskOutcome, "expired">
          readonly answers?: readonly { header: string; selected: readonly string[]; freeText?: string; questionIndex?: number }[]
          readonly contextAnswers?: readonly { questionIndex: number; header: string; selected: readonly string[]; freeText?: string }[]
        }
      | { readonly outcome: "expired"; readonly resolvedBy: "system" },
  ): AskResolutionEvent {
    const eventId = this.deps.identity.nextEventId()
    const trace: EventTrace = {
      traceId: requested.trace.traceId,
      operationId: requested.trace.operationId,
      causationId: requested.eventId,
    }
    return {
      eventId,
      sessionId: input.sessionId,
      revision,
      type: "AskUserResolved",
      timestamp: this.deps.identity.now(),
      trace,
      payload: {
        runId: input.runId,
        turn: input.turn,
        toolUseId: input.toolUseId,
        outcome: payload.outcome,
        ...(payload.outcome === "answered" && payload.answers !== undefined ? { answers: copyAnswers(payload.answers) } : {}),
        ...(payload.outcome === "chat" && payload.contextAnswers !== undefined
          ? { contextAnswers: payload.contextAnswers.map((row) => ({ questionIndex: row.questionIndex, ...copyAnswer(row) })) }
          : {}),
        ...(payload.outcome === "expired" ? { resolvedBy: "system" as const } : {}),
      },
    }
  }

  private wakeBroker(
    input: Pick<AskResolutionInput, "sessionId" | "runId" | "turn" | "toolUseId">,
    payload: AskResolutionEvent["payload"],
  ): void {
    if (!this.deps.broker || !isResolvableAskBroker(this.deps.broker)) return
    if (payload.outcome === "expired") return
    try {
      this.deps.broker.resolve({
        sessionId: input.sessionId,
        runId: input.runId,
        turn: input.turn,
        toolUseId: input.toolUseId,
        outcome: payload.outcome,
        ...(payload.outcome === "answered" && payload.answers !== undefined ? { answers: copyAnswers(payload.answers) } : {}),
        ...(payload.outcome === "chat" && payload.contextAnswers !== undefined
          ? { answers: payload.contextAnswers.map((row) => ({ questionIndex: row.questionIndex, ...copyAnswer(row) })) }
          : {}),
      })
    } catch {
      // The durable event already won. A broker is a local wake-up mechanism,
      // so a faulty wake-up must not turn a committed decision into an error.
    }
  }
}

function askResourceKey(input: Pick<AskResolutionInput, "sessionId" | "runId" | "turn" | "toolUseId">): string {
  return JSON.stringify([input.sessionId.toString(), input.runId.toString(), input.turn, input.toolUseId])
}

function findAskRequested(events: readonly AgentEvent[], input: AskExpiryInput): AskRequestedEvent | undefined {
  return [...events]
    .reverse()
    .find(
      (event): event is AskRequestedEvent =>
        event.type === "AskUserRequested" &&
        event.payload.runId === input.runId &&
        event.payload.turn === input.turn &&
        event.payload.toolUseId === input.toolUseId,
    )
}

function findAskResolution(events: readonly AgentEvent[], input: AskExpiryInput): AskResolutionEvent | undefined {
  return [...events]
    .reverse()
    .find(
      (event): event is AskResolutionEvent =>
        event.type === "AskUserResolved" &&
        event.payload.runId === input.runId &&
        event.payload.turn === input.turn &&
        event.payload.toolUseId === input.toolUseId,
    )
}

function hasAskToolTerminal(events: readonly AgentEvent[], requested: AskRequestedEvent, input: AskExpiryInput): boolean {
  return events.some(
    (event) =>
      event.revision > requested.revision &&
      event.type === "ToolResultCommitted" &&
      event.payload.runId === input.runId &&
      event.payload.turn === input.turn &&
      event.payload.toolUseId === input.toolUseId,
  )
}

function hasRunTerminal(events: readonly AgentEvent[], input: AskExpiryInput): boolean {
  return events.some(
    (event) =>
      (event.type === "RunCompleted" || event.type === "RunFailed" || event.type === "RunCancelled") && event.payload.runId === input.runId,
  )
}

/**
 * Answers are validated against the durable questions before anything is
 * committed, so an off-the-wire row can never reach the canonical replay
 * invariant: one row per question, exact derived header, known labels only,
 * no repeated selection.
 */
function validateAnswers(
  requested: AskRequestedEvent,
  input: AskResolutionInput,
): readonly { header: string; selected: readonly string[]; freeText?: string }[] {
  if (input.outcome !== "answered") return []
  const questions = requested.payload.questions
  const rows = input.answers ?? []
  if (rows.length !== questions.length) {
    throw new AskResolutionError("invalid_answers", "invalid_answers: answers must cover every question exactly once")
  }
  return questions.map((question, index) => {
    const row = rows[index]!
    const header = question.header ?? question.question.slice(0, 12)
    if (row.header !== header) {
      throw new AskResolutionError("invalid_answers", `invalid_answers: answers[${index}].header does not match the question`)
    }
    if (row.questionIndex !== undefined && row.questionIndex !== index) {
      throw new AskResolutionError("invalid_answers", `invalid_answers: answers[${index}].questionIndex does not match the question`)
    }
    const labels = new Set(question.options.map((option) => option.label))
    const seen = new Set<string>()
    for (const label of row.selected) {
      if (!labels.has(label)) {
        throw new AskResolutionError("invalid_answers", `invalid_answers: answers[${index}] selects an unknown option`)
      }
      if (seen.has(label)) {
        throw new AskResolutionError("invalid_answers", `invalid_answers: answers[${index}] repeats a selection`)
      }
      seen.add(label)
    }
    const hasText = row.freeText?.trim().length !== undefined && row.freeText.trim().length > 0
    if (!hasText && row.selected.length === 0) {
      throw new AskResolutionError("invalid_answers", `invalid_answers: answers[${index}] must include a selection or non-empty freeText`)
    }
    if (!question.multiSelect && ((hasText && row.selected.length > 0) || (!hasText && row.selected.length !== 1))) {
      throw new AskResolutionError("invalid_answers", `invalid_answers: answers[${index}] single-select requires one option or freeText`)
    }
    return {
      header: row.header,
      selected: [...row.selected],
      ...(row.freeText === undefined ? {} : { freeText: row.freeText }),
      ...(row.questionIndex === undefined ? {} : { questionIndex: row.questionIndex }),
    }
  })
}

function validateContextAnswers(
  requested: AskRequestedEvent,
  input: AskResolutionInput,
): readonly { questionIndex: number; header: string; selected: readonly string[]; freeText?: string }[] | undefined {
  if (input.outcome !== "chat") return undefined
  const rows = input.contextAnswers ?? input.answers
  if (rows === undefined) return undefined
  const seen = new Set<number>()
  return rows.map((row, answerIndex) => {
    const index = row.questionIndex
    const question = index === undefined ? undefined : requested.payload.questions[index]
    if (index === undefined || question === undefined || seen.has(index)) {
      throw new AskResolutionError(
        "invalid_answers",
        `invalid_answers: contextAnswers[${answerIndex}] has a missing, unknown or repeated question index`,
      )
    }
    const header = question.header ?? question.question.slice(0, 12)
    if (row.header !== header) {
      throw new AskResolutionError("invalid_answers", `invalid_answers: contextAnswers[${answerIndex}].header does not match the question`)
    }
    const labels = new Set(question.options.map((option) => option.label))
    if (row.selected.some((label) => !labels.has(label)) || new Set(row.selected).size !== row.selected.length) {
      throw new AskResolutionError("invalid_answers", `invalid_answers: contextAnswers[${answerIndex}] has an invalid selection`)
    }
    const hasText = row.freeText?.trim().length !== undefined && row.freeText.trim().length > 0
    if (row.selected.length === 0 && !hasText) {
      throw new AskResolutionError("invalid_answers", `invalid_answers: contextAnswers[${answerIndex}] is empty`)
    }
    if (!question.multiSelect && (row.selected.length > 1 || (hasText && row.selected.length > 0))) {
      throw new AskResolutionError("invalid_answers", `invalid_answers: contextAnswers[${answerIndex}] violates single-select rules`)
    }
    seen.add(index)
    return { questionIndex: index, header, selected: [...row.selected], ...(row.freeText === undefined ? {} : { freeText: row.freeText }) }
  })
}

function copyAnswer(row: { header: string; selected: readonly string[]; freeText?: string; questionIndex?: number }) {
  return {
    header: row.header,
    selected: [...row.selected],
    ...(row.freeText === undefined ? {} : { freeText: row.freeText }),
    ...(row.questionIndex === undefined ? {} : { questionIndex: row.questionIndex }),
  }
}

function copyAnswers(rows: readonly { header: string; selected: readonly string[]; freeText?: string; questionIndex?: number }[]) {
  return rows.map(copyAnswer)
}

function staleAsk(reason: string): AskResolutionError {
  return new AskResolutionError("stale_ask", `stale_ask: ${reason}`)
}
