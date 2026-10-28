import { z } from "zod"
import {
  booleanSchema,
  iso8601TimestampSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
} from "./primitives.js"

// v1 params/result schemas for the rewind group split out of the retired
// `session.command` umbrella (contract §11.7): `session.listCheckpoints`,
// `session.previewRewind` and `session.rewind`. Public identifiers are
// business-only — `checkpointId` and canonical `revision`/`generation` —
// while the internal DAG cursor (`branchId`/`nodeId`/`recordHash`) never
// reaches the wire. `previewRewind` is read-only and leaves no durable
// history; `rewind` moves the active timeline without rewriting the
// physical revision log, so old projections are invalidated by a resync
// barrier rather than carried in results (contract §15.7).

export const sessionControlLeaseRefSchema = z
  .object({
    scope: z.literal("session-control", { errorMap: () => ({ message: "lease.scope must be session-control for the rewind methods" }) }),
    generation: positiveIntegerSchema("lease.generation"),
  })
  .strict()

export const publicCheckpointSchema = z
  .object({
    checkpointId: nonEmptyStringSchema("checkpoint.checkpointId"),
    kind: z.enum(["prompt", "manual"], { errorMap: () => ({ message: "checkpoint.kind must be prompt or manual" }) }),
    headRevision: nonNegativeIntegerSchema("checkpoint.headRevision"),
    generation: nonNegativeIntegerSchema("checkpoint.generation"),
    createdAt: iso8601TimestampSchema("checkpoint.createdAt"),
  })
  .strict()
export type PublicCheckpoint = z.infer<typeof publicCheckpointSchema>

export const sessionListCheckpointsParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
  })
  .strict()
export type SessionListCheckpointsParams = z.infer<typeof sessionListCheckpointsParamsSchema>

export const sessionListCheckpointsResultSchema = z
  .object({
    sessionId: nonEmptyStringSchema("session.listCheckpoints.result.sessionId"),
    checkpoints: z.array(publicCheckpointSchema, {
      invalid_type_error: "session.listCheckpoints.result.checkpoints must be a checkpoint array",
      required_error: "session.listCheckpoints.result.checkpoints must be a checkpoint array",
    }),
  })
  .strict()
export type SessionListCheckpointsResult = z.infer<typeof sessionListCheckpointsResultSchema>

export const sessionPreviewRewindParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
    checkpointId: nonEmptyStringSchema("session.previewRewind.checkpointId"),
    expectedRevision: nonNegativeIntegerSchema("session.previewRewind.expectedRevision").optional(),
    lease: sessionControlLeaseRefSchema.optional(),
  })
  .strict()
export type SessionPreviewRewindParams = z.infer<typeof sessionPreviewRewindParamsSchema>

export const sessionPreviewRewindResultSchema = z
  .object({
    sessionId: nonEmptyStringSchema("session.previewRewind.result.sessionId"),
    checkpoint: publicCheckpointSchema,
    currentRevision: nonNegativeIntegerSchema("session.previewRewind.result.currentRevision"),
    currentGeneration: nonNegativeIntegerSchema("session.previewRewind.result.currentGeneration"),
    staleRevision: booleanSchema("session.previewRewind.result.staleRevision"),
    canCommit: booleanSchema("session.previewRewind.result.canCommit"),
  })
  .strict()
export type SessionPreviewRewindResult = z.infer<typeof sessionPreviewRewindResultSchema>

export const sessionRewindParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
    commandId: nonEmptyStringSchema("commandId"),
    checkpointId: nonEmptyStringSchema("session.rewind.checkpointId"),
    expectedRevision: nonNegativeIntegerSchema("session.rewind.expectedRevision").optional(),
    lease: sessionControlLeaseRefSchema.optional(),
  })
  .strict()
export type SessionRewindParams = z.infer<typeof sessionRewindParamsSchema>

/** `failed`/`already_failed` are canonical rewind facts the Host reports in
 * the result — admission succeeded, so the RPC itself does not fail. */
export const sessionRewindResultSchema = z
  .object({
    accepted: z.literal(true, { errorMap: () => ({ message: "accepted must be literal true" }) }),
    sessionId: nonEmptyStringSchema("session.rewind.result.sessionId"),
    commandId: nonEmptyStringSchema("session.rewind.result.commandId"),
    status: z.enum(["rewound", "already_rewound", "failed", "already_failed"], {
      errorMap: () => ({ message: "session.rewind.result.status must be rewound, already_rewound, failed or already_failed" }),
    }),
    rewindId: nonEmptyStringSchema("session.rewind.result.rewindId"),
    error: nonEmptyStringSchema("session.rewind.result.error").optional(),
  })
  .strict()
export type SessionRewindResult = z.infer<typeof sessionRewindResultSchema>
