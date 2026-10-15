/**
 * ModelClient → CallModel adapter and provider fallback.
 *
 * The runtime depends only on CallModel. Try clients in configured order; if one fails,
 * try the next and throw only after all clients fail.
 */

import type { Message, AssistantMessage } from "@ag2cli/core/message.js"
import type { CallModel, CallModelOptions } from "@ag2cli/runtime/ports/model/contract.js"
import type { ModelClient, CallModelInput } from "@ag2cli/runtime/ports/model/contract.js"

/** Wrap one ModelClient as a CallModel. */
export function clientToCallModel(client: ModelClient): CallModel {
  return async (messages: Message[], options?: CallModelOptions): Promise<AssistantMessage> => {
    const input: CallModelInput = {
      messages,
      model: options?.model,
      tools: options?.tools,
      maxTokens: options?.maxTokens,
      systemPrompt: options?.systemPrompt,
      signal: options?.signal,
      thinking: options?.thinking,
      reasoningEffort: options?.reasoningEffort,
    }
    return client.call(input)
  }
}

/**
 * Wrap a group of ModelClients as a CallModel with fallback.
 *
 * Try clients in order: record each failure and try the next; throw the last error only if all clients fail.
 * Fallback applies only to the current call; the higher-level state machine handles recovery across turns.
 *
 * Fallback completes within a single callModel invocation and is transparent to the agent loop: the loop sees
 * the first successful response, or the last error if every client fails.
 */
export function clientChainWithFallback(clients: ModelClient[]): {
  callModel: CallModel
  protocol: ModelClient["protocol"]
} {
  if (clients.length === 0) throw new Error("clientChainWithFallback: at least one client is required")
  return {
    callModel: async (messages, options) => {
      let lastErr: unknown
      for (const client of clients) {
        try {
          const input: CallModelInput = {
            messages,
            model: options?.model,
            tools: options?.tools,
            maxTokens: options?.maxTokens,
            systemPrompt: options?.systemPrompt,
            signal: options?.signal,
            thinking: options?.thinking,
            reasoningEffort: options?.reasoningEffort,
          }
          return await client.call(input)
        } catch (err) {
          lastErr = err
          // Try the next provider.
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error("All providers failed")
    },
    protocol: clients[0]!.protocol,
  }
}
