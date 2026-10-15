import type { Plan } from "../plan/plan.js"
import type { RunId, SessionId, TaskId } from "../ids.js"
import type { ContentBlock, Message } from "../message.js"
import type { GuardianDenialReasonCode, PreparedSecurityFact, ToolResult, ToolResultDenial } from "../tool-facts.js"
import type { ModelProviderMetadata } from "../model/observation.js"
import type { CanonicalModelRequest, ContextProvenance } from "../model/observation.js"
import type { SessionGoal } from "../session/session-goal.js"
import type { TaskSnapshot } from "../task/task.js"
import type { SessionPermissionMode, SessionPermissionRule } from "../session/session-security.js"

export type AgentEventType =
  | "SessionCreated"
  | "SessionTitleSet"
  | "SessionArchived"
  | "CommandAccepted"
  | "InputAccepted"
  | "InputCancellationRequested"
  | "InputConsumed"
  | "RunStopRequested"
  | "RunRetryRequested"
  | "ModelAttemptStarted"
  | "ModelAttemptAbandoned"
  | "ModelResponseCommitted"
  | "ToolAttemptStarted"
  | "ToolAttemptAbandoned"
  | "ToolResultCommitted"
  | "HeadMoved"
  | "BranchCreated"
  | "ForkRequested"
  | "ForkCompleted"
  | "ForkRejected"
  | "SessionAdditionalDirectoryAdded"
  | "SessionPermissionModeSet"
  | "SessionPermissionRulesSet"
  | "SessionCheckpointCreated"
  | "PlanCreated"
  | "PlanGenerationFailed"
  | "PlanGenerationCancelled"
  | "RunStarted"
  | "ContextCompacted"
  | "SessionContextCompacted"
  | "SessionContextWindowSet"
  | "SessionContextWindowCleared"
  | "SessionAgentSelected"
  | "SessionGoalUpdated"
  | "ModelRetryScheduled"
  | "ToolCallRequested"
  | "ToolCallPrepared"
  | "ToolApprovalRequested"
  | "ToolApprovalResolved"
  | "ToolCallExecutionStarted"
  | "RunCompleted"
  | "RunFailed"
  | "RunCancelled"
  | "BackgroundTaskCreated"
  | "BackgroundTaskStarted"
  | "BackgroundTaskOutputAppended"
  | "BackgroundTaskCompleted"
  | "BackgroundTaskFailed"
  | "BackgroundTaskCancelled"

export interface HistoryCursor {
  readonly sessionId: SessionId
  readonly branchId: string
  readonly nodeId: string
  readonly physicalRevision: number
  readonly recordHash: string
}

export interface ForeignLineageRef {
  readonly sourceSessionId: SessionId
  readonly sourceCursor: HistoryCursor
  readonly materializedPrefixDigest: string
}

/** Correlation metadata shared by durable events and protocol adapters. */
export interface EventTrace {
  readonly traceId: string
  readonly operationId: string
  /** The event or command that caused this event. */
  readonly causationId?: string
}

export interface AgentEventBase<TType extends AgentEventType, TPayload> {
  readonly eventId: string
  readonly sessionId: SessionId
  readonly revision: number
  /** Optional until all legacy event producers are migrated to the record envelope. */
  readonly scopeId?: string
  readonly modeScope?: "serve" | "local-tui" | "local-run" | "ephemeral"
  readonly workspaceIdentity?: string
  readonly transitionId?: string
  readonly writerEpoch?: number
  readonly recordHash?: string
  readonly previousRecordHash?: string
  readonly type: TType
  readonly timestamp: string
  readonly trace: EventTrace
  readonly payload: TPayload
}

export type AgentEvent =
  | AgentEventBase<
      "SessionCreated",
      {
        workspaceRoot: string
        workspaceId?: string
        additionalDirectories?: readonly string[]
        scopeRevision?: number
        scopeDigest?: string
        permissionMode: SessionPermissionMode
        permissionRules: readonly SessionPermissionRule[]
        policyRevision: number
      }
    >
  | AgentEventBase<"SessionTitleSet", { commandId: string; title?: string }>
  | AgentEventBase<"SessionArchived", { commandId: string; archivedAt: string }>
  | AgentEventBase<
      "CommandAccepted",
      {
        commandId: string
        family: string
        inputFingerprint: Readonly<Record<string, unknown>>
      }
    >
  | AgentEventBase<
      "InputAccepted",
      {
        inputId: string
        commandId: string
        kind: "message" | "steer" | "notification"
        text: string
        delivery: "fifo" | "safe-boundary"
        targetRunId?: RunId
        context?: readonly string[]
        fileReferences?: readonly string[]
        history?: {
          branchId: string
          nodeId: string
          parentNodeId?: string
        }
      }
    >
  | AgentEventBase<
      "InputCancellationRequested",
      {
        inputId: string
        commandId: string
        reason?: string
      }
    >
  | AgentEventBase<
      "InputConsumed",
      {
        inputId: string
        commandId: string
        kind: "message" | "steer" | "notification"
        text: string
        delivery: "fifo" | "safe-boundary"
        runId: RunId
        executionGeneration: number
        boundary: "model-request" | "safe-boundary"
        parent: HistoryCursor
      }
    >
  | AgentEventBase<"RunStopRequested", { runId: RunId; commandId: string; reason?: string }>
  | AgentEventBase<"RunRetryRequested", { runId: RunId; commandId: string; reason?: string }>
  | AgentEventBase<
      "ModelAttemptStarted",
      {
        runId: RunId
        turn: number
        attemptId: string
        executionGeneration: number
        branchId: string
        inputCursor: HistoryCursor
        requestFingerprint: string
        /** Full request snapshot is persisted only when the observability policy captures model payloads. */
        request?: CanonicalModelRequest
        context?: ContextProvenance
        /** Policy revision the request was bound to; a later commit that moved it invalidates the response. */
        boundPolicyRevision: number
      }
    >
  | AgentEventBase<
      "ModelAttemptAbandoned",
      {
        runId: RunId
        turn: number
        attemptId: string
        executionGeneration: number
        reason: string
        recoveryCommandId: string
      }
    >
  | AgentEventBase<
      "ModelResponseCommitted",
      {
        runId: RunId
        turn: number
        attemptId: string
        executionGeneration: number
        branchId: string
        inputCursor: HistoryCursor
        requestFingerprint: string
        parent: HistoryCursor
        content: readonly ContentBlock[]
        stopReason?: string
        metadata?: ModelProviderMetadata
        durationMs?: number
      }
    >
  | AgentEventBase<
      "ToolAttemptStarted",
      {
        runId: RunId
        turn: number
        attemptId: string
        toolUseId: string
        executionGeneration: number
        branchId: string
        inputCursor: HistoryCursor
        requestFingerprint: string
      }
    >
  | AgentEventBase<
      "ToolAttemptAbandoned",
      {
        runId: RunId
        turn: number
        attemptId: string
        toolUseId: string
        executionGeneration: number
        reason: string
        recoveryCommandId: string
      }
    >
  | AgentEventBase<
      "ToolResultCommitted",
      {
        runId: RunId
        turn: number
        attemptId: string
        toolUseId: string
        executionGeneration: number
        branchId: string
        requestFingerprint: string
        parent: HistoryCursor
        result: ToolResult
      }
    >
  | AgentEventBase<
      "BranchCreated",
      {
        commandId: string
        branchId: string
        parentBranchId: string
        parentCursor: HistoryCursor
        head: HistoryCursor
      }
    >
  | AgentEventBase<
      "HeadMoved",
      {
        commandId: string
        from: HistoryCursor
        to: HistoryCursor
        branchId: string
        head: HistoryCursor
        executionGeneration: number
      }
    >
  | AgentEventBase<
      "ForkRequested",
      {
        commandId: string
        sourceSessionId: SessionId
        sourceCursor: HistoryCursor
        targetSessionId: SessionId
      }
    >
  | AgentEventBase<
      "ForkCompleted",
      {
        commandId: string
        sourceSessionId: SessionId
        sourceCursor: HistoryCursor
        targetSessionId: SessionId
        materializedPrefixDigest: string
        foreignLineageRef: ForeignLineageRef
      }
    >
  | AgentEventBase<
      "ForkRejected",
      {
        commandId: string
        sourceSessionId: SessionId
        sourceCursor: HistoryCursor
        targetSessionId: SessionId
        reason: string
      }
    >
  | AgentEventBase<
      "SessionAdditionalDirectoryAdded",
      {
        commandId: string
        requestedDirectory: string
        directory: string
        additionalDirectories?: readonly string[]
        scopeRevision: number
        policyRevision: number
        scopeDigest: string
        changed: boolean
      }
    >
  | AgentEventBase<
      "SessionPermissionModeSet",
      {
        mode: SessionPermissionMode
        policyRevision: number
      }
    >
  | AgentEventBase<
      "SessionPermissionRulesSet",
      {
        rules: readonly SessionPermissionRule[]
        policyRevision: number
      }
    >
  | AgentEventBase<
      "SessionCheckpointCreated",
      {
        checkpointId: string
        kind: "prompt" | "manual"
        headRevision: number
        generation: number
        head: HistoryCursor
      }
    >
  | AgentEventBase<"PlanCreated", Plan>
  | AgentEventBase<"PlanGenerationFailed", { message: string }>
  | AgentEventBase<"PlanGenerationCancelled", { reason?: string }>
  | AgentEventBase<"RunStarted", { runId: RunId; commandId: string; goal: string; maxTurns?: number }>
  | AgentEventBase<
      "ContextCompacted",
      {
        runId: RunId
        turn: number
        compactId: string
        inputMessageCount: number
        outputMessageCount: number
        messages: readonly Message[]
        inputTokens?: number
      }
    >
  | AgentEventBase<
      "SessionContextCompacted",
      {
        commandId: string
        instructions?: string
        changed: boolean
        compactId: string
        inputMessageCount: number
        outputMessageCount: number
        messages: readonly Message[]
        inputTokens?: number
      }
    >
  | AgentEventBase<"SessionContextWindowSet", { contextWindow: number }>
  | AgentEventBase<"SessionContextWindowCleared", {}>
  | AgentEventBase<"SessionAgentSelected", { agentName?: string }>
  | AgentEventBase<"SessionGoalUpdated", SessionGoal>
  | AgentEventBase<
      "ModelRetryScheduled",
      {
        runId: RunId
        turn: number
        callId?: string
        attempt: number
        nextAttempt: number
        delayMs: number
        category: string
      }
    >
  | AgentEventBase<
      "ToolCallRequested",
      {
        runId: RunId
        turn: number
        toolUseId: string
        name: string
        input: unknown
      }
    >
  | AgentEventBase<
      "ToolCallPrepared",
      {
        runId: RunId
        turn: number
        toolUseId: string
        name: string
        preparedInput?: unknown
        status: "ready" | "invalid" | "blocked" | "denied" | "reused"
        decision?: "allow" | "ask" | "deny"
        reasons: readonly string[]
        analyzerVersion: string
        policyVersion: string
        approvalFingerprint?: string
        cwd?: string
        scopeRevision?: number
        scopeDigest?: string
        policyRevision?: number
        /**
         * Producer-declared denial code captured at preparation time. Durable
         * so a crash before the settled result re-settles on the same code.
         */
        denial?: ToolResultDenial
        /**
         * Producer-declared security fact captured at preparation time.
         * Durable so a resumed turn re-judges on the same fact the live turn
         * prepared (live/resume equivalence).
         */
        securityFact?: PreparedSecurityFact
      }
    >
  | AgentEventBase<
      "ToolApprovalRequested",
      {
        runId: RunId
        turn: number
        toolUseId: string
        name: string
        preparedEventId: string
        /** Binds the approval to the exact canonical input it was requested for. */
        inputFingerprint: string
        /** Who owns answering this ask; absent means the user (the wire never carries "user"). */
        ownedBy?: "guardian"
        scopeRevision?: number
        policyRevision?: number
      }
    >
  | AgentEventBase<
      "ToolApprovalResolved",
      {
        runId: RunId
        turn: number
        toolUseId: string
        preparedEventId: string
        decision: "approved" | "denied"
        /** Who resolved; absent means the user (legacy resolutions stay absent). */
        resolvedBy?: "guardian" | "system"
        /**
         * Resolving guardian identity; legal iff resolvedBy is "guardian".
         * `reasonCode` is the stable machine reason (denied resolutions only);
         * `reason` is bounded, model-authored display text — never identity or
         * binding.
         */
        guardian?: { guardianId: string; reasonCode?: GuardianDenialReasonCode; reason?: string }
        /**
         * The guardian approval this system denial superseded; legal iff
         * resolvedBy is "system", the decision is denied and the ask was
         * guardian-owned. Keeps both audit facts: the guardian approved, and
         * the system blocked execution under the newer policy.
         */
        supersededApproval?: { guardianId: string; reason?: string }
      }
    >
  | AgentEventBase<
      "ToolCallExecutionStarted",
      {
        runId: RunId
        turn: number
        toolUseId: string
        name: string
        dispatchId: string
        requestFingerprint: string
        replayPolicy: "never" | "retry-safe"
        preparedEventId?: string
        execution?: {
          shell: "/bin/bash"
          argvShape: "bash-noprofile-norc-c"
          cwd: string
        }
      }
    >
  | AgentEventBase<"RunCompleted", { runId: RunId; turns: number; finalText: string }>
  | AgentEventBase<
      "RunFailed",
      {
        runId: RunId
        turns: number
        message: string
        code?: "approval_required"
      }
    >
  | AgentEventBase<"RunCancelled", { runId: RunId; turns: number; reason?: string }>
  | AgentEventBase<"BackgroundTaskCreated", { task: TaskSnapshot }>
  | AgentEventBase<"BackgroundTaskStarted", { taskId: TaskId; runNumber: number }>
  | AgentEventBase<"BackgroundTaskOutputAppended", { taskId: TaskId; sequence: number; chunk: string; totalBytes: number }>
  | AgentEventBase<"BackgroundTaskCompleted", { taskId: TaskId; runNumber: number; nextRunAt?: string }>
  | AgentEventBase<"BackgroundTaskFailed", { taskId: TaskId; message: string }>
  | AgentEventBase<"BackgroundTaskCancelled", { taskId: TaskId; reason?: string }>
