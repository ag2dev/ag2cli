import type { AgentEvent } from "../events/event.js"
import type { RunId } from "../ids.js"
import type { AssistantMessage, Message } from "../message.js"
import { userText } from "../message.js"
import { projectConversationMessages } from "./session-projection.js"

/** Rebuild the model-visible transcript from the canonical session events. */
export function messagesFromSessionEvents(events: readonly AgentEvent[]): Message[] {
  return projectConversationMessages(events, messagesFromConversationEvents)
}

/**
 * Fold one already-projected conversation view into the live transcript: a
 * compaction event replaces the transcript with its rebuilt messages.
 */
export function messagesFromConversationEvents(events: readonly AgentEvent[]): Message[] {
  return foldConversationEvents(events, false)
}

/**
 * Fold the conversation corpus across compaction boundaries. History
 * retrieval must see every pre-boundary segment, so a compaction event
 * resets the pairing bookkeeping only — its rebuilt transcript never
 * enters the corpus and no segment is dropped.
 */
export function foldConversationSegments(events: readonly AgentEvent[]): Message[] {
  return foldConversationEvents(events, true)
}

function foldConversationEvents(events: readonly AgentEvent[], retainSegments: boolean): Message[] {
  const messages: Message[] = []
  const acceptedInputs = new Map<string, Extract<AgentEvent, { type: "InputAccepted" }>["payload"]>()
  // Tool ids the transcript's assistant messages actually carry. A
  // ToolResultCommitted without one belongs to a model-less run — a
  // user `!` command — whose result must never become a tool_result
  // block: providers reject a tool message with no preceding assistant
  // tool call, and the shell output belongs to the user side anyway.
  const assistantToolUses = new Set<string>()
  // Tool ids carried by the latest assistant message: the only ids whose
  // results are siblings of one another and must share one user row.
  const currentTurnToolUses = new Set<string>()
  // Tool ids whose result is already in the transcript. The reducer allows
  // re-committing under a fresh attempt id, but a second row with the same
  // tool_use_id would violate the providers' pairing rule.
  const answeredToolUses = new Set<string>()
  const collectToolUses = (content: Message["message"]["content"]): void => {
    if (typeof content === "string") return
    for (const block of content) {
      if (block.type === "tool_use") assistantToolUses.add(block.id)
    }
  }
  // The tail user row and the run that produced it, so a model-less
  // run's shell output merges into the command echo it answers.
  let tailUserRow: {
    readonly runId: RunId
    readonly text: string
    readonly index: number
  } | null = null
  for (const event of events) {
    if (event.type === "InputAccepted") {
      acceptedInputs.set(event.payload.inputId, event.payload)
    }
    if (event.type === "InputConsumed") {
      const accepted = acceptedInputs.get(event.payload.inputId)
      // Every consumed input — prompt, steer, host notification — wakes the
      // loop as user-side text: the model must see the delivery, not merely
      // be re-driven.
      if (accepted !== undefined) {
        messages.push(userText(accepted.text))
        tailUserRow = {
          runId: event.payload.runId,
          text: accepted.text,
          index: messages.length - 1,
        }
      }
    }
    if (event.type === "ContextCompacted" || event.type === "SessionContextCompacted") {
      if (!retainSegments) {
        messages.length = 0
        messages.push(...event.payload.messages)
      }
      // Pairing restarts from the compacted transcript: only the tool
      // uses the summary itself carries can still answer results, and
      // results the summary already carries count as answered.
      assistantToolUses.clear()
      currentTurnToolUses.clear()
      answeredToolUses.clear()
      for (const message of event.payload.messages) {
        collectToolUses(message.message.content)
        const content = message.message.content
        if (typeof content !== "string") {
          for (const block of content) {
            if (block.type === "tool_result") answeredToolUses.add(block.tool_use_id)
          }
        }
      }
      for (let i = event.payload.messages.length - 1; i >= 0; i--) {
        const message = event.payload.messages[i]
        if (message !== undefined && message.type === "assistant") {
          const content = message.message.content
          if (typeof content !== "string") {
            for (const block of content) {
              if (block.type === "tool_use") currentTurnToolUses.add(block.id)
            }
          }
          break
        }
      }
      tailUserRow = null
    }
    if (event.type === "ModelResponseCommitted") {
      const assistant: AssistantMessage = {
        type: "assistant",
        message: { role: "assistant", content: [...event.payload.content] },
        ...(event.payload.stopReason ? { stop_reason: event.payload.stopReason } : {}),
      }
      messages.push(assistant)
      collectToolUses(assistant.message.content)
      // Each assistant message opens a fresh answer window: only its own
      // tool uses may still be answered, each at most once.
      const content = assistant.message.content
      currentTurnToolUses.clear()
      for (const block of content) {
        if (block.type === "tool_use") currentTurnToolUses.add(block.id)
      }
      answeredToolUses.clear()
      tailUserRow = null
    }
    if (event.type === "ToolResultCommitted") {
      if (assistantToolUses.has(event.payload.toolUseId)) {
        if (!answeredToolUses.has(event.payload.toolUseId)) {
          const block = {
            tool_use_id: event.payload.toolUseId,
            content: event.payload.result.content,
            is_error: event.payload.result.isError,
          }
          // Sibling results of one assistant message must share its single
          // answering user row: Anthropic requires every tool_use to be
          // answered by tool_result blocks in the immediately next message.
          const tail = currentTurnToolUses.has(event.payload.toolUseId) ? tailToolResultBlocks(messages[messages.length - 1]) : null
          if (tail !== null) {
            messages[messages.length - 1] = toolResultMessage([...tail, block])
          } else {
            messages.push(toolResultMessage([block]))
          }
          answeredToolUses.add(event.payload.toolUseId)
        }
      } else if (tailUserRow !== null && tailUserRow.runId === event.payload.runId && tailUserRow.index === messages.length - 1) {
        // The `!` command echo is still the tail message: fold the
        // output into it so the model sees one user row — command and
        // result together.
        messages[tailUserRow.index] = userText(`${tailUserRow.text}\n${event.payload.result.content}`)
      } else {
        messages.push(userText(event.payload.result.content))
      }
    }
  }
  return messages
}

/** Format a bounded, read-only conversation snapshot for auxiliary clients. */
export function formatMessagesForContext(messages: readonly Message[], maxCharacters = 12_000): string[] {
  const lines = messages.map((message) => {
    const role = message.type === "user" ? "User" : "Assistant"
    return `${role}: ${messageContentText(message.message.content)}`
  })
  const joined = lines.join("\n")
  if (joined.length <= maxCharacters) return lines
  return [`…\n${joined.slice(-Math.max(1, maxCharacters - 2))}`]
}

/** The tail row's tool_result blocks, or null unless the tail is a user row made solely of results. */
function tailToolResultBlocks(message: Message | undefined): { tool_use_id: string; content: string; is_error?: boolean }[] | null {
  if (message === undefined || message.type !== "user") return null
  const content = message.message.content
  if (typeof content === "string" || content.length === 0) return null
  const blocks: { tool_use_id: string; content: string; is_error?: boolean }[] = []
  for (const block of content) {
    if (block.type !== "tool_result") return null
    blocks.push(
      block.is_error === undefined
        ? { tool_use_id: block.tool_use_id, content: block.content }
        : { tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error },
    )
  }
  return blocks
}

function toolResultMessage(
  results: readonly {
    tool_use_id: string
    content: string
    is_error?: boolean
  }[],
): Message {
  return {
    type: "user",
    message: {
      role: "user",
      content: results.map((result) => ({ type: "tool_result", ...result })),
    },
  }
}

function messageContentText(content: Message["message"]["content"]): string {
  if (typeof content === "string") return content
  return content
    .filter((block) => block.type !== "thinking")
    .map((block) => {
      if (block.type === "text") return block.text
      if (block.type === "tool_use") return `${block.name}(${JSON.stringify(block.input)})`
      if (block.type === "tool_result") return block.content
      return ""
    })
    .join("\n")
}
