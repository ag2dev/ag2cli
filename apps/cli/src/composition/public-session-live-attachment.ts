/**
 * Live public projection attachment: the composition-owned seam that turns
 * a raw durable/transient session subscription into public events. One
 * attachment owns one projector, so every attach (initial or resync)
 * starts from a clean public state. The live stream is not
 * lineage-filtered — an incremental filter cannot exist for a batch
 * transport — so a batch that moves the canonical head (rewind, branch
 * selection) is withheld and reported as a resync instead of being
 * applied onto the previous lineage, mirroring the wire replica's
 * contract.
 */
import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicTransientEvent } from "@ag2cli/app-server-protocol/dto/transient.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import { sessionId as mintSessionId, type SessionId } from "@ag2cli/core/ids.js"
import type { SessionSubscriptionHandle } from "@ag2cli/session-client/session-client.js"
import { PublicSessionProjector, projectTransientEvent } from "../interfaces/transport/public-projection.js"

/** Host subscribe face at the branded-id boundary; InProcessSessionServer satisfies it structurally. */
interface SessionHostSubscribeFace {
  subscribe(
    id: SessionId,
    afterRevision: number,
    listener: (events: readonly AgentEvent[]) => void,
    options?: { readonly onOverflow?: (overflow: { readonly cursor: number }) => void },
  ): SessionSubscriptionHandle
  subscribeTransient(id: SessionId, listener: (event: TransientStreamEvent) => void): () => void
}

/**
 * Adapt one host session to the live-attachment ports. The branded id
 * crossing stays in this module so string-addressed composition layers
 * (the TUI assembly) never import the internal id space.
 */
export function liveAttachmentPorts(sessionServer: SessionHostSubscribeFace, session: string): PublicLiveAttachmentDeps {
  const id = mintSessionId(session)
  return {
    subscribe: (listener, options) => {
      const handle = sessionServer.subscribe(id, 0, listener, options === undefined ? undefined : { onOverflow: options.onOverflow })
      return () => handle.unsubscribe()
    },
    subscribeTransient: (listener) => sessionServer.subscribeTransient(id, listener),
  }
}

export interface PublicLiveAttachmentDeps {
  /** Live durable AgentEvent subscription; may backfill from its own anchor. */
  readonly subscribe: (listener: (events: readonly AgentEvent[]) => void, options?: { readonly onOverflow?: () => void }) => () => void
  /** Optional live transient stream; absent ports mean no transient delivery. */
  readonly subscribeTransient?: (listener: (event: TransientStreamEvent) => void) => () => void
}

export interface PublicLiveAttachmentCallbacks {
  /** Public events one core batch produced, in stream order. */
  readonly onEvent: (events: readonly PublicSessionEvent[]) => void
  /** Live public transient events as projected against the active run. */
  readonly onTransient?: (event: PublicTransientEvent) => void
  /** The live projection went stale (head moved or the transport overflowed); rebuild from history. */
  readonly onResyncRequired: () => void
}

export interface PublicLiveAttachment {
  /** Detach both subscriptions; the attachment is single-use. */
  stop(): void
}

export function createPublicLiveAttachment(deps: PublicLiveAttachmentDeps, callbacks: PublicLiveAttachmentCallbacks): PublicLiveAttachment {
  const projector = new PublicSessionProjector()
  let stopped = false
  let detachDurable: (() => void) | null = null
  let detachTransient: (() => void) | null = null
  const resync = (): void => {
    if (stopped) return
    stopped = true
    detachDurable?.()
    detachDurable = null
    detachTransient?.()
    detachTransient = null
    callbacks.onResyncRequired()
  }
  detachDurable = deps.subscribe(
    (events) => {
      if (stopped) return
      // A head move redefines the active lineage; the live projector
      // cannot rebuild it incrementally, so the whole view resyncs.
      if (events.some((event) => event.type === "HeadMoved" || event.type === "BranchCreated")) {
        resync()
        return
      }
      const projected = events.flatMap((event) => projector.apply(event, { skipUnmapped: true }))
      if (projected.length > 0) callbacks.onEvent(projected)
    },
    { onOverflow: resync },
  )
  if (!stopped) {
    detachTransient =
      deps.subscribeTransient?.((event) => {
        if (stopped) return
        const publicEvent = projectTransientEvent(event, projector.activeRunId)
        if (publicEvent !== undefined) callbacks.onTransient?.(publicEvent)
      }) ?? null
  }
  return {
    stop() {
      stopped = true
      detachDurable?.()
      detachDurable = null
      detachTransient?.()
      detachTransient = null
    },
  }
}
