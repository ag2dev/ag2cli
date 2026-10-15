import type { EventTrace } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import type { SessionId } from "@ag2cli/core/ids.js"

export interface TransientEventIdentity {
  nextEventId(): string
  now(): string
}

type TransientType = TransientStreamEvent["type"]
type TransientPayload<TType extends TransientType> = Extract<TransientStreamEvent, { type: TType }>["payload"]

/**
 * Creates best-effort live events for one runtime producer.
 *
 * The session transport may normalize sequence numbers when several producers
 * share a session. The runtime-local counter keeps direct use-case consumers
 * deterministic without coupling the use cases to a transport implementation.
 */
export class TransientEventPublisher {
  private readonly sequences = new Map<string, number>()

  constructor(
    private readonly identity: TransientEventIdentity,
    private readonly listener?: (event: TransientStreamEvent) => void,
  ) {}

  emit<TType extends TransientType>(sessionId: SessionId, trace: EventTrace, type: TType, payload: TransientPayload<TType>): void {
    if (!this.listener) return
    const key = sessionId.toString()
    const sequence = (this.sequences.get(key) ?? 0) + 1
    this.sequences.set(key, sequence)
    try {
      this.listener({
        eventId: this.identity.nextEventId(),
        sessionId,
        sequence,
        type,
        timestamp: this.identity.now(),
        trace,
        payload,
      } as Extract<TransientStreamEvent, { type: TType }>)
    } catch {
      // Live projections are observers and must not change the run outcome.
    }
  }
}
