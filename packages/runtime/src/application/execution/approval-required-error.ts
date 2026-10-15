/**
 * A model tool call was denied terminally: either an ask with no approval or
 * interaction surface to answer it, or a broker answer marked terminal (the
 * ask's policy world changed underneath it). The run must end instead of
 * retrying; `code` discriminates approval_required from stale_policy while
 * RunFailed keeps the single approval_required family literal and carries
 * this code in the message.
 */
export class ApprovalRequiredError extends Error {
  readonly code: "approval_required" | "stale_policy"
  readonly toolName: string

  constructor(toolName: string, code: "approval_required" | "stale_policy" = "approval_required") {
    super(`${code}: ${toolName}`)
    this.name = "ApprovalRequiredError"
    this.code = code
    this.toolName = toolName
  }
}
