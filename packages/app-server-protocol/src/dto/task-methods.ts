import { z } from "zod"
import { publicTaskSummarySchema, publicTaskStatusSchema } from "./snapshot.js"
import {
  booleanSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
  workspaceRelativePathSchema,
} from "./primitives.js"

// v1 params/result schemas for the standalone task and remote shell group
// (`session.createTask`/`listTasks`/`cancelTask`/`getTaskLogs` plus
// `session.executeShell`/`executeUserShell`). Remote shell reuses the task
// lifecycle: both execute methods admit a background task and return its
// identity; paged output arrives via `session.getTaskLogs`, cancellation via
// `session.cancelTask`. Agent work is the only task kind creatable through
// `session.createTask` itself — shell execution is a separate authorization
// path and periodic loops are not part of the public task kind enum.

export const MAX_TASK_TITLE_LENGTH = 512
export const MAX_AGENT_PROMPT_LENGTH = 32_768
export const MAX_USER_SHELL_COMMAND_LENGTH = 65_536
export const MAX_SHELL_ARGV_ITEMS = 64
export const MAX_SHELL_ARG_LENGTH = 8_192
export const MAX_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1_000
export const MAX_CANCEL_TASK_REASON_LENGTH = 1_024
export const MAX_TASK_LOGS_LIMIT = 500
export const MAX_TASK_LOG_CHUNK_LENGTH = 4_096

function boundedNonEmptyStringSchema(name: string, max: number): z.ZodString {
  const message = `${name} must be a non-empty string of at most ${max} characters`
  return nonEmptyStringSchema(name).max(max, { message })
}

function boundedIntegerSchema(name: string, min: number, max: number): z.ZodNumber {
  const message = `${name} must be an integer between ${min} and ${max}`
  return z.number({ invalid_type_error: message, required_error: message }).int({ message }).min(min, { message }).max(max, { message })
}

function boundedStringSchema(name: string, max: number): z.ZodString {
  const message = `${name} must be a string of at most ${max} characters`
  return z.string({ invalid_type_error: message, required_error: message }).max(max, { message })
}

const composerLeaseRefSchema = z
  .object({
    scope: z.literal("composer", { errorMap: () => ({ message: "lease.scope must be composer for the task methods" }) }),
    generation: positiveIntegerSchema("lease.generation"),
  })
  .strict()

export const sessionCreateTaskParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("session.createTask.sessionId"),
    commandId: nonEmptyStringSchema("session.createTask.commandId"),
    taskType: z.literal("agent", {
      errorMap: () => ({
        message: "session.createTask.taskType must be agent; shell execution rides session.executeShell/executeUserShell",
      }),
    }),
    title: boundedNonEmptyStringSchema("session.createTask.title", MAX_TASK_TITLE_LENGTH),
    prompt: boundedNonEmptyStringSchema("session.createTask.prompt", MAX_AGENT_PROMPT_LENGTH),
    lease: composerLeaseRefSchema.optional(),
  })
  .strict()
export type SessionCreateTaskParams = z.infer<typeof sessionCreateTaskParamsSchema>

export const sessionCreateTaskResultSchema = z
  .object({
    accepted: z.literal(true, { errorMap: () => ({ message: "accepted must be literal true" }) }),
    sessionId: nonEmptyStringSchema("session.createTask.result.sessionId"),
    commandId: nonEmptyStringSchema("session.createTask.result.commandId"),
    task: publicTaskSummarySchema,
    queued: booleanSchema("session.createTask.result.queued"),
  })
  .strict()
export type SessionCreateTaskResult = z.infer<typeof sessionCreateTaskResultSchema>

export const sessionListTasksParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("session.listTasks.sessionId"),
  })
  .strict()
export type SessionListTasksParams = z.infer<typeof sessionListTasksParamsSchema>

/** Periodic loop tasks are not part of the public task kind enum and never
 * appear in public listings; they remain a local-runtime concern. */
export const sessionListTasksResultSchema = z
  .object({
    sessionId: nonEmptyStringSchema("session.listTasks.result.sessionId"),
    tasks: z.array(publicTaskSummarySchema),
  })
  .strict()
export type SessionListTasksResult = z.infer<typeof sessionListTasksResultSchema>

export const sessionCancelTaskParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("session.cancelTask.sessionId"),
    taskId: nonEmptyStringSchema("session.cancelTask.taskId"),
    reason: boundedNonEmptyStringSchema("session.cancelTask.reason", MAX_CANCEL_TASK_REASON_LENGTH).optional(),
  })
  .strict()
export type SessionCancelTaskParams = z.infer<typeof sessionCancelTaskParamsSchema>

/** `cancelled` reports the post-call status only: cancelling an already
 * terminal task is a convergent no-op that returns `false`, never an error. */
export const sessionCancelTaskResultSchema = z
  .object({
    cancelled: booleanSchema("session.cancelTask.result.cancelled"),
    sessionId: nonEmptyStringSchema("session.cancelTask.result.sessionId"),
    taskId: nonEmptyStringSchema("session.cancelTask.result.taskId"),
    task: publicTaskSummarySchema,
  })
  .strict()
export type SessionCancelTaskResult = z.infer<typeof sessionCancelTaskResultSchema>

export const sessionGetTaskLogsParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("session.getTaskLogs.sessionId"),
    taskId: nonEmptyStringSchema("session.getTaskLogs.taskId"),
    afterSequence: nonNegativeIntegerSchema("session.getTaskLogs.afterSequence").optional(),
    limit: boundedIntegerSchema("session.getTaskLogs.limit", 1, MAX_TASK_LOGS_LIMIT).optional(),
  })
  .strict()
export type SessionGetTaskLogsParams = z.infer<typeof sessionGetTaskLogsParamsSchema>

export const taskLogChunkSchema = z
  .object({
    sequence: nonNegativeIntegerSchema("session.getTaskLogs.chunk.sequence"),
    text: boundedStringSchema("session.getTaskLogs.chunk.text", MAX_TASK_LOG_CHUNK_LENGTH),
  })
  .strict()
export type TaskLogChunk = z.infer<typeof taskLogChunkSchema>

export const sessionGetTaskLogsResultSchema = z
  .object({
    sessionId: nonEmptyStringSchema("session.getTaskLogs.result.sessionId"),
    taskId: nonEmptyStringSchema("session.getTaskLogs.result.taskId"),
    status: publicTaskStatusSchema,
    outputBytes: nonNegativeIntegerSchema("session.getTaskLogs.result.outputBytes"),
    chunks: z.array(taskLogChunkSchema).max(MAX_TASK_LOGS_LIMIT, {
      message: `session.getTaskLogs.result.chunks must hold at most ${MAX_TASK_LOGS_LIMIT} entries`,
    }),
    nextAfterSequence: positiveIntegerSchema("session.getTaskLogs.result.nextAfterSequence").optional(),
  })
  .strict()
export type SessionGetTaskLogsResult = z.infer<typeof sessionGetTaskLogsResultSchema>

const shellTaskParamsBase = {
  sessionId: nonEmptyStringSchema("sessionId"),
  commandId: nonEmptyStringSchema("commandId"),
  cwdRelative: workspaceRelativePathSchema("cwdRelative").optional(),
  timeoutMs: boundedIntegerSchema("timeoutMs", 1, MAX_TASK_TIMEOUT_MS).optional(),
} as const

export const sessionExecuteShellParamsSchema = z
  .object({
    ...shellTaskParamsBase,
    argv: z
      .array(boundedStringSchema("session.executeShell.argv[]", MAX_SHELL_ARG_LENGTH), {
        invalid_type_error: "session.executeShell.argv must be a string array",
        required_error: "session.executeShell.argv must be a string array",
      })
      .min(1, { message: `session.executeShell.argv must hold 1 to ${MAX_SHELL_ARGV_ITEMS} entries` })
      .max(MAX_SHELL_ARGV_ITEMS, { message: `session.executeShell.argv must hold 1 to ${MAX_SHELL_ARGV_ITEMS} entries` }),
  })
  .strict()
export type SessionExecuteShellParams = z.infer<typeof sessionExecuteShellParamsSchema>

export const sessionExecuteUserShellParamsSchema = z
  .object({
    ...shellTaskParamsBase,
    command: boundedNonEmptyStringSchema("session.executeUserShell.command", MAX_USER_SHELL_COMMAND_LENGTH),
  })
  .strict()
export type SessionExecuteUserShellParams = z.infer<typeof sessionExecuteUserShellParamsSchema>

/** Both execute methods share the admission result: the task identity plus
 * the queued fact; progress arrives as `task.updated` events and paged output
 * via `session.getTaskLogs`. */
export const sessionShellAdmissionResultSchema = z
  .object({
    accepted: z.literal(true, { errorMap: () => ({ message: "accepted must be literal true" }) }),
    sessionId: nonEmptyStringSchema("result.sessionId"),
    commandId: nonEmptyStringSchema("result.commandId"),
    taskId: nonEmptyStringSchema("result.taskId"),
    queued: booleanSchema("result.queued"),
  })
  .strict()
export type SessionShellAdmissionResult = z.infer<typeof sessionShellAdmissionResultSchema>

export const sessionExecuteShellResultSchema = sessionShellAdmissionResultSchema
export type SessionExecuteShellResult = SessionShellAdmissionResult

export const sessionExecuteUserShellResultSchema = sessionShellAdmissionResultSchema
export type SessionExecuteUserShellResult = SessionShellAdmissionResult
