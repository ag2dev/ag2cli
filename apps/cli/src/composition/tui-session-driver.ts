/**
 * Session driver: the composition-owned event loop connecting an embedded
 * session to the projection ingress. The live attachment subscribes
 * BEFORE the backlog read and buffers, so events published while adoption
 * is in flight are never lost (transports that backfill from the anchor
 * simply fill the buffer). One shared ingress carries run state across
 * the adoption boundary; buffered events route by provenance — overlap
 * with the backlog replays cardless, genuinely new gap events deliver
 * live — and the projection watermark dedups the durable overlap.
 * Resync rebuilds the projection from history: the ingress drops its own
 * bookkeeping AND the writer's watermark before the backlog replays.
 * A live batch that moves the canonical head cannot be applied onto the
 * previous lineage incrementally, so the attachment withholds it and
 * this loop rebuilds from the lineage-filtered backlog instead.
 * Unknown event types classify by the criticality the envelope carries:
 * informational ones ride the ingress (whose watermark advances before
 * the closed type map drops them), a live critical one rebuilds from
 * history first, and a critical one that survived the rebuild leaves
 * the session unprojectable — reported as a degradation the caller must
 * answer by refusing every mutation.
 */
import { isKnownPublicSessionEventType, type PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicTransientEvent } from "@ag2cli/app-server-protocol/dto/transient.js"
import type { TuiIngress, TuiIngressFact } from "./tui-projection-pump.js"

/** Live-stream callbacks the driver hands to the attach wiring. */
export interface TuiSessionDriverLiveCallbacks {
  /** Public events one durable batch produced, in stream order. */
  readonly onEvent: (events: readonly PublicSessionEvent[]) => void
  /** Live public transient events. */
  readonly onTransient?: (event: PublicTransientEvent) => void
  /** The live projection went stale (head moved or overflow); rebuild from history. */
  readonly onResyncRequired: () => void
}

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
  /**
   * Live public projection attach: subscribes durable and transient
   * streams against a fresh projector and reports head moves as
   * resync-required instead of applying them.
   */
  readonly attach: (callbacks: TuiSessionDriverLiveCallbacks) => { stop(): void }
  /** Lineage-filtered public backlog reader; absent means live-only. */
  readonly readPublicEvents?: () => Promise<readonly PublicSessionEvent[]>
  /** Durable public event observation (embedded session port wiring). */
  readonly onEvents?: (events: readonly PublicSessionEvent[]) => void
  /**
   * The replayed history became (or stopped being) projectable: an
   * unknown critical event that survived a rebuild degrades the session
   * read-only; only a clean rebuild clears it again.
   */
  readonly onDegradationChange?: (degraded: boolean) => void
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
  const buffer: PublicSessionEvent[] = []
  let delivering = false
  let stopped = false
  let started = false
  let attachment: { stop(): void } | null = null
  let resyncPromise: Promise<void> | undefined
  let degraded = false

  const setDegraded = (next: boolean): void => {
    if (degraded === next) return
    degraded = next
    options.onDegradationChange?.(next)
  }

  /**
   * One batch through the intake. Replay batches carry history
   * provenance: an unknown critical event there already survived a
   * rebuild, while a live one gets exactly that rebuild first. Returns
   * whether a replay batch held an unprojectable event.
   */
  const deliver = (events: readonly PublicSessionEvent[], replay: boolean): boolean => {
    if (stopped) return false
    options.onEvents?.(events)
    const facts: TuiIngressFact[] = []
    let unprojectable = false
    for (const event of events) {
      // A missing or unrecognized criticality never reads as safe: only
      // an explicit informational envelope may ride the skip path.
      if (isKnownPublicSessionEventType(event.type) || event.criticality === "informational") {
        const produced = ingress.durable(event)
        if (produced.length > 0) facts.push(...produced)
        continue
      }
      unprojectable = true
    }
    if (facts.length > 0) options.onFacts(facts)
    options.onApplied?.()
    if (unprojectable && !replay) void resync()
    return unprojectable && replay
  }

  const receiveDurable = (events: readonly PublicSessionEvent[]): void => {
    if (delivering) deliver(events, false)
    else buffer.push(...events)
  }

  /** Replay the backlog plus buffered overlap cardless, then flip to live. */
  const adopt = async (): Promise<void> => {
    const backlog = await options.readPublicEvents!()
    if (stopped) return
    const tail = backlog.at(-1)?.revision ?? 0
    delivering = true
    const unprojectable = deliver(backlog, true)
    const buffered = buffer.splice(0)
    // Overlap replays cardless; gap events are genuinely new.
    const overlapUnprojectable = deliver(
      buffered.filter((event) => event.revision <= tail),
      true,
    )
    ingress.setReplayMode(false)
    deliver(
      buffered.filter((event) => event.revision > tail),
      false,
    )
    // Degradation recomputes per rebuild: a replayed history the
    // projection cannot hold degrades the session read-only, and only
    // a clean rebuild clears it again.
    setDegraded(unprojectable || overlapUnprojectable)
  }

  const attachLive = (): void => {
    attachment = options.attach({
      onEvent: receiveDurable,
      onTransient: (event) => {
        if (stopped) return
        ingress.transient(event)
        options.onApplied?.()
      },
      onResyncRequired: () => {
        void resync()
      },
    })
  }

  const detachLive = (): void => {
    attachment?.stop()
    attachment = null
  }

  const resync = async (): Promise<void> => {
    if (stopped || options.readPublicEvents === undefined || resyncPromise !== undefined) return resyncPromise
    resyncPromise = (async () => {
      delivering = false
      detachLive()
      attachLive()
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
        // History-shaped is the safe default for provenance-unknown
        // events; an unprojectable one degrades rather than resyncing
        // against a history that just failed to read.
        if (deliver(buffer.splice(0), true)) setDegraded(true)
      } finally {
        delivering = true
      }
    })().finally(() => {
      resyncPromise = undefined
    })
    return resyncPromise
  }

  return {
    async start() {
      if (started || stopped) return
      started = true
      // Attach before reading: events published during the backlog await
      // land in the buffer instead of vanishing.
      attachLive()
      if (options.readPublicEvents !== undefined) {
        try {
          await adopt()
        } catch (error) {
          if (stopped) return
          options.onAdoptionFailure?.(error)
          delivering = true
          // Provenance unknown: history-shaped is the safe default, so
          // the buffered batch lands cardless before the live flip, and
          // an unprojectable event degrades instead of resyncing
          // against the history that just failed to read.
          if (deliver(buffer.splice(0), true)) setDegraded(true)
          ingress.setReplayMode(false)
        }
      }
      if (stopped) return
      ingress.setReplayMode(false)
      delivering = true
      deliver(buffer.splice(0), false)
    },
    resync,
    stop() {
      stopped = true
      detachLive()
    },
  }
}
