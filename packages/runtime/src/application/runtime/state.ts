/**
 * Agent execution state.
 *
 * The state object carries data across iterations and is rebuilt rather than
 * mutated in place when execution continues. Each transition therefore creates
 * a complete snapshot for auditing, replay, and recovery-path tests.
 */

import type { Message } from "@ag2cli/core/message.js"
import type { Continue } from "./transitions.js"

export interface State {
  messages: Message[]
  turns: number
  /** Continue transition from the previous iteration; undefined means the first turn. Terminal transitions are not written back to State (the loop breaks directly). */
  transition: Continue | undefined
  /**
   * Effective max_tokens passed to the model. undefined means use the default.
   */
  maxTokensOverride: number | undefined
  /**
   * Whether this turn has already tried increasing the output limit, preventing
   * the recovery path from triggering repeatedly.
   */
  hasAttemptedTokensEscalate: boolean
}

/** Default output limit before escalation. */
export const DEFAULT_MAX_TOKENS = 1024
/** Output limit used for recovery retries. */
export const ESCALATED_MAX_TOKENS = 8192

/** Create the initial State. */
export function initialState(messages: Message[]): State {
  return {
    messages,
    turns: 0,
    transition: undefined,
    maxTokensOverride: undefined,
    hasAttemptedTokensEscalate: false,
  }
}

/**
 * Rebuild the entire State at a continue point.
 *
 * Explicitly list every field, including unchanged ones, rather than assigning
 * individual fields such as `state.turns = ...`. This makes each continue point
 * a complete snapshot that can be audited and compared.
 */
export function rebuild(
  prev: State,
  patch: Partial<Omit<State, "messages">> & {
    appendedMessages?: Message[]
    /** Replace the messages array entirely for context compaction. Takes precedence over appendedMessages. */
    replaceMessages?: Message[]
  },
): State {
  // maxTokensOverride must distinguish explicitly passing undefined (reset) from
  // omitting the field (inherit), because ?? treats undefined as omitted. Use
  // hasOwn to check whether the patch explicitly includes this key.
  const overrideTouched = Object.prototype.hasOwnProperty.call(patch, "maxTokensOverride")
  const messages = patch.replaceMessages
    ? [...patch.replaceMessages]
    : patch.appendedMessages
      ? [...prev.messages, ...patch.appendedMessages]
      : prev.messages
  return {
    messages,
    turns: patch.turns ?? prev.turns,
    transition: patch.transition ?? prev.transition,
    // Use the patch value only when explicitly touched (including undefined to reset); otherwise inherit.
    maxTokensOverride: overrideTouched ? patch.maxTokensOverride : prev.maxTokensOverride,
    hasAttemptedTokensEscalate: patch.hasAttemptedTokensEscalate ?? prev.hasAttemptedTokensEscalate,
  }
}
