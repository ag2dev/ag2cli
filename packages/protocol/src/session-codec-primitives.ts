import type { EventTrace } from "@ag2cli/core/events/event.js"
import { planId, runId, sessionId, taskId, type PlanId, type RunId, type SessionId, type TaskId } from "@ag2cli/core/ids.js"
import { MAX_CONTEXT_WINDOW_TOKENS } from "@ag2cli/core/model/limits.js"
import type { SessionGoalUpdate } from "@ag2cli/core/session/session-goal.js"
import type { BackgroundTaskType } from "@ag2cli/core/task/task.js"

export function parseStringArray(value: unknown, name: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`)
  }
  return [...value]
}

export function parseFileReferences(value: unknown): readonly string[] | undefined {
  const paths = parseStringArray(value, "fileReferences")
  if (paths === undefined) return undefined
  if (paths.length > 16) throw new Error("fileReferences allows at most 16 paths")
  if (paths.some((path) => path.trim().length === 0 || path.length > 4_096)) {
    throw new Error("fileReferences contains an empty or overly long path")
  }
  return paths
}

export function parseSessionGoalUpdate(value: unknown): SessionGoalUpdate {
  const candidate = asRecord(value, "update_goal.update")
  if (candidate.action === "set") {
    return { action: "set", text: parseNonEmptyString(candidate.text, "update_goal.update.text") }
  }
  if (candidate.action === "clear" || candidate.action === "pause" || candidate.action === "resume") {
    if (candidate.text !== undefined) throw new Error("update_goal.update.text is only allowed for set")
    return { action: candidate.action }
  }
  throw new Error(`update_goal.update.action is invalid: ${String(candidate.action)}`)
}

export function parseShellArgv(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64 || value.some((item) => typeof item !== "string")) {
    throw new Error("execute_shell.argv must contain 1 to 64 strings")
  }
  if (value.some((item) => item.length > 8_192)) throw new Error("execute_shell.argv contains an overly long argument")
  return [...value] as string[]
}

export function parseUserShellCommand(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("execute_user_shell.command is required")
  if (value.length > 65_536) throw new Error("execute_user_shell.command must not exceed 65536 characters")
  return value
}

export function parseTaskType(value: unknown, name: string): BackgroundTaskType {
  if (value !== "agent" && value !== "shell" && value !== "loop") throw new Error(`${name} is invalid`)
  return value
}

export function parseStringRecord(value: unknown, name: string): Readonly<Record<string, string>> {
  const candidate = asRecord(value, name)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(candidate)) {
    if (key.trim().length === 0 || typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${name}.${key} must be a non-empty string`)
    }
    result[key] = item
  }
  return result
}

export function parseTrace(value: unknown): EventTrace | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object") throw new Error("trace must be an object")
  const trace = value as Record<string, unknown>
  const traceId = parseNonEmptyString(trace.traceId, "trace.traceId")
  const operationId = parseNonEmptyString(trace.operationId, "trace.operationId")
  if (trace.causationId !== undefined && typeof trace.causationId !== "string") {
    throw new Error("trace.causationId must be a string")
  }
  return {
    traceId,
    operationId,
    ...(trace.causationId === undefined ? {} : { causationId: trace.causationId }),
  }
}

export function parseString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value
}

export function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

export function parseSessionId(value: unknown): SessionId {
  return sessionId(parseNonEmptyString(value, "sessionId"))
}

export function parsePlanId(value: unknown): PlanId {
  return planId(parseNonEmptyString(value, "planId"))
}

export function parseRunId(value: unknown): RunId {
  return runId(parseNonEmptyString(value, "runId"))
}

export function parseTaskId(value: unknown): TaskId {
  return taskId(parseNonEmptyString(value, "taskId"))
}

export function parseNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

export function parsePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

export function parseBoundedPositiveInteger(value: unknown, name: string, min: number, max: number): number {
  const parsed = parsePositiveInteger(value, name)
  if (parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return parsed
}

export function parseContextWindow(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_CONTEXT_WINDOW_TOKENS) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_CONTEXT_WINDOW_TOKENS}`)
  }
  return value
}

export function parseNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

export function parseOptionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : parseNonNegativeInteger(value, name)
}

export function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`)
  return value
}

export function parseNonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
  return value
}
