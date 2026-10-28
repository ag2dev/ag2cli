/**
 * A durable ask converged to expiry before the tool executed: the host
 * restarted and the restart sweep resolved the pending question as expired.
 * The run must end instead of executing unattended; RunFailed carries the
 * interaction_expired code.
 */
export class AskExpiredError extends Error {
  readonly toolName: string

  constructor(toolName: string) {
    super(`interaction_expired: ${toolName}`)
    this.name = "AskExpiredError"
    this.toolName = toolName
  }
}
