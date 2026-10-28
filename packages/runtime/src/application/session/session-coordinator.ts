import type { SessionCommand, SessionCommandResult } from "@ag2cli/session-protocol/session-command.js"
import { OrderedLane } from "../../concurrency/ordered-lane.js"
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
  private readonly lane = new OrderedLane<string>()

  execute(
    sessionId: SessionId,
    command: SessionCommand,
    options: SessionExecuteOptions | undefined,
    operation: ExecuteCommand,
  ): Promise<SessionCommandResult> {
    if (isNonBlockingCommand(command)) return operation(sessionId, command, options)

    return this.lane.run(sessionId.toString(), () => operation(sessionId, command, options))
  }
}

function isNonBlockingCommand(command: SessionCommand): boolean {
  return (
    command.type === "get_snapshot" ||
    command.type === "read_events" ||
    command.type === "read_trace" ||
    command.type === "read_model_calls" ||
    command.type === "resolve_approval" ||
    command.type === "resolve_ask" ||
    command.type === "start_run" ||
    command.type === "steer" ||
    command.type === "cancel_input"
  )
}
