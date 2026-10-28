import type { TaskSnapshot } from "@ag2cli/core/task/task.js"
import type { BackgroundTaskExecutor, BackgroundTaskExecutionInput } from "../../ports/background-task-executor.js"
import type { ExecuteShellInput, ExecuteShellResult, ExecuteUserShellInput } from "../execution/execute-shell.js"

/** Structural subset of ExecuteShellUseCase so tests can substitute a stub. */
export interface ShellTaskExecutionPort {
  execute(input: ExecuteShellInput | ExecuteUserShellInput): Promise<ExecuteShellResult>
}

/**
 * Adapts durable shell/user_shell tasks onto the synchronous shell use case.
 * The shell path keeps its own per-session serialization and reservation
 * fencing, so this adapter must run outside the task manager's coordination
 * reservation: a session's execution reservation is single-writer, and the
 * nested acquire would conflict with itself, leaving the task queued forever.
 */
export class ShellBackgroundTaskExecutor implements BackgroundTaskExecutor {
  constructor(private readonly shell: ShellTaskExecutionPort) {}

  canRun(task: Pick<TaskSnapshot, "type">): boolean {
    return task.type === "shell" || task.type === "user_shell"
  }

  async execute(input: BackgroundTaskExecutionInput): Promise<{ readonly output?: string }> {
    const { task, runNumber } = input
    const commandId = `task:${task.id}:run:${runNumber}`
    const result = await this.executeShell(commandId, task, input)
    const content = result.result.content
    if (result.result.isError) {
      // Surface the failed output as task logs before failing the run.
      await input.onOutput?.(content)
      throw new Error(content.length > 0 ? content : "shell task failed")
    }
    return content === "" ? {} : { output: content }
  }

  private executeShell(commandId: string, task: TaskSnapshot, input: BackgroundTaskExecutionInput): Promise<ExecuteShellResult> {
    if (task.type === "shell") {
      return this.shell.execute({
        sessionId: input.sessionId,
        commandId,
        argv: task.argv ?? [],
        ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
        ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
        signal: input.signal,
      })
    }
    if (task.type === "user_shell") {
      return this.shell.execute({
        sessionId: input.sessionId,
        commandId,
        command: task.command ?? "",
        ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
        ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
        signal: input.signal,
      })
    }
    throw new Error(`shell task executor cannot run task type: ${task.type}`)
  }
}
