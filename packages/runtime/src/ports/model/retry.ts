/**
 * Canonical vocabulary for model retries: failure categories and retry events.
 *
 * This module contains only data shapes; classification and backoff are implemented in adapters/model/retry.
 */

export type ModelFailureSource = "http" | "network" | "stream" | "semantic"

export type ModelFailureCategory =
  | "empty_response"
  | "transport"
  | "timeout"
  | "rate_limited"
  | "provider_unavailable"
  | "quota_exhausted"
  | "authentication"
  | "context_overflow"
  | "request_invalid"
  | "tool_compatibility"
  | "malformed_response"
  | "partial_stream_failure"
  | "cancelled"
  | "unknown"

export type ModelFailureCode =
  | "EMPTY_RESPONSE"
  | "TRANSPORT_ERROR"
  | "REQUEST_TIMEOUT"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "QUOTA_EXHAUSTED"
  | "AUTHENTICATION_ERROR"
  | "CONTEXT_OVERFLOW"
  | "INVALID_REQUEST"
  | "TOOL_COMPATIBILITY"
  | "MALFORMED_RESPONSE"
  | "PARTIAL_STREAM_FAILURE"
  | "CANCELLED"
  | "UNKNOWN"

export interface ModelFailure {
  readonly category: ModelFailureCategory
  readonly source: ModelFailureSource
  readonly message: string
  readonly status?: number
  readonly providerCode?: string
  readonly retryAfterMs?: number
  /** The provider may recover, but replay may still be unsafe. */
  readonly retryable: boolean
  /** Safe to send the same logical request again. */
  readonly replayable: boolean
  /** Conservative one-time fallback for an unknown pre-response transport error. */
  readonly conservativeRetryable: boolean
}

export interface ModelFailureContext {
  readonly hasVisibleOutput?: boolean
  readonly hasToolCall?: boolean
  readonly userCancelled?: boolean
}

export interface ModelRetryEvent {
  readonly attempt: number
  readonly nextAttempt: number
  readonly delayMs: number
  readonly failure: ModelFailure
}
