import type { Plan } from "@ag2cli/core/plan/plan.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { AgentEvent, EventTrace } from "@ag2cli/core/events/event.js"
import { DEFAULT_SESSION_PERMISSION_MODE } from "@ag2cli/core/session/session-security.js"
import type { EventStore } from "../../ports/event-store.js"
import type { PlanProvider } from "../../ports/model-provider.js"
import { noopTraceSink, type TraceSink } from "../../ports/trace-sink.js"
import type { ObservabilityPolicy } from "../../ports/observability.js"
import { PlanService, type PlanIdentity } from "./plan-service.js"
import type { WorkspaceScopeDigest } from "../../ports/workspace.js"
import {
  commandIdempotencyConflictError,
  resolveCommandIdempotency,
  type CommandIdempotencyFamily,
} from "../session/command-idempotency.js"
import type { SessionExecutionReservation } from "../../ports/session-execution-reservation.js"
import { commitSessionEvents, SessionAuthority } from "../session/session-authority.js"

export interface PlanEventIdentity extends PlanIdentity {
  nextEventId(): string
}

export interface CreatePlanInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly goal: string
  readonly context?: readonly string[]
  readonly workspace?: string
  readonly additionalDirectories?: readonly string[]
  readonly trace?: EventTrace
  readonly signal?: AbortSignal
}

interface CreatePlanFingerprint {
  readonly goal: string
  readonly context: readonly string[]
}

export const CREATE_PLAN_FAMILY: CommandIdempotencyFamily<CreatePlanFingerprint> = {
  family: "create_plan",
  findAnchor: (events, commandId) => {
    const anchor = events.find(
      (event): event is Extract<AgentEvent, { type: "CommandAccepted" }> =>
        event.type === "CommandAccepted" && event.payload.family === CREATE_PLAN_FAMILY.family && event.payload.commandId === commandId,
    )
    if (anchor === undefined) return undefined
    const goal = anchor.payload.inputFingerprint.goal
    const context = anchor.payload.inputFingerprint.context
    if (typeof goal !== "string" || !Array.isArray(context) || !context.every((item) => typeof item === "string")) {
      throw new Error(`CommandAccepted fingerprint is invalid: ${commandId}`)
    }
    return {
      event: anchor,
      inputFingerprint: { goal, context: [...context] },
    }
  },
  findTerminal: (events, anchor) =>
    events.find(
      (event) =>
        (event.type === "PlanCreated" || event.type === "PlanGenerationFailed" || event.type === "PlanGenerationCancelled") &&
        event.trace.traceId === anchor.trace.traceId,
    ),
}

export interface CreatePlanDependencies {
  readonly provider: PlanProvider
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly identity: PlanEventIdentity
  readonly traceSink?: TraceSink
  readonly observability?: ObservabilityPolicy
  readonly workspaceScopeDigest?: WorkspaceScopeDigest
  /** Optional cross-process guard used by local durable compositions. */
  readonly executionReservation?: SessionExecutionReservation
  readonly reservationOwnerId?: string
  /** Notify a live transport after a durable batch has been appended. */
  readonly onEventsAppended?: (events: readonly AgentEvent[]) => Promise<void> | void
}

/** One complete plan use case: provider output becomes a durable domain event. */
export class CreatePlanUseCase {
  private readonly planService: PlanService
  private readonly pending = new Map<string, Promise<void>>()
  private readonly authority: SessionAuthority

  constructor(private readonly deps: CreatePlanDependencies) {
    this.planService = new PlanService(deps.identity)
    this.authority = deps.authority ?? new SessionAuthority(deps.eventStore)
  }

  async execute(input: CreatePlanInput): Promise<Plan> {
    const previous = this.pending.get(input.sessionId)
    const operation = (previous ?? Promise.resolve()).then(async () => {
      if (this.deps.executionReservation === undefined) return this.executeNow(input)
      const events = await this.deps.eventStore.read(input.sessionId)
      const idempotency = resolveCommandIdempotency(CREATE_PLAN_FAMILY, events, {
        family: CREATE_PLAN_FAMILY.family,
        commandId: input.commandId,
        inputFingerprint: {
          goal: input.goal,
          context: [...(input.context ?? [])],
        },
      })
      if (idempotency.status === "replay" || idempotency.status === "conflict") return this.executeNow(input)
      const lease = await this.deps.executionReservation.acquire({
        sessionId: input.sessionId,
        commandId: input.commandId,
        ownerId: this.deps.reservationOwnerId ?? `pid-${process.pid}`,
        baseRevision: events.length,
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
    })
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    )
    this.pending.set(input.sessionId, tracked)
    try {
      return await operation
    } finally {
      if (this.pending.get(input.sessionId) === tracked) this.pending.delete(input.sessionId)
    }
  }

  private async executeNow(input: CreatePlanInput): Promise<Plan> {
    const previous = await this.deps.eventStore.read(input.sessionId)
    const idempotency = resolveCommandIdempotency(CREATE_PLAN_FAMILY, previous, {
      family: CREATE_PLAN_FAMILY.family,
      commandId: input.commandId,
      inputFingerprint: {
        goal: input.goal,
        context: [...(input.context ?? [])],
      },
    })
    if (idempotency.status === "conflict") throw commandIdempotencyConflictError(idempotency.record)
    if (idempotency.status === "replay") return replayPlanTerminal(idempotency.terminal)
    const existingAcceptance = previous.find(
      (event) =>
        event.type === "CommandAccepted" &&
        event.payload.family === CREATE_PLAN_FAMILY.family &&
        event.payload.commandId === input.commandId,
    )

    const setupEvents: AgentEvent[] = []
    let revision = previous.length + 1
    const traceId = existingAcceptance?.trace.traceId ?? input.trace?.traceId ?? this.deps.identity.nextEventId()
    const operationId = existingAcceptance?.trace.operationId ?? input.trace?.operationId ?? this.deps.identity.nextEventId()
    let causationId = existingAcceptance?.eventId ?? input.trace?.causationId ?? input.commandId
    const nextTrace = (eventId: string): EventTrace => {
      const trace: EventTrace = {
        traceId,
        operationId,
        ...(causationId ? { causationId } : {}),
      }
      causationId = eventId
      return trace
    }
    if (existingAcceptance === undefined && previous.length === 0) {
      const eventId = this.deps.identity.nextEventId()
      setupEvents.push({
        eventId,
        sessionId: input.sessionId,
        revision,
        type: "SessionCreated",
        timestamp: this.deps.identity.now(),
        trace: nextTrace(eventId),
        payload: {
          workspaceRoot: input.workspace ?? ".",
          additionalDirectories: input.additionalDirectories ?? [],
          ...(input.additionalDirectories && input.additionalDirectories.length > 0
            ? this.deps.workspaceScopeDigest === undefined
              ? {}
              : {
                  scopeDigest: this.deps.workspaceScopeDigest(input.workspace ?? ".", input.additionalDirectories),
                }
            : {}),
          permissionMode: DEFAULT_SESSION_PERMISSION_MODE,
          permissionRules: [],
          policyRevision: 0,
          scopeRevision: 0,
        },
      })
      revision++
    }
    if (existingAcceptance === undefined) {
      const acceptanceEventId = this.deps.identity.nextEventId()
      setupEvents.push({
        eventId: acceptanceEventId,
        sessionId: input.sessionId,
        revision,
        type: "CommandAccepted",
        timestamp: this.deps.identity.now(),
        trace: nextTrace(acceptanceEventId),
        payload: {
          commandId: input.commandId,
          family: CREATE_PLAN_FAMILY.family,
          inputFingerprint: {
            goal: input.goal,
            context: [...(input.context ?? [])],
          },
        },
      })
    }
    await commitSessionEvents({
      authority: this.authority,
      events: setupEvents,
      onCommitted: this.deps.onEventsAppended,
    })

    const traceSink = this.deps.traceSink ?? noopTraceSink
    const providerStartedAt = performance.now()
    const providerTrace: EventTrace = {
      traceId,
      operationId,
      ...(causationId ? { causationId } : {}),
    }
    const commandTrace: EventTrace = {
      traceId,
      operationId,
      causationId: input.commandId,
    }
    recordTrace(traceSink, {
      name: "session.command",
      phase: "started",
      sessionId: input.sessionId,
      trace: commandTrace,
      timestamp: this.deps.identity.now(),
      attributes: { commandType: "create_plan" },
    })
    recordTrace(traceSink, {
      name: "plan.provider",
      phase: "started",
      sessionId: input.sessionId,
      trace: providerTrace,
      timestamp: this.deps.identity.now(),
      attributes: {
        contextCount: input.context?.length ?? 0,
        goalLength: input.goal.length,
      },
    })

    let generated
    try {
      if (input.signal?.aborted) throw new DOMException("Plan generation was cancelled", "AbortError")
      generated = await this.deps.provider.generatePlan({
        sessionId: input.sessionId,
        goal: input.goal,
        context: [...(input.context ?? [])],
        signal: input.signal,
      })
      if (input.signal?.aborted) throw new DOMException("Plan generation was cancelled", "AbortError")
    } catch (error) {
      const current = await this.deps.eventStore.read(input.sessionId)
      const cancelled = input.signal?.aborted || isAbortError(error)
      const events: AgentEvent[] = []
      const eventId = this.deps.identity.nextEventId()
      const eventBase = {
        eventId,
        sessionId: input.sessionId,
        revision: current.length + 1,
        timestamp: this.deps.identity.now(),
        trace: nextTrace(eventId),
      }
      recordTrace(traceSink, {
        name: "plan.provider",
        phase: cancelled ? "cancelled" : "failed",
        sessionId: input.sessionId,
        trace: providerTrace,
        timestamp: this.deps.identity.now(),
        durationMs: Math.round(performance.now() - providerStartedAt),
      })
      const terminalEvent = cancelled
        ? {
            ...eventBase,
            type: "PlanGenerationCancelled" as const,
            payload: {
              reason: error instanceof Error ? error.message : undefined,
            },
          }
        : {
            ...eventBase,
            type: "PlanGenerationFailed" as const,
            payload: {
              message: error instanceof Error ? error.message : String(error),
            },
          }
      events.push(terminalEvent)
      await commitSessionEvents({
        authority: this.authority,
        events,
        onCommitted: this.deps.onEventsAppended,
      })
      recordTrace(traceSink, {
        name: "session.command",
        phase: cancelled ? "cancelled" : "failed",
        sessionId: input.sessionId,
        trace: { ...commandTrace, causationId: eventId },
        timestamp: this.deps.identity.now(),
        durationMs: Math.round(performance.now() - providerStartedAt),
        attributes: {
          commandType: "create_plan",
          eventRevision: terminalEvent.revision,
        },
      })
      throw error
    }
    const current = await this.deps.eventStore.read(input.sessionId)
    const plan = this.planService.create(input.sessionId, current.length + 1, generated)
    const events: AgentEvent[] = []
    const eventId = this.deps.identity.nextEventId()
    const event: AgentEvent = {
      eventId,
      sessionId: input.sessionId,
      revision: current.length + 1,
      type: "PlanCreated",
      timestamp: this.deps.identity.now(),
      trace: nextTrace(eventId),
      payload: plan,
    }
    events.push(event)
    await commitSessionEvents({
      authority: this.authority,
      events,
      onCommitted: this.deps.onEventsAppended,
    })
    recordTrace(traceSink, {
      name: "plan.provider",
      phase: "succeeded",
      sessionId: input.sessionId,
      trace: providerTrace,
      timestamp: this.deps.identity.now(),
      durationMs: Math.round(performance.now() - providerStartedAt),
      attributes: { eventRevision: event.revision },
    })
    recordTrace(traceSink, {
      name: "session.command",
      phase: "succeeded",
      sessionId: input.sessionId,
      trace: { ...commandTrace, causationId: event.eventId },
      timestamp: this.deps.identity.now(),
      durationMs: Math.round(performance.now() - providerStartedAt),
      attributes: { commandType: "create_plan", eventRevision: event.revision },
    })
    return plan
  }
}

function recordTrace(sink: TraceSink, record: Parameters<TraceSink["record"]>[0]): void {
  try {
    sink.record(record)
  } catch (error) {
    // Diagnostics are best effort; a broken sink must not change the plan outcome.
    void error
  }
}

function replayPlanTerminal(terminal: AgentEvent): Plan {
  if (terminal.type === "PlanCreated") return terminal.payload
  if (terminal.type === "PlanGenerationFailed") throw new Error(terminal.payload.message)
  if (terminal.type === "PlanGenerationCancelled") {
    throw new DOMException(terminal.payload.reason ?? "Plan generation was cancelled", "AbortError")
  }
  throw new Error(`create_plan terminal event has an invalid type: ${terminal.type}`)
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError")
}
