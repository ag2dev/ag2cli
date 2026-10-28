/**
 * In-process projection adapter: the single seam through which embedded
 * consumers (headless run first, the TUI next) observe the public session
 * contract without crossing a JSON-RPC message boundary. The ports are
 * function-level on purpose — no JsonRpcMessage is constructed, nothing
 * flows through the in-process app server, and no transport codec runs — so
 * the in-process face and the wire face stay two projections of one
 * projector. The attach asymmetry is the wire contract's: backlog replay
 * is strict (an unmapped core event fails the attach), while the live
 * stream drains with skipUnmapped so a newly introduced informational
 * event cannot kill a running consumer.
 */
import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicSessionSnapshot } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type { PublicTransientEvent } from "@ag2cli/app-server-protocol/dto/transient.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import { PublicSessionProjector, projectTransientEvent, type ProjectionContext } from "../interfaces/transport/public-projection.js"

/** Durable-subscription gap signal; the cursor is the last revision the transport kept. */
export interface PublicSessionAdapterOverflow {
  readonly cursor: number
}

/**
 * Function-level session ports. A composition root wires them from its own
 * session client: readEvents from execute(readEventsCommand(from)) and
 * readSnapshot from execute(getSnapshotCommand()); the subscription anchor
 * is the caller's — the adapter's own revision dedup makes any anchor safe.
 */
export interface PublicSessionAdapterDeps {
  /** Live durable AgentEvent subscription; may backfill from its own anchor. */
  readonly subscribe: (
    listener: (events: readonly AgentEvent[]) => void,
    options?: { readonly onOverflow?: (overflow: PublicSessionAdapterOverflow) => void },
  ) => () => void
  /** Optional live transient stream; absent ports mean no transient delivery. */
  readonly subscribeTransient?: (listener: (event: TransientStreamEvent) => void) => () => void
  /** Canonical backlog reader (full durable history from the given revision). */
  readonly readEvents: (fromRevision: number) => Promise<readonly AgentEvent[]>
  /** Authoritative session-level reducer facts the projector cannot derive. */
  readonly readSnapshot: () => Promise<SessionSnapshot>
  /** Host-level facts (title/workspace/selectableModes) for snapshot assembly. */
  readonly context: ProjectionContext
}

export interface PublicSessionAdapterCallbacks {
  /** Public durable events one core event produced, in stream order. */
  readonly onEvent: (events: readonly PublicSessionEvent[]) => void
  /** Live public transient events as projected against the active run. */
  readonly onTransient?: (event: PublicTransientEvent) => void
  /** The live projection went stale; re-attach (start) from minimumRevision. */
  readonly onResyncRequired: (gap: { readonly minimumRevision: number }) => void
}

export interface PublicSessionAttachment {
  readonly snapshot: PublicSessionSnapshot
  readonly barrierRevision: number
}

export interface PublicSessionAdapter {
  /** Attach live: subscribe first, replay the backlog strictly, answer the
   * barrier snapshot, then drain what buffered during the replay. Each call
   * detaches any previous attachment first, like the wire attach face. */
  start(): Promise<PublicSessionAttachment>
  /** Re-assemble the public snapshot from the live projector state and the
   * authoritative internal snapshot — the same assembly the wire face uses. */
  currentSnapshot(): Promise<PublicSessionSnapshot>
  /** Detach the live subscription; the adapter can attach again via start. */
  stop(): void
}

export function createPublicSessionAdapter(deps: PublicSessionAdapterDeps, callbacks: PublicSessionAdapterCallbacks): PublicSessionAdapter {
  let projector = new PublicSessionProjector()
  let detachDurable: (() => void) | null = null
  let detachTransient: (() => void) | null = null
  // Attachments are generational: an overflow or failure from a superseded
  // attachment (a re-attach or stop() already replaced it) must not detach
  // the current one or signal resync for a projection no longer in use.
  let generation = 0

  const detach = (): void => {
    detachDurable?.()
    detachDurable = null
    detachTransient?.()
    detachTransient = null
  }

  return {
    async start() {
      detach()
      const attachmentGeneration = ++generation
      const replayProjector = new PublicSessionProjector()
      const durableBuffer: AgentEvent[] = []
      const transientBuffer: TransientStreamEvent[] = []
      let ready = false
      const emitDurable = (events: readonly AgentEvent[]): void => {
        for (const event of events) {
          const publicEvents = replayProjector.apply(event, { skipUnmapped: true })
          if (publicEvents.length > 0) callbacks.onEvent(publicEvents)
        }
      }
      const emitTransient = (event: TransientStreamEvent): void => {
        const publicEvent = projectTransientEvent(event, replayProjector.activeRunId)
        if (publicEvent !== undefined) callbacks.onTransient?.(publicEvent)
      }
      detachDurable = deps.subscribe(
        (events) => {
          if (!ready) durableBuffer.push(...events)
          else emitDurable(events)
        },
        {
          onOverflow: ({ cursor }) => {
            if (attachmentGeneration !== generation) return
            detach()
            callbacks.onResyncRequired({ minimumRevision: cursor + 1 })
          },
        },
      )
      detachTransient =
        deps.subscribeTransient?.((event) => {
          if (!ready) transientBuffer.push(event)
          else emitTransient(event)
        }) ?? null
      try {
        const internal = await deps.readSnapshot()
        const events = await deps.readEvents(0)
        for (const event of events) replayProjector.apply(event)
        const barrierRevision = replayProjector.currentRevision
        const assembled = replayProjector.snapshot(internal, deps.context)
        if (attachmentGeneration !== generation) {
          // A stop() or re-attach superseded this attachment mid-replay; its
          // snapshot must not adopt the live state of a newer attachment.
          throw new Error("The session attachment was superseded")
        }
        ready = true
        projector = replayProjector
        emitDurable(durableBuffer)
        for (const event of transientBuffer) emitTransient(event)
        return { snapshot: { ...assembled, asOfRevision: barrierRevision }, barrierRevision }
      } catch (error) {
        if (attachmentGeneration === generation) detach()
        throw error
      }
    },
    async currentSnapshot() {
      const internal = await deps.readSnapshot()
      return { ...projector.snapshot(internal, deps.context), asOfRevision: projector.currentRevision }
    },
    stop() {
      generation++
      detach()
    },
  }
}
