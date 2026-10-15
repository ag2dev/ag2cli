import type { RunId, SessionId } from "@ag2cli/core/ids.js"
import type { Message, AssistantMessage } from "@ag2cli/core/message.js"
import type { ApiToolDefinition } from "@ag2cli/core/tool-facts.js"
import type { SystemPrompt } from "@ag2cli/core/model/prompt.js"
import type { ModelRetryEvent } from "./model/retry.js"

/** Provider-neutral live updates emitted while a response is being generated. */
export type ExecutionModelStreamEvent =
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "thinking_delta"; readonly delta: string }
  | { readonly type: "tool_call_start"; readonly toolUseId: string; readonly name: string }
  | { readonly type: "tool_call_delta"; readonly toolUseId: string; readonly delta: string }
  | { readonly type: "tool_call_end"; readonly toolUseId: string; readonly input: unknown }

/** Model boundary used by the new execution runtime. It carries no SDK type. */
export interface ExecutionModelProvider {
  generate(input: {
    readonly sessionId: SessionId
    readonly runId: RunId
    readonly messages: readonly Message[]
    readonly tools: readonly ApiToolDefinition[]
    /** Optional per-call model override; the provider must not mutate shared state. */
    readonly model?: string
    readonly maxTokens?: number
    readonly thinking?: "auto" | "on" | "off"
    readonly reasoningEffort?: "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    readonly systemPrompt?: SystemPrompt
    readonly signal?: AbortSignal
    readonly onStreamEvent?: (event: ExecutionModelStreamEvent) => void
    readonly onRetry?: (event: ModelRetryEvent) => void | Promise<void>
  }): Promise<AssistantMessage>
}
