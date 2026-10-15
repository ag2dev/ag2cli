/**
 * Agent control-flow transitions.
 *
 * Represent all continue and terminal decisions with a discriminated union so
 * control-flow reasons do not become scattered across conditional branches.
 * Transitions are written to execution state, making recovery paths auditable and testable.
 */

/** Variants that continue to the next turn. */
export type Continue =
  | { reason: "next_turn" } // The model called a tool; continue after execution.
  // Output was truncated by max_tokens; retry with a higher limit.
  | { reason: "max_output_tokens_escalate"; fromTokens: number; toTokens: number }
  // Context exceeded the threshold; compact history and retry.
  | { reason: "auto_compact_retry"; messagesBefore: number; messagesAfter: number }

/** Variants that terminate the loop. */
export type Terminal =
  | { reason: "completed"; finalText: string } // The model returned final text; finish normally.
  | { reason: "max_turns"; turnCount: number } // The turn limit was reached.
  // Unrecoverable model error.
  | { reason: "model_error"; error: string }
  // Context is still too large to continue.
  | { reason: "blocking_limit"; reason_detail: string }

/** One transition decision: continue or terminate. */
export type Transition = Continue | Terminal

/** Set of Continue reasons, used by isTerminal for reverse checking so new Continue variants need no guard change. */
const CONTINUE_REASONS = new Set<string>(["next_turn", "max_output_tokens_escalate", "auto_compact_retry"])

/** Type guard for whether a transition terminates the loop, based on whether its reason is outside the Continue set. */
export function isTerminal(t: Transition): t is Terminal {
  return !CONTINUE_REASONS.has(t.reason)
}
