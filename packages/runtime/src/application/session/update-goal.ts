import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import { updateSessionGoal, type SessionGoal, type SessionGoalUpdate } from "@ag2cli/core/session/session-goal.js"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import type { EventStore } from "../../ports/event-store.js"
import { commandIdempotencyConflictError, resolveCommandIdempotency, type CommandIdempotencyFamily } from "./command-idempotency.js"
import { appendSessionEventsIfRevision } from "./revision-conflict.js"
import type { SessionAuthority } from "./session-authority.js"

/**
 * `SessionGoalUpdated` persists the *resulting* `SessionGoal`, not the request's
 * `SessionGoalUpdate` verb, so the fingerprint compared here is the projected
 * outcome (`updateSessionGoal(priorGoal, update).goal`) rather than the raw
 * update. `updateSessionGoal` is a pure, idempotent function of
 * `(priorGoal, action)`, so re-projecting against the *current* (post-anchor)
 * snapshot and comparing to what was actually recorded correctly distinguishes
 * "same update retried" (projects back to the same recorded goal) from "a
 * different update reused this commandId" (projects to a different goal).
 */
export const GOAL_FAMILY: CommandIdempotencyFamily<SessionGoal> = {
  family: "update_goal",
  findAnchor: (events, commandId) => {
    const anchor = events.find(
      (event): event is Extract<AgentEvent, { type: "SessionGoalUpdated" }> =>
        event.type === "SessionGoalUpdated" && event.trace.traceId === `session-goal:${commandId}`,
    )
    return anchor === undefined ? undefined : { event: anchor, inputFingerprint: anchor.payload }
  },
}

export interface UpdateSessionGoalInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly update: SessionGoalUpdate
}

export interface UpdateSessionGoalResult {
  readonly changed: boolean
  readonly goal: SessionGoal
}

export interface UpdateSessionGoalDependencies {
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly identity: {
    nextEventId(): string
    now(): string
  }
  readonly onEventsAppended?: (events: readonly AgentEvent[]) => Promise<void> | void
}

/** Persist the user-owned session goal in the same event stream as all session state. */
export class UpdateSessionGoalUseCase {
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly deps: UpdateSessionGoalDependencies) {}

  async execute(input: UpdateSessionGoalInput): Promise<UpdateSessionGoalResult> {
    validateCommandId(input.commandId)
    const previous = this.pending.get(input.sessionId.toString())
    const operation = (previous ?? Promise.resolve()).then(() => this.executeNow(input))
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    )
    this.pending.set(input.sessionId.toString(), tracked)
    try {
      return await operation
    } finally {
      if (this.pending.get(input.sessionId.toString()) === tracked) this.pending.delete(input.sessionId.toString())
    }
  }

  private async executeNow(input: UpdateSessionGoalInput): Promise<UpdateSessionGoalResult> {
    const events = await this.deps.eventStore.read(input.sessionId)
    if (events.length === 0) throw new Error("The current Session has not been initialized; send a message first")
    const snapshot = replaySession(events)
    const change = updateSessionGoal(snapshot.goal, input.update)
    const idempotency = resolveCommandIdempotency(GOAL_FAMILY, events, {
      family: GOAL_FAMILY.family,
      commandId: input.commandId,
      inputFingerprint: change.goal,
    })
    if (idempotency.status === "conflict") throw commandIdempotencyConflictError(idempotency.record)
    if (idempotency.status === "replay")
      return {
        changed: true,
        goal: idempotency.terminal.payload as SessionGoal,
      }
    if (!change.changed) return change

    const eventId = this.deps.identity.nextEventId()
    const event: AgentEvent = {
      eventId,
      sessionId: input.sessionId,
      revision: events.length + 1,
      type: "SessionGoalUpdated",
      timestamp: this.deps.identity.now(),
      trace: {
        traceId: `session-goal:${input.commandId}`,
        operationId: `session-goal:${input.commandId}`,
      },
      payload: change.goal,
    }
    await appendSessionEventsIfRevision({
      eventStore: this.deps.eventStore,
      authority: this.deps.authority,
      sessionId: input.sessionId,
      expectedRevision: events.length,
      events: [event],
      onEventsAppended: this.deps.onEventsAppended,
    })
    return change
  }
}

function validateCommandId(commandId: string): void {
  if (commandId.trim().length === 0) throw new Error("commandId must not be empty")
}
