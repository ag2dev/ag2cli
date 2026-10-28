import { z } from "zod"
import { publicClientKindSchema } from "./interactions.js"
import { iso8601TimestampSchema, nonEmptyStringSchema, nonNegativeIntegerSchema } from "./primitives.js"

// Connection-domain presence and interaction leases: in-memory, cleared on
// restart, never part of durable history. Lease holders expose only
// `clientId`/`clientKind`/`name` -- no connection or device identifiers.

export const publicPresenceClientSchema = z.object({
  clientId: nonEmptyStringSchema("presence.client.clientId"),
  clientKind: publicClientKindSchema,
  name: z.string(),
  version: z.string(),
})
export type PublicPresenceClient = z.infer<typeof publicPresenceClientSchema>

export const publicInteractionLeaseStatusSchema = z.enum(["available", "held"])
export type PublicInteractionLeaseStatus = z.infer<typeof publicInteractionLeaseStatusSchema>

export const publicInteractionLeaseHolderSchema = z.object({
  clientId: nonEmptyStringSchema("presence.holder.clientId"),
  clientKind: publicClientKindSchema,
  name: z.string(),
})
export type PublicInteractionLeaseHolder = z.infer<typeof publicInteractionLeaseHolderSchema>

export const publicInteractionLeaseSchema = z.object({
  status: publicInteractionLeaseStatusSchema,
  // A never-held scope reports {status: "available", generation: 0}; held
  // generations start at 1 and only ever increase.
  generation: nonNegativeIntegerSchema("presence.lease.generation"),
  holder: publicInteractionLeaseHolderSchema.optional(),
  expiresAt: iso8601TimestampSchema("presence.lease.expiresAt").optional(),
})
export type PublicInteractionLease = z.infer<typeof publicInteractionLeaseSchema>

export const publicInteractionLeasesSchema = z.object({
  composer: publicInteractionLeaseSchema,
  "session-control": publicInteractionLeaseSchema,
})
export type PublicInteractionLeases = z.infer<typeof publicInteractionLeasesSchema>

export const publicPresenceSchema = z.object({
  sessionId: nonEmptyStringSchema("presence.sessionId"),
  clients: z.array(publicPresenceClientSchema),
  leases: publicInteractionLeasesSchema,
})
export type PublicPresence = z.infer<typeof publicPresenceSchema>
