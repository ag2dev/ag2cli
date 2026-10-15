/**
 * Shared normalization for human-readable denial reason text: every settled
 * denial (executor settlement and shell settlement) filters empty reasons,
 * joins with one ASCII semicolon and caps the total length, so the model
 * content and the structured `denial.reason` never diverge.
 */
export const DENIED_REASON_MAX_LENGTH = 400

export function deniedReasons(reasons: readonly string[]): string {
  const joined = reasons.filter((reason) => reason.length > 0).join("; ")
  if (joined.length === 0) return ""
  return joined.length > DENIED_REASON_MAX_LENGTH ? `${joined.slice(0, DENIED_REASON_MAX_LENGTH)}…(truncated)` : joined
}
