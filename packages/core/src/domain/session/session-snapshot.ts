import type { AgentEvent } from "../events/event.js"
import type { SessionId } from "../ids.js"
import type { Plan } from "../plan/plan.js"
import type { RunSnapshot } from "../execution/run.js"
import type { RunId } from "../ids.js"
import { EMPTY_SESSION_GOAL, normalizeSessionGoal, type SessionGoal } from "./session-goal.js"
import type { TaskSnapshot } from "../task/task.js"
import { isTerminalTaskStatus } from "../task/task.js"
import { validateCanonicalSession } from "./canonical-invariants.js"
import { projectSessionTimeline, type SessionTimelineSnapshot } from "./session-timeline.js"
import { projectActiveSessionEvents } from "./session-projection.js"
import { reduceCanonicalSession } from "./canonical-session.js"
import {
  DEFAULT_SESSION_PERMISSION_MODE,
  assertExplicitSessionCreatedPolicy,
  assertKnownPermissionMode,
  assertSessionRevisionField,
  normalizeSessionPermissionRules,
  type SessionPermissionMode,
  type SessionPermissionRule,
} from "./session-security.js"

export type SessionStatus = "created" | "planning" | "plan_ready" | "running" | "completed" | "failed" | "cancelled"

export type SessionInputStatus = "pending" | "cancelled" | "cancelled-before-acceptance" | "consumed"

/**
 * Security-relevant slice of a session snapshot: workspace roots, scope
 * revisions and permission policy. Executor security input and the tool
 * execution context share this one alias so neither can drift from the
 * canonical projection.
 */
export type SessionSecuritySnapshot = Pick<
  SessionSnapshot,
  "workspaceRoot" | "additionalDirectories" | "scopeRevision" | "scopeDigest" | "permissionMode" | "permissionRules" | "policyRevision"
>

/** Durable mailbox state exposed to reconnecting clients. */
export interface SessionInputSnapshot {
  readonly inputId: string
  readonly commandId: string
  readonly kind: "message" | "steer" | "notification"
  readonly text?: string
  readonly delivery?: "fifo" | "safe-boundary"
  readonly status: SessionInputStatus
  readonly active: boolean
  readonly targetRunId?: RunId
}

/** Reconstructable state exposed to every client. */
export interface SessionSnapshot {
  readonly sessionId: SessionId
  readonly lastRevision: number
  readonly status: SessionStatus
  readonly workspaceRoot?: string
  readonly additionalDirectories: readonly string[]
  readonly scopeRevision: number
  readonly scopeDigest?: string
  readonly permissionMode: SessionPermissionMode
  readonly permissionRules: readonly SessionPermissionRule[]
  readonly policyRevision: number
  readonly inputs: readonly SessionInputSnapshot[]
  /** Present when the append-only session has checkpoint/rewind controls. */
  readonly timeline?: SessionTimelineSnapshot
  readonly lastUserGoal?: string
  readonly currentPlan?: Plan
  readonly plans: readonly Plan[]
  readonly contextWindowOverride?: number
  /** Selected agent name, replayed from SessionAgentSelected events. */
  readonly activeAgent?: string
  /** User-owned session objective, replayed from SessionGoalUpdated events. */
  readonly goal?: SessionGoal
  readonly runs?: readonly RunSnapshot[]
  readonly currentRun?: RunSnapshot
  readonly tasks?: readonly TaskSnapshot[]
  readonly currentTask?: TaskSnapshot
  readonly lastError?: string
}

export function emptySessionSnapshot(sessionId: SessionId): SessionSnapshot {
  return {
    sessionId,
    lastRevision: 0,
    status: "created",
    plans: [],
    goal: EMPTY_SESSION_GOAL,
    tasks: [],
    additionalDirectories: [],
    scopeRevision: 0,
    permissionMode: DEFAULT_SESSION_PERMISSION_MODE,
    permissionRules: [],
    policyRevision: 0,
    inputs: [],
  }
}

export function replaySession(events: readonly AgentEvent[]): SessionSnapshot {
  if (events.length === 0) {
    throw new Error("cannot rebuild a session from an empty event stream; use emptySessionSnapshot")
  }

  validateCanonicalSession(events)

  const timeline = projectSessionTimeline(events)
  const canonical = reduceCanonicalSession(events)
  const activeEvents = projectActiveSessionEvents(events)
  let snapshot = emptySessionSnapshot(events[0]!.sessionId)
  for (const event of activeEvents) {
    snapshot = applySessionEvent(snapshot, {
      ...event,
      revision: snapshot.lastRevision + 1,
    })
  }

  if (snapshot.workspaceRoot === undefined) {
    throw new Error("session is missing its SessionCreated event")
  }
  // Workspace and permission state are security state, not conversation state.
  // Rewind may replace active model events, but it must not silently revoke or
  // grant the scope and policy selected later in the stream.
  const security = projectSecurityState(events)
  const activeInputIds = new Set(
    activeEvents
      .filter((event): event is Extract<AgentEvent, { type: "InputConsumed" }> => event.type === "InputConsumed")
      .map((event) => event.payload.inputId),
  )
  const inputs = [...canonical.inputs.values()].map((input) => toInputSnapshot(input, activeInputIds.has(input.inputId)))
  return {
    ...snapshot,
    workspaceRoot: security.workspaceRoot,
    additionalDirectories: security.additionalDirectories,
    scopeRevision: security.scopeRevision,
    ...(security.scopeDigest === undefined ? {} : { scopeDigest: security.scopeDigest }),
    permissionMode: security.permissionMode,
    permissionRules: security.permissionRules,
    policyRevision: security.policyRevision,
    inputs,
    lastRevision: events.at(-1)!.revision,
    ...(timeline.snapshot.checkpoints.length > 0 || timeline.snapshot.generation > 0 || canonical.executionGeneration > 0
      ? {
          timeline: {
            ...timeline.snapshot,
            generation: canonical.executionGeneration,
            headRevision: canonical.activeHead?.physicalRevision ?? timeline.snapshot.headRevision,
          },
        }
      : {}),
  }
}

export function projectSecurityState(events: readonly AgentEvent[]): SessionSecuritySnapshot {
  let workspaceRoot: string | undefined
  let additionalDirectories: readonly string[] = []
  let scopeRevision = 0
  let scopeDigest: string | undefined
  let permissionMode = DEFAULT_SESSION_PERMISSION_MODE
  let permissionRules: readonly SessionPermissionRule[] = []
  let policyRevision = 0
  for (const event of events) {
    if (event.type === "SessionCreated") {
      assertExplicitSessionCreatedPolicy(event.payload)
      workspaceRoot = event.payload.workspaceRoot
      additionalDirectories = [...(event.payload.additionalDirectories ?? [])]
      scopeRevision = event.payload.scopeRevision ?? 0
      scopeDigest = event.payload.scopeDigest
      permissionMode = event.payload.permissionMode
      permissionRules = normalizeSessionPermissionRules(event.payload.permissionRules)
      policyRevision = event.payload.policyRevision
    } else if (event.type === "SessionAdditionalDirectoryAdded") {
      additionalDirectories = [...(event.payload.additionalDirectories ?? [...additionalDirectories, event.payload.directory])]
      scopeRevision = assertSessionRevisionField(event.payload.scopeRevision, "SessionAdditionalDirectoryAdded.scopeRevision")
      policyRevision = assertSessionRevisionField(event.payload.policyRevision, "SessionAdditionalDirectoryAdded.policyRevision")
      scopeDigest = event.payload.scopeDigest
    } else if (event.type === "SessionPermissionModeSet") {
      assertKnownPermissionMode(event.payload.mode)
      permissionMode = event.payload.mode
      policyRevision = assertSessionRevisionField(event.payload.policyRevision, "SessionPermissionModeSet.policyRevision")
    } else if (event.type === "SessionPermissionRulesSet") {
      permissionRules = normalizeSessionPermissionRules(event.payload.rules)
      policyRevision = assertSessionRevisionField(event.payload.policyRevision, "SessionPermissionRulesSet.policyRevision")
    }
  }
  if (workspaceRoot === undefined) throw new Error("session is missing its SessionCreated event")
  return {
    workspaceRoot,
    additionalDirectories,
    scopeRevision,
    scopeDigest,
    permissionMode,
    permissionRules,
    policyRevision,
  }
}

/** Apply one contiguous canonical event to a client-side snapshot. */
export function applySessionEvent(snapshot: SessionSnapshot, event: AgentEvent): SessionSnapshot {
  if (event.sessionId !== snapshot.sessionId) {
    throw new Error("event stream contains multiple SessionCreated events")
  }
  if (event.revision !== snapshot.lastRevision + 1) {
    throw new Error(`session replay revision conflict: expected ${snapshot.lastRevision + 1}, got ${event.revision}`)
  }
  if (snapshot.lastRevision === 0 && event.type !== "SessionCreated") {
    throw new Error("SessionCreated must be the session's first event")
  }

  let next = snapshot
  switch (event.type) {
    case "SessionCreated":
      if (event.revision !== 1 || snapshot.workspaceRoot !== undefined) {
        throw new Error("SessionCreated must be the session's first event")
      }
      assertExplicitSessionCreatedPolicy(event.payload)
      next = {
        ...snapshot,
        workspaceRoot: event.payload.workspaceRoot,
        additionalDirectories: [...(event.payload.additionalDirectories ?? [])],
        scopeRevision: event.payload.scopeRevision ?? 0,
        ...(event.payload.scopeDigest === undefined ? {} : { scopeDigest: event.payload.scopeDigest }),
        permissionMode: event.payload.permissionMode,
        permissionRules: normalizeSessionPermissionRules(event.payload.permissionRules),
        policyRevision: event.payload.policyRevision,
        status: "created",
      }
      break
    case "SessionAdditionalDirectoryAdded": {
      const directories = event.payload.additionalDirectories ?? [...snapshot.additionalDirectories, event.payload.directory]
      next = {
        ...snapshot,
        additionalDirectories: [...directories],
        scopeRevision: assertSessionRevisionField(event.payload.scopeRevision, "SessionAdditionalDirectoryAdded.scopeRevision"),
        policyRevision: assertSessionRevisionField(event.payload.policyRevision, "SessionAdditionalDirectoryAdded.policyRevision"),
        scopeDigest: event.payload.scopeDigest,
      }
      break
    }
    case "SessionPermissionModeSet": {
      assertKnownPermissionMode(event.payload.mode)
      next = {
        ...snapshot,
        permissionMode: event.payload.mode,
        policyRevision: assertSessionRevisionField(event.payload.policyRevision, "SessionPermissionModeSet.policyRevision"),
      }
      break
    }
    case "SessionPermissionRulesSet": {
      next = {
        ...snapshot,
        permissionRules: normalizeSessionPermissionRules(event.payload.rules),
        policyRevision: assertSessionRevisionField(event.payload.policyRevision, "SessionPermissionRulesSet.policyRevision"),
      }
      break
    }
    case "SessionCheckpointCreated": {
      const checkpoint = {
        checkpointId: event.payload.checkpointId,
        kind: event.payload.kind,
        headRevision: event.payload.headRevision,
        generation: event.payload.generation,
        createdAt: event.timestamp,
        head: event.payload.head,
      }
      next = {
        ...snapshot,
        timeline: {
          generation: snapshot.timeline?.generation ?? event.payload.generation,
          headRevision: snapshot.timeline?.headRevision ?? event.payload.headRevision,
          checkpoints: [...(snapshot.timeline?.checkpoints ?? []), checkpoint],
        },
      }
      break
    }
    case "BranchCreated":
      // Timeline control is reduced by canonical-session.ts. It must not be
      // replayed as a user-visible conversation mutation.
      break
    case "HeadMoved":
      next = {
        ...snapshot,
        timeline: {
          generation: event.payload.executionGeneration,
          headRevision: event.payload.to.physicalRevision,
          checkpoints: snapshot.timeline?.checkpoints ?? [],
        },
      }
      break
    case "InputAccepted":
      next = upsertInput(next, {
        inputId: event.payload.inputId,
        commandId: event.payload.commandId,
        kind: event.payload.kind,
        text: event.payload.text,
        delivery: event.payload.delivery,
        status:
          next.inputs.find((input) => input.inputId === event.payload.inputId)?.status === "cancelled-before-acceptance"
            ? "cancelled-before-acceptance"
            : "pending",
        active: true,
        ...(event.payload.targetRunId === undefined ? {} : { targetRunId: event.payload.targetRunId }),
      })
      next = {
        ...next,
        status: "planning",
        lastError: undefined,
      }
      break
    case "InputCancellationRequested": {
      const existing = next.inputs.find((input) => input.inputId === event.payload.inputId)
      next = upsertInput(next, {
        inputId: event.payload.inputId,
        commandId: existing?.commandId ?? event.payload.commandId,
        kind: existing?.kind ?? "message",
        ...(existing?.text === undefined ? {} : { text: existing.text }),
        ...(existing?.delivery === undefined ? {} : { delivery: existing.delivery }),
        status: existing === undefined ? "cancelled-before-acceptance" : "cancelled",
        active: existing?.active ?? true,
        ...(existing?.targetRunId === undefined ? {} : { targetRunId: existing.targetRunId }),
      })
      break
    }
    case "InputConsumed": {
      const input = next.inputs.find((item) => item.inputId === event.payload.inputId)
      if (input === undefined) throw new Error(`session is missing InputAccepted: ${event.payload.inputId}`)
      next = upsertInput(next, { ...input, status: "consumed", active: true })
      requireRun(next, event.payload.runId)
      next = {
        ...next,
        lastUserGoal: input.text,
        status: "planning",
        lastError: undefined,
      }
      next = advanceTimelineHead(next, event.revision)
      break
    }
    case "PlanCreated":
      next = {
        ...snapshot,
        currentPlan: event.payload,
        plans: [...snapshot.plans, event.payload],
        status: "plan_ready",
        lastError: undefined,
      }
      break
    case "PlanGenerationFailed":
      next = {
        ...snapshot,
        status: "failed",
        lastError: event.payload.message,
      }
      break
    case "PlanGenerationCancelled":
      next = {
        ...snapshot,
        status: "cancelled",
        lastError: event.payload.reason,
      }
      break
    case "RunStarted": {
      const run: RunSnapshot = {
        id: event.payload.runId,
        commandId: event.payload.commandId,
        status: "running",
        turn: 0,
        startedAt: event.timestamp,
      }
      next = upsertRun({ ...snapshot, status: "running", lastError: undefined }, run)
      break
    }
    case "ModelAttemptStarted": {
      const run = requireRun(snapshot, event.payload.runId)
      next = upsertRun({ ...snapshot, status: "running" }, { ...run, turn: event.payload.turn })
      break
    }
    case "ModelRetryScheduled":
      requireRun(snapshot, event.payload.runId)
      break
    case "ContextCompacted":
      requireRun(snapshot, event.payload.runId)
      next = advanceTimelineHead(next, event.revision)
      break
    case "SessionContextCompacted":
      if (event.payload.changed) next = advanceTimelineHead(next, event.revision)
      break
    case "SessionContextWindowSet":
      next = {
        ...snapshot,
        contextWindowOverride: event.payload.contextWindow,
      }
      break
    case "SessionContextWindowCleared":
      next = { ...snapshot, contextWindowOverride: undefined }
      break
    case "SessionAgentSelected":
      next = { ...snapshot, activeAgent: event.payload.agentName }
      break
    case "SessionGoalUpdated":
      next = { ...snapshot, goal: normalizeSessionGoal(event.payload) }
      break
    case "ModelResponseCommitted": {
      const run = requireRun(snapshot, event.payload.runId)
      next = upsertRun({ ...snapshot, status: "running" }, { ...run, turn: event.payload.turn })
      next = advanceTimelineHead(next, event.revision)
      break
    }
    case "ToolCallRequested":
    case "ToolCallPrepared":
    case "ToolApprovalRequested":
    case "ToolApprovalResolved":
    case "AskUserRequested":
    case "AskUserResolved":
    case "ToolCallExecutionStarted":
    case "ToolAttemptStarted":
    case "ToolAttemptAbandoned":
    case "ToolResultCommitted":
      requireRun(snapshot, event.payload.runId)
      break
    case "RunCompleted": {
      const run = requireRun(snapshot, event.payload.runId)
      next = upsertRun(
        { ...snapshot, status: "completed", lastError: undefined },
        {
          ...run,
          status: "completed",
          turn: event.payload.turns,
          completedAt: event.timestamp,
          finalText: event.payload.finalText,
        },
      )
      next = advanceTimelineHead(next, event.revision)
      break
    }
    case "RunFailed": {
      const run = requireRun(snapshot, event.payload.runId)
      next = upsertRun(
        { ...snapshot, status: "failed", lastError: event.payload.message },
        {
          ...run,
          status: "failed",
          turn: event.payload.turns,
          completedAt: event.timestamp,
          lastError: event.payload.message,
        },
      )
      next = advanceTimelineHead(next, event.revision)
      break
    }
    case "RunCancelled": {
      const run = requireRun(snapshot, event.payload.runId)
      next = upsertRun(
        { ...snapshot, status: "cancelled", lastError: event.payload.reason },
        {
          ...run,
          status: "cancelled",
          turn: event.payload.turns,
          completedAt: event.timestamp,
          ...(event.payload.reason ? { lastError: event.payload.reason } : {}),
        },
      )
      next = advanceTimelineHead(next, event.revision)
      break
    }
    case "BackgroundTaskCreated":
      if ((snapshot.tasks ?? []).some((task) => task.id === event.payload.task.id)) {
        throw new Error(`background task already exists in session: ${event.payload.task.id}`)
      }
      next = {
        ...snapshot,
        tasks: [...(snapshot.tasks ?? []), event.payload.task],
        currentTask: event.payload.task,
      }
      break
    case "BackgroundTaskStarted": {
      const task = requireTask(snapshot, event.payload.taskId)
      if (!taskCanTransition(task.status, "running")) throw new Error(`background task cannot start: ${task.id}`)
      const updated = {
        ...task,
        status: "running" as const,
        runCount: Math.max(task.runCount, event.payload.runNumber),
        startedAt: event.timestamp,
        completedAt: undefined,
        nextRunAt: undefined,
        lastError: undefined,
      }
      next = upsertTask({ ...snapshot, currentTask: updated }, updated)
      break
    }
    case "BackgroundTaskOutputAppended": {
      const task = requireTask(snapshot, event.payload.taskId)
      if (task.status !== "running") throw new Error(`background task is not running: ${task.id}`)
      const output = `${task.lastOutput ?? ""}${event.payload.chunk}`
      const updated = {
        ...task,
        lastOutput: output.slice(-8_192),
        outputBytes: event.payload.totalBytes,
      }
      next = upsertTask({ ...snapshot, currentTask: updated }, updated)
      break
    }
    case "BackgroundTaskCompleted": {
      const task = requireTask(snapshot, event.payload.taskId)
      if (task.status !== "running") throw new Error(`background task is not running: ${task.id}`)
      const recurring = event.payload.nextRunAt !== undefined
      const updated = {
        ...task,
        status: recurring ? ("queued" as const) : ("completed" as const),
        runCount: Math.max(task.runCount, event.payload.runNumber),
        ...(recurring ? { nextRunAt: event.payload.nextRunAt } : { completedAt: event.timestamp, nextRunAt: undefined }),
      }
      next = upsertTask({ ...snapshot, currentTask: updated }, updated)
      break
    }
    case "BackgroundTaskFailed": {
      const task = requireTask(snapshot, event.payload.taskId)
      if (isTerminalTaskStatus(task.status)) throw new Error(`background task already finished: ${task.id}`)
      const updated = {
        ...task,
        status: "failed" as const,
        completedAt: event.timestamp,
        lastError: event.payload.message,
        nextRunAt: undefined,
      }
      next = upsertTask({ ...snapshot, currentTask: updated }, updated)
      break
    }
    case "BackgroundTaskCancelled": {
      const task = requireTask(snapshot, event.payload.taskId)
      if (isTerminalTaskStatus(task.status)) throw new Error(`background task already finished: ${task.id}`)
      const updated = {
        ...task,
        status: "cancelled" as const,
        completedAt: event.timestamp,
        ...(event.payload.reason ? { lastError: event.payload.reason } : {}),
        nextRunAt: undefined,
      }
      next = upsertTask({ ...snapshot, currentTask: updated }, updated)
      break
    }
  }
  return { ...next, lastRevision: event.revision }
}

function requireRun(snapshot: SessionSnapshot, id: RunId): RunSnapshot {
  const run = snapshot.runs?.find((item) => item.id === id)
  if (!run) throw new Error(`session is missing RunStarted: ${id}`)
  return run
}

function advanceTimelineHead(snapshot: SessionSnapshot, physicalRevision: number): SessionSnapshot {
  if (snapshot.timeline === undefined) return snapshot
  return {
    ...snapshot,
    timeline: {
      ...snapshot.timeline,
      headRevision: physicalRevision,
    },
  }
}

function upsertInput(snapshot: SessionSnapshot, input: SessionInputSnapshot): SessionSnapshot {
  const inputs = [...snapshot.inputs]
  const index = inputs.findIndex((item) => item.inputId === input.inputId)
  if (index < 0) inputs.push(input)
  else inputs[index] = input
  return { ...snapshot, inputs }
}

function toInputSnapshot(input: import("./canonical-session.js").CanonicalInputState, active: boolean): SessionInputSnapshot {
  return {
    inputId: input.inputId,
    commandId: input.commandId,
    kind: input.kind,
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    status: input.status,
    active,
    ...(input.targetRunId === undefined ? {} : { targetRunId: input.targetRunId }),
  }
}

function upsertRun(snapshot: SessionSnapshot, run: RunSnapshot): SessionSnapshot {
  const runs = [...(snapshot.runs ?? [])]
  const index = runs.findIndex((item) => item.id === run.id)
  if (index < 0) runs.push(run)
  else runs[index] = run
  return { ...snapshot, runs, currentRun: run }
}

function requireTask(snapshot: SessionSnapshot, id: import("../ids.js").TaskId): TaskSnapshot {
  const task = (snapshot.tasks ?? []).find((item) => item.id === id)
  if (!task) throw new Error(`session is missing BackgroundTaskCreated: ${id}`)
  return task
}

function upsertTask(snapshot: SessionSnapshot, task: TaskSnapshot): SessionSnapshot {
  const tasks = [...(snapshot.tasks ?? [])]
  const index = tasks.findIndex((item) => item.id === task.id)
  if (index < 0) throw new Error(`session is missing BackgroundTaskCreated: ${task.id}`)
  tasks[index] = task
  return { ...snapshot, tasks, currentTask: task }
}

function taskCanTransition(status: TaskSnapshot["status"], target: TaskSnapshot["status"]): boolean {
  return status === "queued" && target === "running"
}
