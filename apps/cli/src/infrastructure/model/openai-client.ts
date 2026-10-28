/**
 * ModelClient implementation for the OpenAI protocol.
 *
 * Use the OpenAI SDK to call /v1/chat/completions. The main task is protocol normalization: translate OpenAI's
 * response shape into our AssistantMessage so the agent loop remains unaware of provider differences.
 *
 * Normalization mapping:
 *  - choices[0].message.content (string | null) → [{type:"text",text}] or []
 *  - choices[0].message.tool_calls[] → [{type:"tool_use",id,name,input}]
 *    Note that OpenAI's function.arguments is a JSON string and must be parsed with JSON.parse.
 *  - choices[0].finish_reason("stop"|"tool_calls"|"length"|...) → stop_reason
 *    length means the output reached the max_tokens limit.
 *  - Tool definition: OpenAI uses {type:"function",function:{name,description,parameters}}.
 *
 * Authenticate with Authorization: Bearer (matching the provided endpoint). Use the ID supplied by OpenAI for tool_use.
 */

import OpenAI from "openai"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.js"
import type { AssistantMessage, ContentBlock, Message } from "@ag2cli/core/message.js"
import { type ModelClient, type CallModelInput } from "@ag2cli/runtime/ports/model/contract.js"
import { joinSystemPrompt } from "@ag2cli/runtime/ports/model/prompt.js"
import { loadRuntimeConfig } from "../../config/runtime.js"
import { withModelRetry, withModelStreamRetry } from "./retry/controller.js"
import { classifyModelResponse } from "./retry/failure.js"
import { buildOpenAICompletionParams, estimateRequestTokens } from "./compatibility/request.js"
import { deriveFamily, resolveOpenAICompatibility } from "./compatibility/resolver.js"
import { resolveRequestMaxTokens } from "./request-cap.js"
import { resolveModel } from "@ag2cli/model-catalog/resolve.js"
import type { ModelOverrides } from "@ag2cli/model-catalog/types.js"
import {
  contentParts,
  makeAssistantMessage,
  normalizeOpenAIResponse,
  readReasoningDelta,
  ThinkTagStreamParser,
  type OpenAICompletionLike,
} from "./compatibility/response.js"
import type { OpenAICompatibilityName, OpenAIReasoningEffort, OpenAIThinkingMode } from "@ag2cli/runtime/ports/model/compatibility.js"

/** Configuration for the OpenAI protocol (shared with Anthropic, but using a different request path). */
export interface OpenAIConfig {
  baseURL: string // User-configured OpenAI-compatible endpoint; the SDK does not append /v1.
  apiKey: string
  model: string
  contextWindow?: number
  compatibility?: OpenAICompatibilityName
  thinking?: OpenAIThinkingMode
  reasoningEffort?: OpenAIReasoningEffort
  maxTokens?: number
  /** Invoked once per unknown model; provider is the derived endpoint family, if any. */
  onModelMiss?: (miss: { protocol: "openai"; provider?: string; modelId: string }) => void
}

/** Read OpenAI settings from the environment (separate variables avoid conflicts with Anthropic's AG2CLI_* settings). */
export function loadOpenAIConfig(env: Readonly<Record<string, string | undefined>> = process.env): OpenAIConfig {
  // Reuse the same AG2CLI_* variables while allowing OpenAI-specific overrides. The endpoint must be provided by the user
  // to avoid binding the application to a particular vendor or proxy by default.
  const provider = loadRuntimeConfig(env).provider
  const baseURL = provider.openaiBaseURL ?? provider.baseURL
  const apiKey = provider.openaiApiKey ?? provider.apiKey
  const model = provider.openaiModel ?? provider.model
  if (!baseURL || !apiKey || !model) {
    throw new Error("OpenAI configuration is missing: set AG2CLI_BASE_URL, AG2CLI_API_KEY, and AG2CLI_MODEL (or AG2CLI_OPENAI_*)")
  }
  return {
    baseURL,
    apiKey,
    model,
    ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
    ...(provider.compatibility ? { compatibility: provider.compatibility } : {}),
    thinking: provider.thinking,
    reasoningEffort: provider.reasoningEffort,
    ...(provider.maxTokens ? { maxTokens: provider.maxTokens } : {}),
  }
}

/** Map OpenAI finish_reason to the internal stop_reason. */
function mapFinishReason(reason: string | null | undefined): string | undefined {
  switch (reason) {
    case "stop":
      return "end_turn"
    case "tool_calls":
      return "tool_use"
    case "length":
      return "max_tokens" // The output reached the max_tokens limit.
    default:
      return reason ?? undefined
  }
}

export class OpenAIModelClient implements ModelClient {
  readonly protocol = "openai" as const
  model: string
  private reasoningEffort?: OpenAIReasoningEffort
  private readonly baseURL: string
  private readonly compatibility?: OpenAICompatibilityName
  private readonly configuredThinking: OpenAIThinkingMode
  private readonly configuredReasoningEffort: OpenAIReasoningEffort
  private readonly family: string | undefined
  private readonly catalogOverrides: ModelOverrides
  private readonly onModelMiss?: (miss: { protocol: "openai"; provider?: string; modelId: string }) => void
  private readonly reportedMisses = new Set<string>()
  private client: OpenAI

  constructor(config?: OpenAIConfig) {
    const cfg = config ?? loadOpenAIConfig()
    // Surface an unusable explicit endpoint at construction time instead of
    // at the first request.
    if (!URL.canParse(cfg.baseURL)) {
      throw new Error(`Invalid OpenAI endpoint: ${cfg.baseURL}`)
    }
    this.client = new OpenAI({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      maxRetries: 0,
    })
    this.baseURL = cfg.baseURL
    this.model = cfg.model
    this.compatibility = cfg.compatibility
    // Family depends only on (endpoint, compatibility), never on the model,
    // so it is derived once and reused for every per-call resolution.
    this.family = deriveFamily(cfg.baseURL, cfg.compatibility)
    this.catalogOverrides = {
      ...(cfg.contextWindow === undefined ? {} : { contextWindow: cfg.contextWindow }),
      ...(cfg.maxTokens === undefined ? {} : { maxOutputTokens: cfg.maxTokens }),
    }
    this.onModelMiss = cfg.onModelMiss
    this.configuredThinking = cfg.thinking ?? "auto"
    this.configuredReasoningEffort = cfg.reasoningEffort ?? "auto"
  }

  setModel(model: string): void {
    const value = model.trim()
    if (!value) throw new Error("Model name must not be empty")
    this.model = value
  }

  /** Misses dedupe per instance on (family ?? protocol, modelId); the callback fires once per key. */
  private reportModelMiss(modelId: string): void {
    if (this.onModelMiss === undefined) return
    const key = `${this.family ?? "openai"}:${modelId}`
    if (this.reportedMisses.has(key)) return
    this.reportedMisses.add(key)
    this.onModelMiss({ protocol: "openai", ...(this.family === undefined ? {} : { provider: this.family }), modelId })
  }

  setEffort(effort: "low" | "medium" | "high"): void {
    this.reasoningEffort = effort
  }

  /**
   * Stream a call. OpenAI uses stream:true; delta.content contains incremental text,
   * and choices[0].finish_reason appears at the end. Normalize these into our StreamEvent.
   */
  async *callStream(input: CallModelInput): AsyncGenerator<import("@ag2cli/runtime/ports/model/stream.js").StreamEvent> {
    try {
      yield* withModelStreamRetry(() => this.callStreamOnce(input), {
        signal: input.signal,
        isTerminal: (event) => event.type === "message_end",
        isVisibleOutput: (event) => event.type === "text" && event.text.trim().length > 0,
        isToolCall: (event) => event.type === "tool_call_start" || event.type === "tool_call_delta" || event.type === "tool_call_end",
        errorFromEvent: (event) => (event.type === "error" ? event.error : undefined),
        ...(input.onRetry ? { onRetry: input.onRetry } : {}),
        classifyTerminal: (event) =>
          event.type === "message_end"
            ? classifyModelResponse({
                stopReason: event.stop_reason,
                content: event.message?.message.content,
              })
            : undefined,
      })
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
    }
  }

  private async *callStreamOnce(input: CallModelInput): AsyncGenerator<import("@ag2cli/runtime/ports/model/stream.js").StreamEvent> {
    const profile = this.compatibilityFor()
    const request = this.buildRequest(input, profile, true)
    const stream = (await this.client.chat.completions.create(
      request as never,
      input.signal ? { signal: input.signal } : undefined,
    )) as unknown as AsyncIterable<unknown>
    let finishReason: string | null | undefined
    let text = ""
    let thinking = ""
    let responseId: string | undefined
    let responseModel: string | undefined
    let usage: OpenAICompletionLike["usage"]
    let structuredReasoningSeen = false
    const toolCalls = new Map<number, { id: string; name: string; inputText: string; started: boolean }>()
    const tagParser = profile.descriptor.parseThinkTags ? new ThinkTagStreamParser() : undefined
    try {
      for await (const chunk of stream) {
        const rawChunk = chunk as unknown as Record<string, unknown>
        responseId = typeof rawChunk.id === "string" ? rawChunk.id : responseId
        responseModel = typeof rawChunk.model === "string" ? rawChunk.model : responseModel
        if (rawChunk.usage !== undefined) usage = rawChunk.usage as OpenAICompletionLike["usage"]
        const choices = Array.isArray(rawChunk.choices) ? rawChunk.choices : []
        const choice = (choices[0] ?? {}) as Record<string, unknown>
        const delta = (choice.delta ?? {}) as Record<string, unknown>
        const structuredReasoning = readReasoningDelta(delta, profile.descriptor.visibleReasoningDetailTypes)
        if (structuredReasoning.thinking) {
          structuredReasoningSeen = true
          thinking += structuredReasoning.thinking
          yield { type: "thinking", thinking: structuredReasoning.thinking }
        }
        const contentDelta = contentParts(delta.content)
        if (contentDelta.thinking) {
          structuredReasoningSeen = true
          thinking += contentDelta.thinking
          yield { type: "thinking", thinking: contentDelta.thinking }
        }
        const textDelta = contentDelta.text || structuredReasoning.text
        if (textDelta) {
          const parts = contentDelta.text
            ? (tagParser?.feed(contentDelta.text) ?? { thinking: "", text: contentDelta.text })
            : { thinking: "", text: textDelta }
          if (parts.thinking && !structuredReasoningSeen) {
            thinking += parts.thinking
            yield { type: "thinking", thinking: parts.thinking }
          }
          if (parts.text) {
            text += parts.text
            yield { type: "text", text: parts.text }
          }
        }
        for (const toolCall of readStreamToolCalls(delta.tool_calls, delta.function_call)) {
          const index = toolCall.index
          const current = toolCalls.get(index) ?? {
            id: toolCall.id ?? `tool_call_${index}`,
            name: "",
            inputText: "",
            started: false,
          }
          if (toolCall.id) current.id = toolCall.id
          if (toolCall.function?.name) current.name += toolCall.function.name
          if (!current.started && current.name) {
            current.started = true
            yield { type: "tool_call_start", id: current.id, name: current.name }
          }
          const argumentsDelta = toolCall.function?.arguments
          if (argumentsDelta) {
            current.inputText += argumentsDelta
            yield { type: "tool_call_delta", id: current.id, delta: argumentsDelta }
          }
          toolCalls.set(index, current)
        }
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason
      }
      const finalTagParts = tagParser?.finish() ?? { thinking: "", text: "" }
      if (finalTagParts.thinking) {
        thinking += finalTagParts.thinking
        yield { type: "thinking", thinking: finalTagParts.thinking }
      }
      if (finalTagParts.text) {
        text += finalTagParts.text
        yield { type: "text", text: finalTagParts.text }
      }
      const content: ContentBlock[] = []
      if (thinking) content.push({ type: "thinking", thinking })
      if (text) content.push({ type: "text", text })
      for (const toolCall of [...toolCalls.values()]) {
        const toolInput = parseToolInput(toolCall.inputText)
        if (!toolCall.started) yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name }
        yield { type: "tool_call_end", id: toolCall.id, input: toolInput }
        content.push({ type: "tool_use", id: toolCall.id, name: toolCall.name, input: toolInput })
      }
      const stopReason = mapFinishReason(finishReason)
      yield {
        type: "message_end",
        stop_reason: stopReason,
        message: {
          ...makeAssistantMessage(content, stopReason, {
            protocol: "openai",
            model: responseModel ?? this.model,
            ...(responseId ? { providerRequestId: responseId } : {}),
            ...(usage ? { usage: openaiUsage(usage) } : {}),
          }),
        },
      }
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
    }
  }

  async call(input: CallModelInput): Promise<AssistantMessage> {
    return withModelRetry(() => this.callOnce(input), {
      signal: input.signal,
      ...(input.onRetry ? { onRetry: input.onRetry } : {}),
      classifyResult: (response) =>
        classifyModelResponse({
          stopReason: response.stop_reason,
          content: response.message.content,
        }),
    })
  }

  private async callOnce(input: CallModelInput): Promise<AssistantMessage> {
    const profile = this.compatibilityFor()
    const request = this.buildRequest(input, profile, false)
    const res = await this.client.chat.completions.create(request as never, input.signal ? { signal: input.signal } : undefined)
    const normalized = normalizeOpenAIResponse(
      res as unknown as OpenAICompletionLike,
      profile.descriptor.parseThinkTags,
      profile.descriptor.visibleReasoningDetailTypes,
    )
    const choice = normalized.choice
    const content = normalized.content
    const metadata = {
      protocol: "openai" as const,
      model:
        typeof (res as unknown as Record<string, unknown>).model === "string"
          ? ((res as unknown as Record<string, unknown>).model as string)
          : this.model,
      providerRequestId:
        typeof (res as unknown as Record<string, unknown>).id === "string"
          ? ((res as unknown as Record<string, unknown>).id as string)
          : undefined,
      ...((res as unknown as OpenAICompletionLike).usage ? { usage: openaiUsage((res as unknown as OpenAICompletionLike).usage!) } : {}),
    }

    return {
      ...makeAssistantMessage(
        content,
        mapFinishReason(typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined),
        metadata,
      ),
    }
  }

  private compatibilityFor() {
    return resolveOpenAICompatibility(this.baseURL, this.compatibility ? { name: this.compatibility } : undefined)
  }

  private buildRequest(
    input: CallModelInput,
    resolved: ReturnType<typeof resolveOpenAICompatibility>,
    stream: boolean,
  ): Record<string, unknown> {
    const model = input.model ?? this.model
    const resolvedFacts = resolveModel({
      protocol: "openai",
      ...(this.family === undefined ? {} : { provider: this.family }),
      modelId: model,
      overrides: this.catalogOverrides,
    })
    if (!resolvedFacts.matched) this.reportModelMiss(model)
    const params = buildOpenAICompletionParams({
      descriptor: resolved.descriptor,
      input: {
        ...input,
        thinking: input.thinking ?? this.configuredThinking,
        reasoningEffort: input.reasoningEffort ?? this.reasoningEffort ?? this.configuredReasoningEffort,
      },
      maxTokens: resolveRequestMaxTokens(
        {
          ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
          estimatedInputTokens: estimateRequestTokens(input),
        },
        resolvedFacts,
      ),
    })
    const request: Record<string, unknown> = {
      model,
      messages: toOpenAIMessages(input, resolved.descriptor),
      ...params,
      ...(stream ? { stream: true } : {}),
    }
    if (stream && resolved.descriptor.supportsStreamUsage) request.stream_options = { include_usage: true }
    const tools = input.tools?.map((t) => {
      const td = t as { name: string; description: string; input_schema: Record<string, unknown> }
      return { type: "function", function: { name: td.name, description: td.description, parameters: td.input_schema } }
    })
    if (tools && tools.length > 0) request.tools = tools
    return request
  }
}

function parseToolInput(value: string): unknown {
  if (!value.trim()) return {}
  try {
    return JSON.parse(value) as unknown
  } catch {
    return { _raw: value }
  }
}

/**
 * Unlike Anthropic, OpenAI's `cached_tokens` is a subset already included in
 * `prompt_tokens`/`total_tokens` (informational breakdown, not an additive
 * line item), so unlike anthropicUsage() this does not adjust totalTokens.
 */
function openaiUsage(usage: OpenAI.CompletionUsage | NonNullable<OpenAICompletionLike["usage"]>): {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens?: number
  reasoningTokens?: number
} {
  const cachedInputTokens =
    typeof usage.prompt_tokens_details?.cached_tokens === "number" ? usage.prompt_tokens_details.cached_tokens : undefined
  const reasoningTokens =
    typeof usage.completion_tokens_details?.reasoning_tokens === "number" ? usage.completion_tokens_details.reasoning_tokens : undefined
  return {
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

/**
 * Normalize internal Message[] into a message sequence that conforms to the Chat Completions protocol.
 *
 * Key normalization rules (aligned with the OpenAI SDK's ChatCompletionMessageParam union):
 *  - An assistant message containing a tool_use block becomes one {role:"assistant", content: text | null,
 *    tool_calls:[{id,type:"function",function:{name,arguments (JSON string)}}]} message.
 *    Text blocks go in content; tool_use blocks go in tool_calls (both may appear in one message).
 *  - Each tool_result block in a user message becomes its own {role:"tool", tool_call_id, content} message
 *    (OpenAI requires tool results to use a separate role:tool message rather than being placed in a user message).
 *    Any remaining text blocks become a separate user message, if present.
 *  - Plain-text user/assistant messages pass through as {role, content:string}.
 *
 * If systemPrompt is present, insert it as the first {role:"system"} message (OpenAI puts system messages
 * in the messages array rather than in a separate top-level field as Anthropic does).
 */
type OpenAIMessage = ChatCompletionMessageParam

/** Join all text blocks from internal content into a string (return "" when there is no text). */
function joinText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
}

/** Expand one internal Message into zero or more OpenAI messages (tool results may expand into multiple messages). */
function toOpenAIMessage(m: Message, descriptor: ReturnType<typeof resolveOpenAICompatibility>["descriptor"]): OpenAIMessage[] {
  const content = m.message.content
  if (m.type === "user") {
    if (typeof content === "string") {
      return [{ role: "user", content }]
    }
    const results: OpenAIMessage[] = []
    // Emit all tool_result blocks first as separate role:tool messages, preserving their order.
    for (const b of content) {
      if (b.type === "tool_result") {
        results.push({ role: "tool", content: b.content, tool_call_id: b.tool_use_id })
      }
    }
    // Put any remaining text in a separate user message.
    const text = joinText(content)
    if (text) results.push({ role: "user", content: text })
    return results
  }
  // For assistant messages, text maps to content and tool_use maps to tool_calls in the same message.
  // Here m is narrowed to AssistantMessage, whose content is ContentBlock[].
  const blocks = m.message.content
  const text = joinText(blocks)
  const thinking = blocks
    .filter((b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking")
    .map((b) => b.thinking)
    .join("")
  const toolUses = blocks.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
  const toolCalls = toolUses.map((b) => ({
    id: b.id,
    type: "function" as const,
    function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
  }))
  const assistantMessage: Record<string, unknown> = {
    role: "assistant",
    content: text || (descriptor.assistantEmptyContent === "empty" ? "" : null),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
  if (descriptor.reasoningReplay === "preserve" || descriptor.reasoningReplay === "placeholder") {
    assistantMessage.reasoning_content = thinking || ""
  }
  if (!text && !thinking && toolCalls.length === 0) return []
  return [assistantMessage as unknown as OpenAIMessage]
}

function toOpenAIMessages(input: CallModelInput, descriptor: ReturnType<typeof resolveOpenAICompatibility>["descriptor"]): OpenAIMessage[] {
  const apiMessages = input.messages.flatMap((message) => toOpenAIMessage(message, descriptor))
  const systemText = input.systemPrompt ? joinSystemPrompt(input.systemPrompt) : undefined
  return systemText ? [{ role: "system", content: systemText }, ...apiMessages] : apiMessages
}

function readStreamToolCalls(
  value: unknown,
  legacyValue?: unknown,
): Array<{
  readonly index: number
  readonly id?: string
  readonly function?: { readonly name?: string; readonly arguments?: string }
}> {
  const calls = Array.isArray(value)
    ? value.flatMap((item, itemIndex) => {
        const record = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : undefined
        const fn =
          record?.function !== null && typeof record?.function === "object" ? (record.function as Record<string, unknown>) : undefined
        if (!record) return []
        return [
          {
            index: typeof record.index === "number" ? record.index : itemIndex,
            ...(typeof record.id === "string" ? { id: record.id } : {}),
            ...(fn
              ? {
                  function: {
                    ...(typeof fn.name === "string" ? { name: fn.name } : {}),
                    ...(typeof fn.arguments === "string" ? { arguments: fn.arguments } : {}),
                  },
                }
              : {}),
          },
        ]
      })
    : []
  if (calls.length > 0 || legacyValue === undefined) return calls
  const legacy = legacyValue !== null && typeof legacyValue === "object" ? (legacyValue as Record<string, unknown>) : undefined
  if (!legacy) return []
  return [
    {
      index: 0,
      function: {
        ...(typeof legacy.name === "string" ? { name: legacy.name } : {}),
        ...(typeof legacy.arguments === "string" ? { arguments: legacy.arguments } : {}),
      },
    },
  ]
}
