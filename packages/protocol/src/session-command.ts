import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { EventTrace } from "@ag2cli/core/events/event.js"
import type { SessionId, RunId, TaskId } from "@ag2cli/core/ids.js"
import type { Plan } from "@ag2cli/core/plan/plan.js"
import type { RunResult } from "@ag2cli/core/execution/run.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import type { ModelCallRecord } from "@ag2cli/core/model/observation.js"
import type { SessionGoalUpdate } from "@ag2cli/core/session/session-goal.js"
import type { SessionTimelineSnapshot } from "@ag2cli/core/session/session-timeline.js"
import type { SessionPermissionMode, SessionPermissionRule } from "@ag2cli/core/session/session-security.js"
import type { BackgroundTaskType, TaskSnapshot } from "@ag2cli/core/task/task.js"

/** Wire-level approval decision. Runtime maps this to its approval port. */
export type ProtocolApprovalDecision = "approved" | "denied"

import type { TraceRecord } from "./trace.js"

export interface ProtocolSessionRecord {
  readonly sessionId: SessionId
  readonly workspaceId?: string
  readonly snapshot: SessionSnapshot
  readonly title?: string
  readonly createdAt: string
  readonly archived: boolean
  readonly archivedAt?: string
}

export interface ProtocolRewindPreview {
  readonly checkpoint: import("@ag2cli/core/session/session-timeline.js").SessionCheckpoint
  readonly currentRevision: number
  readonly currentGeneration: number
  readonly staleRevision: boolean
  readonly canCommit: boolean
}

export type ProtocolRewindSessionResult =
  | {
      readonly status: "rewound" | "already_rewound"
      readonly rewindId: string
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly status: "failed" | "already_failed"
      readonly rewindId: string
      readonly error: string
      readonly snapshot: SessionSnapshot
    }

export const SESSION_PROTOCOL_VERSION = 1 as const
export type SessionProtocolVersion = typeof SESSION_PROTOCOL_VERSION

interface SessionCommandBase {
  readonly protocolVersion: SessionProtocolVersion
}

export type SessionCommand =
  | (SessionCommandBase & {
      readonly type: "create_plan"
      readonly commandId: string
      readonly goal: string
      readonly context?: readonly string[]
      readonly workspace?: string
      readonly additionalDirectories?: readonly string[]
      readonly trace?: EventTrace
    })
  | (SessionCommandBase & {
      readonly type: "add_additional_directory"
      readonly commandId: string
      readonly directory: string
      readonly workspaceRoot?: string
      readonly expectedScopeRevision?: number
    })
  | (SessionCommandBase & {
      readonly type: "set_permission_mode"
      readonly commandId: string
      readonly mode: SessionPermissionMode
      readonly expectedPolicyRevision?: number
    })
  | (SessionCommandBase & {
      readonly type: "set_permission_rules"
      readonly commandId: string
      readonly rules: readonly SessionPermissionRule[]
      readonly expectedPolicyRevision?: number
    })
  | (SessionCommandBase & {
      readonly type: "resolve_approval"
      readonly runId: import("@ag2cli/core/ids.js").RunId
      readonly turn: number
      readonly toolUseId: string
      readonly preparedEventId: string
      readonly expectedScopeRevision: number
      readonly expectedPolicyRevision: number
      readonly decision: ProtocolApprovalDecision
    })
  | (SessionCommandBase & {
      readonly type: "start_run"
      readonly commandId: string
      readonly goal: string
      readonly context?: readonly string[]
      readonly fileReferences?: readonly string[]
      readonly workspace?: string
      readonly additionalDirectories?: readonly string[]
      readonly permissionMode?: SessionPermissionMode
      readonly permissionRules?: readonly SessionPermissionRule[]
      readonly maxTurns?: number
      readonly trace?: EventTrace
    })
  | (SessionCommandBase & {
      readonly type: "steer"
      readonly commandId: string
      readonly runId: RunId
      readonly text: string
    })
  | (SessionCommandBase & {
      readonly type: "cancel_input"
      readonly commandId: string
      readonly inputId: string
      readonly reason?: string
    })
  | (SessionCommandBase & {
      readonly type: "execute_shell"
      readonly commandId: string
      readonly argv: readonly string[]
      readonly cwd?: string
      readonly timeoutMs?: number
    })
  | (SessionCommandBase & {
      readonly type: "execute_user_shell"
      readonly commandId: string
      readonly command: string
      readonly cwd?: string
      readonly timeoutMs?: number
    })
  | (SessionCommandBase & {
      readonly type: "compact"
      readonly commandId: string
      readonly instructions?: string
    })
  | (SessionCommandBase & {
      readonly type: "set_context_window"
      readonly commandId: string
      readonly contextWindow: number
    })
  | (SessionCommandBase & {
      readonly type: "clear_context_window"
      readonly commandId: string
    })
  | (SessionCommandBase & {
      readonly type: "set_agent"
      readonly commandId: string
      readonly agentName?: string
    })
  | (SessionCommandBase & {
      readonly type: "update_goal"
      readonly commandId: string
      readonly update: SessionGoalUpdate
    })
  | (SessionCommandBase & {
      readonly type: "create_task"
      readonly commandId: string
      readonly taskId?: TaskId
      readonly taskType: BackgroundTaskType
      readonly title: string
      readonly prompt?: string
      readonly argv?: readonly string[]
      readonly intervalMs?: number
      readonly maxRuns?: number
      readonly workspace?: string
      readonly parentRunId?: import("@ag2cli/core/ids.js").RunId
    })
  | (SessionCommandBase & { readonly type: "list_tasks" })
  | (SessionCommandBase & {
      readonly type: "cancel_task"
      readonly taskId: TaskId
      readonly reason?: string
    })
  | (SessionCommandBase & { readonly type: "list_checkpoints" })
  | (SessionCommandBase & {
      readonly type: "preview_rewind"
      readonly checkpointId: string
      readonly expectedRevision?: number
    })
  | (SessionCommandBase & {
      readonly type: "rewind"
      readonly commandId: string
      readonly checkpointId: string
      readonly expectedRevision?: number
      readonly trace?: EventTrace
    })
  | (SessionCommandBase & { readonly type: "get_snapshot" })
  | (SessionCommandBase & {
      readonly type: "read_events"
      readonly afterRevision?: number
    })
  | (SessionCommandBase & { readonly type: "read_trace" })
  | (SessionCommandBase & {
      readonly type: "read_model_calls"
      readonly includePayload?: boolean
    })

export type CreatePlanCommand = Extract<SessionCommand, { readonly type: "create_plan" }>
export type AddAdditionalDirectoryCommand = Extract<SessionCommand, { readonly type: "add_additional_directory" }>
export type AddAdditionalDirectoryCommandInput = Omit<AddAdditionalDirectoryCommand, "protocolVersion" | "type">
export type CreatePlanCommandInput = Omit<CreatePlanCommand, "protocolVersion" | "type">
export type StartRunCommand = Extract<SessionCommand, { readonly type: "start_run" }>
export type StartRunCommandInput = Omit<StartRunCommand, "protocolVersion" | "type">
export type SteerCommand = Extract<SessionCommand, { readonly type: "steer" }>
export type SteerCommandInput = Omit<SteerCommand, "protocolVersion" | "type">
export type CancelInputCommand = Extract<SessionCommand, { readonly type: "cancel_input" }>
export type CancelInputCommandInput = Omit<CancelInputCommand, "protocolVersion" | "type">
export type ResolveApprovalCommand = Extract<SessionCommand, { readonly type: "resolve_approval" }>
export type ResolveApprovalCommandInput = Omit<ResolveApprovalCommand, "protocolVersion" | "type">
export type ExecuteShellCommand = Extract<SessionCommand, { readonly type: "execute_shell" }>
export type ExecuteShellCommandInput = Omit<ExecuteShellCommand, "protocolVersion" | "type">
export type ExecuteUserShellCommand = Extract<SessionCommand, { readonly type: "execute_user_shell" }>
export type ExecuteUserShellCommandInput = Omit<ExecuteUserShellCommand, "protocolVersion" | "type">
export type CompactSessionCommand = Extract<SessionCommand, { readonly type: "compact" }>
export type CompactSessionCommandInput = Omit<CompactSessionCommand, "protocolVersion" | "type">
export type SetContextWindowCommand = Extract<SessionCommand, { readonly type: "set_context_window" }>
export type SetContextWindowCommandInput = Omit<SetContextWindowCommand, "protocolVersion" | "type">
export type ClearContextWindowCommand = Extract<SessionCommand, { readonly type: "clear_context_window" }>
export type ClearContextWindowCommandInput = Omit<ClearContextWindowCommand, "protocolVersion" | "type">
export type SetAgentCommand = Extract<SessionCommand, { readonly type: "set_agent" }>
export type SetAgentCommandInput = Omit<SetAgentCommand, "protocolVersion" | "type">
export type UpdateGoalCommand = Extract<SessionCommand, { readonly type: "update_goal" }>
export type UpdateGoalCommandInput = Omit<UpdateGoalCommand, "protocolVersion" | "type">
export type CreateTaskCommand = Extract<SessionCommand, { readonly type: "create_task" }>
export type CreateTaskCommandInput = Omit<CreateTaskCommand, "protocolVersion" | "type">
export type ListTasksCommand = Extract<SessionCommand, { readonly type: "list_tasks" }>
export type CancelTaskCommand = Extract<SessionCommand, { readonly type: "cancel_task" }>
export type CancelTaskCommandInput = Omit<CancelTaskCommand, "protocolVersion" | "type">
export type PreviewRewindCommand = Extract<SessionCommand, { readonly type: "preview_rewind" }>
export type RewindCommand = Extract<SessionCommand, { readonly type: "rewind" }>

/** Construct the versioned command used by every plan-capable client. */
export function createPlanCommand(input: CreatePlanCommandInput): CreatePlanCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "create_plan",
    ...input,
  }
}

export function addAdditionalDirectoryCommand(input: AddAdditionalDirectoryCommandInput): AddAdditionalDirectoryCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "add_additional_directory",
    ...input,
  }
}

export function setPermissionModeCommand(
  input: Omit<Extract<SessionCommand, { readonly type: "set_permission_mode" }>, "protocolVersion" | "type">,
): Extract<SessionCommand, { readonly type: "set_permission_mode" }> {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "set_permission_mode",
    ...input,
  }
}

export function setPermissionRulesCommand(
  input: Omit<Extract<SessionCommand, { readonly type: "set_permission_rules" }>, "protocolVersion" | "type">,
): Extract<SessionCommand, { readonly type: "set_permission_rules" }> {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "set_permission_rules",
    ...input,
  }
}

/** Construct the versioned command used by every execution-capable client. */
export function startRunCommand(input: StartRunCommandInput): StartRunCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "start_run",
    ...input,
  }
}

export function steerCommand(input: SteerCommandInput): SteerCommand {
  return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "steer", ...input }
}

export function cancelInputCommand(input: CancelInputCommandInput): CancelInputCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "cancel_input",
    ...input,
  }
}

export function resolveApprovalCommand(input: ResolveApprovalCommandInput): ResolveApprovalCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "resolve_approval",
    ...input,
  }
}

export function executeShellCommand(input: ExecuteShellCommandInput): ExecuteShellCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "execute_shell",
    ...input,
  }
}

export function executeUserShellCommand(input: ExecuteUserShellCommandInput): ExecuteUserShellCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "execute_user_shell",
    ...input,
  }
}

export function compactSessionCommand(input: CompactSessionCommandInput): CompactSessionCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "compact",
    ...input,
  }
}

export function setContextWindowCommand(input: SetContextWindowCommandInput): SetContextWindowCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "set_context_window",
    ...input,
  }
}

export function clearContextWindowCommand(input: ClearContextWindowCommandInput): ClearContextWindowCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "clear_context_window",
    ...input,
  }
}

export function setAgentCommand(input: SetAgentCommandInput): SetAgentCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "set_agent",
    ...input,
  }
}

export function updateGoalCommand(input: UpdateGoalCommandInput): UpdateGoalCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "update_goal",
    ...input,
  }
}

export function createTaskCommand(input: CreateTaskCommandInput): CreateTaskCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "create_task",
    ...input,
  }
}

export function listTasksCommand(): ListTasksCommand {
  return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "list_tasks" }
}

export function cancelTaskCommand(input: CancelTaskCommandInput): CancelTaskCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "cancel_task",
    ...input,
  }
}

export function listCheckpointsCommand(): Extract<SessionCommand, { readonly type: "list_checkpoints" }> {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "list_checkpoints",
  }
}

export function previewRewindCommand(input: Omit<PreviewRewindCommand, "protocolVersion" | "type">): PreviewRewindCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "preview_rewind",
    ...input,
  }
}

export function rewindCommand(input: Omit<RewindCommand, "protocolVersion" | "type">): RewindCommand {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "rewind",
    ...input,
  }
}

export function getSnapshotCommand(): Extract<SessionCommand, { readonly type: "get_snapshot" }> {
  return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "get_snapshot" }
}

export function readEventsCommand(afterRevision = 0): Extract<SessionCommand, { readonly type: "read_events" }> {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "read_events",
    afterRevision,
  }
}

export function readTraceCommand(): Extract<SessionCommand, { readonly type: "read_trace" }> {
  return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "read_trace" }
}

export function readModelCallsCommand(includePayload = false): Extract<SessionCommand, { readonly type: "read_model_calls" }> {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    type: "read_model_calls",
    ...(includePayload ? { includePayload: true } : {}),
  }
}

export type SessionCommandResult =
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "plan_created"
      readonly plan: Plan
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "additional_directory_added"
      readonly changed: boolean
      readonly directory: string
      readonly additionalDirectories: readonly string[]
      readonly scopeRevision: number
      readonly scopeDigest?: string
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "permission_updated"
      readonly changed: boolean
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "run_result"
      readonly result: RunResult
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "input_accepted"
      readonly inputId: string
      /** True when an existing agent loop owns delivery of this input. */
      readonly queued: boolean
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "input_cancelled"
      readonly inputId: string
      readonly status: "cancelled" | "cancelled-before-acceptance" | "already-delivered"
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "shell_result"
      readonly runId: RunId
      readonly result: import("@ag2cli/core/tool-facts.js").ToolResult
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "compacted"
      readonly changed: boolean
      readonly inputMessageCount: number
      readonly outputMessageCount: number
      readonly inputTokens?: number
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "context_window_updated"
      readonly changed: boolean
      readonly contextWindowOverride?: number
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "goal_updated"
      readonly changed: boolean
      readonly goal: import("@ag2cli/core/session/session-goal.js").SessionGoal
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "agent_updated"
      readonly changed: boolean
      readonly agentName?: string
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "task_created"
      readonly task: TaskSnapshot
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "tasks"
      readonly tasks: readonly TaskSnapshot[]
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "task_cancelled"
      readonly task: TaskSnapshot
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "checkpoints"
      readonly checkpoints: SessionTimelineSnapshot["checkpoints"]
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "rewind_preview"
      readonly preview: ProtocolRewindPreview
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "rewind_result"
      readonly result: ProtocolRewindSessionResult
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "snapshot"
      readonly snapshot: SessionSnapshot
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "events"
      readonly events: readonly AgentEvent[]
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "trace"
      readonly records: readonly TraceRecord[]
    }
  | {
      readonly protocolVersion: SessionProtocolVersion
      readonly type: "model_calls"
      readonly records: readonly ModelCallRecord[]
    }
