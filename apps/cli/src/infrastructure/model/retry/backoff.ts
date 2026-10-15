import type { ModelFailure } from "@ag2cli/runtime/ports/model/retry.js"

export const RETRY_BASE_DELAY_MS = 1_000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_BACKOFF_MS = 30_000
export const RETRY_MAX_PROVIDER_HINT_MS = 60_000
export const RETRY_MIN_JITTER_DELAY_MS = 250

export interface RetryDelayOptions {
  readonly random?: number
  readonly remainingMs?: number
}

/**
 * Calculate one bounded exponential delay. Provider retry hints take priority;
 * the caller's remaining operation deadline still limits the result.
 */
export function retryDelay(retryIndex: number, failure?: Pick<ModelFailure, "retryAfterMs">, options: RetryDelayOptions = {}): number {
  const index = Math.max(1, Math.floor(retryIndex))
  const hinted = failure?.retryAfterMs
  const raw =
    hinted === undefined
      ? Math.min(RETRY_MAX_BACKOFF_MS, RETRY_BASE_DELAY_MS * RETRY_BACKOFF_FACTOR ** (index - 1))
      : Math.min(RETRY_MAX_PROVIDER_HINT_MS, Math.max(0, hinted))
  const random = clamp(options.random ?? Math.random(), 0, 1)
  const delayed = hinted === undefined ? RETRY_MIN_JITTER_DELAY_MS + Math.round(random * Math.max(0, raw - RETRY_MIN_JITTER_DELAY_MS)) : raw
  if (options.remainingMs === undefined) return delayed
  return Math.max(0, Math.min(delayed, options.remainingMs))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
