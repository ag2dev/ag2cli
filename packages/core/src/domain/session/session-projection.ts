import type { AgentEvent } from "../events/event.js"
import type { Message } from "../message.js"
import { reduceCanonicalSession, type CanonicalSessionState } from "./canonical-session.js"

/**
 * Events that describe the model-visible conversation. Session settings and
 * operational state are deliberately kept outside this projection so a later
 * timeline operation has one place to define what is rewound.
 */
export function projectConversationEvents(events: readonly AgentEvent[]): AgentEvent[] {
  if (events.length === 0) return []
  const state = reduceCanonicalSession(events)
  const activeEventIds = new Set<string>()
  let cursor = state.activeHead
  while (cursor !== undefined) {
    const node = state.nodes.get(`${cursor.branchId}:${cursor.nodeId}`)
    if (node?.eventId !== undefined) activeEventIds.add(node.eventId)
    cursor = node?.parentCursor
  }
  const activeConsumedInputs = new Set<string>()
  for (const event of events) {
    if (activeEventIds.has(event.eventId) && event.type === "InputConsumed") activeConsumedInputs.add(event.payload.inputId)
  }
  return events.filter(
    (event) =>
      (activeEventIds.has(event.eventId) && isConversationEvent(event)) ||
      (event.type === "InputAccepted" && activeConsumedInputs.has(event.payload.inputId)),
  )
}

/**
 * Project the state-bearing events that belong to the current canonical
 * generation. The physical JSONL tail is deliberately not the active view.
 */
export function projectActiveSessionEvents(events: readonly AgentEvent[]): AgentEvent[] {
  if (events.length === 0) return []
  const state = reduceCanonicalSession(events)
  const activeEventIds = activeHistoryEventIds(state)
  const consumedInputs = new Set<string>()
  for (const event of events) {
    if (activeEventIds.has(event.eventId) && event.type === "InputConsumed") consumedInputs.add(event.payload.inputId)
  }
  const activeRuns = new Set(
    [...state.runs.values()]
      .filter((run) => run.executionGeneration === state.executionGeneration && run.branchId === state.activeHead?.branchId)
      .map((run) => String(run.runId)),
  )
  for (const event of events) {
    if (!activeEventIds.has(event.eventId)) continue
    const runId = runIdOf(event)
    if (runId !== undefined) activeRuns.add(runId)
  }
  return events.filter((event) => {
    if (event.type === "SessionCreated") return true
    if (activeEventIds.has(event.eventId)) return true
    if (event.type === "InputAccepted") return consumedInputs.has(event.payload.inputId)
    const runId = runIdOf(event)
    if (runId !== undefined) return activeRuns.has(runId)
    return isSessionStateEvent(event)
  })
}

/**
 * Build the model-visible message list from one canonical conversation view.
 * Message construction remains here rather than in clients or transports.
 */
export function projectConversationMessages(
  events: readonly AgentEvent[],
  createMessages: (events: readonly AgentEvent[]) => Message[],
): Message[] {
  return createMessages(projectConversationEvents(events))
}

/** Return whether an event contributes to the model-visible conversation. */
export function isConversationEvent(event: AgentEvent): boolean {
  switch (event.type) {
    case "InputConsumed":
    case "ModelResponseCommitted":
    case "ToolResultCommitted":
    case "PlanCreated":
    case "PlanGenerationFailed":
    case "PlanGenerationCancelled":
    case "ContextCompacted":
    case "SessionContextCompacted":
    case "ModelRetryScheduled":
    case "ToolCallRequested":
    case "ToolCallPrepared":
    case "ToolApprovalRequested":
    case "ToolApprovalResolved":
    case "AskUserRequested":
    case "AskUserResolved":
    case "ToolCallExecutionStarted":
    case "RunCompleted":
    case "RunFailed":
    case "RunCancelled":
      return true
    case "SessionCreated":
    case "InputAccepted":
    case "InputCancellationRequested":
    case "RunStopRequested":
    case "RunRetryRequested":
    case "ModelAttemptStarted":
    case "ModelAttemptAbandoned":
    case "ToolAttemptStarted":
    case "ToolAttemptAbandoned":
    case "HeadMoved":
    case "BranchCreated":
    case "ForkRequested":
    case "ForkCompleted":
    case "ForkRejected":
    case "SessionAdditionalDirectoryAdded":
    case "SessionPermissionModeSet":
    case "SessionPermissionRulesSet":
    case "SessionCheckpointCreated":
    case "SessionContextWindowSet":
    case "SessionContextWindowCleared":
    case "SessionAgentSelected":
    case "SessionGoalUpdated":
    case "BackgroundTaskCreated":
    case "BackgroundTaskStarted":
    case "BackgroundTaskOutputAppended":
    case "BackgroundTaskCompleted":
    case "BackgroundTaskFailed":
    case "BackgroundTaskCancelled":
      return false
  }
  return false
}

function activeHistoryEventIds(state: CanonicalSessionState): Set<string> {
  const activeEventIds = new Set<string>()
  let cursor = state.activeHead
  while (cursor !== undefined) {
    const node = state.nodes.get(`${cursor.branchId}:${cursor.nodeId}`)
    if (node?.eventId !== undefined) activeEventIds.add(node.eventId)
    cursor = node?.parentCursor
  }
  return activeEventIds
}

function runIdOf(event: AgentEvent): string | undefined {
  if (!event.payload || typeof event.payload !== "object" || !("runId" in event.payload)) return undefined
  const value = (event.payload as { readonly runId?: unknown }).runId
  return typeof value === "string" ? value : value === undefined ? undefined : String(value)
}

function isSessionStateEvent(event: AgentEvent): boolean {
  switch (event.type) {
    case "SessionAdditionalDirectoryAdded":
    case "SessionPermissionModeSet":
    case "SessionPermissionRulesSet":
    case "SessionContextWindowSet":
    case "SessionContextWindowCleared":
    case "SessionAgentSelected":
    case "SessionGoalUpdated":
    case "SessionCheckpointCreated":
    case "PlanCreated":
    case "PlanGenerationFailed":
    case "PlanGenerationCancelled":
    case "BackgroundTaskCreated":
    case "BackgroundTaskStarted":
    case "BackgroundTaskOutputAppended":
    case "BackgroundTaskCompleted":
    case "BackgroundTaskFailed":
    case "BackgroundTaskCancelled":
      return true
    default:
      return false
  }
}
