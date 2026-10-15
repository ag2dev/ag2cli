import type { CallModel, CallModelOptions } from "@ag2cli/runtime/ports/model/contract.js"
import type { AssistantMessage } from "@ag2cli/core/message.js"
import type { ExecutionModelProvider, ExecutionModelStreamEvent } from "@ag2cli/runtime/ports/execution-model-provider.js"
import type { StreamEvent } from "@ag2cli/runtime/ports/model/stream.js"

/** Adapter for the existing provider clients while the runtime boundary is migrated. */
export function callModelExecutionProvider(
  callModel: CallModel,
  callModelStream?: (messages: import("@ag2cli/core/message.js").Message[], options?: CallModelOptions) => AsyncGenerator<StreamEvent>,
): ExecutionModelProvider {
  return {
    generate: async ({ messages, tools, model, maxTokens, thinking, reasoningEffort, systemPrompt, signal, onStreamEvent, onRetry }) => {
      if (!callModelStream || !onStreamEvent) {
        return callModel([...messages], {
          ...(tools.length > 0 ? { tools: [...tools] } : {}),
          ...(model ? { model } : {}),
          ...(systemPrompt ? { systemPrompt: [...systemPrompt] } : {}),
          ...(signal ? { signal } : {}),
          ...(onRetry ? { onRetry } : {}),
          ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(thinking === undefined ? {} : { thinking }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        })
      }

      return collectStream(
        callModelStream([...messages], {
          ...(tools.length > 0 ? { tools: [...tools] } : {}),
          ...(model ? { model } : {}),
          ...(systemPrompt ? { systemPrompt: [...systemPrompt] } : {}),
          ...(signal ? { signal } : {}),
          ...(onRetry ? { onRetry } : {}),
          ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(thinking === undefined ? {} : { thinking }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        }),
        onStreamEvent,
      )
    },
  }
}

async function collectStream(
  stream: AsyncGenerator<StreamEvent>,
  onStreamEvent: (event: ExecutionModelStreamEvent) => void,
): Promise<AssistantMessage> {
  let text = ""
  let thinking = ""
  const toolCalls = new Map<string, { readonly name: string; inputText: string; input?: unknown }>()
  let finalMessage: AssistantMessage | undefined
  let stopReason: string | undefined

  for await (const event of stream) {
    if (event.type === "thinking") {
      thinking += event.thinking
      onStreamEvent({ type: "thinking_delta", delta: event.thinking })
    } else if (event.type === "text") {
      if (event.text.length === 0) continue
      text += event.text
      onStreamEvent({ type: "text_delta", delta: event.text })
    } else if (event.type === "tool_call_start") {
      toolCalls.set(event.id, { name: event.name, inputText: "" })
      onStreamEvent({ type: "tool_call_start", toolUseId: event.id, name: event.name })
    } else if (event.type === "tool_call_delta") {
      const call = toolCalls.get(event.id)
      if (call) call.inputText += event.delta
      onStreamEvent({ type: "tool_call_delta", toolUseId: event.id, delta: event.delta })
    } else if (event.type === "tool_call_end") {
      const call = toolCalls.get(event.id)
      if (call) call.input = event.input
      onStreamEvent({ type: "tool_call_end", toolUseId: event.id, input: event.input })
    } else if (event.type === "message_end") {
      stopReason = event.stop_reason
      finalMessage = event.message
    } else if (event.type === "error") {
      throw event.error
    }
  }

  if (finalMessage) {
    const finalContent = finalMessage.message.content
    const hasVisibleText = finalContent.some((block) => block.type === "text" && block.text.length > 0)
    const finalToolUseIds = new Set(
      finalContent
        .filter((block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use")
        .map((block) => block.id),
    )
    const missingToolUses = [...toolCalls.entries()]
      .filter(([id]) => !finalToolUseIds.has(id))
      .map(([id, call]) => ({
        type: "tool_use" as const,
        id,
        name: call.name,
        input: call.input ?? parseToolInput(call.inputText),
      }))
    const content = [
      ...(finalContent.some((block) => block.type === "thinking") || thinking.length === 0
        ? []
        : [{ type: "thinking" as const, thinking }]),
      ...(hasVisibleText || text.length === 0 ? [] : [{ type: "text" as const, text }]),
      ...finalContent,
      ...missingToolUses,
    ]
    return {
      ...finalMessage,
      message: { ...finalMessage.message, content },
      ...(finalMessage.stop_reason === undefined && stopReason !== undefined ? { stop_reason: stopReason } : {}),
    }
  }
  const content = [
    ...(thinking ? [{ type: "thinking" as const, thinking }] : []),
    ...(text ? [{ type: "text" as const, text }] : []),
    ...[...toolCalls.entries()].map(([id, call]) => ({
      type: "tool_use" as const,
      id,
      name: call.name,
      input: call.input ?? parseToolInput(call.inputText),
    })),
  ]
  return {
    type: "assistant",
    message: { role: "assistant", content },
    ...(stopReason ? { stop_reason: stopReason } : {}),
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
