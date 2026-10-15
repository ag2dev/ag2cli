import type { AppServerTransientEventKind } from "@ag2cli/app-server-protocol/types.js"

export type WireEvent = {
  readonly eventId: string
  readonly sessionId: string
  readonly revision: number
  readonly type: string
  readonly timestamp: string
  readonly payload: Record<string, unknown>
}

export type WireTransientEvent = {
  readonly eventId: string
  readonly sessionId: string
  readonly sequence: number
  readonly type: AppServerTransientEventKind
  readonly timestamp: string
  readonly payload: Record<string, unknown>
}

export type ChatEntry =
  | { readonly id: string; readonly role: "user"; readonly text: string }
  | { readonly id: string; readonly role: "assistant"; readonly text: string; readonly runId?: string }
  | { readonly id: string; readonly role: "tool"; readonly text: string; readonly name?: string }
  | { readonly id: string; readonly role: "status"; readonly text: string; readonly tone: "error" | "muted" }

/**
 * Child-agent attribution: attributed model-stream events and the spawn
 * fact belong to a child panel this client does not have, so they never
 * enter the conversation projection or the transient buffer.
 */
function isChildAttributed(event: WireTransientEvent): boolean {
  return event.type === "child_agent_started" || event.payload.childSessionId !== undefined
}

export interface PendingApproval {
  readonly key: string
  readonly runId: string
  readonly turn: number
  readonly toolUseId: string
  readonly name: string
  readonly preparedEventId: string
  readonly expectedScopeRevision: number
  readonly expectedPolicyRevision: number
  /** Guardian-owned asks are answered by the Guardian reviewer; this client can only display them. */
  readonly ownedBy?: "guardian"
}

export function pendingApprovals(events: readonly WireEvent[]): readonly PendingApproval[] {
  const pending = new Map<string, PendingApproval>()
  for (const event of events) {
    const runId = asString(event.payload.runId)
    const key = JSON.stringify([runId, event.payload.turn, event.payload.toolUseId])
    if (event.type === "ToolApprovalRequested" && runId !== undefined) {
      pending.set(key, {
        key,
        runId,
        turn: asNumber(event.payload.turn) ?? 0,
        toolUseId: asString(event.payload.toolUseId) ?? "",
        name: asString(event.payload.name) ?? "Tool",
        preparedEventId: asString(event.payload.preparedEventId) ?? event.eventId,
        expectedScopeRevision: asNumber(event.payload.scopeRevision) ?? 0,
        expectedPolicyRevision: asNumber(event.payload.policyRevision) ?? 0,
        ...(event.payload.ownedBy === "guardian" ? { ownedBy: "guardian" as const } : {}),
      })
    }
    if (event.type === "ToolApprovalResolved" || event.type === "ToolResultCommitted") pending.delete(key)
    if (["RunCompleted", "RunFailed", "RunCancelled"].includes(event.type)) {
      for (const [request, approval] of pending) if (approval.runId === runId) pending.delete(request)
    }
  }
  return [...pending.values()]
}

export function pendingApprovalCount(events: readonly WireEvent[]): number {
  return pendingApprovals(events).length
}

export function parseWireEvent(value: unknown, expectedSessionId?: string): WireEvent | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.eventId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.type !== "string" ||
    typeof value.timestamp !== "string" ||
    !isRecord(value.payload)
  ) {
    return undefined
  }
  if (expectedSessionId !== undefined && value.sessionId !== expectedSessionId) return undefined
  return {
    eventId: value.eventId,
    sessionId: value.sessionId,
    revision: value.revision,
    type: value.type,
    timestamp: value.timestamp,
    payload: value.payload,
  }
}

export function mergeWireEvents(existing: readonly WireEvent[], incoming: readonly WireEvent[]): readonly WireEvent[] {
  const byRevision = new Map<number, WireEvent>()
  for (const event of existing) byRevision.set(event.revision, event)
  for (const event of incoming) byRevision.set(event.revision, event)
  return [...byRevision.values()].sort((left, right) => left.revision - right.revision)
}

export function projectChat(events: readonly WireEvent[], transientEvents: readonly WireTransientEvent[] = []): readonly ChatEntry[] {
  const entries: ChatEntry[] = []
  const assistantRuns = new Set<string>()
  const runsWithToolOutput = new Set<string>()
  const terminalRuns = new Set<string>()
  const durableResponseTurns = new Set<string>()
  const durableToolCalls = new Set<string>()
  const acceptedInputs = new Map<string, string>()
  const toolNames = new Map<string, string>()

  for (const event of [...events].sort((left, right) => left.revision - right.revision)) {
    const payload = event.payload
    switch (event.type) {
      case "InputAccepted": {
        const inputId = asString(payload.inputId)
        const text = asString(payload.text)
        if (inputId !== undefined && text !== undefined) acceptedInputs.set(inputId, text)
        break
      }
      case "InputConsumed": {
        const inputId = asString(payload.inputId)
        const text = asString(payload.text) ?? (inputId === undefined ? undefined : acceptedInputs.get(inputId))
        if (text !== undefined) entries.push({ id: event.eventId, role: "user", text })
        break
      }
      case "ModelResponseCommitted": {
        const text = contentText(payload.content)
        const runId = asString(payload.runId)
        if (text !== undefined && text.length > 0) {
          if (runId !== undefined) durableResponseTurns.add(`${runId}:${asNumber(payload.turn) ?? 0}`)
          entries.push({ id: event.eventId, role: "assistant", text, ...(runId === undefined ? {} : { runId }) })
          if (runId !== undefined) assistantRuns.add(runId)
        }
        if (Array.isArray(payload.content)) {
          for (const block of payload.content) {
            if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
              toolNames.set(block.id, block.name)
            }
          }
        }
        break
      }
      case "ToolResultCommitted": {
        const toolUseId = asString(payload.toolUseId)
        if (toolUseId !== undefined) durableToolCalls.add(toolUseId)
        const runId = asString(payload.runId)
        if (runId !== undefined) runsWithToolOutput.add(runId)
        const result = isRecord(payload.result) ? asString(payload.result.content) : undefined
        if (result !== undefined) {
          const name = toolUseId === undefined ? undefined : toolNames.get(toolUseId)
          entries.push({ id: event.eventId, role: "tool", text: result, ...(name === undefined ? {} : { name }) })
        }
        break
      }
      case "RunCompleted": {
        const runId = asString(payload.runId)
        if (runId !== undefined) terminalRuns.add(runId)
        const finalText = asString(payload.finalText)
        if (
          runId !== undefined &&
          !assistantRuns.has(runId) &&
          !runsWithToolOutput.has(runId) &&
          finalText !== undefined &&
          finalText.length > 0
        ) {
          entries.push({ id: event.eventId, role: "assistant", text: finalText, runId })
        }
        break
      }
      case "RunFailed": {
        const runId = asString(payload.runId)
        if (runId !== undefined) terminalRuns.add(runId)
        const message = asString(payload.message) ?? "Run failed"
        entries.push({ id: event.eventId, role: "status", text: message, tone: "error" })
        break
      }
      case "RunCancelled": {
        const runId = asString(payload.runId)
        if (runId !== undefined) terminalRuns.add(runId)
        entries.push({ id: event.eventId, role: "status", text: asString(payload.reason) ?? "Run cancelled", tone: "muted" })
        break
      }
    }
  }
  return [...entries, ...projectTransient(transientEvents, terminalRuns, durableResponseTurns, durableToolCalls)]
}

export function mergeTransientEvents(
  existing: readonly WireTransientEvent[],
  incoming: readonly WireTransientEvent[],
): readonly WireTransientEvent[] {
  const byId = new Map<string, WireTransientEvent>()
  for (const event of existing) byId.set(event.eventId, event)
  for (const event of incoming) byId.set(event.eventId, event)
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence).slice(-512)
}

export function pruneTransientEvents(
  events: readonly WireEvent[],
  transientEvents: readonly WireTransientEvent[],
): readonly WireTransientEvent[] {
  const terminalRuns = new Set<string>()
  const durableResponseTurns = new Set<string>()
  const durableToolCalls = new Set<string>()
  for (const event of events) {
    const runId = asString(event.payload.runId)
    if (event.type === "RunCompleted" || event.type === "RunFailed" || event.type === "RunCancelled") {
      if (runId !== undefined) terminalRuns.add(runId)
    }
    if (event.type === "ModelResponseCommitted" && runId !== undefined) {
      if ((contentText(event.payload.content) ?? "").length > 0) durableResponseTurns.add(`${runId}:${asNumber(event.payload.turn) ?? 0}`)
    }
    if (event.type === "ToolResultCommitted") {
      const toolUseId = asString(event.payload.toolUseId)
      if (toolUseId !== undefined) durableToolCalls.add(toolUseId)
    }
  }
  return transientEvents.filter((event) => {
    if (isChildAttributed(event)) return false
    const runId = asString(event.payload.runId)
    if (runId !== undefined && terminalRuns.has(runId)) return false
    if (event.type === "model_text_delta") {
      return runId === undefined || !durableResponseTurns.has(`${runId}:${asNumber(event.payload.turn) ?? 0}`)
    }
    const toolUseId = asString(event.payload.toolUseId)
    return toolUseId === undefined || !durableToolCalls.has(toolUseId)
  })
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined
}

function projectTransient(
  events: readonly WireTransientEvent[],
  terminalRuns: ReadonlySet<string>,
  durableResponseTurns: ReadonlySet<string>,
  durableToolCalls: ReadonlySet<string>,
): readonly ChatEntry[] {
  const assistant = new Map<string, { readonly id: string; readonly runId: string; text: string }>()
  const tools = new Map<string, { readonly id: string; readonly name: string; text: string }>()
  const order: string[] = []
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (isChildAttributed(event)) continue
    const runId = asString(event.payload.runId)
    if (runId !== undefined && terminalRuns.has(runId)) continue
    const turn = asNumber(event.payload.turn) ?? 0
    if (event.type === "model_text_delta") {
      if (runId !== undefined && durableResponseTurns.has(`${runId}:${turn}`)) continue
      const delta = asString(event.payload.delta) ?? ""
      if (delta.length === 0 || runId === undefined) continue
      const key = `assistant:${runId}:${turn}`
      const current = assistant.get(key)
      if (current) current.text += delta
      else {
        assistant.set(key, { id: event.eventId, runId, text: delta })
        order.push(key)
      }
      continue
    }
    const toolUseId = asString(event.payload.toolUseId)
    if (toolUseId !== undefined && durableToolCalls.has(toolUseId)) continue
    if (event.type === "model_tool_call_start" || event.type === "model_tool_call_delta" || event.type === "model_tool_call_end") {
      if (toolUseId === undefined) continue
      const name = asString(event.payload.name) ?? "Tool call"
      const key = `tool:${toolUseId}`
      const current = tools.get(key)
      if (current) {
        if (event.type === "model_tool_call_delta") current.text += asString(event.payload.delta) ?? ""
        if (event.type === "model_tool_call_end") current.text = formatToolInput(event.payload.input)
      } else {
        tools.set(key, {
          id: event.eventId,
          name,
          text:
            event.type === "model_tool_call_start"
              ? "Calling tool…"
              : event.type === "model_tool_call_delta"
                ? (asString(event.payload.delta) ?? "")
                : formatToolInput(event.payload.input),
        })
        order.push(key)
      }
      continue
    }
    if (event.type === "tool_output_delta" && toolUseId !== undefined) {
      const key = `tool:${toolUseId}`
      const current = tools.get(key)
      const delta = asString(event.payload.delta) ?? ""
      if (current) current.text += delta
      else {
        tools.set(key, { id: event.eventId, name: asString(event.payload.name) ?? "Tool output", text: delta })
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

function formatToolInput(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? "{}"
  } catch {
    return "{}"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
