/**
 * Expose a protocol-independent ModelClient through a generic message-stream interface.
 *
 * Provider protocol conversion must remain inside ModelClient; this module only selects the streaming
 * capability and must not create Anthropic or OpenAI SDK clients directly.
 */

import type { Message } from "@ag2cli/core/message.js"
import { flatText, type CallModelInput, type CallModelOptions, type ModelClient } from "@ag2cli/runtime/ports/model/contract.js"
import type { CallModelStream } from "@ag2cli/runtime/ports/model/stream.js"

export function modelClientToStream(client: Pick<ModelClient, "call" | "callStream">): CallModelStream {
  return async function* (messages: Message[], options?: CallModelOptions) {
    if (client.callStream) {
      yield* client.callStream({
        messages,
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.tools ? { tools: options.tools } : {}),
        ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options?.thinking ? { thinking: options.thinking } : {}),
        ...(options?.onRetry ? { onRetry: options.onRetry } : {}),
      })
      return
    }

    const response = await client.call({
      messages,
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.tools ? { tools: options.tools } : {}),
      ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options?.thinking ? { thinking: options.thinking } : {}),
      ...(options?.onRetry ? { onRetry: options.onRetry } : {}),
    })
    const text = flatText(response.message.content)
    for (const block of response.message.content) {
      if (block.type === "thinking" && block.thinking) yield { type: "thinking", thinking: block.thinking }
    }
    if (text) yield { type: "text", text }
    yield { type: "message_end", stop_reason: response.stop_reason, message: response }
  }
}
