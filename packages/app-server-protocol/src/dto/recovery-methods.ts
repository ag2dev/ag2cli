import { z } from "zod"
import { publicSessionEventSchema } from "./events.js"
import { booleanSchema, nonEmptyStringSchema, nonNegativeIntegerSchema } from "./primitives.js"
import { publicSessionSnapshotSchema } from "./snapshot.js"

// v1 params/result schemas for the attach & recovery group
// (`session.attach`/`detach`/`snapshot`/`replay`/`resync`). Recovery is
// snapshot-first: attach establishes the live delivery barrier and returns
// the public snapshot taken at it; catchup history comes from `session.replay`
// pages keyed by canonical revision. Internal snapshot facts (`workspaceRoot`,
// `lastRevision`, writer epochs) never cross the wire, and transient events
// are live-only — no result carries them.

export const DEFAULT_INCLUDE_RECENT_MESSAGES = 20
export const MAX_INCLUDE_RECENT_MESSAGES = 100

export const DEFAULT_REPLAY_LIMIT = 200
export const MAX_REPLAY_LIMIT = 1_000

export const DEFAULT_REPLAY_MAX_BYTES = 1_048_576
export const MAX_REPLAY_MAX_BYTES = 4_194_304

function boundedIntegerSchema(name: string, min: number, max: number): z.ZodNumber {
  const message = `${name} must be an integer between ${min} and ${max}`
  return z.number({ invalid_type_error: message, required_error: message }).int({ message }).min(min, { message }).max(max, { message })
}

export const sessionAttachParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
    includeRecentMessages: boundedIntegerSchema("includeRecentMessages", 1, MAX_INCLUDE_RECENT_MESSAGES).optional(),
  })
  .strict()
export type SessionAttachParams = z.infer<typeof sessionAttachParamsSchema>

export const sessionDetachParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
  })
  .strict()
export type SessionDetachParams = z.infer<typeof sessionDetachParamsSchema>

export const sessionSnapshotMethodParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
  })
  .strict()
export type SessionSnapshotMethodParams = z.infer<typeof sessionSnapshotMethodParamsSchema>

export const sessionReplayParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
    afterRevision: nonNegativeIntegerSchema("afterRevision"),
    limit: boundedIntegerSchema("limit", 1, MAX_REPLAY_LIMIT).optional(),
    maxBytes: boundedIntegerSchema("maxBytes", 1, MAX_REPLAY_MAX_BYTES).optional(),
  })
  .strict()
export type SessionReplayParams = z.infer<typeof sessionReplayParamsSchema>

export const sessionResyncParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
  })
  .strict()
export type SessionResyncParams = z.infer<typeof sessionResyncParamsSchema>

/** `barrierRevision === snapshot.asOfRevision` always holds; the identity is a
 * semantic invariant asserted by handler tests, not expressible in the schema. */
export const sessionAttachResultSchema = z
  .object({
    snapshot: publicSessionSnapshotSchema,
    barrierRevision: nonNegativeIntegerSchema("barrierRevision"),
  })
  .strict()
export type SessionAttachResult = z.infer<typeof sessionAttachResultSchema>

export const sessionSnapshotMethodResultSchema = z
  .object({
    snapshot: publicSessionSnapshotSchema,
  })
  .strict()
export type SessionSnapshotMethodResult = z.infer<typeof sessionSnapshotMethodResultSchema>

/**
 * One replay page: projected public events in canonical order plus the scan
 * cursor. `scannedThroughRevision` advances even when a page projects no
 * events (filtered internal events are crossed, not reported), and
 * `nextAfterRevision` appears exactly when `hasMore` is true. A page always
 * contains at least one projected event when any exists beyond the cursor —
 * the progress guarantee against undersized `maxBytes`.
 */
export const sessionReplayResultSchema = z
  .object({
    events: z.array(publicSessionEventSchema),
    scannedThroughRevision: nonNegativeIntegerSchema("scannedThroughRevision"),
    nextAfterRevision: nonNegativeIntegerSchema("nextAfterRevision").optional(),
    hasMore: booleanSchema("hasMore"),
  })
  .strict()
export type SessionReplayResult = z.infer<typeof sessionReplayResultSchema>

export const sessionResyncResultSchema = z
  .object({
    snapshot: publicSessionSnapshotSchema,
  })
  .strict()
export type SessionResyncResult = z.infer<typeof sessionResyncResultSchema>

export const sessionDetachResultSchema = z
  .object({
    sessionId: nonEmptyStringSchema("result.sessionId"),
    detached: booleanSchema("detached"),
  })
  .strict()
export type SessionDetachResult = z.infer<typeof sessionDetachResultSchema>
