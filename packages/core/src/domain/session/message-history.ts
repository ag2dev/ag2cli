import type { AgentEvent } from "../events/event.js"
import type { RunId } from "../ids.js"
import type { AssistantMessage, Message } from "../message.js"
import { userText } from "../message.js"
import { projectConversationMessages } from "./session-projection.js"

/** Rebuild the model-visible transcript from the canonical session events. */
export function messagesFromSessionEvents(events: readonly AgentEvent[]): Message[] {
  return projectConversationMessages(events, messagesFromConversationEvents)
}

function messagesFromConversationEvents(events: readonly AgentEvent[]): Message[] {
  const messages: Message[] = []
  const acceptedInputs = new Map<string, Extract<AgentEvent, { type: "InputAccepted" }>["payload"]>()
  // Tool ids the transcript's assistant messages actually carry. A
  // ToolResultCommitted without one belongs to a model-less run — a
  // user `!` command — whose result must never become a tool_result
  // block: providers reject a tool message with no preceding assistant
  // tool call, and the shell output belongs to the user side anyway.
  const assistantToolUses = new Set<string>()
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
      // Host notifications wake the loop as user-side text: the model must
      // see the delivery, not merely be re-driven.
      if (accepted !== undefined && accepted.kind !== "steer") {
        messages.push(userText(accepted.text))
        tailUserRow = {
          runId: event.payload.runId,
          text: accepted.text,
          index: messages.length - 1,
        }
      }
    }
    if (event.type === "ContextCompacted" || event.type === "SessionContextCompacted") {
      messages.length = 0
      messages.push(...event.payload.messages)
      // Pairing restarts from the compacted transcript: only the tool
      // uses the summary itself carries can still answer results.
      assistantToolUses.clear()
      for (const message of event.payload.messages) collectToolUses(message.message.content)
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
      tailUserRow = null
    }
    if (event.type === "ToolResultCommitted") {
      if (assistantToolUses.has(event.payload.toolUseId)) {
        messages.push(
          toolResultMessage([
            {
              tool_use_id: event.payload.toolUseId,
              content: event.payload.result.content,
              is_error: event.payload.result.isError,
            },
          ]),
        )
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
