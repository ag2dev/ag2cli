import { z } from "zod"
import { booleanSchema, nonEmptyStringSchema, nonNegativeIntegerSchema, positiveIntegerSchema } from "./primitives.js"

// v1 params/result schemas for the session action group split out of the
// retired `session.command` umbrella (contract §11.7): `session.compact`,
// `session.addDirectory`, `session.setContextWindow`,
// `session.clearContextWindow`, `session.selectAgent` and
// `session.updateGoal`. Every face is a convergent session-state mutation
// behind the `composer` interaction lease; results carry the reducer facts
// the Host reports, not a snapshot replay — structural updates keep
// arriving as durable session events.

export const MAX_COMPACT_INSTRUCTIONS_LENGTH = 4_096
export const MAX_ADDITIONAL_DIRECTORIES = 64

const composerLeaseRefSchema = z
  .object({
    scope: z.literal("composer", { errorMap: () => ({ message: "lease.scope must be composer for the session action methods" }) }),
    generation: positiveIntegerSchema("lease.generation"),
  })
  .strict()

const actionParamsBase = {
  sessionId: nonEmptyStringSchema("sessionId"),
  commandId: nonEmptyStringSchema("commandId"),
  lease: composerLeaseRefSchema.optional(),
} as const

const acceptedResultBase = {
  accepted: z.literal(true, { errorMap: () => ({ message: "accepted must be literal true" }) }),
  sessionId: nonEmptyStringSchema("result.sessionId"),
  commandId: nonEmptyStringSchema("result.commandId"),
  changed: booleanSchema("result.changed"),
} as const

export const sessionCompactParamsSchema = z
  .object({
    ...actionParamsBase,
    instructions: nonEmptyStringSchema("session.compact.instructions")
      .max(MAX_COMPACT_INSTRUCTIONS_LENGTH, {
        message: `session.compact.instructions must be a non-empty string of at most ${MAX_COMPACT_INSTRUCTIONS_LENGTH} characters`,
      })
      .optional(),
  })
  .strict()
export type SessionCompactParams = z.infer<typeof sessionCompactParamsSchema>

export const sessionCompactResultSchema = z
  .object({
    ...acceptedResultBase,
    inputMessageCount: nonNegativeIntegerSchema("session.compact.result.inputMessageCount"),
    outputMessageCount: nonNegativeIntegerSchema("session.compact.result.outputMessageCount"),
    inputTokens: nonNegativeIntegerSchema("session.compact.result.inputTokens").optional(),
  })
  .strict()
export type SessionCompactResult = z.infer<typeof sessionCompactResultSchema>

export const sessionAddDirectoryParamsSchema = z
  .object({
    ...actionParamsBase,
    directory: nonEmptyStringSchema("session.addDirectory.directory"),
    workspaceRoot: nonEmptyStringSchema("session.addDirectory.workspaceRoot").optional(),
    expectedScopeRevision: nonNegativeIntegerSchema("session.addDirectory.expectedScopeRevision").optional(),
  })
  .strict()
export type SessionAddDirectoryParams = z.infer<typeof sessionAddDirectoryParamsSchema>

/** Additional directories may live outside the workspace, so the wire takes
 * host-side absolute or workspace-relative paths verbatim; admission and
 * path policy checks stay with the Host. */
export const sessionAddDirectoryResultSchema = z
  .object({
    ...acceptedResultBase,
    directory: nonEmptyStringSchema("session.addDirectory.result.directory"),
    additionalDirectories: z
      .array(nonEmptyStringSchema("session.addDirectory.result.additionalDirectories[]"), {
        invalid_type_error: "session.addDirectory.result.additionalDirectories must be a string array",
        required_error: "session.addDirectory.result.additionalDirectories must be a string array",
      })
      .max(MAX_ADDITIONAL_DIRECTORIES, {
        message: `session.addDirectory.result.additionalDirectories must hold at most ${MAX_ADDITIONAL_DIRECTORIES} entries`,
      }),
    scopeRevision: nonNegativeIntegerSchema("session.addDirectory.result.scopeRevision"),
    scopeDigest: nonEmptyStringSchema("session.addDirectory.result.scopeDigest").optional(),
  })
  .strict()
export type SessionAddDirectoryResult = z.infer<typeof sessionAddDirectoryResultSchema>

export const sessionSetContextWindowParamsSchema = z
  .object({
    ...actionParamsBase,
    contextWindow: positiveIntegerSchema("session.setContextWindow.contextWindow"),
  })
  .strict()
export type SessionSetContextWindowParams = z.infer<typeof sessionSetContextWindowParamsSchema>

export const sessionSetContextWindowResultSchema = z
  .object({
    ...acceptedResultBase,
    contextWindowOverride: positiveIntegerSchema("session.setContextWindow.result.contextWindowOverride").optional(),
  })
  .strict()
export type SessionSetContextWindowResult = z.infer<typeof sessionSetContextWindowResultSchema>

export const sessionClearContextWindowParamsSchema = z.object({ ...actionParamsBase }).strict()
export type SessionClearContextWindowParams = z.infer<typeof sessionClearContextWindowParamsSchema>

export const sessionClearContextWindowResultSchema = z.object({ ...acceptedResultBase }).strict()
export type SessionClearContextWindowResult = z.infer<typeof sessionClearContextWindowResultSchema>

export const sessionSelectAgentParamsSchema = z
  .object({
    ...actionParamsBase,
    agentName: nonEmptyStringSchema("session.selectAgent.agentName").optional(),
  })
  .strict()
export type SessionSelectAgentParams = z.infer<typeof sessionSelectAgentParamsSchema>

/** Omitting `agentName` selects the default agent; `agentName` reports the
 * effective agent only when the Host echoes one back. */
export const sessionSelectAgentResultSchema = z
  .object({
    ...acceptedResultBase,
    agentName: nonEmptyStringSchema("session.selectAgent.result.agentName").optional(),
  })
  .strict()
export type SessionSelectAgentResult = z.infer<typeof sessionSelectAgentResultSchema>

export const sessionGoalUpdateSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set", { errorMap: () => ({ message: "session.updateGoal.update.action must be set, clear, pause or resume" }) }),
      text: nonEmptyStringSchema("session.updateGoal.update.text"),
    })
    .strict(),
  z
    .object({
      action: z.enum(["clear", "pause", "resume"], {
        errorMap: () => ({ message: "session.updateGoal.update.action must be set, clear, pause or resume" }),
      }),
    })
    .strict(),
])
export type SessionGoalUpdateParams = z.infer<typeof sessionGoalUpdateSchema>

export const sessionUpdateGoalParamsSchema = z
  .object({
    ...actionParamsBase,
    update: sessionGoalUpdateSchema,
  })
  .strict()
export type SessionUpdateGoalParams = z.infer<typeof sessionUpdateGoalParamsSchema>

export const publicGoalSchema = z
  .object({
    status: z.enum(["unset", "active", "paused"], {
      errorMap: () => ({ message: "goal.status must be unset, active or paused" }),
    }),
    text: nonEmptyStringSchema("session.updateGoal.result.goal.text").optional(),
  })
  .strict()
export type PublicGoal = z.infer<typeof publicGoalSchema>

export const sessionUpdateGoalResultSchema = z
  .object({
    ...acceptedResultBase,
    goal: publicGoalSchema,
  })
  .strict()
export type SessionUpdateGoalResult = z.infer<typeof sessionUpdateGoalResultSchema>
