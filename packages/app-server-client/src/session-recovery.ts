/**
 * Coordinates recovery of a Session's durable event subscription across a physical
 * reconnect, on top of the v1 recovery face: cursor-less `session.attach` (snapshot plus
 * barrier revision) followed by `session.replay` paging while a page reports `hasMore`.
 *
 * The live cursor is advanced by the caller from the `session.event` notification's
 * envelope (`event.revision`) via {@link SessionRecoveryToolkit.observe}. This module
 * stays independent of any concrete event or snapshot shape: the attach result only has
 * to expose `barrierRevision`, replay pages expose the paging fields, and events only
 * need their envelope identity, so the CLI and the Web client can share it without
 * coupling to each other's private types.
 */

/** Minimum surface of a v1 `session.attach` result this toolkit depends on. */
export interface RecoveryAttachResult {
  readonly barrierRevision: number
}

/** Minimum envelope surface of a durable event this toolkit depends on. */
export interface RecoveryEventEnvelope {
  readonly eventId: string
  readonly revision: number
}

/** Minimum surface of a v1 `session.replay` result page this toolkit depends on. */
export interface RecoveryReplayPage<E extends RecoveryEventEnvelope> {
  readonly events: readonly E[]
  readonly scannedThroughRevision: number
  readonly nextAfterRevision?: number
  readonly hasMore: boolean
}

/** Host-supplied recovery RPCs: one cursor-less attach plus on-demand replay paging. */
export interface SessionRecoveryRpc<A extends RecoveryAttachResult, E extends RecoveryEventEnvelope> {
  attach(sessionId: string): Promise<A>
  replay(sessionId: string, afterRevision: number): Promise<RecoveryReplayPage<E>>
}

export interface SessionRecoveryOutcome<A, E> {
  /**
   * `false` when a newer reconnect superseded this recovery before it resolved. The caller
   * must discard the outcome without publishing it -- re-issuing `attach()` for the current
   * connection generation is the caller's responsibility, mirroring how
   * {@link ReconnectingAppServerClient} only replaces the physical connection.
   */
  readonly current: boolean
  readonly attach?: A
  /** Replay backfill strictly after the pre-attach cursor, deduplicated by eventId. */
  readonly events: readonly E[]
}

/**
 * Per-Session recovery state: cursor, generation-guarded/deduplicated attach+replay.
 *
 * Callers only ever interact with this class, which owns every Session's state behind a
 * `(sessionId)`-keyed API -- never exposing the internal maps, the same encapsulation
 * discipline as `AppServerPresenceRegistry`'s `(sessionId, scope)`-keyed lease API.
 */
export class SessionRecoveryToolkit<A extends RecoveryAttachResult, E extends RecoveryEventEnvelope> {
  private readonly cursors = new Map<string, number>()
  // Deliberately hand-rolled: the in-flight guard evicts on every settle
  // — each attach is re-issuable, the opposite of a memoizing
  // once-guard — and outcomes are stamped with the connection
  // generation at issue time; and this public client toolkit stays free
  // of the runtime package so remote clients depend on the protocol
  // only.
  private readonly inFlight = new Map<string, Promise<SessionRecoveryOutcome<A, E>>>()
  private generation = 0

  constructor(private readonly rpc: SessionRecoveryRpc<A, E>) {}

  /** The highest revision this toolkit has observed for one Session, or 0 if none yet. */
  cursor(sessionId: string): number {
    return this.cursors.get(sessionId) ?? 0
  }

  /** Advances one Session's cursor from a revision observed via a live notification
   * (`session.event`'s `event.revision`). A lower or equal revision is ignored. */
  observe(sessionId: string, revision: number): void {
    if (revision > this.cursor(sessionId)) this.cursors.set(sessionId, revision)
  }

  /**
   * Attaches (or reuses an already in-flight recovery for) one Session, then replays pages
   * from the current cursor while the Host reports `hasMore`. Concurrent callers targeting
   * the same Session share one underlying recovery instead of issuing redundant calls --
   * this is what collapses repeated `session.resyncRequired` notifications, or a
   * `resyncRequired` racing an ordinary subscribe, into a single recovery.
   */
  attach(sessionId: string): Promise<SessionRecoveryOutcome<A, E>> {
    const existing = this.inFlight.get(sessionId)
    if (existing !== undefined) return existing
    const generation = this.generation
    const promise = this.recover(sessionId).then((outcome) => (generation === this.generation ? outcome : { ...outcome, current: false }))
    this.inFlight.set(sessionId, promise)
    // Cleanup rides both settle paths explicitly: `.finally()` derives a new
    // promise that adopts a rejection (e.g. the shared in-flight attach failing
    // with `client_closed` at teardown), and voiding that derived promise leaks
    // an unhandled rejection into the process. Two `.then` handlers leave no
    // unobserved derived rejection.
    const cleanup = (): void => {
      if (this.inFlight.get(sessionId) === promise) this.inFlight.delete(sessionId)
    }
    void promise.then(cleanup, cleanup)
    return promise
  }

  private async recover(sessionId: string): Promise<SessionRecoveryOutcome<A, E>> {
    // The cursor at attach time is the only trustworthy replay floor. Live
    // notifications observed during the attach window advance the cursor past
    // revisions that were never delivered contiguously (e.g. after a queue
    // overflow), so paging from the live cursor would skip exactly the gap
    // the replay exists to backfill.
    const preAttachCursor = this.cursor(sessionId)
    const attach = await this.rpc.attach(sessionId)
    if (preAttachCursor >= attach.barrierRevision) return { current: true, attach, events: [] }
    const events = new Map<string, E>()
    let after = preAttachCursor
    for (;;) {
      const page = await this.rpc.replay(sessionId, after)
      for (const event of page.events) events.set(event.eventId, event)
      // Every page reports how far the host scanned, terminal or not.
      this.observe(sessionId, page.scannedThroughRevision)
      // A page that claims more but offers no forward cursor would loop forever.
      if (!page.hasMore || page.nextAfterRevision === undefined || page.nextAfterRevision <= after) break
      after = page.nextAfterRevision
    }
    return { current: true, attach, events: [...events.values()] }
  }

  /** True while a fresh recovery for this Session is in flight (shared by concurrent callers). */
  isAttaching(sessionId: string): boolean {
    return this.inFlight.has(sessionId)
  }

  /**
   * Marks every in-flight recovery as superseded (its eventual `current: false` outcome
   * tells the caller to discard it) without waiting for it to settle. Call this once a
   * physical reconnect happens (see `ReconnectingAppServerClient.onConnectionStateChange`),
   * before re-issuing `attach()` for every Session that needs to recover its subscription.
   */
  reconnected(): void {
    this.generation += 1
    this.inFlight.clear()
  }

  /** Drops all tracked state for one Session, e.g. once it is detached or archived. */
  forget(sessionId: string): void {
    this.cursors.delete(sessionId)
    this.inFlight.delete(sessionId)
  }
}
