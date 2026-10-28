/**
 * ModelClient implementation for the Anthropic protocol.
 *
 * Evolved from defaultCallModel in the original client.ts: it uses @anthropic-ai/sdk to call
 * /v1/messages. The response content blocks (text / tool_use) already match our format,
 * requiring almost no normalization. This protocol most closely matches the internal Message shape.
 */

import Anthropic from "@anthropic-ai/sdk"
import type { AssistantMessage, ContentBlock } from "@ag2cli/core/message.js"
import { type ModelClient, type CallModelInput } from "@ag2cli/runtime/ports/model/contract.js"
import { type LlmConfig, loadConfig } from "../../config/model-config.js"
import { joinSystemPrompt } from "@ag2cli/runtime/ports/model/prompt.js"
import { withModelRetry, withModelStreamRetry } from "./retry/controller.js"
import { classifyModelResponse } from "./retry/failure.js"
import { resolveModel } from "@ag2cli/model-catalog/resolve.js"
import type { ModelOverrides } from "@ag2cli/model-catalog/types.js"
import { resolveRequestMaxTokens } from "./request-cap.js"
import { estimateRequestTokens } from "./compatibility/request.js"

export class AnthropicModelClient implements ModelClient {
  readonly protocol = "anthropic" as const
  model: string
  private readonly catalogOverrides: ModelOverrides
  private readonly onModelMiss?: (miss: { protocol: "anthropic"; modelId: string }) => void
  private readonly reportedMisses = new Set<string>()
  private client: Anthropic

  constructor(config?: LlmConfig & { onModelMiss?: (miss: { protocol: "anthropic"; modelId: string }) => void }) {
    const cfg = config ?? loadConfig()
    // Surface an unusable explicit endpoint at construction time instead of
    // at the first request.
    if (!URL.canParse(cfg.baseURL)) {
      throw new Error(`Invalid Anthropic endpoint: ${cfg.baseURL}`)
    }
    // Use only the explicit apiKey so a host auth token cannot change the authentication method.
    this.client = new Anthropic({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      authToken: null,
      maxRetries: 0,
    })
    this.model = cfg.model
    this.onModelMiss = config?.onModelMiss
    this.catalogOverrides = {
      ...(cfg.contextWindow === undefined ? {} : { contextWindow: cfg.contextWindow }),
      ...(cfg.maxTokens === undefined ? {} : { maxOutputTokens: cfg.maxTokens }),
    }
  }

  setModel(model: string): void {
    const value = model.trim()
    if (!value) throw new Error("Model name must not be empty")
    this.model = value
  }

  /**
   * The anthropic protocol normalizes every provider to the anthropic scope,
   * so resolution needs only the model id plus constructor overrides.
   */
  private requestMaxTokens(input: CallModelInput): number {
    const modelId = input.model ?? this.model
    const resolvedFacts = resolveModel({
      protocol: "anthropic",
      modelId,
      overrides: this.catalogOverrides,
    })
    if (!resolvedFacts.matched) this.reportModelMiss(modelId)
    return resolveRequestMaxTokens(
      {
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        estimatedInputTokens: estimateRequestTokens(input),
      },
      resolvedFacts,
    )
  }

  /** Misses dedupe per instance on (protocol, modelId); the anthropic protocol normalizes away the provider scope. */
  private reportModelMiss(modelId: string): void {
    if (this.onModelMiss === undefined) return
    const key = `anthropic:${modelId}`
    if (this.reportedMisses.has(key)) return
    this.reportedMisses.add(key)
    this.onModelMiss({ protocol: "anthropic", modelId })
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
    const apiMessages = input.messages.map((m) => ({
      role: m.message.role,
      content: typeof m.message.content === "string" ? m.message.content : m.message.content.filter((block) => block.type !== "thinking"),
    })) as Anthropic.Messages.MessageParam[]
    // The system prompt is a top-level field in the Anthropic protocol.
    const systemText = input.systemPrompt ? joinSystemPrompt(input.systemPrompt) : undefined
    const res = await this.client.messages.create(
      {
        model: input.model ?? this.model,
        max_tokens: this.requestMaxTokens(input),
        messages: apiMessages,
        // Keep tool definitions broadly typed in the protocol-independent layer and convert them to the provider shape at the SDK boundary.
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools as Anthropic.Messages.ToolUnion[] } : {}),
        ...(systemText ? { system: systemText } : {}),
      },
      input.signal ? { signal: input.signal } : undefined,
    )
    return {
      type: "assistant",
      message: {
        role: "assistant",
        content: res.content as ContentBlock[],
      },
      stop_reason: res.stop_reason ?? undefined,
      modelMetadata: {
        protocol: "anthropic",
        model: res.model,
        providerRequestId: res.id,
        usage: anthropicUsage(res.usage),
      },
    }
  }

  /**
   * Stream a call. Preserve JSON deltas for tool calls as well as text deltas; the execution runtime
   * enters tool approval and execution only after receiving the complete message.
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
    const apiMessages = input.messages.map((m) => ({
      role: m.message.role,
      content: typeof m.message.content === "string" ? m.message.content : m.message.content.filter((block) => block.type !== "thinking"),
    })) as Anthropic.Messages.MessageParam[]
    const systemText = input.systemPrompt ? joinSystemPrompt(input.systemPrompt) : undefined
    const stream = this.client.messages.stream(
      {
        model: input.model ?? this.model,
        max_tokens: this.requestMaxTokens(input),
        messages: apiMessages,
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools as Anthropic.Messages.ToolUnion[] } : {}),
        ...(systemText ? { system: systemText } : {}),
      },
      input.signal ? { signal: input.signal } : undefined,
    )
    let pendingStopReason: string | undefined
    const toolCalls = new Map<number, { readonly id: string; readonly name: string; inputText: string }>()
    try {
      for await (const ev of stream) {
        if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
          toolCalls.set(ev.index, {
            id: ev.content_block.id,
            name: ev.content_block.name,
            inputText: "",
          })
          yield { type: "tool_call_start", id: ev.content_block.id, name: ev.content_block.name }
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          yield { type: "text", text: ev.delta.text }
        } else if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta") {
          const toolCall = toolCalls.get(ev.index)
          if (toolCall) toolCall.inputText += ev.delta.partial_json
          if (toolCall) yield { type: "tool_call_delta", id: toolCall.id, delta: ev.delta.partial_json }
        } else if (ev.type === "content_block_stop") {
          const toolCall = toolCalls.get(ev.index)
          if (toolCall) yield { type: "tool_call_end", id: toolCall.id, input: parseToolInput(toolCall.inputText) }
        } else if (ev.type === "message_delta" && ev.delta.stop_reason) {
          pendingStopReason = ev.delta.stop_reason
        }
      }
      const message = await stream.finalMessage()
      yield {
        type: "message_end",
        stop_reason: pendingStopReason,
        message: {
          type: "assistant",
          message: { role: "assistant", content: message.content as ContentBlock[] },
          ...(pendingStopReason ? { stop_reason: pendingStopReason } : {}),
          modelMetadata: {
            protocol: "anthropic",
            model: message.model,
            providerRequestId: message.id,
            usage: anthropicUsage(message.usage),
          },
        },
      }
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
    }
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
 * Anthropic reports cache tokens as separate line items, not a subset of
 * `input_tokens` (unlike OpenAI's `cached_tokens`), so the true input total
 * is their sum — see "Total input tokens in a request is the summation of
 * `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`"
 * in the Anthropic Messages API usage docs.
 */
function anthropicUsage(usage?: Anthropic.Messages.Usage): {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
} {
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  const cacheCreationInputTokens = usage?.cache_creation_input_tokens ?? undefined
  const cachedInputTokens = usage?.cache_read_input_tokens ?? undefined
  return {
    inputTokens: usage?.input_tokens ?? undefined,
    outputTokens: usage?.output_tokens ?? undefined,
    totalTokens: inputTokens + outputTokens + (cacheCreationInputTokens ?? 0) + (cachedInputTokens ?? 0),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
  }
}
