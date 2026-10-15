import type { EventTrace } from "./event.js"
import type { RunId, SessionId } from "../ids.js"

/**
 * Ephemeral events used by live clients while a run is in progress.
 *
 * These events are deliberately not revisions of the session journal. A
 * reconnecting client must recover from the durable events instead of relying
 * on replaying every token or process-output chunk.
 *
 * Child attribution: a delegated child agent's model stream is bridged onto
 * the parent session's live stream with `childSessionId` on the model kinds
 * (and one `child_agent_started` spawn fact), so a parent-side projection can
 * route attributed events to a child panel instead of the main transcript.
 */
export type TransientStreamEvent =
  | TransientStreamEventBase<
      "model_text_delta",
      {
        readonly runId: RunId
        readonly turn: number
        readonly callId: string
        readonly delta: string
        readonly childSessionId?: string
      }
    >
  | TransientStreamEventBase<
      "model_tool_call_start",
      {
        readonly runId: RunId
        readonly turn: number
        readonly callId: string
        readonly toolUseId: string
        readonly name: string
        readonly childSessionId?: string
      }
    >
  | TransientStreamEventBase<
      "model_tool_call_delta",
      {
        readonly runId: RunId
        readonly turn: number
        readonly callId: string
        readonly toolUseId: string
        readonly delta: string
        readonly childSessionId?: string
      }
    >
  | TransientStreamEventBase<
      "model_tool_call_end",
      {
        readonly runId: RunId
        readonly turn: number
        readonly callId: string
        readonly toolUseId: string
        readonly input: unknown
        readonly childSessionId?: string
      }
    >
  | TransientStreamEventBase<
      "tool_output_delta",
      {
        readonly runId: RunId
        readonly turn: number
        readonly toolUseId: string
        readonly name: string
        readonly stream: "stdout" | "stderr"
        readonly delta: string
      }
    >
  | TransientStreamEventBase<
      "child_agent_started",
      {
        /** Ephemeral child session id; durable lineage stays in ToolResult metadata. */
        readonly childSessionId: string
        readonly description: string
        readonly subagentType?: string
        readonly toolUseId?: string
      }
    >

export type TransientStreamEventType = TransientStreamEvent["type"]

export interface TransientStreamEventBase<TType extends TransientStreamEventType, TPayload> {
  readonly eventId: string
  readonly sessionId: SessionId
  /** Monotonic for the live stream; it is not a durable revision. */
  readonly sequence: number
  readonly type: TType
  readonly timestamp: string
  readonly trace: EventTrace
  readonly payload: TPayload
}
