/**
 * Coordinates recovery of a Session's durable event/presence subscription across a physical
 * reconnect, independent of any concrete event shape or UI framework.
 *
 * Scope: `afterRevision` cursor per Session, deduplicated/generation-guarded `session.attach`
 * (plus whatever host-specific `session.replay` merge a caller needs), and collapsing repeated
 * `session.resyncRequired` notifications into one attach. It does not touch the physical
 * connection itself -- that remains {@link ReconnectingAppServerClient}'s sole responsibility --
 * and it does not know about `AgentEvent`, `WireEvent`, or any other host-specific event type:
 * the attach result type `T` is fully opaque to this module, so both the CLI (backed by
 * `@ag2cli/core` events) and the Web client (backed by its own wire-only event shape) can share
 * this same toolkit without coupling to each other's private types.
 */

/** Performs one Session's `session.attach` (and any host-specific merge, e.g. with
 * `session.replay`) starting after the given revision, returning the Host's own result shape. */
export type SessionAttachFn<T> = (sessionId: string, afterRevision: number) => Promise<T>

export interface SessionAttachOutcome<T> {
  /**
   * `false` when a newer reconnect superseded this attach before it resolved. The caller must
   * discard `result` without publishing it -- a fresh attach for the current connection
   * generation is the caller's responsibility to (re-)issue, mirroring how
   * {@link ReconnectingAppServerClient} only replaces the physical connection and leaves
   * subscription recovery to its caller.
   */
  readonly current: boolean
  readonly result?: T
}

/**
 * Per-Session recovery state: `afterRevision` cursor, generation-guarded/deduplicated attach.
 *
 * Not exported: callers only ever interact with `SessionRecoveryToolkit`, which owns every
 * Session's state behind a `(sessionId)`-keyed API -- never exposing the internal map or its
 * key format, the same encapsulation discipline as `AppServerPresenceRegistry`'s
 * `(sessionId, scope)`-keyed lease API.
 */
export class SessionRecoveryToolkit<T> {
  private readonly cursors = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<SessionAttachOutcome<T>>>()
  private generation = 0

  constructor(private readonly attachFn: SessionAttachFn<T>) {}

  /** The highest revision this toolkit has observed for one Session, or 0 if none yet. */
  cursor(sessionId: string): number {
    return this.cursors.get(sessionId) ?? 0
  }

  /** Advances one Session's cursor from a revision observed via a live notification (not an
   * attach), e.g. `session.event`. A lower or equal revision is ignored. */
  observe(sessionId: string, revision: number): void {
    if (revision > this.cursor(sessionId)) this.cursors.set(sessionId, revision)
  }

  /**
   * Attaches (or reuses an already in-flight attach for) one Session, starting from its current
   * cursor unless `afterRevision` is given explicitly. Concurrent callers targeting the same
   * Session share one underlying attach instead of issuing redundant `session.attach` calls --
   * this is what collapses repeated `session.resyncRequired` notifications, or a
   * `resyncRequired` racing an ordinary subscribe, into a single attach.
   */
  attach(sessionId: string, afterRevision?: number): Promise<SessionAttachOutcome<T>> {
    const existing = this.inFlight.get(sessionId)
    if (existing !== undefined) return existing
    const generation = this.generation
    const from = afterRevision ?? this.cursor(sessionId)
    const promise = this.attachFn(sessionId, from).then((result) => ({ current: generation === this.generation, result }))
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

  /** True while a fresh attach for this Session is in flight (shared by concurrent callers). */
  isAttaching(sessionId: string): boolean {
    return this.inFlight.has(sessionId)
  }

  /**
   * Marks every in-flight attach as superseded (its eventual `current: false` outcome tells the
   * caller to discard it) without waiting for it to settle. Call this once a physical
   * reconnect happens (see `ReconnectingAppServerClient.onConnectionStateChange`), before
   * re-issuing `attach()` for every Session that needs to recover its subscription.
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
