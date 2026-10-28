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

export function thresholdsForContextWindow(contextWindow: number, maxOutputTokens?: number): CompactThresholds {
  // The effective window is what one request can actually hold after the
  // output-token reservation. The 12K floor keeps a small window from
  // collapsing the auto threshold below the smallest compact construction,
  // which would re-compact on every message; the window itself caps the
  // floor so the threshold never exceeds the real window. The blocking
  // limit stays derived from the raw window so an override of the output
  // reservation cannot move it.
  const reservedOutput = Math.min(maxOutputTokens ?? 20_000, 20_000)
  const effectiveWindow = Math.max(contextWindow - reservedOutput, Math.min(contextWindow, 12_000))
  const autoCompactTokens = Math.max(1, Math.floor(effectiveWindow * 0.75))
  return {
    autoCompactTokens,
    blockingLimitTokens: Math.max(autoCompactTokens + 1, Math.floor(contextWindow * 0.95)),
  }
}
