import type { SessionId, TaskId } from "@ag2cli/core/ids.js"
import type { TaskSnapshot } from "@ag2cli/core/task/task.js"

export interface BackgroundTaskExecutionInput {
  readonly sessionId: SessionId
  readonly task: TaskSnapshot
  readonly runNumber: number
  readonly signal: AbortSignal
  readonly onOutput?: (text: string) => Promise<void>
}

export interface BackgroundTaskExecutionResult {
  readonly output?: string
}

/** Execution boundary for durable tasks; it contains no scheduler or UI policy. */
export interface BackgroundTaskExecutor {
  execute(input: BackgroundTaskExecutionInput): Promise<BackgroundTaskExecutionResult>
}

export type BackgroundTaskCancellation = {
  readonly sessionId: SessionId
  readonly taskId: TaskId
  readonly reason?: string
}
