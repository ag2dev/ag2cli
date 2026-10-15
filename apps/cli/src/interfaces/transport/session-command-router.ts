import { taskId, type SessionId } from "@ag2cli/core/ids.js"
import type { EventStore } from "@ag2cli/runtime/ports/event-store.js"
import type { TraceStore } from "@ag2cli/runtime/ports/trace-sink.js"
import type { ObservabilityPolicy } from "@ag2cli/runtime/ports/observability.js"
import type { ApprovalResolutionResolver } from "@ag2cli/runtime/application/session/approval-resolution.js"
import type { SessionCatalog } from "@ag2cli/runtime/ports/session-catalog.js"
import { projectModelCalls } from "@ag2cli/core/events/model-calls.js"
import type { SessionCommand, SessionCommandResult } from "@ag2cli/protocol/session-command.js"
import { SESSION_PROTOCOL_VERSION } from "@ag2cli/protocol/session-command.js"
import type { SessionExecuteOptions } from "@ag2cli/runtime/application/session/session-execution.js"
import type { CreatePlanUseCase } from "@ag2cli/runtime/application/plan/create-plan.js"
import type { RunAgentUseCase } from "@ag2cli/runtime/application/execution/run-agent.js"
import type { ExecuteShellUseCase } from "@ag2cli/runtime/application/execution/execute-shell.js"
import type { CompactSessionUseCase } from "@ag2cli/runtime/application/session/compact-session.js"
import type { UpdateSessionContextWindowUseCase } from "@ag2cli/runtime/application/session/context-window.js"
import type { UpdateSessionGoalUseCase } from "@ag2cli/runtime/application/session/update-goal.js"
import type { UpdateSessionAgentUseCase } from "@ag2cli/runtime/application/session/update-agent.js"
import type { AddAdditionalDirectoryUseCase } from "@ag2cli/runtime/application/session/workspace-roots.js"
import type { UpdateSessionPermissionUseCase } from "@ag2cli/runtime/application/session/permission-state.js"
import type { RewindSessionUseCase } from "@ag2cli/runtime/application/session/rewind-session.js"
import type { BackgroundTaskManager } from "@ag2cli/runtime/application/task/background-task-manager.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"

export interface SessionCommandRouterDependencies {
  readonly eventStore: EventStore
  readonly catalog?: SessionCatalog
  readonly createPlan: CreatePlanUseCase
  readonly addAdditionalDirectory?: AddAdditionalDirectoryUseCase
  readonly permission: UpdateSessionPermissionUseCase
  readonly rewind?: RewindSessionUseCase
  readonly run?: RunAgentUseCase
  readonly shell?: ExecuteShellUseCase
  readonly compact?: CompactSessionUseCase
  readonly contextWindow: UpdateSessionContextWindowUseCase
  readonly goal: UpdateSessionGoalUseCase
  readonly agent: UpdateSessionAgentUseCase
  readonly taskManager: BackgroundTaskManager
  readonly approvalResolution?: ApprovalResolutionResolver
  readonly traceSink?: TraceStore
  readonly observability?: ObservabilityPolicy
  /** Runtime-configured default; an explicit command value takes precedence. */
  readonly defaultMaxTurns?: number
  readonly snapshotFor: (sessionId: SessionId) => Promise<SessionSnapshot>
}

/** Routes validated session commands without owning session state or transport subscriptions. */
export class SessionCommandRouter {
  constructor(private readonly deps: SessionCommandRouterDependencies) {}

  async execute(sessionId: SessionId, command: SessionCommand, options?: SessionExecuteOptions): Promise<SessionCommandResult> {
    if (isWriteCommand(command)) {
      const record = await this.deps.catalog?.get(sessionId)
      if (record?.archived) throw new Error(`Session is archived and cannot be written: ${sessionId}`)
    }

    switch (command.type) {
      case "add_additional_directory": {
        if (!this.deps.addAdditionalDirectory) throw new Error("Additional directory management is not enabled on this Session server")
        const result = await this.deps.addAdditionalDirectory.execute({
          sessionId,
          commandId: command.commandId,
          directory: command.directory,
          workspaceRoot: command.workspaceRoot,
          expectedScopeRevision: command.expectedScopeRevision,
          signal: options?.signal,
        })
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "additional_directory_added",
          changed: result.changed,
          directory: result.directory,
          additionalDirectories: result.additionalDirectories,
          scopeRevision: result.scopeRevision,
          ...(result.scopeDigest === undefined ? {} : { scopeDigest: result.scopeDigest }),
          snapshot: await this.deps.snapshotFor(sessionId),
        }
      }
      case "create_plan": {
        const plan = await this.deps.createPlan.execute({
          sessionId,
          commandId: command.commandId,
          goal: command.goal,
          context: command.context,
          workspace: command.workspace,
          additionalDirectories: command.additionalDirectories,
          trace: command.trace,
          signal: options?.signal,
        })
        return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "plan_created", plan, snapshot: await this.deps.snapshotFor(sessionId) }
      }
      case "set_permission_mode":
      case "set_permission_rules": {
        const result = await this.deps.permission.execute({
          sessionId,
          commandId: command.commandId,
          ...(command.type === "set_permission_mode"
            ? { mode: command.mode, expectedPolicyRevision: command.expectedPolicyRevision }
            : { rules: command.rules, expectedPolicyRevision: command.expectedPolicyRevision }),
        })
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "permission_updated",
          changed: result.changed,
          snapshot: await this.deps.snapshotFor(sessionId),
        }
      }
      case "start_run": {
        if (!this.deps.run) throw new Error("Execution runtime is not enabled on this Session server")
        if (options?.acceptOnly) {
          const admission = await this.deps.run.admit({
            sessionId,
            commandId: command.commandId,
            goal: command.goal,
            context: command.context,
            fileReferences: command.fileReferences,
            workspace: command.workspace,
            additionalDirectories: command.additionalDirectories,
            permissionMode: command.permissionMode,
            permissionRules: command.permissionRules,
            trace: command.trace,
            ...(command.maxTurns === undefined && this.deps.defaultMaxTurns === undefined
              ? {}
              : { maxTurns: command.maxTurns ?? this.deps.defaultMaxTurns }),
          })
          if (!admission.queued) {
            void this.deps.run
              .execute({
                sessionId,
                commandId: command.commandId,
                goal: command.goal,
                context: command.context,
                fileReferences: command.fileReferences,
                workspace: command.workspace,
                additionalDirectories: command.additionalDirectories,
                permissionMode: command.permissionMode,
                permissionRules: command.permissionRules,
                trace: command.trace,
                ...(command.maxTurns === undefined && this.deps.defaultMaxTurns === undefined
                  ? {}
                  : { maxTurns: command.maxTurns ?? this.deps.defaultMaxTurns }),
              })
              .catch(() => {})
          }
          return {
            protocolVersion: SESSION_PROTOCOL_VERSION,
            type: "input_accepted",
            inputId: admission.inputId,
            queued: admission.queued,
            snapshot: await this.deps.snapshotFor(sessionId),
          }
        }
        const queued = await this.deps.run.queueIfRunning({
          sessionId,
          commandId: command.commandId,
          goal: command.goal,
          context: command.context,
          fileReferences: command.fileReferences,
          workspace: command.workspace,
          additionalDirectories: command.additionalDirectories,
          permissionMode: command.permissionMode,
          permissionRules: command.permissionRules,
          ...(command.maxTurns === undefined && this.deps.defaultMaxTurns === undefined
            ? {}
            : { maxTurns: command.maxTurns ?? this.deps.defaultMaxTurns }),
        })
        if (queued !== undefined) {
          return {
            protocolVersion: SESSION_PROTOCOL_VERSION,
            type: "input_accepted",
            inputId: queued.inputId,
            queued: true,
            snapshot: await this.deps.snapshotFor(sessionId),
          }
        }
        const result = await this.deps.run.execute({
          sessionId,
          commandId: command.commandId,
          goal: command.goal,
          context: command.context,
          fileReferences: command.fileReferences,
          workspace: command.workspace,
          additionalDirectories: command.additionalDirectories,
          permissionMode: command.permissionMode,
          permissionRules: command.permissionRules,
          ...(command.maxTurns === undefined && this.deps.defaultMaxTurns === undefined
            ? {}
            : { maxTurns: command.maxTurns ?? this.deps.defaultMaxTurns }),
          trace: command.trace,
          signal: options?.signal,
        })
        return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "run_result", result, snapshot: await this.deps.snapshotFor(sessionId) }
      }
      case "steer": {
        if (!this.deps.run) throw new Error("Execution runtime is not enabled on this Session server")
        const result = await this.deps.run.steer({
          sessionId,
          commandId: command.commandId,
          runId: command.runId,
          text: command.text,
        })
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "input_accepted",
          inputId: result.inputId,
          queued: true,
          snapshot: await this.deps.snapshotFor(sessionId),
        }
      }
      case "cancel_input": {
        if (!this.deps.run) throw new Error("Execution runtime is not enabled on this Session server")
        const result = await this.deps.run.cancelInput({
          sessionId,
          commandId: command.commandId,
          inputId: command.inputId,
          reason: command.reason,
        })
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "input_cancelled",
          inputId: result.inputId,
          status: result.status,
          snapshot: await this.deps.snapshotFor(sessionId),
        }
      }
      case "execute_shell":
      case "execute_user_shell": {
        if (!this.deps.shell) throw new Error("Execution runtime is not enabled on this Session server")
        const result =
          command.type === "execute_shell"
            ? await this.deps.shell.execute({
                sessionId,
                commandId: command.commandId,
                argv: command.argv,
                cwd: command.cwd,
                timeoutMs: command.timeoutMs,
                signal: options?.signal,
              })
            : await this.deps.shell.execute({
                sessionId,
                commandId: command.commandId,
                command: command.command,
                cwd: command.cwd,
                timeoutMs: command.timeoutMs,
                signal: options?.signal,
              })
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "shell_result",
          runId: result.runId,
          result: result.result,
          snapshot: await this.deps.snapshotFor(sessionId),
        }
      }
      case "compact": {
        if (!this.deps.compact) throw new Error("Context compaction is not enabled on this Session server")
        const result = await this.deps.compact.execute({
          sessionId,
          commandId: command.commandId,
          ...(command.instructions === undefined ? {} : { instructions: command.instructions }),
          signal: options?.signal,
        })
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "compacted",
          changed: result.changed,
          inputMessageCount: result.inputMessageCount,
          outputMessageCount: result.outputMessageCount,
          ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
          snapshot: await this.deps.snapshotFor(sessionId),
        }
      }
      case "set_context_window":
      case "clear_context_window": {
        const result = await this.deps.contextWindow.execute({
          sessionId,
          commandId: command.commandId,
          update: command.type === "set_context_window" ? { mode: "set", contextWindow: command.contextWindow } : { mode: "clear" },
        })
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "context_window_updated",
          changed: result.changed,
          ...(result.contextWindowOverride === undefined ? {} : { contextWindowOverride: result.contextWindowOverride }),
          snapshot: await this.deps.snapshotFor(sessionId),
        }
      }
      case "set_agent": {
        const result = await this.deps.agent.execute({
          sessionId,
          commandId: command.commandId,
          ...(command.agentName === undefined ? {} : { agentName: command.agentName }),
        })
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "agent_updated",
          changed: result.changed,
          ...(result.agentName === undefined ? {} : { agentName: result.agentName }),
          snapshot: await this.deps.snapshotFor(sessionId),
        }
      }
      case "update_goal": {
        const result = await this.deps.goal.execute({ sessionId, commandId: command.commandId, update: command.update })
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "goal_updated",
          changed: result.changed,
          goal: result.goal,
          snapshot: await this.deps.snapshotFor(sessionId),
        }
      }
      case "create_task": {
        const task = await this.deps.taskManager.create(sessionId, {
          taskId: command.taskId ?? taskId(`task-${command.commandId}`),
          type: command.taskType,
          title: command.title,
          ...(command.prompt === undefined ? {} : { prompt: command.prompt }),
          ...(command.argv === undefined ? {} : { argv: command.argv }),
          ...(command.intervalMs === undefined ? {} : { intervalMs: command.intervalMs }),
          ...(command.maxRuns === undefined ? {} : { maxRuns: command.maxRuns }),
          ...(command.workspace === undefined ? {} : { workspace: command.workspace }),
          ...(command.parentRunId === undefined ? {} : { parentRunId: command.parentRunId }),
        })
        return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "task_created", task, snapshot: await this.deps.snapshotFor(sessionId) }
      }
      case "list_tasks":
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "tasks",
          tasks: await this.deps.taskManager.list(sessionId),
          snapshot: await this.deps.snapshotFor(sessionId),
        }
      case "cancel_task": {
        const task = await this.deps.taskManager.cancel(sessionId, command.taskId, command.reason)
        return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "task_cancelled", task, snapshot: await this.deps.snapshotFor(sessionId) }
      }
      case "list_checkpoints": {
        if (!this.deps.rewind) throw new Error("Rewind is not enabled on this Session server")
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "checkpoints",
          checkpoints: await this.deps.rewind.listCheckpoints({ sessionId }),
          snapshot: await this.deps.snapshotFor(sessionId),
        }
      }
      case "preview_rewind": {
        if (!this.deps.rewind) throw new Error("Rewind is not enabled on this Session server")
        const preview = await this.deps.rewind.preview({
          sessionId,
          checkpointId: command.checkpointId,
          expectedRevision: command.expectedRevision,
          signal: options?.signal,
        })
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "rewind_preview",
          preview,
          snapshot: await this.deps.snapshotFor(sessionId),
        }
      }
      case "rewind": {
        if (!this.deps.rewind) throw new Error("Rewind is not enabled on this Session server")
        const result = await this.deps.rewind.execute({
          sessionId,
          rewindId: command.commandId,
          checkpointId: command.checkpointId,
          expectedRevision: command.expectedRevision,
          trace: command.trace,
          signal: options?.signal,
        })
        return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "rewind_result", result, snapshot: result.snapshot }
      }
      case "resolve_approval": {
        if (!this.deps.approvalResolution) {
          throw new Error("Remote approval broker is not enabled on this Session server")
        }
        await this.deps.approvalResolution.resolve({
          sessionId,
          runId: command.runId,
          turn: command.turn,
          toolUseId: command.toolUseId,
          preparedEventId: command.preparedEventId,
          expectedScopeRevision: command.expectedScopeRevision,
          expectedPolicyRevision: command.expectedPolicyRevision,
          decision: command.decision,
        })
        return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "snapshot", snapshot: await this.deps.snapshotFor(sessionId) }
      }
      case "get_snapshot":
        return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "snapshot", snapshot: await this.deps.snapshotFor(sessionId) }
      case "read_events":
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "events",
          events: await this.deps.eventStore.readSince(sessionId, command.afterRevision ?? 0),
        }
      case "read_trace":
        return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "trace", records: this.deps.traceSink?.read(sessionId) ?? [] }
      case "read_model_calls": {
        const events = await this.deps.eventStore.read(sessionId)
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "model_calls",
          records: projectModelCalls(sessionId, events, {
            includePayload: command.includePayload === true && this.deps.observability?.captureModelPayload === true,
          }),
        }
      }
    }
  }
}

function isWriteCommand(command: SessionCommand): boolean {
  return (
    command.type === "create_plan" ||
    command.type === "add_additional_directory" ||
    command.type === "set_permission_mode" ||
    command.type === "set_permission_rules" ||
    command.type === "start_run" ||
    command.type === "steer" ||
    command.type === "cancel_input" ||
    command.type === "execute_shell" ||
    command.type === "execute_user_shell" ||
    command.type === "resolve_approval" ||
    command.type === "compact" ||
    command.type === "set_context_window" ||
    command.type === "clear_context_window" ||
    command.type === "set_agent" ||
    command.type === "update_goal" ||
    command.type === "create_task" ||
    command.type === "cancel_task" ||
    command.type === "rewind" ||
    command.type === "preview_rewind"
  )
}
