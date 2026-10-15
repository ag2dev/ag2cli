/**
 * Canonical context-window limits and thresholds.
 *
 * Keep only pure data and functions here; compaction orchestration belongs in application/context.
 */

export interface CompactThresholds {
  readonly autoCompactTokens: number
  readonly blockingLimitTokens: number
}

export const DEFAULT_THRESHOLDS: CompactThresholds = {
  autoCompactTokens: 4000,
  blockingLimitTokens: 50000,
}

export const MAX_CONTEXT_WINDOW_TOKENS = 10_000_000

export function thresholdsForContextWindow(contextWindow: number): CompactThresholds {
  const autoCompactTokens = Math.max(1, Math.floor(contextWindow * 0.75))
  return {
    autoCompactTokens,
    blockingLimitTokens: Math.max(autoCompactTokens + 1, Math.floor(contextWindow * 0.95)),
  }
}
