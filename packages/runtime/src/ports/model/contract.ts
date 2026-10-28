/**
 * ModelClient — protocol-independent abstraction for model calls.
 *
 * Protocol conversion for provider requests and responses is contained in
 * ModelClient implementations. The runtime depends only on the unified
 * AssistantMessage type; adding a protocol requires only a new implementation.
 */

import type { Message, AssistantMessage, ContentBlock } from "@ag2cli/core/message.js"
import type { ApiToolDefinition } from "@ag2cli/core/tool-facts.js"
import type { StreamEvent } from "./stream.js"
import type { SystemPrompt } from "@ag2cli/core/model/prompt.js"
import type { ModelRetryEvent } from "./retry.js"
import type { OpenAIReasoningEffort, OpenAIThinkingMode } from "./compatibility.js"

/** Input and options for one model call, using the internal Message format. */
export interface CallModelInput {
  messages: Message[]
  /** Optional per-call model override, used by isolated child agents. */
  model?: string
  tools?: unknown[] // Tool definitions converted to API format; each implementation interprets them.
  maxTokens?: number
  /**
   * Array of system-prompt sections. Each protocol client normalizes this:
   * Anthropic uses the top-level system string; OpenAI uses a system role as the first message.
   */
  systemPrompt?: SystemPrompt
  /** Runtime reliability: cancellation signal passed by the client to the underlying SDK create/stream call. */
  signal?: AbortSignal
  thinking?: OpenAIThinkingMode
  reasoningEffort?: OpenAIReasoningEffort
  onRetry?: (event: ModelRetryEvent) => void | Promise<void>
}

/** Protocol-independent model client. */
export interface ModelClient {
  /** Protocol identifier. */
  readonly protocol: "anthropic" | "openai"
  /** Configured model identifier, for client status surfaces. */
  readonly model?: string
  /** Optional live model selection for interactive clients. */
  readonly setModel?: (model: string) => void
  readonly setEffort?: (effort: "low" | "medium" | "high") => void
  /** Aggregated call returning a normalized AssistantMessage. */
  call(input: CallModelInput): Promise<AssistantMessage>
  /**
   * Optional streaming call returning text, tool-call fragments, message_end,
   * and error events. If not implemented, the caller falls back to call() and
   * sends the aggregated response at once without incremental output.
   */
  callStream?(input: CallModelInput): AsyncGenerator<StreamEvent>
}

/** Extract plain text from content; shared by both implementations. */
export function flatText(content: ContentBlock[] | string): string {
  if (typeof content === "string") return content
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
}

/** Input to one model call in the internal Message format and its assistant-message output. */
export type CallModelResult = AssistantMessage

/** Options for one model call. */
export interface CallModelOptions {
  /** Optional per-call model override; does not mutate the shared client. */
  model?: string
  /** Tool definitions converted to API format; absent means plain conversation. */
  tools?: ApiToolDefinition[]
  /** Maximum output tokens. */
  maxTokens?: number
  /** System-prompt sections, applied throughout the session and passed on each model call. */
  systemPrompt?: SystemPrompt
  /** Runtime reliability: cancellation signal passed through by the entry-point OperationController; client implementations pass it to the SDK. */
  signal?: AbortSignal
  /** Provider-specific reasoning effort when the selected adapter supports it. */
  thinking?: OpenAIThinkingMode
  reasoningEffort?: OpenAIReasoningEffort
  /** Durable runtime callback invoked before a provider retry sleeps. */
  onRetry?: (event: ModelRetryEvent) => void | Promise<void>
}

/** Injection point that turns a conversation into a model response. The default implementation uses a provider adapter. */
export type CallModel = (messages: Message[], options?: CallModelOptions) => Promise<CallModelResult>
