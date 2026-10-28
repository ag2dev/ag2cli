import { z } from "zod"
import { iso8601TimestampSchema, nonEmptyStringSchema, positiveIntegerSchema } from "./primitives.js"
import { publicSessionSnapshotSchema, publicSessionSummarySchema } from "./snapshot.js"

// v1 params/result schemas for the session catalog group
// (`session.list`/`create`/`get`/`fork`/`archive`/`delete`). Results are
// public DTOs only: the internal `SessionRecord` (with its full snapshot)
// never crosses the wire. `session.fork` addresses history by business
// identity only — internal DAG cursors (branchId/nodeId/recordHash) are not
// wire params.

/** Fixed single-scope lease reference carried by the session-control methods. */
export const sessionControlLeaseRefSchema = z
  .object({
    scope: z.literal("session-control"),
    generation: positiveIntegerSchema("lease.generation"),
  })
  .strict()
export type SessionControlLeaseRef = z.infer<typeof sessionControlLeaseRefSchema>

export const sessionListParamsSchema = z
  .object({
    workspaceId: nonEmptyStringSchema("workspaceId").optional(),
  })
  .strict()
  .optional()
export type SessionListParams = z.infer<typeof sessionListParamsSchema>

export const sessionCreateParamsSchema = z
  .object({
    // Client-generated resource identity: create is idempotent per
    // (sessionId, payload); the server never mints session ids.
    sessionId: nonEmptyStringSchema("sessionId"),
    workspaceId: nonEmptyStringSchema("workspaceId"),
    title: nonEmptyStringSchema("title").optional(),
  })
  .strict()
export type SessionCreateParams = z.infer<typeof sessionCreateParamsSchema>

export const sessionGetParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
  })
  .strict()
export type SessionGetParams = z.infer<typeof sessionGetParamsSchema>

export const sessionForkParamsSchema = z
  .object({
    sourceSessionId: nonEmptyStringSchema("sourceSessionId"),
    targetSessionId: nonEmptyStringSchema("targetSessionId").optional(),
    title: nonEmptyStringSchema("title").optional(),
    lease: sessionControlLeaseRefSchema.optional(),
  })
  .strict()
export type SessionForkParams = z.infer<typeof sessionForkParamsSchema>

export const sessionArchiveParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
    lease: sessionControlLeaseRefSchema.optional(),
  })
  .strict()
export type SessionArchiveParams = z.infer<typeof sessionArchiveParamsSchema>

export const sessionDeleteParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
    lease: sessionControlLeaseRefSchema.optional(),
  })
  .strict()
export type SessionDeleteParams = z.infer<typeof sessionDeleteParamsSchema>

export const sessionListResultSchema = z.array(publicSessionSummarySchema)
export type SessionListResult = z.infer<typeof sessionListResultSchema>

export const sessionSnapshotResultSchema = z
  .object({
    session: publicSessionSnapshotSchema,
  })
  .strict()
export type SessionSnapshotResult = z.infer<typeof sessionSnapshotResultSchema>

export const sessionGetResultSchema = z
  .object({
    summary: publicSessionSummarySchema,
  })
  .strict()
export type SessionGetResult = z.infer<typeof sessionGetResultSchema>

export const sessionArchiveResultSchema = z
  .object({
    sessionId: nonEmptyStringSchema("result.sessionId"),
    archived: z.literal(true),
    archivedAt: iso8601TimestampSchema("result.archivedAt"),
  })
  .strict()
export type SessionArchiveResult = z.infer<typeof sessionArchiveResultSchema>

export const sessionDeleteResultSchema = z
  .object({
    sessionId: nonEmptyStringSchema("result.sessionId"),
    deleted: z.literal(true),
  })
  .strict()
export type SessionDeleteResult = z.infer<typeof sessionDeleteResultSchema>
