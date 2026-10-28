import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { EventStore } from "../../ports/event-store.js"
import { OrderedLane } from "../../concurrency/ordered-lane.js"
import { appendSessionEventsIfRevision, SessionRevisionConflictError } from "./revision-conflict.js"
import type { SessionAuthority } from "./session-authority.js"

export interface EnqueueSessionNotificationInput {
  readonly sessionId: SessionId
  readonly text: string
}

export interface EnqueueSessionNotificationResult {
  readonly inputId: string
  readonly commandId: string
}

export interface EnqueueSessionNotificationDependencies {
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly identity: {
    nextEventId(): string
    now(): string
  }
  readonly onEventsAppended?: (events: readonly AgentEvent[], replayed: boolean) => Promise<void> | void
}

const CAS_ATTEMPTS = 3

/**
 * Append a host-side completion notification as a pending canonical input.
 *
 * The notification is a best-effort projection for the model's next run: it
 * never starts a run by itself and stays invisible to the model until a run
 * consumes it. This is a host-side injection seam, not a public protocol
 * command. Revision races against the main loop are retried with fresh reads;
 * exhaustion surfaces the structured `SessionRevisionConflictError` so the
 * caller can log and drop this one notification without losing any durable
 * state.
 */
export class EnqueueSessionNotificationUseCase {
  private readonly lane = new OrderedLane<string>()

  constructor(private readonly deps: EnqueueSessionNotificationDependencies) {}

  async execute(input: EnqueueSessionNotificationInput): Promise<EnqueueSessionNotificationResult> {
    if (input.text.trim().length === 0) throw new Error("notification text must not be empty")
    return this.lane.run(input.sessionId.toString(), () => this.executeNow(input))
  }

  private async executeNow(input: EnqueueSessionNotificationInput): Promise<EnqueueSessionNotificationResult> {
    const commandId = `host-notification:${this.deps.identity.nextEventId()}`
    const inputId = `input:${commandId}`
    for (let attempt = 1; ; attempt += 1) {
      const events = await this.deps.eventStore.read(input.sessionId)
      if (events.length === 0) throw new Error("The current Session has not been initialized; send a message first")
      const event: AgentEvent = {
        eventId: this.deps.identity.nextEventId(),
        sessionId: input.sessionId,
        revision: events.length + 1,
        type: "InputAccepted",
        timestamp: this.deps.identity.now(),
        trace: { traceId: `session-notification:${commandId}`, operationId: `session-notification:${commandId}` },
        payload: {
          inputId,
          commandId,
          kind: "notification",
          text: input.text,
          delivery: "fifo",
        },
      }
      try {
        await appendSessionEventsIfRevision({
          eventStore: this.deps.eventStore,
          authority: this.deps.authority,
          sessionId: input.sessionId,
          expectedRevision: events.length,
          events: [event],
          onEventsAppended: this.deps.onEventsAppended,
        })
        return { inputId, commandId }
      } catch (error) {
        if (!(error instanceof SessionRevisionConflictError)) throw error
        if (attempt >= CAS_ATTEMPTS) throw error
      }
    }
  }
}
