import type { ResolvedModelInfo } from "@ag2cli/model-catalog/types.js"

const OUTPUT_RESERVE_TOKENS = 256

export interface RequestCapInput {
  readonly maxTokens?: number
  readonly estimatedInputTokens: number
}

/**
 * Protocol-independent send-value formula shared by both clients: the
 * per-call cap or the resolved default, clamped by the usable-context budget
 * and the resolved capability ceiling. The budget floor keeps the value >= 1
 * so a huge request can never derive a non-positive cap.
 */
export function resolveRequestMaxTokens(input: RequestCapInput, resolved: ResolvedModelInfo): number {
  const requested = input.maxTokens ?? resolved.defaultMaxOutputTokens
  const usableBudget = Math.max(1, resolved.contextWindow.value - input.estimatedInputTokens - OUTPUT_RESERVE_TOKENS)
  const ceiling = resolved.maxOutputTokensCeiling.value ?? Number.MAX_SAFE_INTEGER
  return Math.min(requested, usableBudget, ceiling)
}
