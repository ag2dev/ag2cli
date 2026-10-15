import type { RunId, TaskId } from "../ids.js"

export type BackgroundTaskType = "agent" | "shell" | "loop"
export type BackgroundTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

/** The durable state shared by the TUI, headless clients and future app clients. */
export interface TaskSnapshot {
  readonly id: TaskId
  readonly type: BackgroundTaskType
  readonly title: string
  readonly status: BackgroundTaskStatus
  readonly createdAt: string
  readonly prompt?: string
  readonly argv?: readonly string[]
  readonly intervalMs?: number
  readonly maxRuns?: number
  readonly runCount: number
  readonly startedAt?: string
  readonly completedAt?: string
  readonly nextRunAt?: string
  readonly lastOutput?: string
  readonly outputBytes: number
  readonly lastError?: string
  readonly parentRunId?: RunId
}

export const MAX_TASK_OUTPUT_CHUNK = 4_096
export const MAX_TASK_OUTPUT_PREVIEW = 8_192
export const MAX_TASK_OUTPUT_BYTES = 64 * 1024

export function isTerminalTaskStatus(status: BackgroundTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

export function taskCanStart(task: TaskSnapshot): boolean {
  return task.status === "queued"
}
