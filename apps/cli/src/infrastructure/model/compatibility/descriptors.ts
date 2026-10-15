import type { OpenAIEndpointDescriptor } from "@ag2cli/runtime/ports/model/compatibility.js"

/**
 * Built-ins describe wire formats only. There is deliberately no model
 * capability or model-name registry here.
 */
export const OPENAI_ENDPOINT_DESCRIPTORS: readonly OpenAIEndpointDescriptor[] = [
  {
    name: "deepseek",
    matchers: [{ kind: "hostname", value: "api.deepseek.com" }],
    maxTokensField: "max_tokens",
    supportsReasoningEffort: true,
    thinkingRequestFormat: "deepseek",
    reasoningReplay: "preserve",
    assistantEmptyContent: "empty",
    parseThinkTags: true,
    visibleReasoningDetailTypes: [],
    supportsStreamUsage: false,
    requiresToolResultName: false,
  },
  {
    name: "qwen",
    matchers: [
      { kind: "hostname", value: "dashscope.aliyuncs.com" },
      { kind: "hostname", value: "dashscope-intl.aliyuncs.com" },
    ],
    maxTokensField: "max_tokens",
    supportsReasoningEffort: false,
    thinkingRequestFormat: "qwen",
    reasoningReplay: "strip",
    assistantEmptyContent: "null",
    parseThinkTags: true,
    visibleReasoningDetailTypes: [],
    supportsStreamUsage: false,
    requiresToolResultName: false,
  },
  {
    name: "openrouter",
    matchers: [{ kind: "hostname", value: "openrouter.ai" }],
    maxTokensField: "max_tokens",
    supportsReasoningEffort: true,
    thinkingRequestFormat: "openrouter",
    reasoningReplay: "strip",
    assistantEmptyContent: "null",
    parseThinkTags: true,
    visibleReasoningDetailTypes: ["response.output_text", "response.text"],
    supportsStreamUsage: true,
    requiresToolResultName: false,
  },
  {
    name: "together",
    matchers: [
      { kind: "hostname", value: "api.together.xyz" },
      { kind: "hostname", value: "api.together.ai" },
    ],
    maxTokensField: "max_tokens",
    supportsReasoningEffort: false,
    thinkingRequestFormat: "together",
    reasoningReplay: "strip",
    assistantEmptyContent: "null",
    parseThinkTags: true,
    visibleReasoningDetailTypes: [],
    supportsStreamUsage: false,
    requiresToolResultName: false,
  },
  {
    name: "zai",
    matchers: [
      { kind: "hostname", value: "api.z.ai" },
      { kind: "hostname", value: "open.bigmodel.cn" },
    ],
    maxTokensField: "max_tokens",
    supportsReasoningEffort: false,
    thinkingRequestFormat: "zai",
    reasoningReplay: "strip",
    assistantEmptyContent: "null",
    parseThinkTags: true,
    visibleReasoningDetailTypes: [],
    supportsStreamUsage: false,
    requiresToolResultName: false,
  },
  {
    name: "llama.cpp",
    // A remote local-compatible server is indistinguishable from generic
    // OpenAI by URL alone. Restrict this built-in to unmistakable local hosts;
    // users can still override a remote llama.cpp gateway explicitly.
    matchers: [
      { kind: "hostname", value: "localhost" },
      { kind: "hostname", value: "127.0.0.1" },
      { kind: "hostname", value: "[::1]" },
    ],
    maxTokensField: "max_tokens",
    supportsReasoningEffort: false,
    thinkingRequestFormat: "none",
    reasoningReplay: "strip",
    assistantEmptyContent: "null",
    parseThinkTags: true,
    visibleReasoningDetailTypes: [],
    supportsStreamUsage: false,
    requiresToolResultName: false,
  },
  {
    name: "openai",
    matchers: [{ kind: "hostname", value: "api.openai.com" }],
    maxTokensField: "max_completion_tokens",
    supportsReasoningEffort: true,
    thinkingRequestFormat: "openai",
    reasoningReplay: "strip",
    assistantEmptyContent: "null",
    parseThinkTags: false,
    visibleReasoningDetailTypes: [],
    supportsStreamUsage: true,
    requiresToolResultName: false,
  },
]

export const GENERIC_OPENAI_DESCRIPTOR: OpenAIEndpointDescriptor = {
  name: "generic",
  matchers: [],
  maxTokensField: "max_tokens",
  supportsReasoningEffort: false,
  thinkingRequestFormat: "none",
  reasoningReplay: "strip",
  assistantEmptyContent: "null",
  parseThinkTags: true,
  visibleReasoningDetailTypes: [],
  // `stream_options.include_usage` is part of the de-facto Chat Completions
  // contract and existing compatible endpoints rely on the final usage chunk.
  // Known endpoints that reject it opt out in their own descriptor.
  supportsStreamUsage: true,
  requiresToolResultName: false,
}

export function descriptorByName(name: string): OpenAIEndpointDescriptor | undefined {
  return name === "generic" ? GENERIC_OPENAI_DESCRIPTOR : OPENAI_ENDPOINT_DESCRIPTORS.find((item) => item.name === name)
}
