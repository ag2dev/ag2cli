import type { CallModelInput } from "@ag2cli/runtime/ports/model/contract.js"
import type { OpenAIEndpointDescriptor, OpenAIReasoningEffort, OpenAIThinkingMode } from "@ag2cli/runtime/ports/model/compatibility.js"

export interface OpenAIRequestPolicyOptions {
  readonly descriptor: OpenAIEndpointDescriptor
  readonly input: Pick<CallModelInput, "messages" | "systemPrompt" | "tools" | "thinking" | "reasoningEffort">
  readonly maxTokens: number
  readonly configuredThinking?: OpenAIThinkingMode
  readonly configuredReasoningEffort?: OpenAIReasoningEffort
}

/** Build only provider-specific parameters; messages remain owned by the client adapter. */
export function buildOpenAICompletionParams(options: OpenAIRequestPolicyOptions): Record<string, unknown> {
  const { descriptor, input } = options
  const thinking = input.thinking ?? options.configuredThinking ?? "auto"
  const effort = input.reasoningEffort ?? options.configuredReasoningEffort ?? "auto"
  const params: Record<string, unknown> = {
    [descriptor.maxTokensField]: options.maxTokens,
  }

  const explicitThinking = thinking !== "auto" || effort !== "auto"
  if (!explicitThinking || descriptor.thinkingRequestFormat === "none") return params

  const enabled = thinking === "on" || (thinking === "auto" && effort !== "none")
  const requestedEffort = effort === "auto" || effort === "none" ? undefined : normalizeEffort(effort)
  switch (descriptor.thinkingRequestFormat) {
    case "openai":
      if (descriptor.supportsReasoningEffort) {
        if (enabled) params.reasoning_effort = requestedEffort ?? "medium"
        else params.reasoning_effort = "none"
      }
      break
    case "deepseek":
      params.thinking = { type: enabled ? "enabled" : "disabled" }
      if (enabled && requestedEffort && descriptor.supportsReasoningEffort) params.reasoning_effort = requestedEffort
      break
    case "qwen":
      params.enable_thinking = enabled
      break
    case "openrouter":
      params.reasoning = { effort: enabled ? (requestedEffort ?? "medium") : "none" }
      break
    case "together":
      params.reasoning = { enabled }
      if (enabled && requestedEffort && descriptor.supportsReasoningEffort) params.reasoning_effort = requestedEffort
      break
    case "zai":
      params.thinking = { type: enabled ? "enabled" : "disabled" }
      if (enabled && requestedEffort && descriptor.supportsReasoningEffort) params.reasoning_effort = requestedEffort
      break
  }
  return params
}

export function estimateRequestTokens(input: Pick<CallModelInput, "messages" | "systemPrompt" | "tools">): number {
  let characters = 0
  for (const message of input.messages) {
    const content = message.message.content
    characters += typeof content === "string" ? content.length : JSON.stringify(content).length
  }
  if (input.systemPrompt) characters += JSON.stringify(input.systemPrompt).length
  if (input.tools) characters += JSON.stringify(input.tools).length
  return Math.ceil(characters / 4) + input.messages.length * 4 + 16
}

function normalizeEffort(effort: Exclude<OpenAIReasoningEffort, "auto" | "none">): "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return effort
}
