import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicTransientEvent } from "@ag2cli/app-server-protocol/dto/transient.js"

export type ChatEntry =
  | { readonly id: string; readonly role: "user"; readonly text: string }
  | { readonly id: string; readonly role: "assistant"; readonly text: string; readonly runId?: string }
  | { readonly id: string; readonly role: "tool"; readonly text: string; readonly name?: string }
  | { readonly id: string; readonly role: "status"; readonly text: string; readonly tone: "error" | "muted" }

/**
 * Child-agent attribution: attributed stream events and the spawn fact belong
 * to a child panel this client does not have. The store keeps the facts; only
 * this projection filters them out.
 */
function isChildAttributed(event: PublicTransientEvent): boolean {
  return event.kind === "child_agent_started" || ("childSessionId" in event && event.childSessionId !== undefined)
}

/** Deduplicates by eventId; multiple events may legally share one revision. */
export function mergeWireEvents(
  existing: readonly PublicSessionEvent[],
  incoming: readonly PublicSessionEvent[],
): readonly PublicSessionEvent[] {
  const byEventId = new Map<string, PublicSessionEvent>()
  for (const event of existing) byEventId.set(event.eventId, event)
  for (const event of incoming) byEventId.set(event.eventId, event)
  return [...byEventId.values()].sort((left, right) => left.revision - right.revision)
}

export function projectChat(
  events: readonly PublicSessionEvent[],
  transientEvents: readonly PublicTransientEvent[] = [],
): readonly ChatEntry[] {
  const entries = new Map<string, ChatEntry>()
  const durableAssistantRuns = new Set<string>()
  const durableToolCalls = new Set<string>()
  const terminalRuns = new Set<string>()

  for (const event of [...events].sort((left, right) => left.revision - right.revision)) {
    switch (event.type) {
      case "message.upserted": {
        const message = event.message
        const text = contentText(message.content)
        if (text === undefined) break
        entries.set(message.messageId, {
          id: message.messageId,
          role: message.role,
          text,
          ...(message.role === "assistant" && message.runId !== undefined ? { runId: message.runId } : {}),
        })
        if (message.role === "assistant" && message.runId !== undefined) durableAssistantRuns.add(message.runId)
        break
      }
      case "tool_call.upserted": {
        const toolCall = event.toolCall
        if (toolCall.status !== "completed" && toolCall.status !== "failed") break
        durableToolCalls.add(toolCall.toolCallId)
        const summary = toolCall.resultSummary
        if (summary === undefined || summary.length === 0) break
        entries.set(`tool:${toolCall.toolCallId}`, {
          id: `tool:${toolCall.toolCallId}`,
          role: "tool",
          text: summary,
          name: toolCall.toolName,
        })
        break
      }
      case "run.updated": {
        const run = event.run
        if (run.status === "completed" || run.status === "cancelled") terminalRuns.add(run.runId)
        if (run.status === "failed") {
          terminalRuns.add(run.runId)
          entries.set(`status:${event.eventId}`, {
            id: `status:${event.eventId}`,
            role: "status",
            text: run.failure?.message ?? "Run failed",
            tone: "error",
          })
        }
        break
      }
      case "input.failed": {
        entries.set(`status:${event.eventId}`, {
          id: `status:${event.eventId}`,
          role: "status",
          text: event.failure.message || "Input failed",
          tone: "error",
        })
        break
      }
    }
  }
  return [...entries.values(), ...projectTransient(transientEvents, terminalRuns, durableAssistantRuns, durableToolCalls)]
}

export function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return undefined
  const text = value
    .filter(isRecord)
    .flatMap((block) => {
      if (block.type === "text" && typeof block.text === "string") return [block.text]
      return []
    })
    .join("")
  return text.length > 0 ? text : undefined
}

function projectTransient(
  events: readonly PublicTransientEvent[],
  terminalRuns: ReadonlySet<string>,
  durableAssistantRuns: ReadonlySet<string>,
  durableToolCalls: ReadonlySet<string>,
): readonly ChatEntry[] {
  const assistant = new Map<string, { readonly id: string; readonly runId: string; text: string }>()
  const tools = new Map<string, { readonly id: string; readonly name: string; text: string }>()
  const order: string[] = []
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (isChildAttributed(event)) continue
    if (terminalRuns.has(event.runId)) continue
    if (event.kind === "model_text_delta") {
      if (durableAssistantRuns.has(event.runId)) continue
      const delta = event.text
      if (delta.length === 0) continue
      const key = `assistant:${event.runId}`
      const current = assistant.get(key)
      if (current) current.text += delta
      else {
        assistant.set(key, { id: event.eventId, runId: event.runId, text: delta })
        order.push(key)
      }
      continue
    }
    if (event.kind === "child_agent_started") continue
    const toolCallId = "toolCallId" in event ? event.toolCallId : undefined
    if (toolCallId !== undefined && durableToolCalls.has(toolCallId)) continue
    if (event.kind === "model_tool_call_start" || event.kind === "model_tool_call_delta" || event.kind === "model_tool_call_end") {
      if (toolCallId === undefined) continue
      const key = `tool:${toolCallId}`
      const current = tools.get(key)
      if (current) {
        if (event.kind === "model_tool_call_delta") current.text += event.inputDelta
      } else {
        tools.set(key, {
          id: event.eventId,
          name: event.kind === "model_tool_call_start" ? event.toolName : "Tool call",
          text: event.kind === "model_tool_call_start" ? "Calling tool…" : event.kind === "model_tool_call_delta" ? event.inputDelta : "",
        })
        order.push(key)
      }
      continue
    }
    if (event.kind === "tool_output_delta" && toolCallId !== undefined) {
      const key = `tool:${toolCallId}`
      const current = tools.get(key)
      if (current) current.text += event.text
      else {
        tools.set(key, { id: event.eventId, name: "Tool output", text: event.text })
        order.push(key)
      }
    }
  }
  return order.flatMap((key): ChatEntry[] => {
    const liveAssistant = assistant.get(key)
    if (liveAssistant) return [{ id: liveAssistant.id, role: "assistant", text: liveAssistant.text, runId: liveAssistant.runId }]
    const liveTool = tools.get(key)
    return liveTool ? [{ id: liveTool.id, role: "tool", text: liveTool.text, name: liveTool.name }] : []
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
