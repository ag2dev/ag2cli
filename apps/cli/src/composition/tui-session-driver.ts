/**
 * Session driver: the composition-owned event loop connecting an embedded
 * session to the projection ingress. The durable subscription attaches
 * BEFORE the backlog read and buffers, so events published while adoption
 * is in flight are never lost (transports that backfill from the anchor
 * simply fill the buffer). One shared ingress carries run state across
 * the adoption boundary; buffered events route by provenance — overlap
 * with the backlog replays cardless, genuinely new gap events deliver
 * live — and the projection watermark dedups the durable overlap.
 * Resync rebuilds the projection from history: the ingress drops its own
 * bookkeeping AND the writer's watermark before the backlog replays.
 */
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import type { TuiIngress, TuiIngressFact } from "./tui-ingress.js"

export interface TuiSessionDriverOptions {
  /** The projection ingress every event flows through. */
  readonly ingress: TuiIngress
  /** Host-level facts the ingress returns (live approvals, context usage). */
  readonly onFacts: (facts: readonly TuiIngressFact[]) => void
  /**
   * The projection may have moved (a durable batch, a transient batch,
   * a resync reset); the host re-mirrors content on this signal.
   */
  readonly onApplied?: () => void
  /** Canonical backlog reader; absent means live-only (fresh session). */
  readonly readEvents?: (fromRevision: number) => Promise<readonly AgentEvent[]>
  /** Live durable subscription; may backfill from its own anchor. */
  readonly subscribe: (listener: (events: readonly AgentEvent[]) => void) => () => void
  /** Optional live transient stream subscription. */
  readonly subscribeTransient?: (listener: (event: TransientStreamEvent) => void) => () => void
  /** Backlog-read failure surface; the loop keeps running live-only. */
  readonly onAdoptionFailure?: (error: unknown) => void
}

export interface TuiSessionDriver {
  /** Attach subscriptions, then adopt history, then flip to live. */
  start(): Promise<void>
  /** Rebuild the projection from canonical history after a subscription gap. */
  resync(): Promise<void>
  /** Detach subscriptions and cancel a pending adoption. */
  stop(): void
}

export function createTuiSessionDriver(options: TuiSessionDriverOptions): TuiSessionDriver {
  const ingress = options.ingress
  const buffer: AgentEvent[] = []
  let delivering = false
  let stopped = false
  let started = false
  let detachDurable: (() => void) | null = null
  let detachTransient: (() => void) | null = null
  let resyncPromise: Promise<void> | undefined

  const deliver = (events: readonly AgentEvent[]): void => {
    if (stopped) return
    const facts = events.flatMap((event) => ingress.durable(event))
    if (facts.length > 0) options.onFacts(facts)
    options.onApplied?.()
  }

  const receiveDurable = (events: readonly AgentEvent[]): void => {
    if (delivering) deliver(events)
    else buffer.push(...events)
  }

  /** Replay the backlog plus buffered overlap cardless, then flip to live. */
  const adopt = async (): Promise<void> => {
    const backlog = await options.readEvents!(0)
    if (stopped) return
    const tail = backlog.at(-1)?.revision ?? 0
    delivering = true
    deliver(backlog)
    const buffered = buffer.splice(0)
    // Overlap replays cardless; gap events are genuinely new.
    deliver(buffered.filter((event) => event.revision <= tail))
    ingress.setReplayMode(false)
    deliver(buffered.filter((event) => event.revision > tail))
  }

  return {
    async start() {
      if (started || stopped) return
      started = true
      // Attach before reading: events published during the backlog await
      // land in the buffer instead of vanishing.
      detachDurable = options.subscribe(receiveDurable)
      detachTransient =
        options.subscribeTransient?.((event) => {
          if (stopped) return
          ingress.transient(event)
          options.onApplied?.()
        }) ?? null
      if (options.readEvents !== undefined) {
        try {
          await adopt()
        } catch (error) {
          if (stopped) return
          options.onAdoptionFailure?.(error)
          delivering = true
          // Provenance unknown: history-shaped is the safe default, so
          // the buffered batch lands cardless before the live flip.
          deliver(buffer.splice(0))
          ingress.setReplayMode(false)
        }
      }
      if (stopped) return
      ingress.setReplayMode(false)
      delivering = true
      deliver(buffer.splice(0))
    },
    async resync() {
      if (stopped || options.readEvents === undefined || resyncPromise !== undefined) return resyncPromise
      resyncPromise = (async () => {
        delivering = false
        detachDurable?.()
        detachDurable = options.subscribe(receiveDurable)
        buffer.length = 0
        ingress.resetProjection()
        ingress.setReplayMode(true)
        try {
          await adopt()
        } catch (error) {
          if (stopped) return
          options.onAdoptionFailure?.(error)
          ingress.setReplayMode(false)
          delivering = true
          deliver(buffer.splice(0))
        } finally {
          delivering = true
        }
      })().finally(() => {
        resyncPromise = undefined
      })
      return resyncPromise
    },
    stop() {
      stopped = true
      detachDurable?.()
      detachDurable = null
      detachTransient?.()
      detachTransient = null
    },
  }
}
