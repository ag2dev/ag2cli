/**
 * Canonical facts for model-call observations: requests, provenance, usage, and call records.
 *
 * Keep only pure data shapes here; policy parsing and redaction belong in ports/observability,
 * and collection belongs in adapters/telemetry.
 */

import type { EventTrace } from "../events/event.js"
import type { RunId, SessionId } from "../ids.js"
import type { ContentBlock, Message } from "../message.js"
import type { PromptAssemblyManifest, SystemPrompt } from "./prompt.js"
import type { ApiToolDefinition } from "../tool-facts.js"

export type ObservabilityMode = "disabled" | "metadata" | "local-full"
export type TelemetryMode = "disabled" | "redacted"
export type ModelCallPurpose = "plan" | "execution" | "compact" | "auxiliary"

export interface CanonicalModelRequest {
  readonly messages: readonly Message[]
  readonly systemPrompt?: SystemPrompt
  readonly tools: readonly ApiToolDefinition[]
  readonly maxTokens?: number
  readonly context?: ContextProvenance
}

export interface ContextProvenance {
  readonly requestContextCount: number
  readonly memoryNames: readonly string[]
  readonly skillNames: readonly string[]
  /** Stable IDs only; prompt text remains governed by observability policy. */
  readonly prompt?: PromptAssemblyManifest
  readonly compact?: {
    readonly status: "disabled" | "not-needed" | "applied"
    readonly inputMessageCount: number
    readonly outputMessageCount: number
    readonly inputTokens?: number
  }
}

export interface ModelUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  /** True when inputTokens came from the provider-neutral request estimate. */
  readonly estimated?: boolean
  /**
   * Input tokens served from a prompt cache instead of full-price processing.
   * Semantics differ by protocol, so this is not additive across providers:
   *  - Anthropic: NOT included in `inputTokens`; add it (plus
   *    `cacheCreationInputTokens`) to `inputTokens` to get the true input total
   *    (`totalTokens` below already does this).
   *  - OpenAI: a subset already included in `inputTokens` (informational only).
   */
  readonly cachedInputTokens?: number
  /**
   * Input tokens spent writing new entries into a prompt cache (Anthropic
   * `cache_creation_input_tokens`; no OpenAI equivalent — omitted there). Not
   * included in `inputTokens`.
   */
  readonly cacheCreationInputTokens?: number
  /** Provider-reported reasoning token count when available. */
  readonly reasoningTokens?: number
}

export interface ModelProviderMetadata {
  readonly protocol: "anthropic" | "openai"
  readonly model?: string
  readonly providerRequestId?: string
  readonly usage?: ModelUsage
}

export interface ModelCallObservation {
  readonly callId: string
  readonly purpose: ModelCallPurpose
  readonly request: CanonicalModelRequest
  readonly status: "succeeded" | "failed" | "cancelled"
  readonly startedAt: string
  readonly completedAt: string
  readonly durationMs: number
  readonly response?: {
    readonly content: readonly ContentBlock[]
    readonly stopReason?: string
    readonly metadata?: ModelProviderMetadata
  }
  readonly error?: { readonly name: string; readonly message: string }
}

export interface ModelCallRecord {
  readonly sessionId: SessionId
  readonly callId: string
  readonly purpose: ModelCallPurpose
  readonly runId?: RunId
  readonly turn?: number
  readonly trace: EventTrace
  readonly status: "started" | "succeeded" | "failed" | "cancelled"
  readonly startedAt: string
  readonly completedAt?: string
  readonly durationMs?: number
  /** Retry lifecycle projected from canonical ModelRetryScheduled events. */
  readonly retries?: readonly ModelRetrySummary[]
  readonly request?: CanonicalModelRequest
  /** Low-sensitive request provenance; unlike `request`, it projects in every observability mode. */
  readonly context?: ContextProvenance
  readonly response?: {
    readonly content?: readonly ContentBlock[]
    readonly stopReason?: string
    readonly metadata?: ModelProviderMetadata
  }
  readonly error?: { readonly name: string; readonly message: string }
}

export interface ModelRetrySummary {
  readonly attempt: number
  readonly nextAttempt: number
  readonly delayMs: number
  readonly category: string
}
