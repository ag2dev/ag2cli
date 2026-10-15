/**
 * Agent message types.
 *
 * The outer `type` supports runtime dispatch; the inner `message` preserves the
 * role and content fields required by provider protocols. Protocol conversion
 * stays in boundary adapters.
 */

import type { ModelProviderMetadata } from "./model/observation.js"

/** A block of message content. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result"
      tool_use_id: string
      content: string
      is_error?: boolean
    }

/** A user message envelope. */
export interface UserMessage {
  type: "user"
  message: { role: "user"; content: string | ContentBlock[] }
}

/** An assistant message envelope. */
export interface AssistantMessage {
  type: "assistant"
  message: { role: "assistant"; content: ContentBlock[] }
  /** The model's stop reason: end_turn / tool_use / max_tokens / ... */
  stop_reason?: string
  /** Provider diagnostics captured without exposing SDK response types. */
  modelMetadata?: ModelProviderMetadata
}

/** A session message: a discriminated union of user and assistant messages. */
export type Message = UserMessage | AssistantMessage

/** Convenience helper for constructing an assistant text message. */
export function assistantText(text: string, stop_reason?: string): AssistantMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    stop_reason,
  }
}

/** Convenience helper for constructing a user text message. */
export function userText(text: string): UserMessage {
  return { type: "user", message: { role: "user", content: text } }
}
