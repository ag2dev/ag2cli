import type { ModelFailure } from "@ag2cli/runtime/ports/model/retry.js"

/** Total provider requests, including the initial request. */
export const RETRY_MAX_ATTEMPTS = {
  emptyResponse: 3,
  transport: 5,
  timeout: 5,
  rateLimited: 5,
  providerUnavailable: 5,
  unknownTransport: 2,
  default: 1,
} as const

export function maxAttemptsFor(failure: ModelFailure): number {
  switch (failure.category) {
    case "empty_response":
      return RETRY_MAX_ATTEMPTS.emptyResponse
    case "transport":
    case "partial_stream_failure":
      return failure.replayable ? RETRY_MAX_ATTEMPTS.transport : 1
    case "timeout":
      return failure.replayable ? RETRY_MAX_ATTEMPTS.timeout : 1
    case "rate_limited":
      return failure.replayable ? RETRY_MAX_ATTEMPTS.rateLimited : 1
    case "provider_unavailable":
      return failure.replayable ? RETRY_MAX_ATTEMPTS.providerUnavailable : 1
    case "unknown":
      return failure.conservativeRetryable && failure.replayable ? RETRY_MAX_ATTEMPTS.unknownTransport : RETRY_MAX_ATTEMPTS.default
    default:
      return RETRY_MAX_ATTEMPTS.default
  }
}

export function shouldRetry(failure: ModelFailure, attempt: number): boolean {
  const retryable = failure.retryable || failure.conservativeRetryable
  return retryable && failure.replayable && attempt < maxAttemptsFor(failure)
}
