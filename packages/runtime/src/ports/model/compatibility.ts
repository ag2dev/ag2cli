/**
 * OpenAI-compatible endpoint compatibility is intentionally endpoint-scoped,
 * not model-scoped. Providers frequently add or replace models; the wire
 * dialect is the stable part we can safely identify from a URL.
 */

export type OpenAICompatibilityName = "generic" | "openai" | "deepseek" | "qwen" | "openrouter" | "together" | "zai" | "llama.cpp"

export type OpenAIThinkingRequestFormat = "none" | "openai" | "deepseek" | "qwen" | "openrouter" | "together" | "zai"

export type OpenAIThinkingMode = "auto" | "on" | "off"

export type OpenAIReasoningEffort = "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export type OpenAIMaxTokensField = "max_tokens" | "max_completion_tokens"

export type OpenAIReasoningReplay = "strip" | "preserve" | "placeholder"

export interface OpenAIEndpointDescriptor {
  readonly name: OpenAICompatibilityName
  readonly matchers: readonly OpenAIEndpointMatcher[]
  readonly maxTokensField: OpenAIMaxTokensField
  readonly supportsReasoningEffort: boolean
  readonly thinkingRequestFormat: OpenAIThinkingRequestFormat
  readonly reasoningReplay: OpenAIReasoningReplay
  /** Content value for assistant messages that contain reasoning/tool calls but no text. */
  readonly assistantEmptyContent: "null" | "empty"
  readonly parseThinkTags: boolean
  /** Explicit reasoning-detail types that are actually visible answer text. */
  readonly visibleReasoningDetailTypes: readonly string[]
  readonly supportsStreamUsage: boolean
  readonly requiresToolResultName: boolean
}

export type OpenAIEndpointMatcher =
  | { readonly kind: "hostname"; readonly value: string }
  | { readonly kind: "hostname-suffix"; readonly value: string }
  | { readonly kind: "path-prefix"; readonly value: string }

export interface OpenAICompatibilityOverride {
  readonly name?: OpenAICompatibilityName
  readonly maxTokensField?: OpenAIMaxTokensField
  readonly supportsReasoningEffort?: boolean
  readonly thinkingRequestFormat?: OpenAIThinkingRequestFormat
  readonly reasoningReplay?: OpenAIReasoningReplay
  readonly assistantEmptyContent?: "null" | "empty"
  readonly parseThinkTags?: boolean
  readonly visibleReasoningDetailTypes?: readonly string[]
  readonly supportsStreamUsage?: boolean
  readonly requiresToolResultName?: boolean
}

export interface ResolvedOpenAICompatibility {
  readonly endpoint: string
  readonly descriptor: OpenAIEndpointDescriptor
  readonly source: "override" | "endpoint" | "generic"
}
