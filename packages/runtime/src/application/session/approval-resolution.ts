import type { AgentEvent, EventTrace } from "@ag2cli/core/events/event.js"
import type { RunId, SessionId } from "@ag2cli/core/ids.js"
import type { GuardianDenialReasonCode } from "@ag2cli/core/tool-facts.js"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import type { ApprovalBroker, ApprovalDecision } from "../../ports/approval-broker.js"
import { isResolvableApprovalBroker } from "../../ports/approval-broker.js"
import type { EventStore } from "../../ports/event-store.js"
import { commitSessionEvents, SessionAuthority } from "./session-authority.js"
import { SessionRevisionConflictError } from "./revision-conflict.js"

type ApprovalResolutionEvent = Extract<AgentEvent, { type: "ToolApprovalResolved" }>
type ApprovalRequestedEvent = Extract<AgentEvent, { type: "ToolApprovalRequested" }>

export type ApprovalResolutionErrorCode =
  "stale_approval" | "approval_already_resolved" | "approval_not_user_owned" | "approval_owner_mismatch"

export class ApprovalResolutionError extends Error {
  constructor(
    readonly code: ApprovalResolutionErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = "ApprovalResolutionError"
  }
}

export interface ApprovalResolutionInput {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly turn: number
  readonly toolUseId: string
  readonly preparedEventId: string
  readonly expectedScopeRevision: number
  readonly expectedPolicyRevision: number
  readonly decision: ApprovalDecision
}

/**
 * Executor-only extension: attribution is a compile-time capability of
 * `record()` — a remote/user `resolve()` cannot carry guardian or system
 * attribution, so no runtime stripping is needed. The union pins the shape:
 * an approval carries no denial reasonCode and never rides resolvedBy.
 */
export type ExecutorApprovalResolutionInput = Omit<ApprovalResolutionInput, "decision"> &
  (
    | {
        readonly decision: "approved"
        readonly guardian?: { readonly guardianId: string; readonly reason?: string }
      }
    | {
        readonly decision: "denied"
        /** Marks a system-forced denial (registry abort); never rides approvals. */
        readonly resolvedBy?: "system"
        readonly guardian?: {
          readonly guardianId: string
          readonly reasonCode?: GuardianDenialReasonCode
          readonly reason?: string
        }
      }
  )

/** Widened internal shape both entry points funnel into. */
type ResolutionAttemptInput = ApprovalResolutionInput & {
  readonly guardian?: {
    readonly guardianId: string
    readonly reasonCode?: GuardianDenialReasonCode
    readonly reason?: string
  }
  readonly resolvedBy?: "system"
}

export interface ApprovalResolutionOutcome {
  readonly status: "committed" | "replayed"
  readonly decision: ApprovalDecision
  readonly event: ApprovalResolutionEvent
  /** Present when a security drift forced the recorded denial; maps to stale_policy. */
  readonly reason?: "invalidated"
}

export interface ApprovalResolutionResolver {
  resolve(input: ApprovalResolutionInput): Promise<ApprovalResolutionOutcome>
}

export interface ApprovalResolutionWriter {
  record(input: ExecutorApprovalResolutionInput): Promise<ApprovalResolutionOutcome>
}

export interface ApprovalResolutionServiceDependencies {
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly identity: {
    nextEventId(): string
    now(): string
  }
  /** Local broker used only to wake an executor after the event is durable. */
  readonly broker?: ApprovalBroker
  readonly onEventsAppended?: (events: readonly AgentEvent[]) => Promise<void> | void
}

const MAX_CAS_RETRIES = 8

/**
 * Canonical approval decision boundary.
 *
 * The broker is deliberately not the source of truth: a decision becomes
 * visible only after `appendIfRevision` succeeds. `resolve` is the transport
 * side of the boundary; `record` is the executor side and adopts an already
 * durable canonical decision instead of creating a competing event.
 */
export class ApprovalResolutionService implements ApprovalResolutionResolver, ApprovalResolutionWriter {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly authority: SessionAuthority

  constructor(private readonly deps: ApprovalResolutionServiceDependencies) {
    this.authority = deps.authority ?? new SessionAuthority(deps.eventStore)
  }

  resolve(input: ApprovalResolutionInput): Promise<ApprovalResolutionOutcome> {
    // The broker is only a live-worker wake-up channel.  A degraded/history-only
    // server can still append the canonical decision; there simply is no local
    // worker to wake after the event becomes durable.
    return this.enqueue(input, "remote")
  }

  record(input: ExecutorApprovalResolutionInput): Promise<ApprovalResolutionOutcome> {
    return this.enqueue(input, "executor")
  }

  private enqueue(input: ResolutionAttemptInput, source: "remote" | "executor"): Promise<ApprovalResolutionOutcome> {
    const key = approvalResourceKey(input)
    const previous = this.pending.get(key) ?? Promise.resolve()
    const current = previous.then(() => this.resolveNow(input, source))
    const tracked = current.then(
      () => undefined,
      () => undefined,
    )
    this.pending.set(key, tracked)
    return current.finally(() => {
      if (this.pending.get(key) === tracked) this.pending.delete(key)
    })
  }

  private async resolveNow(input: ResolutionAttemptInput, source: "remote" | "executor"): Promise<ApprovalResolutionOutcome> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const events = await this.deps.eventStore.read(input.sessionId)
      const requested = findApprovalRequested(events, input)
      const existing = findApprovalResolution(events, input)

      if (existing) {
        if (existing.payload.preparedEventId !== input.preparedEventId) {
          if (source === "remote") this.wakeBroker(input, existing.payload.decision)
          throw staleApproval("preparedEventId does not match")
        }
        // Ownership fence on the replay branch: a durable resolution on a
        // guardian-owned ask may only be adopted when it is this guardian's
        // own verdict (matching identity) or a system outcome the executor
        // already forced. Anything else — a user encoding, a foreign
        // guardian — is a mismatch, never silently returned as the
        // guardian's decision.
        if (source === "executor" && requested?.payload.ownedBy === "guardian") {
          const adoptable =
            existing.payload.resolvedBy === "system" ||
            (existing.payload.resolvedBy === "guardian" && existing.payload.guardian?.guardianId === input.guardian?.guardianId)
          if (!adoptable) {
            throw new ApprovalResolutionError(
              "approval_owner_mismatch",
              "approval_owner_mismatch: the durable resolution is not this guardian's outcome",
            )
          }
        }
        if (source === "remote" && existing.payload.decision !== input.decision) {
          this.wakeBroker(input, existing.payload.decision)
          throw new ApprovalResolutionError(
            "approval_already_resolved",
            `approval_already_resolved: this approval was already resolved as ${existing.payload.decision}`,
            { decision: existing.payload.decision },
          )
        }
        if (source === "remote") this.wakeBroker(input, existing.payload.decision)
        return {
          status: "replayed",
          decision: existing.payload.decision,
          event: existing,
        }
      }

      if (!requested) throw staleApproval("the current Session has no matching tool call awaiting approval")
      if (requested.payload.preparedEventId !== input.preparedEventId) throw staleApproval("preparedEventId does not match")
      // Ownership fence: a guardian-owned ask has exactly one answerer. A
      // remote (user) resolution against it can only race the guardian and
      // must never override or pre-empt its verdict.
      if (source === "remote" && requested.payload.ownedBy === "guardian") {
        throw new ApprovalResolutionError("approval_not_user_owned", "approval_not_user_owned: the guardian answers this ask, not the user")
      }

      const prepared = findPreparedEvent(events, requested, input)
      if (!prepared) throw staleApproval("ToolCallPrepared does not exist")
      if (hasApprovalTerminal(events, requested, input)) throw staleApproval("the current approval is already terminal")

      const snapshot = replaySession(events)
      const preparedScopeRevision = prepared.payload.scopeRevision ?? requested.payload.scopeRevision ?? 0
      const preparedPolicyRevision = prepared.payload.policyRevision ?? requested.payload.policyRevision ?? 0
      if (preparedScopeRevision !== input.expectedScopeRevision || preparedPolicyRevision !== input.expectedPolicyRevision) {
        throw staleApproval("Tool approval preparation has expired")
      }

      const securityChanged =
        snapshot.scopeRevision !== input.expectedScopeRevision || snapshot.policyRevision !== input.expectedPolicyRevision
      if (source === "remote" && securityChanged) throw staleApproval("Session security revision has changed")

      // A pending request invalidated by a security change must converge to a
      // denied canonical decision. This keeps the executor from granting an
      // old preparation after the wait was interrupted. Only approvals are
      // forced: an executor-recorded denial keeps its resolver attribution —
      // a guardian deny is a real guardian verdict even under drift.
      const forcedInvalidation = source === "executor" && securityChanged && input.decision === "approved"
      const decision: ApprovalDecision = forcedInvalidation ? "denied" : input.decision
      const event = this.makeResolutionEvent(input, requested, events.length + 1, decision, forcedInvalidation)
      try {
        const committed = await commitSessionEvents({
          authority: this.authority,
          expectedRevision: events.length,
          events: [event],
          onCommitted: this.deps.onEventsAppended,
        })
        const committedEvent = committed.events.find(
          (candidate): candidate is ApprovalResolutionEvent => candidate.type === "ToolApprovalResolved",
        )
        if (committedEvent === undefined) throw new Error("approval resolution commit returned no resolution event")
        if (source === "remote") this.wakeBroker(input, decision)
        return {
          status: committed.replayed ? "replayed" : "committed",
          decision,
          event: committedEvent,
          ...(forcedInvalidation ? { reason: "invalidated" as const } : {}),
        }
      } catch (error) {
        if (error instanceof SessionRevisionConflictError) continue
        throw error
      }
    }

    throw staleApproval("approval resolution cannot be committed at the current Session revision")
  }

  private makeResolutionEvent(
    input: ResolutionAttemptInput,
    requested: ApprovalRequestedEvent,
    revision: number,
    decision: ApprovalDecision,
    forcedInvalidation: boolean,
  ): ApprovalResolutionEvent {
    const eventId = this.deps.identity.nextEventId()
    const trace: EventTrace = {
      traceId: requested.trace.traceId,
      operationId: requested.trace.operationId,
      causationId: requested.eventId,
    }
    // Tri-state attribution: absent means the user (legacy resolutions stay
    // absent). A drift-forced denial is a system outcome — but the guardian
    // approval it superseded stays on the record: the log carries both the
    // approval fact and the system denial, never rewriting one into the
    // other. A registry abort (input resolvedBy "system") carries no
    // superseded verdict because none existed.
    const guardian = !forcedInvalidation && input.guardian !== undefined ? input.guardian : undefined
    const resolvedBy = forcedInvalidation || input.resolvedBy === "system" ? "system" : guardian !== undefined ? "guardian" : undefined
    const supersededApproval =
      forcedInvalidation && input.guardian !== undefined
        ? {
            guardianId: input.guardian.guardianId,
            ...(input.guardian.reason === undefined ? {} : { reason: input.guardian.reason }),
          }
        : undefined
    return {
      eventId,
      sessionId: input.sessionId,
      revision,
      type: "ToolApprovalResolved",
      timestamp: this.deps.identity.now(),
      trace,
      payload: {
        runId: input.runId,
        turn: input.turn,
        toolUseId: input.toolUseId,
        preparedEventId: input.preparedEventId,
        decision,
        ...(resolvedBy === undefined ? {} : { resolvedBy }),
        ...(guardian === undefined ? {} : { guardian }),
        ...(supersededApproval === undefined ? {} : { supersededApproval }),
      },
    }
  }

  private wakeBroker(input: ApprovalResolutionInput, decision: ApprovalDecision): void {
    if (!this.deps.broker || !isResolvableApprovalBroker(this.deps.broker)) return
    try {
      this.deps.broker.resolve({
        sessionId: input.sessionId,
        runId: input.runId,
        turn: input.turn,
        toolUseId: input.toolUseId,
        decision,
      })
    } catch {
      // The durable event already won. A broker is a local wake-up mechanism,
      // so a faulty wake-up must not turn a committed decision into an error.
    }
  }
}

function approvalResourceKey(input: Pick<ApprovalResolutionInput, "sessionId" | "runId" | "turn" | "toolUseId">): string {
  return JSON.stringify([input.sessionId.toString(), input.runId.toString(), input.turn, input.toolUseId])
}

function findApprovalRequested(events: readonly AgentEvent[], input: ApprovalResolutionInput): ApprovalRequestedEvent | undefined {
  return [...events]
    .reverse()
    .find(
      (event): event is ApprovalRequestedEvent =>
        event.type === "ToolApprovalRequested" &&
        event.payload.runId === input.runId &&
        event.payload.turn === input.turn &&
        event.payload.toolUseId === input.toolUseId,
    )
}

function findApprovalResolution(events: readonly AgentEvent[], input: ApprovalResolutionInput): ApprovalResolutionEvent | undefined {
  return [...events]
    .reverse()
    .find(
      (event): event is ApprovalResolutionEvent =>
        event.type === "ToolApprovalResolved" &&
        event.payload.runId === input.runId &&
        event.payload.turn === input.turn &&
        event.payload.toolUseId === input.toolUseId,
    )
}

function findPreparedEvent(
  events: readonly AgentEvent[],
  requested: ApprovalRequestedEvent,
  input: ApprovalResolutionInput,
): Extract<AgentEvent, { type: "ToolCallPrepared" }> | undefined {
  return events.find(
    (event): event is Extract<AgentEvent, { type: "ToolCallPrepared" }> =>
      event.type === "ToolCallPrepared" &&
      event.eventId === input.preparedEventId &&
      event.payload.runId === input.runId &&
      event.payload.turn === input.turn &&
      event.payload.toolUseId === input.toolUseId &&
      event.eventId === requested.payload.preparedEventId,
  )
}

function hasApprovalTerminal(events: readonly AgentEvent[], requested: ApprovalRequestedEvent, input: ApprovalResolutionInput): boolean {
  return events.some(
    (event) =>
      (event.revision > requested.revision &&
        event.type === "ToolResultCommitted" &&
        event.payload.runId === input.runId &&
        event.payload.turn === input.turn &&
        event.payload.toolUseId === input.toolUseId) ||
      ((event.type === "RunCompleted" || event.type === "RunFailed" || event.type === "RunCancelled") &&
        event.payload.runId === input.runId),
  )
}

function staleApproval(reason: string): ApprovalResolutionError {
  return new ApprovalResolutionError("stale_approval", `stale_approval: ${reason}`)
}
