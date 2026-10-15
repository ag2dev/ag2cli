import type { SessionCommand, SessionCommandResult } from "@ag2cli/protocol/session-command.js"
import type { SessionExecuteOptions } from "./session-execution.js"
import type { SessionId } from "@ag2cli/core/ids.js"

type ExecuteCommand = (sessionId: SessionId, command: SessionCommand, options?: SessionExecuteOptions) => Promise<SessionCommandResult>

/**
 * Serializes session writes across use cases while keeping observation and
 * approval resolution available to an in-flight operation.
 *
 * The coordinator owns ordering only. EventStore remains the durability and
 * revision authority, and the command router remains the capability boundary.
 */
export class SessionCommandCoordinator {
  private readonly pending = new Map<string, Promise<void>>()

  execute(
    sessionId: SessionId,
    command: SessionCommand,
    options: SessionExecuteOptions | undefined,
    operation: ExecuteCommand,
  ): Promise<SessionCommandResult> {
    if (isNonBlockingCommand(command)) return operation(sessionId, command, options)

    const key = sessionId.toString()
    const previous = this.pending.get(key)
    const current = (previous ?? Promise.resolve()).then(() => operation(sessionId, command, options))
    const tracked = current.then(
      () => undefined,
      () => undefined,
    )
    this.pending.set(key, tracked)
    return current.finally(() => {
      if (this.pending.get(key) === tracked) this.pending.delete(key)
    })
  }

  clear(): void {
    this.pending.clear()
  }
}

function isNonBlockingCommand(command: SessionCommand): boolean {
  return (
    command.type === "get_snapshot" ||
    command.type === "read_events" ||
    command.type === "read_trace" ||
    command.type === "read_model_calls" ||
    command.type === "resolve_approval" ||
    command.type === "start_run" ||
    command.type === "steer" ||
    command.type === "cancel_input"
  )
}
