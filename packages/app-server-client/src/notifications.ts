import type { JsonRpcNotification, JsonValue } from "@ag2cli/app-server-protocol/types.js"
import { APP_SERVER_NOTIFICATION_METHODS, isAppServerTransientEventKind } from "@ag2cli/app-server-protocol/types.js"
import type { PublicSessionEvent, PublicSessionEventEnvelope } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicTransientEvent } from "@ag2cli/app-server-protocol/dto/transient.js"
import type {
  AppServerSessionEventNotificationParams,
  InteractionLeaseUpdatedNotificationParams,
  PresenceUpdatedNotificationParams,
  SessionResyncRequiredNotificationParams,
  SessionTransientNotificationParams,
} from "@ag2cli/app-server-protocol/dto/notifications.js"
import { parseAppServerNotificationParams } from "@ag2cli/app-server-protocol/validation.js"

/**
 * Single classification point for server-to-client notifications: every v1
 * notification is runtime-parsed here and handed to the consumer as one typed
 * category. Unknown-but-safe input (an unknown notification method, an
 * unknown transient kind, an unknown informational event type) classifies to
 * a skip, while a malformed payload of a known shape throws the protocol
 * package's `invalid_params` error -- a server violation is never guessed at.
 */

/**
 * A durable event whose `type` is outside the shipped catalog and whose
 * criticality is critical: the consumer cannot interpret it, so the safe
 * response is a resync. The raw payload rides along for diagnostics. This is
 * a toolkit-local type, not a contract artifact.
 */
export interface UnknownCriticalEvent {
  readonly envelope: PublicSessionEventEnvelope
  readonly raw: JsonValue
}

export type ClassifiedAppServerNotification =
  | { readonly kind: "session.event"; readonly event: PublicSessionEvent }
  | { readonly kind: "session.transient"; readonly event: PublicTransientEvent }
  /**
   * An unknown informational event type: skipped for rendering, but the
   * envelope is preserved so the consumer can still advance its revision
   * cursor without feeling the gap.
   */
  | { readonly kind: "unknown-informational-event"; readonly envelope: PublicSessionEventEnvelope }
  | { readonly kind: "unknown-critical-event"; readonly event: UnknownCriticalEvent }
  | { readonly kind: "session.resyncRequired"; readonly params: SessionResyncRequiredNotificationParams }
  | { readonly kind: "presence.updated"; readonly params: PresenceUpdatedNotificationParams }
  | { readonly kind: "interaction.lease.updated"; readonly params: InteractionLeaseUpdatedNotificationParams }

const KNOWN_NOTIFICATION_METHODS: ReadonlySet<string> = new Set(APP_SERVER_NOTIFICATION_METHODS)

export function classifyAppServerNotification(notification: JsonRpcNotification): ClassifiedAppServerNotification | undefined {
  if (!KNOWN_NOTIFICATION_METHODS.has(notification.method)) return undefined
  // The transient parser is strict, but the wire contract makes unknown
  // transient kinds safely ignorable: peek at the kind first so a newer Host's
  // new stream kind costs an older client live detail, never the stream.
  if (notification.method === "session.transient" && carriesUnknownTransientKind(notification.params)) return undefined
  // The registry parses to `unknown` by design; each branch below is the one
  // place its result meets the param type the method's parser guarantees.
  switch (notification.method) {
    case "session.event": {
      const params = parseAppServerNotificationParams(notification.method, notification.params) as AppServerSessionEventNotificationParams
      if ("event" in params) return { kind: "session.event", event: params.event }
      if (params.envelope.criticality === "critical") {
        return { kind: "unknown-critical-event", event: { envelope: params.envelope, raw: params.raw } }
      }
      return { kind: "unknown-informational-event", envelope: params.envelope }
    }
    case "session.transient": {
      const params = parseAppServerNotificationParams(notification.method, notification.params) as SessionTransientNotificationParams
      return { kind: "session.transient", event: params.event }
    }
    case "session.resyncRequired":
      return {
        kind: "session.resyncRequired",
        params: parseAppServerNotificationParams(notification.method, notification.params) as SessionResyncRequiredNotificationParams,
      }
    case "presence.updated":
      return {
        kind: "presence.updated",
        params: parseAppServerNotificationParams(notification.method, notification.params) as PresenceUpdatedNotificationParams,
      }
    case "interaction.lease.updated":
      return {
        kind: "interaction.lease.updated",
        params: parseAppServerNotificationParams(notification.method, notification.params) as InteractionLeaseUpdatedNotificationParams,
      }
  }
}

function carriesUnknownTransientKind(params: JsonValue | undefined): boolean {
  if (typeof params !== "object" || params === null) return false
  const event = (params as { readonly event?: unknown }).event
  if (typeof event !== "object" || event === null) return false
  const kind = (event as { readonly kind?: unknown }).kind
  return typeof kind === "string" && !isAppServerTransientEventKind(kind)
}
