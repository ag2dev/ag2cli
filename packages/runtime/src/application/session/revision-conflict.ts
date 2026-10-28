import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { EventStore } from "../../ports/event-store.js"
import { commitSessionEvents, SessionAuthority } from "./session-authority.js"

/** A durable event append lost a concurrent revision race. */
export class SessionRevisionConflictError extends Error {
  readonly code = "revision_conflict"

  constructor(
    readonly sessionId: SessionId,
    readonly expectedRevision: number,
  ) {
    super(`Session revision has changed: expected ${expectedRevision}`)
    this.name = "SessionRevisionConflictError"
  }
}

/**
 * Commit a contiguous batch with a durable compare-and-swap and only publish
 * the post-commit callback after the CAS succeeds.
 */
export async function appendSessionEventsIfRevision(input: {
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly sessionId: SessionId
  readonly expectedRevision: number
  readonly events: readonly AgentEvent[]
  readonly onEventsAppended?: (events: readonly AgentEvent[], replayed: boolean) => Promise<void> | void
}): Promise<void> {
  const authority = input.authority ?? new SessionAuthority(input.eventStore)
  try {
    await commitSessionEvents({
      authority,
      expectedRevision: input.expectedRevision,
      events: input.events,
      onCommitted: input.onEventsAppended,
    })
  } catch (error) {
    if (error instanceof SessionRevisionConflictError) throw error
    throw error
  }
}
