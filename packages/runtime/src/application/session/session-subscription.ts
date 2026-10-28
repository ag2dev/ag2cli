import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import type { SessionId } from "@ag2cli/core/ids.js"

export interface SessionEventListener {
  (events: readonly AgentEvent[]): void
}

export interface SessionTransientEventListener {
  (event: TransientStreamEvent): void
}

export interface SessionSubscriptionOverflow {
  readonly channel: "durable"
  readonly sessionId: SessionId
  /** The last durable revision accepted before the queue overflowed. */
  readonly cursor: number
  readonly queued: number
}

export interface SessionSubscriptionOptions {
  readonly maxQueueSize?: number
  readonly onOverflow?: (overflow: SessionSubscriptionOverflow) => void
}

export interface SessionSubscriptionHubOptions {
  readonly durableQueueSize?: number
  readonly transientQueueSize?: number
}

interface DurableSubscription {
  readonly sessionId: SessionId
  cursor: number
  readonly listener: SessionEventListener
  readonly onOverflow?: (overflow: SessionSubscriptionOverflow) => void
  readonly maxQueueSize: number
  readonly queue: AgentEvent[]
  receivedLive: boolean
  scheduled: boolean
  closed: boolean
}

interface TransientSubscription {
  readonly sessionId: SessionId
  readonly listener: SessionTransientEventListener
  readonly maxQueueSize: number
  readonly queue: TransientStreamEvent[]
  scheduled: boolean
  closed: boolean
}

const DEFAULT_DURABLE_QUEUE_SIZE = 256
const DEFAULT_TRANSIENT_QUEUE_SIZE = 128

/**
 * Transport-neutral live subscription fanout.
 *
 * Durable events are never silently discarded: a subscriber that cannot keep
 * up is closed and receives an overflow callback so its transport can ask the
 * client to resync from the durable cursor. Transient events are a display
 * optimization and may be coalesced or dropped without changing the session.
 */
export class SessionSubscriptionHub {
  private readonly durable = new Map<string, Set<DurableSubscription>>()
  private readonly transient = new Map<string, Set<TransientSubscription>>()

  constructor(private readonly options: SessionSubscriptionHubOptions = {}) {}

  subscribe(
    sessionId: SessionId,
    afterRevision: number,
    listener: SessionEventListener,
    options: SessionSubscriptionOptions = {},
  ): () => void {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new Error("Session subscription revision must be a non-negative integer")
    }
    const subscription: DurableSubscription = {
      sessionId,
      cursor: afterRevision,
      listener,
      ...(options.onOverflow ? { onOverflow: options.onOverflow } : {}),
      maxQueueSize: boundedQueueSize(options.maxQueueSize ?? this.options.durableQueueSize ?? DEFAULT_DURABLE_QUEUE_SIZE),
      queue: [],
      receivedLive: false,
      scheduled: false,
      closed: false,
    }
    const key = sessionId.toString()
    const subscriptions = this.durable.get(key) ?? new Set<DurableSubscription>()
    subscriptions.add(subscription)
    this.durable.set(key, subscriptions)
    return () => this.closeDurable(subscription)
  }

  subscribeTransient(sessionId: SessionId, listener: SessionTransientEventListener, options: SessionSubscriptionOptions = {}): () => void {
    const subscription: TransientSubscription = {
      sessionId,
      listener,
      maxQueueSize: boundedQueueSize(options.maxQueueSize ?? this.options.transientQueueSize ?? DEFAULT_TRANSIENT_QUEUE_SIZE),
      queue: [],
      scheduled: false,
      closed: false,
    }
    const key = sessionId.toString()
    const subscriptions = this.transient.get(key) ?? new Set<TransientSubscription>()
    subscriptions.add(subscription)
    this.transient.set(key, subscriptions)
    return () => this.closeTransient(subscription)
  }

  publishDurable(events: readonly AgentEvent[]): void {
    const first = events[0]
    if (!first) return
    const key = first.sessionId.toString()
    for (const subscription of [...(this.durable.get(key) ?? [])]) {
      if (subscription.closed) continue
      const visible = events.filter((event) => event.sessionId === subscription.sessionId && event.revision > subscription.cursor)
      if (visible.length === 0) continue
      // The first live batch may legitimately start above the subscription
      // cursor: the attach barrier's history read already covers everything
      // up to the barrier. Once live delivery has begun, a batch starting
      // past cursor + 1 means an intermediate publish never reached this hub,
      // so the subscriber must resync instead of silently skipping the hole.
      const firstVisible = visible[0]
      if (firstVisible !== undefined && subscription.receivedLive && firstVisible.revision > subscription.cursor + 1) {
        this.closeDurable(subscription)
        try {
          subscription.onOverflow?.({
            channel: "durable",
            sessionId: subscription.sessionId,
            cursor: subscription.cursor,
            queued: subscription.queue.length,
          })
        } catch {
          // Transport diagnostics must not affect the authoritative write.
        }
        continue
      }
      subscription.receivedLive = true
      if (subscription.queue.length + visible.length > subscription.maxQueueSize) {
        const overflow: SessionSubscriptionOverflow = {
          channel: "durable",
          sessionId: subscription.sessionId,
          cursor: subscription.cursor,
          queued: subscription.queue.length,
        }
        this.closeDurable(subscription)
        try {
          subscription.onOverflow?.(overflow)
        } catch {
          // Transport diagnostics must not affect the authoritative write.
        }
        continue
      }
      subscription.queue.push(...visible)
      subscription.cursor = visible.at(-1)!.revision
      this.scheduleDurable(subscription)
    }
  }

  publishTransient(event: TransientStreamEvent): void {
    const key = event.sessionId.toString()
    for (const subscription of [...(this.transient.get(key) ?? [])]) {
      if (subscription.closed) continue
      if (subscription.queue.length < subscription.maxQueueSize) {
        subscription.queue.push(event)
      } else {
        const index = subscription.queue.findIndex((queued) => transientCoalesceKey(queued) === transientCoalesceKey(event))
        if (index >= 0) subscription.queue[index] = event
        else continue
      }
      this.scheduleTransient(subscription)
    }
  }

  close(): void {
    for (const subscriptions of this.durable.values()) {
      for (const subscription of subscriptions) subscription.closed = true
    }
    for (const subscriptions of this.transient.values()) {
      for (const subscription of subscriptions) subscription.closed = true
    }
    this.durable.clear()
    this.transient.clear()
  }

  private scheduleDurable(subscription: DurableSubscription): void {
    if (subscription.scheduled || subscription.closed) return
    subscription.scheduled = true
    queueMicrotask(() => {
      subscription.scheduled = false
      if (subscription.closed || subscription.queue.length === 0) return
      const events = subscription.queue.splice(0)
      try {
        subscription.listener(events)
      } catch {
        // A client projection must never change the authoritative write.
      }
      this.scheduleDurable(subscription)
    })
  }

  private scheduleTransient(subscription: TransientSubscription): void {
    if (subscription.scheduled || subscription.closed) return
    subscription.scheduled = true
    queueMicrotask(() => {
      subscription.scheduled = false
      if (subscription.closed || subscription.queue.length === 0) return
      const event = subscription.queue.shift()!
      try {
        subscription.listener(event)
      } catch {
        // A live projection must not affect the authoritative run.
      }
      this.scheduleTransient(subscription)
    })
  }

  private closeDurable(subscription: DurableSubscription): void {
    if (subscription.closed) return
    subscription.closed = true
    const key = subscription.sessionId.toString()
    const subscriptions = this.durable.get(key)
    subscriptions?.delete(subscription)
    if (subscriptions?.size === 0) this.durable.delete(key)
  }

  private closeTransient(subscription: TransientSubscription): void {
    if (subscription.closed) return
    subscription.closed = true
    const key = subscription.sessionId.toString()
    const subscriptions = this.transient.get(key)
    subscriptions?.delete(subscription)
    if (subscriptions?.size === 0) this.transient.delete(key)
  }
}

function boundedQueueSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Session subscription queue size must be a positive integer")
  return value
}

function transientCoalesceKey(event: TransientStreamEvent): string {
  if (event.type === "model_text_delta") return `model:${event.payload.runId}:${event.payload.callId}`
  if (event.type === "model_tool_call_delta") return `tool:${event.payload.runId}:${event.payload.toolUseId}`
  if (event.type === "tool_output_delta") return `output:${event.payload.runId}:${event.payload.toolUseId}:${event.payload.stream}`
  return `${event.type}:${event.eventId}`
}
