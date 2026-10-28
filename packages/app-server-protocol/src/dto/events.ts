import { z } from "zod"
import { publicInteractionResolutionSchema, publicPendingInteractionSchema } from "./interactions.js"
import {
  publicFailureSchema,
  publicInputSnapshotSchema,
  publicMessageSchema,
  publicPermissionModeSchema,
  publicPlanSummarySchema,
  publicRunSnapshotSchema,
  publicTaskSummarySchema,
  publicToolCallSchema,
} from "./snapshot.js"
import { iso8601TimestampSchema, nonEmptyStringSchema, nonNegativeIntegerSchema, positiveIntegerSchema } from "./primitives.js"

// Durable public session events: a flat discriminated union where `type`,
// `criticality` and the payload live on the same object. Each variant pins
// its `criticality` to a literal so the mapping is fixed by `type` at the
// schema level, not a runtime refinement.

const eventEnvelope = {
  eventId: nonEmptyStringSchema("event.eventId"),
  sessionId: nonEmptyStringSchema("event.sessionId"),
  revision: positiveIntegerSchema("event.revision"),
  timestamp: iso8601TimestampSchema("event.timestamp"),
}

export const publicSessionEventTypeSchema = z.enum([
  "input.accepted",
  "input.updated",
  "input.failed",
  "run.updated",
  "message.upserted",
  "tool_call.upserted",
  "interaction.requested",
  "interaction.resolved",
  "security.updated",
  "plan.updated",
  "task.updated",
  "background_task.updated",
  "session.title.updated",
  "session.archived",
])
export type PublicSessionEventType = z.infer<typeof publicSessionEventTypeSchema>

const criticalEventSchema = z.literal("critical")
const informationalEventSchema = z.literal("informational")

export const publicSessionEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventEnvelope, criticality: criticalEventSchema, type: z.literal("input.accepted"), input: publicInputSnapshotSchema }),
  z.object({ ...eventEnvelope, criticality: criticalEventSchema, type: z.literal("input.updated"), input: publicInputSnapshotSchema }),
  z.object({
    ...eventEnvelope,
    criticality: criticalEventSchema,
    type: z.literal("input.failed"),
    inputId: nonEmptyStringSchema("event.inputId"),
    commandId: nonEmptyStringSchema("event.commandId"),
    failure: publicFailureSchema,
  }),
  z.object({ ...eventEnvelope, criticality: criticalEventSchema, type: z.literal("run.updated"), run: publicRunSnapshotSchema }),
  z.object({ ...eventEnvelope, criticality: criticalEventSchema, type: z.literal("message.upserted"), message: publicMessageSchema }),
  z.object({ ...eventEnvelope, criticality: criticalEventSchema, type: z.literal("tool_call.upserted"), toolCall: publicToolCallSchema }),
  z.object({
    ...eventEnvelope,
    criticality: criticalEventSchema,
    type: z.literal("interaction.requested"),
    interaction: publicPendingInteractionSchema,
  }),
  z.object({
    ...eventEnvelope,
    criticality: criticalEventSchema,
    type: z.literal("interaction.resolved"),
    resolution: publicInteractionResolutionSchema,
  }),
  z.object({
    ...eventEnvelope,
    criticality: criticalEventSchema,
    type: z.literal("security.updated"),
    permissionMode: publicPermissionModeSchema,
    policyRevision: nonNegativeIntegerSchema("event.policyRevision"),
  }),
  z.object({
    ...eventEnvelope,
    criticality: criticalEventSchema,
    type: z.literal("session.archived"),
    archivedAt: iso8601TimestampSchema("event.archivedAt"),
  }),
  z.object({ ...eventEnvelope, criticality: informationalEventSchema, type: z.literal("plan.updated"), plan: publicPlanSummarySchema }),
  z.object({ ...eventEnvelope, criticality: informationalEventSchema, type: z.literal("task.updated"), task: publicTaskSummarySchema }),
  z.object({
    ...eventEnvelope,
    criticality: informationalEventSchema,
    type: z.literal("background_task.updated"),
    task: publicTaskSummarySchema,
  }),
  z.object({ ...eventEnvelope, criticality: informationalEventSchema, type: z.literal("session.title.updated"), title: z.string() }),
])
export type PublicSessionEvent = z.infer<typeof publicSessionEventSchema>

export type PublicSessionEventCriticality = "critical" | "informational"

// Exactly one entry per known event type; drives criticality lookup without
// parsing the full union.
export const CRITICALITY_BY_EVENT_TYPE: Readonly<Record<PublicSessionEventType, PublicSessionEventCriticality>> = {
  "input.accepted": "critical",
  "input.updated": "critical",
  "input.failed": "critical",
  "run.updated": "critical",
  "message.upserted": "critical",
  "tool_call.upserted": "critical",
  "interaction.requested": "critical",
  "interaction.resolved": "critical",
  "security.updated": "critical",
  "session.archived": "critical",
  "plan.updated": "informational",
  "task.updated": "informational",
  "background_task.updated": "informational",
  "session.title.updated": "informational",
}

export function isKnownPublicSessionEventType(type: unknown): type is PublicSessionEventType {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(CRITICALITY_BY_EVENT_TYPE, type)
}

// Lenient envelope for events whose `type` is not in the known directory:
// validates the envelope fields and leaves the payload untouched, so
// consumers can decide between skipping (unknown informational) and
// triggering a resync (unknown critical) without guessing at the payload.
export const publicSessionEventEnvelopeSchema = z
  .object({
    ...eventEnvelope,
    criticality: z.enum(["critical", "informational"]),
    type: nonEmptyStringSchema("event.type"),
  })
  .passthrough()
export type PublicSessionEventEnvelope = z.infer<typeof publicSessionEventEnvelopeSchema>
