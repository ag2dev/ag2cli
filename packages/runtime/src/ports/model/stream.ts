/**
 * Contract for streaming model calls.
 *
 * Normalize SDK stream events into a stable internal event union. Callers need
 * only the text, completion, and error event types, not provider-specific SSE details.
 */

import type { AssistantMessage, Message } from "@ag2cli/core/message.js"
import type { CallModelOptions } from "./contract.js"

/**
 * Provider-neutral response stream. Tool-call fragments are included because
 * a model may finish a turn with tool use and the runtime still needs the
 * complete AssistantMessage after the stream ends.
 */
export type StreamEvent =
  | { type: "text"; text: string } // A text delta.
  | { type: "thinking"; thinking: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; delta: string }
  | { type: "tool_call_end"; id: string; input: unknown }
  | { type: "message_end"; stop_reason?: string; message?: AssistantMessage } // The message ended.
  | { type: "error"; error: Error } // An error occurred in the stream.

/** Injection point that turns conversation history into an event stream. */
export type CallModelStream = (messages: Message[], options?: CallModelOptions) => AsyncGenerator<StreamEvent>
