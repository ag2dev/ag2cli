import type { AgentEvent, ForeignLineageRef, HistoryCursor } from "../events/event.js"
import type { RunId, SessionId } from "../ids.js"
import { assertSessionRevisionField } from "./session-security.js"

export type CanonicalInputStatus = "pending" | "cancelled" | "cancelled-before-acceptance" | "consumed"
export type CanonicalAttemptStatus = "started" | "abandoned" | "committed"
export type CanonicalRunStatus = "running" | "completed" | "failed" | "cancelled"

export interface CanonicalInputState {
  readonly inputId: string
  readonly commandId: string
  readonly kind: "message" | "steer" | "notification"
  readonly text?: string
  readonly delivery?: "fifo" | "safe-boundary"
  status: CanonicalInputStatus
  readonly targetRunId?: RunId
  readonly consumedAt?: HistoryCursor
}

export interface CanonicalAttemptState {
  readonly attemptId: string
  readonly runId: RunId
  readonly turn: number
  readonly executionGeneration: number
  readonly branchId: string
  readonly inputCursor: HistoryCursor
  readonly requestFingerprint: string
  readonly request?: import("../model/observation.js").CanonicalModelRequest
  readonly context?: import("../model/observation.js").ContextProvenance
  status: CanonicalAttemptStatus
  readonly toolUseId?: string
}

export interface CanonicalRunState {
  readonly runId: RunId
  status: CanonicalRunStatus
  readonly executionGeneration: number
  readonly branchId: string
  readonly attempts: Map<string, CanonicalAttemptState>
  /** history cursor key -> attemptId of the tool result that produced the node. */
  readonly toolResultNodes: Map<string, string>
  stopRequested: boolean
}

export interface CanonicalBranchState {
  readonly branchId: string
  readonly parentBranchId?: string
  readonly parentCursor?: HistoryCursor
}

export interface CanonicalCheckpointState {
  readonly checkpointId: string
  readonly kind: "prompt" | "manual"
  readonly headRevision: number
  readonly generation: number
  readonly createdAt: string
  readonly head: HistoryCursor
}

export interface CanonicalHistoryNode extends HistoryCursor {
  readonly parentCursor?: HistoryCursor
  readonly eventId?: string
}

export interface CanonicalCommandReceipt {
  readonly commandId: string
  readonly family: string
  readonly status:
    | "accepted"
    | "cancelled"
    | "cancelled-before-acceptance"
    | "consumed"
    | "abandoned"
    | "committed"
    | "completed"
    | "failed"
    | "cancelled-run"
    | "already-delivered"
  readonly eventIds: readonly string[]
}

export interface CanonicalSessionState {
  sessionId?: SessionId
  sessionCreated: boolean
  scopeId?: string
  modeScope?: "serve" | "local-tui" | "local-run" | "ephemeral"
  workspaceIdentity?: string
  workspaceId?: string
  title?: string
  archivedAt?: string
  executionGeneration: number
  activeHead?: HistoryCursor
  readonly branches: Map<string, CanonicalBranchState>
  readonly nodes: Map<string, CanonicalHistoryNode>
  readonly inputs: Map<string, CanonicalInputState>
  readonly runs: Map<string, CanonicalRunState>
  readonly attempts: Map<string, CanonicalAttemptState>
  readonly commandReceipts: Map<string, CanonicalCommandReceipt>
  readonly commandFingerprints: Map<string, string>
  readonly checkpoints: Map<string, CanonicalCheckpointState>
  foreignLineage?: ForeignLineageRef
  pendingBranchTransition?: {
    readonly commandId: string
    readonly branchId: string
    readonly head: HistoryCursor
    readonly parentCursor: HistoryCursor
    readonly transitionId: string
  }
  pendingFork?: {
    readonly commandId: string
    readonly sourceSessionId: SessionId
    readonly sourceCursor: HistoryCursor
    readonly targetSessionId: SessionId
  }
}

export function emptyCanonicalSessionState(): CanonicalSessionState {
  return {
    sessionCreated: false,
    executionGeneration: 0,
    branches: new Map(),
    nodes: new Map(),
    inputs: new Map(),
    runs: new Map(),
    attempts: new Map(),
    commandReceipts: new Map(),
    commandFingerprints: new Map(),
    checkpoints: new Map(),
  }
}

/**
 * Reduce canonical lifecycle and command facts without interpreting provider
 * or UI details.
 */
export function reduceCanonicalSession(events: readonly AgentEvent[]): CanonicalSessionState {
  const state = emptyCanonicalSessionState()
  const eventIds = new Set<string>()

  for (const [index, event] of events.entries()) {
    if (eventIds.has(event.eventId)) throw new Error(`duplicate canonical eventId: ${event.eventId}`)
    eventIds.add(event.eventId)
    if (event.revision !== index + 1) throw new Error(`canonical revision gap at ${event.revision}`)
    if (index === 0 && event.type !== "SessionCreated") throw new Error("SessionCreated must be the first canonical event")
    if (index > 0 && !state.sessionCreated) throw new Error("canonical event precedes SessionCreated")
    if (state.sessionId !== undefined && event.sessionId !== state.sessionId) throw new Error("canonical event session mismatch")
    if (state.pendingBranchTransition !== undefined && event.type !== "HeadMoved") {
      throw new Error("BranchCreated must be immediately followed by HeadMoved")
    }
    applyCanonicalEvent(state, event)
  }

  if (state.pendingBranchTransition !== undefined) {
    throw new Error("canonical stream ends with an incomplete BranchCreated transition")
  }

  return state
}

export function validateCanonicalSessionContract(events: readonly AgentEvent[]): void {
  if (events.length === 0) return
  reduceCanonicalSession(events)
}

function applyCanonicalEvent(state: CanonicalSessionState, event: AgentEvent): void {
  switch (event.type) {
    case "SessionCreated":
      applySessionCreated(state, event)
      return
    case "CommandAccepted":
      if (event.payload.commandId.trim().length === 0) throw new Error("commandId must not be empty")
      if (event.payload.family.trim().length === 0) throw new Error("command family must not be empty")
      rememberCommand(state, event.payload.family, event.payload.commandId, event.payload.inputFingerprint)
      rememberReceipt(state, event.payload.family, event.payload.commandId, "accepted", event.eventId)
      return
    case "SessionTitleSet":
      if (event.payload.title !== undefined && event.payload.title.trim().length === 0) {
        throw new Error("session title must not be empty")
      }
      rememberCommand(state, "title", event.payload.commandId, event.payload.title ?? null)
      state.title = event.payload.title
      rememberReceipt(state, "title", event.payload.commandId, "completed", event.eventId)
      return
    case "SessionArchived":
      if (Number.isNaN(Date.parse(event.payload.archivedAt))) throw new Error("session archive timestamp is invalid")
      rememberCommand(state, "archive", event.payload.commandId, event.payload.archivedAt)
      state.archivedAt = event.payload.archivedAt
      rememberReceipt(state, "archive", event.payload.commandId, "completed", event.eventId)
      return
    case "InputAccepted":
      applyInputAccepted(state, event)
      return
    case "InputCancellationRequested":
      applyInputCancellation(state, event)
      return
    case "InputConsumed":
      applyInputConsumed(state, event)
      return
    case "RunStarted":
      applyRunStarted(state, event)
      return
    case "RunStopRequested":
      requireRunningRun(state, event.payload.runId).stopRequested = true
      rememberCommand(state, "stop", event.payload.commandId, {
        runId: String(event.payload.runId),
        reason: event.payload.reason ?? null,
      })
      rememberReceipt(state, "stop", event.payload.commandId, "cancelled-run", event.eventId)
      return
    case "RunRetryRequested":
      requireRun(state, event.payload.runId)
      rememberCommand(state, "retry", event.payload.commandId, {
        runId: String(event.payload.runId),
        reason: event.payload.reason ?? null,
      })
      rememberReceipt(state, "retry", event.payload.commandId, "accepted", event.eventId)
      return
    case "ModelAttemptStarted":
      applyModelAttemptStarted(state, event)
      return
    case "ModelAttemptAbandoned":
      applyModelAttemptAbandoned(state, event)
      return
    case "ModelResponseCommitted":
      applyModelResponseCommitted(state, event)
      return
    case "ToolAttemptStarted":
      applyToolAttemptStarted(state, event)
      return
    case "ToolAttemptAbandoned":
      applyToolAttemptAbandoned(state, event)
      return
    case "ToolResultCommitted":
      applyToolResultCommitted(state, event)
      return
    case "SessionCheckpointCreated":
      applySessionCheckpointCreated(state, event)
      return
    case "SessionAdditionalDirectoryAdded":
      applyAdditionalDirectoryAdded(state, event)
      return
    case "SessionContextCompacted":
      applySessionContextCompacted(state, event)
      return
    case "ContextCompacted":
      advanceHistory(state, event)
      return
    case "RunCompleted":
    case "RunFailed":
    case "RunCancelled":
      applyRunTerminal(state, event)
      return
    case "BranchCreated":
      applyBranchCreated(state, event)
      return
    case "HeadMoved":
      applyHeadMoved(state, event)
      return
    case "ForkRequested":
      if (event.payload.targetSessionId !== event.sessionId) throw new Error("ForkRequested target session mismatch")
      if (state.pendingFork !== undefined) throw new Error("another fork is already pending")
      rememberCommand(state, "fork", event.payload.commandId, {
        sourceSessionId: String(event.payload.sourceSessionId),
        sourceCursor: event.payload.sourceCursor,
        targetSessionId: String(event.payload.targetSessionId),
      })
      state.pendingFork = event.payload
      rememberReceipt(state, "fork", event.payload.commandId, "accepted", event.eventId)
      return
    case "ForkCompleted":
      applyForkCompleted(state, event)
      return
    case "ForkRejected":
      if (event.payload.targetSessionId !== event.sessionId) throw new Error("ForkRejected target session mismatch")
      assertPendingFork(state, event.payload)
      state.pendingFork = undefined
      rememberReceipt(state, "fork", event.payload.commandId, "failed", event.eventId)
      return
    case "SessionPermissionModeSet":
    case "SessionPermissionRulesSet":
    case "PlanCreated":
    case "PlanGenerationFailed":
    case "PlanGenerationCancelled":
    case "SessionContextWindowSet":
    case "SessionContextWindowCleared":
    case "SessionAgentSelected":
    case "SessionGoalUpdated":
    case "ModelRetryScheduled":
    case "ToolCallRequested":
    case "ToolCallPrepared":
    case "ToolApprovalRequested":
    case "ToolApprovalResolved":
    case "ToolCallExecutionStarted":
    case "BackgroundTaskCreated":
    case "BackgroundTaskStarted":
    case "BackgroundTaskOutputAppended":
    case "BackgroundTaskCompleted":
    case "BackgroundTaskFailed":
    case "BackgroundTaskCancelled":
      return
    default:
      throw new Error(`Unknown canonical Session event type: ${String((event as { type?: unknown }).type)}`)
  }
}

function applySessionCreated(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "SessionCreated" }>): void {
  if (state.sessionCreated) throw new Error("SessionCreated may occur only once")
  state.sessionCreated = true
  state.sessionId = event.sessionId
  state.scopeId = event.scopeId
  state.modeScope = event.modeScope
  state.workspaceIdentity = event.workspaceIdentity
  state.workspaceId = event.payload.workspaceId
  const root = cursorFor(event, "main", "root")
  state.branches.set("main", { branchId: "main" })
  state.nodes.set(historyCursorKey(root), root)
  state.activeHead = root
}

function applyAdditionalDirectoryAdded(
  state: CanonicalSessionState,
  event: Extract<AgentEvent, { type: "SessionAdditionalDirectoryAdded" }>,
): void {
  const payload = event.payload
  if (payload.commandId.trim().length === 0) throw new Error("additional directory commandId must not be empty")
  if (payload.requestedDirectory.trim().length === 0) throw new Error("additional directory request must not be empty")
  if (payload.directory.trim().length === 0) throw new Error("additional directory must not be empty")
  assertSessionRevisionField(payload.scopeRevision, "SessionAdditionalDirectoryAdded.scopeRevision")
  assertSessionRevisionField(payload.policyRevision, "SessionAdditionalDirectoryAdded.policyRevision")
  rememberCommand(state, "add_additional_directory", payload.commandId, {
    requestedDirectory: payload.requestedDirectory,
    directory: payload.directory,
    changed: payload.changed,
  })
  rememberReceipt(state, "add_additional_directory", payload.commandId, payload.changed ? "completed" : "accepted", event.eventId)
}

function applySessionContextCompacted(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "SessionContextCompacted" }>): void {
  const payload = event.payload
  if (payload.commandId.trim().length === 0) throw new Error("compact commandId must not be empty")
  if (payload.instructions !== undefined && payload.instructions.trim().length === 0) {
    throw new Error("compact instructions must not be empty")
  }
  if (!Number.isSafeInteger(payload.inputMessageCount) || payload.inputMessageCount < 0) {
    throw new Error("compact inputMessageCount is invalid")
  }
  if (!Number.isSafeInteger(payload.outputMessageCount) || payload.outputMessageCount < 0) {
    throw new Error("compact outputMessageCount is invalid")
  }
  rememberCommand(state, "compact", payload.commandId, {
    instructions: payload.instructions ?? null,
  })
  rememberReceipt(state, "compact", payload.commandId, payload.changed ? "completed" : "accepted", event.eventId)
  if (payload.changed) advanceHistory(state, event)
}

function applySessionCheckpointCreated(
  state: CanonicalSessionState,
  event: Extract<AgentEvent, { type: "SessionCheckpointCreated" }>,
): void {
  const payload = event.payload
  if (state.checkpoints.has(payload.checkpointId)) throw new Error(`checkpoint identity reused: ${payload.checkpointId}`)
  if (state.activeHead === undefined || !sameHistoryCursor(state.activeHead, payload.head)) {
    throw new Error(`checkpoint head is not the active head: ${payload.checkpointId}`)
  }
  if (payload.headRevision !== payload.head.physicalRevision) throw new Error(`checkpoint revision mismatch: ${payload.checkpointId}`)
  if (payload.generation !== state.executionGeneration) throw new Error(`checkpoint generation mismatch: ${payload.checkpointId}`)
  state.checkpoints.set(payload.checkpointId, {
    ...payload,
    createdAt: event.timestamp,
  })
}

function applyInputAccepted(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "InputAccepted" }>): void {
  const payload = event.payload
  const prior = state.inputs.get(payload.inputId)
  if (prior && prior.status !== "cancelled-before-acceptance") throw new Error(`input identity reused: ${payload.inputId}`)
  if (prior?.status === "cancelled-before-acceptance") {
    if (prior.text !== undefined || prior.delivery !== undefined) throw new Error(`input was already accepted: ${payload.inputId}`)
    if (payload.text.trim().length === 0) throw new Error("accepted input text must not be empty")
    if (payload.targetRunId !== undefined) {
      const target = state.runs.get(String(payload.targetRunId))
      if (!target || target.status !== "running") throw new Error(`input target run is not running: ${payload.targetRunId}`)
    }
    state.inputs.set(payload.inputId, {
      ...prior,
      commandId: payload.commandId,
      kind: payload.kind,
      text: payload.text,
      delivery: payload.delivery,
      status: "cancelled-before-acceptance",
      targetRunId: payload.targetRunId,
    })
    rememberCommand(state, "input", payload.commandId, inputFingerprint(payload))
    rememberReceipt(state, "input", payload.commandId, "cancelled-before-acceptance", event.eventId)
    return
  }
  if (payload.text.trim().length === 0) throw new Error("accepted input text must not be empty")
  rememberCommand(state, "input", payload.commandId, inputFingerprint(payload))
  state.inputs.set(payload.inputId, {
    inputId: payload.inputId,
    commandId: payload.commandId,
    kind: payload.kind,
    text: payload.text,
    delivery: payload.delivery,
    status: "pending",
    targetRunId: payload.targetRunId,
  })
  if (payload.targetRunId !== undefined) {
    const target = state.runs.get(String(payload.targetRunId))
    if (!target || target.status !== "running") throw new Error(`input target run is not running: ${payload.targetRunId}`)
  }
  rememberReceipt(state, "input", payload.commandId, "accepted", event.eventId)
}

function applyInputCancellation(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "InputCancellationRequested" }>): void {
  const payload = event.payload
  rememberCommand(state, "cancel", payload.commandId, {
    inputId: payload.inputId,
    reason: payload.reason ?? null,
  })
  const input = state.inputs.get(payload.inputId)
  if (!input) {
    state.inputs.set(payload.inputId, {
      inputId: payload.inputId,
      commandId: payload.commandId,
      kind: "message",
      status: "cancelled-before-acceptance",
    })
    rememberReceipt(state, "cancel", payload.commandId, "cancelled-before-acceptance", event.eventId)
    return
  }
  if (input.status === "consumed") {
    rememberReceipt(state, "cancel", payload.commandId, "already-delivered", event.eventId)
    return
  }
  if (input.status === "cancelled") {
    rememberReceipt(state, "cancel", payload.commandId, "cancelled", event.eventId)
    return
  }
  if (input.status !== "pending") throw new Error(`input is not cancellable: ${payload.inputId}`)
  input.status = "cancelled"
  rememberReceipt(state, "cancel", payload.commandId, "cancelled", event.eventId)
}

function applyInputConsumed(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "InputConsumed" }>): void {
  const run = requireRunningRun(state, event.payload.runId)
  if (run.executionGeneration !== event.payload.executionGeneration) throw new Error("input run generation is stale")
  if (run.branchId !== event.payload.parent.branchId) throw new Error("input run branch is stale")
  const input = state.inputs.get(event.payload.inputId)
  if (!input) throw new Error(`input not accepted: ${event.payload.inputId}`)
  if (input.status !== "pending") throw new Error(`input is not pending: ${event.payload.inputId}`)
  if (
    input.commandId !== event.payload.commandId ||
    input.kind !== event.payload.kind ||
    input.text !== event.payload.text ||
    input.delivery !== event.payload.delivery
  ) {
    throw new Error(`input consumption payload mismatch: ${event.payload.inputId}`)
  }
  if (input.targetRunId !== undefined && String(input.targetRunId) !== String(event.payload.runId)) {
    throw new Error(`input target run mismatch: ${event.payload.inputId}`)
  }
  if (event.payload.executionGeneration !== state.executionGeneration) throw new Error("input generation is stale")
  assertKnownCursor(state, event.payload.parent)
  if (!sameHistoryCursor(state.activeHead!, event.payload.parent)) throw new Error("input parent is not the active head")
  const consumedAt = cursorFor(event, event.payload.parent.branchId, `event:${event.eventId}`)
  state.inputs.set(input.inputId, { ...input, status: "consumed", consumedAt })
  rememberReceipt(state, "input", input.commandId, "consumed", event.eventId)
  advanceHistory(state, event, event.payload.parent)
}

function applyRunStarted(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "RunStarted" }>): void {
  const payload = event.payload
  const key = String(payload.runId)
  if (state.runs.has(key)) throw new Error(`run identity reused: ${key}`)
  if (state.commandReceipts.has(commandReceiptKey("run", payload.commandId))) {
    throw new Error(`start command already accepted: ${payload.commandId}`)
  }
  if ([...state.runs.values()].some((run) => run.status === "running")) {
    throw new Error("a session may have only one running agent loop")
  }
  const input = [...state.inputs.values()].find((candidate) => candidate.commandId === payload.commandId)
  // A run starts from a user message or from a host notification wake; steer
  // inputs may only redirect an already-running loop.
  if (input === undefined || (input.kind !== "message" && input.kind !== "notification")) {
    throw new Error(`RunStarted is missing a startable InputAccepted: ${payload.commandId}`)
  }
  if (input.status !== "pending") throw new Error(`RunStarted input must be pending, received ${input.status}: ${payload.commandId}`)
  state.runs.set(key, {
    runId: payload.runId,
    status: "running",
    executionGeneration: state.executionGeneration,
    branchId: state.activeHead?.branchId ?? "main",
    attempts: new Map(),
    toolResultNodes: new Map(),
    stopRequested: false,
  })
  if (input.text !== payload.goal) throw new Error(`RunStarted command payload mismatch: ${payload.commandId}`)
  rememberCommand(state, "start", payload.commandId, {
    goal: payload.goal,
    maxTurns: payload.maxTurns ?? null,
  })
  rememberReceipt(state, "run", payload.commandId, "accepted", event.eventId)
}

function applyModelAttemptStarted(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "ModelAttemptStarted" }>): void {
  const payload = event.payload
  const run = requireRunningRun(state, payload.runId)
  if (run.stopRequested) throw new Error(`stopped Run cannot start a model attempt: ${payload.runId}`)
  assertExecutionFence(state, payload.executionGeneration, payload.branchId)
  assertKnownCursor(state, payload.inputCursor)
  if (!sameHistoryCursor(state.activeHead!, payload.inputCursor)) throw new Error("model attempt cursor is not the active head")
  if (state.attempts.has(payload.attemptId)) throw new Error(`attempt identity reused: ${payload.attemptId}`)
  const attempt: CanonicalAttemptState = { ...payload, status: "started" }
  state.attempts.set(payload.attemptId, attempt)
  run.attempts.set(payload.attemptId, attempt)
}

function applyModelAttemptAbandoned(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "ModelAttemptAbandoned" }>): void {
  const payload = event.payload
  requireRunningRun(state, payload.runId)
  const attempt = requireAttempt(state, payload.attemptId)
  if (attempt.runId !== payload.runId || attempt.executionGeneration !== payload.executionGeneration)
    throw new Error("attempt abandonment mismatch")
  if (attempt.status !== "started") throw new Error("only a started attempt may be abandoned")
  attempt.status = "abandoned"
  rememberReceipt(state, "model-recovery", payload.recoveryCommandId, "abandoned", event.eventId)
}

function applyModelResponseCommitted(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "ModelResponseCommitted" }>): void {
  const payload = event.payload
  requireRunningRun(state, payload.runId)
  if (state.runs.get(String(payload.runId))!.stopRequested) throw new Error(`stopped Run cannot commit a model response: ${payload.runId}`)
  const attempt = requireAttempt(state, payload.attemptId)
  if (
    attempt.runId !== payload.runId ||
    attempt.turn !== payload.turn ||
    attempt.executionGeneration !== payload.executionGeneration ||
    attempt.branchId !== payload.branchId ||
    attempt.requestFingerprint !== payload.requestFingerprint
  ) {
    throw new Error(`model response fencing mismatch: ${payload.attemptId}`)
  }
  if (!sameHistoryCursor(attempt.inputCursor, payload.parent)) throw new Error(`model response parent mismatch: ${payload.attemptId}`)
  if (!sameHistoryCursor(attempt.inputCursor, payload.inputCursor)) throw new Error(`model response cursor mismatch: ${payload.attemptId}`)
  assertExecutionFence(state, payload.executionGeneration, payload.branchId)
  if (attempt.status !== "started") throw new Error(`attempt is not commit eligible: ${payload.attemptId}`)
  attempt.status = "committed"
  advanceHistory(state, event, payload.parent)
}

function applyToolAttemptStarted(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "ToolAttemptStarted" }>): void {
  const payload = event.payload
  requireRunningRun(state, payload.runId)
  if (state.runs.get(String(payload.runId))!.stopRequested) throw new Error(`stopped Run cannot start a tool attempt: ${payload.runId}`)
  assertExecutionFence(state, payload.executionGeneration, payload.branchId)
  assertKnownCursor(state, payload.inputCursor)
  if (!sameHistoryCursor(state.activeHead!, payload.inputCursor)) throw new Error("tool attempt cursor is not the active head")
  if (state.attempts.has(payload.attemptId)) throw new Error(`attempt identity reused: ${payload.attemptId}`)
  const attempt: CanonicalAttemptState = {
    ...payload,
    status: "started",
    toolUseId: payload.toolUseId,
  }
  state.attempts.set(payload.attemptId, attempt)
  state.runs.get(String(payload.runId))!.attempts.set(payload.attemptId, attempt)
}

function applyToolAttemptAbandoned(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "ToolAttemptAbandoned" }>): void {
  const payload = event.payload
  requireRunningRun(state, payload.runId)
  const attempt = requireAttempt(state, payload.attemptId)
  if (attempt.toolUseId !== payload.toolUseId || attempt.runId !== payload.runId) throw new Error("tool attempt abandonment mismatch")
  if (attempt.status !== "started") throw new Error("only a started tool attempt may be abandoned")
  attempt.status = "abandoned"
  rememberReceipt(state, "tool-recovery", payload.recoveryCommandId, "abandoned", event.eventId)
}

function applyToolResultCommitted(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "ToolResultCommitted" }>): void {
  const payload = event.payload
  const run = requireRunningRun(state, payload.runId)
  if (run.stopRequested) throw new Error(`stopped Run cannot commit a tool result: ${payload.runId}`)
  const attempt = requireAttempt(state, payload.attemptId)
  if (
    attempt.toolUseId !== payload.toolUseId ||
    attempt.runId !== payload.runId ||
    attempt.executionGeneration !== payload.executionGeneration ||
    attempt.branchId !== payload.branchId ||
    attempt.requestFingerprint !== payload.requestFingerprint
  ) {
    throw new Error(`tool result fencing mismatch: ${payload.attemptId}`)
  }
  if (
    !sameHistoryCursor(attempt.inputCursor, payload.parent) &&
    !siblingToolResultLineage(state, run, attempt.inputCursor, payload.parent)
  ) {
    throw new Error(`tool result parent mismatch: ${payload.attemptId}`)
  }
  assertExecutionFence(state, payload.executionGeneration, payload.branchId)
  if (attempt.status !== "started") throw new Error(`tool attempt is not commit eligible: ${payload.attemptId}`)
  attempt.status = "committed"
  advanceHistory(state, event, payload.parent)
  run.toolResultNodes.set(historyCursorKey(state.activeHead!), payload.attemptId)
}

/**
 * Same-turn fan-out siblings may start attempts at one shared history cursor
 * and then commit in declaration order while the head has already advanced
 * through earlier sibling results.  The commit stays fenced as long as every
 * node between the attempt cursor and this parent is a tool-result node of
 * the same run; user or model history in between still rejects the commit.
 */
function siblingToolResultLineage(
  state: CanonicalSessionState,
  run: CanonicalRunState,
  attemptCursor: HistoryCursor,
  parent: HistoryCursor,
): boolean {
  let cursor: HistoryCursor | undefined = parent
  let hops = 0
  while (cursor !== undefined && !sameHistoryCursor(cursor, attemptCursor)) {
    if (hops++ > 1000) return false
    if (!run.toolResultNodes.has(historyCursorKey(cursor))) return false
    cursor = state.nodes.get(historyCursorKey(cursor))?.parentCursor
  }
  return cursor !== undefined
}

function applyRunTerminal(
  state: CanonicalSessionState,
  event: Extract<AgentEvent, { type: "RunCompleted" | "RunFailed" | "RunCancelled" }>,
): void {
  const run = requireRunningRun(state, event.payload.runId)
  if ([...run.attempts.values()].some((attempt) => attempt.status === "started")) {
    throw new Error(`Run terminal event has an active attempt: ${event.payload.runId}`)
  }
  if (event.type === "RunCompleted" && run.stopRequested) throw new Error(`stopped Run cannot complete: ${event.payload.runId}`)
  run.status = event.type === "RunCompleted" ? "completed" : event.type === "RunFailed" ? "failed" : "cancelled"
  // Inputs accepted for this run but not yet consumed cannot remain pending
  // after the run's terminal fact. The terminal fact is the durable boundary
  // that discards them; a later retry must use a new command identity.
  for (const input of state.inputs.values()) {
    if (input.status === "pending" && input.targetRunId !== undefined && String(input.targetRunId) === String(event.payload.runId)) {
      input.status = "cancelled"
      rememberReceipt(state, "input", input.commandId, "cancelled", event.eventId)
    }
  }
  advanceHistory(state, event)
}

function applyBranchCreated(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "BranchCreated" }>): void {
  const payload = event.payload
  const transitionId = event.transitionId
  if (transitionId === undefined || transitionId.trim().length === 0) throw new Error("BranchCreated requires a transition identity")
  if (state.branches.has(payload.branchId)) throw new Error(`branch identity reused: ${payload.branchId}`)
  if (!state.branches.has(payload.parentBranchId)) throw new Error(`branch parent not found: ${payload.parentBranchId}`)
  assertKnownCursor(state, payload.parentCursor)
  if (!isHistoryAncestor(state, state.activeHead!, payload.parentCursor)) throw new Error("branch parent is not an active-head ancestor")
  if (payload.head.sessionId !== event.sessionId || payload.head.branchId !== payload.branchId) {
    throw new Error("branch head identity mismatch")
  }
  if (payload.head.physicalRevision !== event.revision || payload.head.recordHash !== event.eventId) {
    throw new Error("branch head must identify the BranchCreated commit")
  }
  if (state.nodes.has(historyCursorKey(payload.head))) throw new Error(`history node identity reused: ${payload.head.nodeId}`)
  state.nodes.set(historyCursorKey(payload.head), {
    ...payload.head,
    parentCursor: payload.parentCursor,
  })
  state.branches.set(payload.branchId, {
    branchId: payload.branchId,
    parentBranchId: payload.parentBranchId,
    parentCursor: payload.parentCursor,
  })
  state.pendingBranchTransition = {
    commandId: payload.commandId,
    branchId: payload.branchId,
    head: payload.head,
    parentCursor: payload.parentCursor,
    transitionId,
  }
  rememberReceipt(state, "rewind", payload.commandId, "accepted", event.eventId)
}

function applyHeadMoved(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "HeadMoved" }>): void {
  const payload = event.payload
  const pending = state.pendingBranchTransition
  if (pending === undefined) throw new Error("HeadMoved must complete a preceding BranchCreated")
  if (pending.commandId !== payload.commandId || pending.branchId !== payload.branchId) {
    throw new Error("HeadMoved does not complete the preceding BranchCreated")
  }
  if (event.transitionId === undefined || event.transitionId.trim().length === 0 || pending.transitionId !== event.transitionId) {
    throw new Error("HeadMoved transition does not match BranchCreated")
  }
  if (!state.activeHead || !sameHistoryCursor(state.activeHead, payload.from)) throw new Error("head move source is stale")
  if (!state.branches.has(payload.branchId)) throw new Error(`head move branch not found: ${payload.branchId}`)
  assertKnownCursor(state, payload.to)
  if (!isHistoryAncestor(state, state.activeHead, payload.to)) throw new Error("head move target is not an active-head ancestor")
  if (!sameHistoryCursor(pending.parentCursor, payload.to)) throw new Error("HeadMoved target does not match BranchCreated parent cursor")
  assertKnownCursor(state, payload.head)
  if (payload.head.branchId !== payload.branchId) throw new Error("head move branch mismatch")
  if (!sameHistoryCursor(pending.head, payload.head)) throw new Error("HeadMoved head does not match BranchCreated")
  if (payload.executionGeneration !== state.executionGeneration + 1) throw new Error("head move generation is not monotonic")
  state.activeHead = payload.head
  state.executionGeneration = payload.executionGeneration
  state.pendingBranchTransition = undefined
  for (const run of state.runs.values()) {
    if (run.status === "running" && run.executionGeneration < payload.executionGeneration) run.status = "cancelled"
  }
  for (const attempt of state.attempts.values()) {
    if (attempt.status === "started") attempt.status = "abandoned"
  }
  rememberReceipt(state, "rewind", payload.commandId, "accepted", event.eventId)
}

function applyForkCompleted(state: CanonicalSessionState, event: Extract<AgentEvent, { type: "ForkCompleted" }>): void {
  const payload = event.payload
  if (payload.targetSessionId !== event.sessionId) throw new Error("ForkCompleted target session mismatch")
  if (payload.foreignLineageRef.sourceSessionId !== payload.sourceSessionId) throw new Error("fork source lineage mismatch")
  if (!sameHistoryCursor(payload.foreignLineageRef.sourceCursor, payload.sourceCursor)) throw new Error("fork cursor provenance mismatch")
  if (payload.materializedPrefixDigest !== payload.foreignLineageRef.materializedPrefixDigest) {
    throw new Error("fork materialized prefix digest mismatch")
  }
  assertPendingFork(state, payload)
  state.pendingFork = undefined
  state.foreignLineage = payload.foreignLineageRef
  rememberReceipt(state, "fork", payload.commandId, "completed", event.eventId)
}

function advanceHistory(state: CanonicalSessionState, event: AgentEvent, parentCursor?: HistoryCursor): void {
  const parent = parentCursor ?? state.activeHead
  const branchId = parent?.branchId ?? "main"
  if (!state.branches.has(branchId)) throw new Error(`history branch not found: ${branchId}`)
  const nodeId = `event:${event.eventId}`
  const cursor = cursorFor(event, branchId, nodeId)
  if (state.nodes.has(historyCursorKey(cursor))) throw new Error(`history node identity reused: ${nodeId}`)
  if (parent !== undefined && !sameHistoryCursor(parent, state.activeHead!)) {
    throw new Error("history parent is not the active head")
  }
  state.nodes.set(historyCursorKey(cursor), {
    ...cursor,
    ...(parent === undefined ? {} : { parentCursor: parent }),
    eventId: event.eventId,
  })
  state.activeHead = cursor
}

/** Build a logical cursor without depending on the storage adapter's record hash. */
export function historyCursorForEvent(event: AgentEvent, branchId = "main", nodeId = `event:${event.eventId}`): HistoryCursor {
  return {
    sessionId: event.sessionId,
    branchId,
    nodeId,
    physicalRevision: event.revision,
    recordHash: event.eventId,
  }
}

function cursorFor(event: AgentEvent, branchId: string, nodeId: string): HistoryCursor {
  return historyCursorForEvent(event, branchId, nodeId)
}

function assertExecutionFence(state: CanonicalSessionState, generation: number, branchId: string): void {
  if (generation !== state.executionGeneration) throw new Error("execution generation is stale")
  if (state.activeHead?.branchId !== branchId) throw new Error("execution branch is stale")
}

function assertKnownCursor(state: CanonicalSessionState, cursor: HistoryCursor): void {
  const known = state.nodes.get(historyCursorKey(cursor))
  if (!known || !sameHistoryCursor(known, cursor)) throw new Error(`unknown history cursor: ${cursor.nodeId}`)
}

export function isHistoryAncestor(state: CanonicalSessionState, descendant: HistoryCursor, ancestor: HistoryCursor): boolean {
  if (descendant.sessionId !== ancestor.sessionId) return false
  let node: CanonicalHistoryNode | undefined = state.nodes.get(historyCursorKey(descendant))
  while (node) {
    if (sameHistoryCursor(node, ancestor)) return true
    node = node.parentCursor === undefined ? undefined : state.nodes.get(historyCursorKey(node.parentCursor))
  }
  return false
}

export function sameHistoryCursor(left: HistoryCursor, right: HistoryCursor): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.branchId === right.branchId &&
    left.nodeId === right.nodeId &&
    left.physicalRevision === right.physicalRevision &&
    left.recordHash === right.recordHash
  )
}

export function historyCursorKey(cursor: Pick<HistoryCursor, "branchId" | "nodeId">): string {
  return `${cursor.branchId}:${cursor.nodeId}`
}

function requireRun(state: CanonicalSessionState, runId: RunId): CanonicalRunState {
  const run = state.runs.get(String(runId))
  if (!run) throw new Error(`run not found: ${runId}`)
  return run
}

function requireRunningRun(state: CanonicalSessionState, runId: RunId): CanonicalRunState {
  const run = requireRun(state, runId)
  if (run.status !== "running") throw new Error(`run is not running: ${runId}`)
  return run
}

function requireAttempt(state: CanonicalSessionState, attemptId: string): CanonicalAttemptState {
  const attempt = state.attempts.get(attemptId)
  if (!attempt) throw new Error(`attempt not found: ${attemptId}`)
  return attempt
}

export function commandReceiptKey(family: string, commandId: string): string {
  return `${family}\u0000${commandId}`
}

function rememberReceipt(
  state: CanonicalSessionState,
  family: string,
  commandId: string,
  status: CanonicalCommandReceipt["status"],
  eventId: string,
): void {
  const key = commandReceiptKey(family, commandId)
  const existing = state.commandReceipts.get(key)
  if (existing) {
    state.commandReceipts.set(key, {
      ...existing,
      status,
      eventIds: [...existing.eventIds, eventId],
    })
    return
  }
  state.commandReceipts.set(key, {
    commandId,
    family,
    status,
    eventIds: [eventId],
  })
}

function rememberCommand(state: CanonicalSessionState, family: string, commandId: string, fingerprint: unknown): void {
  if (commandId.trim().length === 0) throw new Error("commandId must not be empty")
  const key = commandReceiptKey(family, commandId)
  const value = stableJson(fingerprint)
  const existing = state.commandFingerprints.get(key)
  if (existing !== undefined && existing !== value) throw new Error(`command identity reused with different payload: ${commandId}`)
  state.commandFingerprints.set(key, value)
}

function inputFingerprint(payload: Extract<AgentEvent, { type: "InputAccepted" }>["payload"]): unknown {
  return {
    inputId: payload.inputId,
    kind: payload.kind,
    text: payload.text,
    delivery: payload.delivery,
    targetRunId: payload.targetRunId === undefined ? null : String(payload.targetRunId),
  }
}

function assertPendingFork(
  state: CanonicalSessionState,
  payload: Extract<AgentEvent, { type: "ForkCompleted" | "ForkRejected" }>["payload"],
): void {
  const pending = state.pendingFork
  if (pending === undefined) throw new Error(`fork completion has no pending request: ${payload.commandId}`)
  if (
    pending.commandId !== payload.commandId ||
    pending.sourceSessionId !== payload.sourceSessionId ||
    pending.targetSessionId !== payload.targetSessionId ||
    !sameHistoryCursor(pending.sourceCursor, payload.sourceCursor)
  ) {
    throw new Error(`fork completion does not match request: ${payload.commandId}`)
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`
}
