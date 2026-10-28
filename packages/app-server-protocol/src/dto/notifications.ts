import { z } from "zod"
import type { JsonValue } from "../types.js"
import { type PublicSessionEvent, type PublicSessionEventEnvelope } from "./events.js"
import { publicInteractionLeasesSchema, publicPresenceSchema } from "./presence.js"
import { nonEmptyStringSchema, positiveIntegerSchema } from "./primitives.js"
import { publicTransientEventSchema } from "./transient.js"

// Server-to-client notification params for the five v1 notifications. The
// legacy `session.operation.failed` notification has no v1 shape and is
// removed with the rest of the legacy surface.

export const sessionTransientNotificationParamsSchema = z.object({ event: publicTransientEventSchema }).strict()

export const sessionResyncRequiredReasonSchema = z
  .enum(["queue_overflow", "restart", "rewind", "history_unavailable"])
  .describe("queue_overflow covers the live delivery buffer, not mailbox capacity")

export const sessionResyncRequiredNotificationParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("resync.sessionId"),
    minimumRevision: positiveIntegerSchema("resync.minimumRevision"),
    reason: sessionResyncRequiredReasonSchema,
  })
  .strict()

export const presenceUpdatedNotificationParamsSchema = publicPresenceSchema

export const interactionLeaseUpdatedNotificationParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("lease.sessionId"),
    leases: publicInteractionLeasesSchema,
  })
  .strict()

/**
 * `session.event` params parse into one of two shapes: a fully validated
 * known event, or — when `type` is outside the known directory — the lenient
 * envelope plus the untouched raw payload, so consumers can decide between
 * skipping (unknown informational) and resyncing (unknown critical).
 */
export type AppServerSessionEventNotificationParams =
  { readonly event: PublicSessionEvent } | { readonly envelope: PublicSessionEventEnvelope; readonly raw: JsonValue }

export type SessionTransientNotificationParams = z.infer<typeof sessionTransientNotificationParamsSchema>
export type SessionResyncRequiredNotificationParams = z.infer<typeof sessionResyncRequiredNotificationParamsSchema>
export type PresenceUpdatedNotificationParams = z.infer<typeof presenceUpdatedNotificationParamsSchema>
export type InteractionLeaseUpdatedNotificationParams = z.infer<typeof interactionLeaseUpdatedNotificationParamsSchema>
