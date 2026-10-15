import type { EventTrace, HistoryCursor } from "@ag2cli/core/events/event.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import { runId, type SessionId } from "@ag2cli/core/ids.js"
import type { Plan, PlanStepStatus } from "@ag2cli/core/plan/plan.js"
import type { RunSnapshot, RunStatus } from "@ag2cli/core/execution/run.js"
import type { RunResult } from "@ag2cli/core/execution/run.js"
import type { SessionSnapshot, SessionStatus } from "@ag2cli/core/session/session-snapshot.js"
import type { SessionCheckpoint, SessionTimelineSnapshot } from "@ag2cli/core/session/session-timeline.js"
import { normalizeSessionGoal, type SessionGoal } from "@ag2cli/core/session/session-goal.js"
import type { ProtocolSessionRecord, ProtocolRewindPreview, ProtocolRewindSessionResult } from "./session-command.js"
import type { ContentBlock, Message } from "@ag2cli/core/message.js"
import type {
  ToolResult,
  ToolResultDenial,
  PermissionDenialCode,
  GuardianDenialReasonCode,
  StructuredPatch,
  PatchLine,
} from "@ag2cli/core/tool-facts.js"
import {
  isPreparedSecurityFact,
  MAX_GUARDIAN_ID_LENGTH,
  MAX_GUARDIAN_REASON_LENGTH,
  PERMISSION_DENIAL_CODES,
} from "@ag2cli/core/tool-facts.js"
import { isModelBashInput } from "@ag2cli/core/model-bash.js"
import { isTraceName, sanitizeTraceAttributes, type TraceRecord, type TracePhase } from "./trace.js"
import { SESSION_PROTOCOL_VERSION, type SessionCommand, type SessionCommandResult } from "./session-command.js"
import { SessionRequestError } from "./errors.js"
import {
  asRecord,
  parseBoolean,
  parseBoundedPositiveInteger,
  parseContextWindow,
  parseFileReferences,
  parseNonEmptyString,
  parseNonNegativeInteger,
  parseNonNegativeNumber,
  parseOptionalNonNegativeInteger,
  parsePlanId,
  parseRunId,
  parseSessionGoalUpdate,
  parseSessionId,
  parseShellArgv,
  parseString,
  parseStringArray,
  parseStringRecord,
  parseTaskId,
  parseTaskType,
  parseTrace,
  parseUserShellCommand,
  parsePositiveInteger,
} from "./session-codec-primitives.js"
import type {
  CanonicalModelRequest,
  ContextProvenance,
  ModelCallRecord,
  ModelCallPurpose,
  ModelProviderMetadata,
  ModelRetrySummary,
  ModelUsage,
} from "@ag2cli/core/model/observation.js"
import type { BackgroundTaskStatus, BackgroundTaskType, TaskSnapshot } from "@ag2cli/core/task/task.js"
import { MAX_TASK_OUTPUT_BYTES, MAX_TASK_OUTPUT_CHUNK } from "@ag2cli/core/task/task.js"
import {
  SESSION_PERMISSION_MODES,
  SESSION_PERMISSION_RULE_BEHAVIORS,
  assertSessionPermissionRuleNameBound,
  normalizeSessionPermissionRules,
  type SessionPermissionMode,
} from "@ag2cli/core/session/session-security.js"

/** Validate and normalize an untrusted JSON command at a transport boundary. */
export function parseSessionCommand(value: unknown): SessionCommand {
  try {
    return parseSessionCommandUnsafe(value)
  } catch (error) {
    if (error instanceof SessionRequestError) throw error
    throw new SessionRequestError(error instanceof Error ? error.message : String(error))
  }
}

function parseSessionCommandUnsafe(value: unknown): SessionCommand {
  if (!value || typeof value !== "object") throw new Error("Session command must be an object")
  const command = value as Record<string, unknown>
  if (command.protocolVersion !== SESSION_PROTOCOL_VERSION) {
    throw new Error(`Session protocol version is unsupported: ${String(command.protocolVersion)}`)
  }
  /* Retired permission-profile vocabulary is rejected, not silently dropped:
   * otherwise a caller upgrading from the old field would believe it took effect. */
  for (const key of ["permissionProfile", "permissionProfiles"] as const) {
    if (Object.hasOwn(command, key)) {
      throw new Error(`Session command carries the removed field ${key}; use permissionMode`)
    }
  }
  if (command.type === "get_snapshot") {
    return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "get_snapshot" }
  }
  if (command.type === "read_trace") {
    return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "read_trace" }
  }
  if (command.type === "read_model_calls") {
    if (command.includePayload !== undefined && typeof command.includePayload !== "boolean") {
      throw new Error("read_model_calls.includePayload must be a boolean")
    }
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "read_model_calls",
      ...(command.includePayload === true ? { includePayload: true } : {}),
    }
  }
  if (command.type === "list_checkpoints") {
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "list_checkpoints",
    }
  }
  if (command.type === "preview_rewind" || command.type === "rewind") {
    const checkpointId = parseNonEmptyString(command.checkpointId, `${command.type}.checkpointId`)
    const expectedRevision = parseOptionalNonNegativeInteger(command.expectedRevision, `${command.type}.expectedRevision`)
    const trace = command.type === "rewind" ? parseTrace(command.trace) : undefined
    if (command.type === "preview_rewind") {
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: command.type,
        checkpointId,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }
    }
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: command.type,
      commandId: parseNonEmptyString(command.commandId, "rewind.commandId"),
      checkpointId,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(trace === undefined ? {} : { trace }),
    }
  }
  if (command.type === "read_events") {
    const afterRevision = command.afterRevision
    if (afterRevision !== undefined && (typeof afterRevision !== "number" || !Number.isSafeInteger(afterRevision) || afterRevision < 0)) {
      throw new Error("afterRevision must be a non-negative integer")
    }
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "read_events",
      ...(afterRevision === undefined ? {} : { afterRevision }),
    }
  }
  if (command.type === "compact") {
    const commandId = parseNonEmptyString(command.commandId, "compact.commandId")
    if (command.instructions !== undefined && (typeof command.instructions !== "string" || command.instructions.trim().length === 0)) {
      throw new Error("compact.instructions must be a non-empty string")
    }
    if (typeof command.instructions === "string" && command.instructions.length > 4_096) {
      throw new Error("compact.instructions must not exceed 4096 characters")
    }
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "compact",
      commandId,
      ...(command.instructions === undefined ? {} : { instructions: command.instructions }),
    }
  }
  if (command.type === "add_additional_directory") {
    const commandId = parseNonEmptyString(command.commandId, "add_additional_directory.commandId")
    const directory = parseNonEmptyString(command.directory, "add_additional_directory.directory")
    const workspaceRoot =
      command.workspaceRoot === undefined ? undefined : parseNonEmptyString(command.workspaceRoot, "add_additional_directory.workspaceRoot")
    const expectedScopeRevision =
      command.expectedScopeRevision === undefined
        ? undefined
        : parseNonNegativeInteger(command.expectedScopeRevision, "add_additional_directory.expectedScopeRevision")
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "add_additional_directory",
      commandId,
      directory,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(expectedScopeRevision === undefined ? {} : { expectedScopeRevision }),
    }
  }
  if (command.type === "set_permission_mode") {
    const mode = parsePermissionMode(command.mode, "set_permission_mode.mode")
    const expectedPolicyRevision =
      command.expectedPolicyRevision === undefined
        ? undefined
        : parseNonNegativeInteger(command.expectedPolicyRevision, "set_permission_mode.expectedPolicyRevision")
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "set_permission_mode",
      commandId: parseNonEmptyString(command.commandId, "set_permission_mode.commandId"),
      mode,
      ...(expectedPolicyRevision === undefined ? {} : { expectedPolicyRevision }),
    }
  }
  if (command.type === "set_permission_rules") {
    const rawRules = command.rules
    if (!Array.isArray(rawRules)) throw new Error("set_permission_rules.rules must be an array")
    const rules = normalizeSessionPermissionRules(
      rawRules.map((value, index) => {
        const rule = asRecord(value, `set_permission_rules.rules[${index}]`)
        const behavior = rule.behavior
        if (!SESSION_PERMISSION_RULE_BEHAVIORS.includes(behavior as never))
          throw new Error(`set_permission_rules.rules[${index}].behavior is invalid`)
        const name = parseNonEmptyString(rule.name, `set_permission_rules.rules[${index}].name`)
        // Live wire ingest: names entering the durable policy set are bounded
        // here (and at the use case). Shared parsePermissionRules stays
        // unbounded because snapshot/event decodes replay durable history.
        assertSessionPermissionRuleNameBound(name)
        if (name.trim() === "bash" && behavior !== "deny")
          throw new Error(`set_permission_rules.rules[${index}]: only deny is a legal bash behavior`)
        return { name, behavior: behavior as never }
      }),
    )
    const expectedPolicyRevision =
      command.expectedPolicyRevision === undefined
        ? undefined
        : parseNonNegativeInteger(command.expectedPolicyRevision, "set_permission_rules.expectedPolicyRevision")
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "set_permission_rules",
      commandId: parseNonEmptyString(command.commandId, "set_permission_rules.commandId"),
      rules,
      ...(expectedPolicyRevision === undefined ? {} : { expectedPolicyRevision }),
    }
  }
  if (command.type === "set_context_window") {
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "set_context_window",
      commandId: parseNonEmptyString(command.commandId, "set_context_window.commandId"),
      contextWindow: parseContextWindow(command.contextWindow, "set_context_window.contextWindow"),
    }
  }
  if (command.type === "clear_context_window") {
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "clear_context_window",
      commandId: parseNonEmptyString(command.commandId, "clear_context_window.commandId"),
    }
  }
  if (command.type === "set_agent") {
    if (
      command.agentName !== undefined &&
      (typeof command.agentName !== "string" || command.agentName.trim().length === 0 || command.agentName.length > 128)
    ) {
      throw new Error("set_agent.agentName must be a non-empty string of 1 to 128 characters")
    }
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "set_agent",
      commandId: parseNonEmptyString(command.commandId, "set_agent.commandId"),
      ...(command.agentName === undefined ? {} : { agentName: command.agentName }),
    }
  }
  if (command.type === "update_goal") {
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "update_goal",
      commandId: parseNonEmptyString(command.commandId, "update_goal.commandId"),
      update: parseSessionGoalUpdate(command.update),
    }
  }
  if (command.type === "create_task") {
    const commandId = parseNonEmptyString(command.commandId, "create_task.commandId")
    const taskType = parseTaskType(command.taskType, "create_task.taskType")
    const title = parseNonEmptyString(command.title, "create_task.title")
    if (title.length > 512) throw new Error("create_task.title must not exceed 512 characters")
    const prompt = command.prompt === undefined ? undefined : parseNonEmptyString(command.prompt, "create_task.prompt")
    if (prompt && prompt.length > 32_768) throw new Error("create_task.prompt must not exceed 32768 characters")
    const argv = command.argv === undefined ? undefined : parseShellArgv(command.argv)
    if ((taskType === "agent" || taskType === "loop") && prompt === undefined) throw new Error("agent/loop task.prompt is required")
    if (taskType === "shell" && argv === undefined) throw new Error("shell task.argv is required")
    if (taskType !== "shell" && argv !== undefined) throw new Error("argv is only allowed for shell tasks")
    const intervalMs =
      command.intervalMs === undefined
        ? undefined
        : parseBoundedPositiveInteger(command.intervalMs, "create_task.intervalMs", 1_000, 7 * 24 * 60 * 60 * 1_000)
    const maxRuns =
      command.maxRuns === undefined ? undefined : parseBoundedPositiveInteger(command.maxRuns, "create_task.maxRuns", 1, 1_000)
    if (taskType !== "loop" && (intervalMs !== undefined || maxRuns !== undefined))
      throw new Error("intervalMs/maxRuns are only allowed for loop tasks")
    if (taskType === "loop" && intervalMs === undefined) throw new Error("loop task.intervalMs is required")
    const workspace = command.workspace === undefined ? undefined : parseNonEmptyString(command.workspace, "create_task.workspace")
    const parentRunId = command.parentRunId === undefined ? undefined : parseRunId(command.parentRunId)
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "create_task",
      commandId,
      ...(command.taskId === undefined ? {} : { taskId: parseTaskId(command.taskId) }),
      taskType,
      title,
      ...(prompt === undefined ? {} : { prompt }),
      ...(argv === undefined ? {} : { argv }),
      ...(intervalMs === undefined ? {} : { intervalMs }),
      ...(maxRuns === undefined ? {} : { maxRuns }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(parentRunId === undefined ? {} : { parentRunId }),
    }
  }
  if (command.type === "list_tasks") return { protocolVersion: SESSION_PROTOCOL_VERSION, type: "list_tasks" }
  if (command.type === "cancel_input") {
    const commandId = parseNonEmptyString(command.commandId, "cancel_input.commandId")
    const reason = command.reason === undefined ? undefined : parseNonEmptyString(command.reason, "cancel_input.reason")
    if (reason !== undefined && reason.length > 1_024) throw new Error("cancel_input.reason must not exceed 1024 characters")
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "cancel_input",
      commandId,
      inputId: parseNonEmptyString(command.inputId, "cancel_input.inputId"),
      ...(reason === undefined ? {} : { reason }),
    }
  }
  if (command.type === "cancel_task") {
    const reason = command.reason === undefined ? undefined : parseNonEmptyString(command.reason, "cancel_task.reason")
    if (reason && reason.length > 1_024) throw new Error("cancel_task.reason must not exceed 1024 characters")
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "cancel_task",
      taskId: parseTaskId(command.taskId),
      ...(reason === undefined ? {} : { reason }),
    }
  }
  if (command.type === "create_plan") {
    if (typeof command.commandId !== "string" || command.commandId.trim().length === 0) {
      throw new Error("create_plan.commandId is required")
    }
    if (typeof command.goal !== "string" || command.goal.trim().length === 0) {
      throw new Error("create_plan.goal is required")
    }
    const context = parseStringArray(command.context, "context")
    const workspace = command.workspace === undefined ? undefined : parseNonEmptyString(command.workspace, "workspace")
    const additionalDirectories = parseStringArray(command.additionalDirectories, "additionalDirectories")
    const trace = parseTrace(command.trace)
    return {
      type: "create_plan",
      protocolVersion: SESSION_PROTOCOL_VERSION,
      commandId: command.commandId,
      goal: command.goal,
      ...(context ? { context } : {}),
      ...(workspace ? { workspace } : {}),
      ...(additionalDirectories ? { additionalDirectories } : {}),
      ...(trace ? { trace } : {}),
    }
  }
  if (command.type === "start_run") {
    if (typeof command.commandId !== "string" || command.commandId.trim().length === 0) {
      throw new Error("start_run.commandId is required")
    }
    if (typeof command.goal !== "string" || command.goal.trim().length === 0) {
      throw new Error("start_run.goal is required")
    }
    const context = parseStringArray(command.context, "context")
    const fileReferences = parseFileReferences(command.fileReferences)
    const workspace = command.workspace === undefined ? undefined : parseNonEmptyString(command.workspace, "workspace")
    const additionalDirectories = parseStringArray(command.additionalDirectories, "additionalDirectories")
    const permissionMode = command.permissionMode === undefined ? undefined : parsePermissionMode(command.permissionMode, "permissionMode")
    // Bash rule-class rejection runs on the RAW array before
    // parsePermissionRules: its normalize step would throw the typed
    // replay error first and hide this per-face ingest message.
    if (Array.isArray(command.permissionRules)) {
      for (const [index, rule] of command.permissionRules.entries()) {
        if (
          typeof rule === "object" &&
          rule !== null &&
          typeof (rule as { name?: unknown }).name === "string" &&
          (rule as { name: string }).name.trim() === "bash" &&
          (rule as { behavior?: unknown }).behavior !== "deny"
        ) {
          throw new Error(`start_run.permissionRules[${index}]: only deny is a legal bash behavior`)
        }
      }
    }
    const permissionRules = command.permissionRules === undefined ? undefined : parsePermissionRules(command.permissionRules)
    if (permissionRules !== undefined) {
      // start_run seeds the durable policy set from the wire: new names are
      // bounded here. In-process callers (sub-agent spawn) construct the
      // typed input directly and bypass this decode, inheriting the parent's
      // canonical — possibly legacy-long — names faithfully.
      for (const rule of permissionRules) assertSessionPermissionRuleNameBound(rule.name)
    }
    const maxTurns = command.maxTurns === undefined ? undefined : parsePositiveInteger(command.maxTurns, "maxTurns")
    const trace = parseTrace(command.trace)
    return {
      type: "start_run",
      protocolVersion: SESSION_PROTOCOL_VERSION,
      commandId: command.commandId,
      goal: command.goal,
      ...(context ? { context } : {}),
      ...(fileReferences ? { fileReferences } : {}),
      ...(workspace ? { workspace } : {}),
      ...(additionalDirectories ? { additionalDirectories } : {}),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(permissionRules === undefined ? {} : { permissionRules }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(trace ? { trace } : {}),
    }
  }
  if (command.type === "execute_shell") {
    if (typeof command.commandId !== "string" || command.commandId.trim().length === 0) {
      throw new Error("execute_shell.commandId is required")
    }
    const argv = parseShellArgv(command.argv)
    const cwd = command.cwd === undefined ? undefined : parseNonEmptyString(command.cwd, "cwd")
    const timeoutMs = command.timeoutMs === undefined ? undefined : parsePositiveInteger(command.timeoutMs, "timeoutMs")
    return {
      type: "execute_shell",
      protocolVersion: SESSION_PROTOCOL_VERSION,
      commandId: command.commandId,
      argv,
      ...(cwd ? { cwd } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
  }
  if (command.type === "execute_user_shell") {
    if (typeof command.commandId !== "string" || command.commandId.trim().length === 0) {
      throw new Error("execute_user_shell.commandId is required")
    }
    const shellCommand = parseUserShellCommand(command.command)
    const cwd = command.cwd === undefined ? undefined : parseNonEmptyString(command.cwd, "cwd")
    const timeoutMs = command.timeoutMs === undefined ? undefined : parsePositiveInteger(command.timeoutMs, "timeoutMs")
    return {
      type: "execute_user_shell",
      protocolVersion: SESSION_PROTOCOL_VERSION,
      commandId: command.commandId,
      command: shellCommand,
      ...(cwd ? { cwd } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
  }
  if (command.type === "resolve_approval") {
    const runId = parseRunId(command.runId)
    const turn = parsePositiveInteger(command.turn, "turn")
    const toolUseId = parseNonEmptyString(command.toolUseId, "toolUseId")
    const preparedEventId = parseNonEmptyString(command.preparedEventId, "preparedEventId")
    const expectedScopeRevision = parseNonNegativeInteger(command.expectedScopeRevision, "expectedScopeRevision")
    const expectedPolicyRevision = parseNonNegativeInteger(command.expectedPolicyRevision, "expectedPolicyRevision")
    if (command.decision !== "approved" && command.decision !== "denied") {
      throw new Error("resolve_approval.decision is invalid")
    }
    return {
      type: "resolve_approval",
      protocolVersion: SESSION_PROTOCOL_VERSION,
      runId,
      turn,
      toolUseId,
      preparedEventId,
      expectedScopeRevision,
      expectedPolicyRevision,
      decision: command.decision,
    }
  }
  throw new Error(`unknown Session command: ${String(command.type)}`)
}

/** Parse a durable event received across a process or transport boundary. */
export function parseAgentEvent(value: unknown, expectedSessionId?: SessionId): AgentEvent {
  const candidate = asRecord(value, "Session event")
  const eventSessionId = parseSessionId(candidate.sessionId)
  if (expectedSessionId !== undefined && eventSessionId !== expectedSessionId) {
    throw new Error("Session event sessionId mismatch")
  }
  const eventId = parseNonEmptyString(candidate.eventId, "eventId")
  const revision = parsePositiveInteger(candidate.revision, "revision")
  const timestamp = parseNonEmptyString(candidate.timestamp, "timestamp")
  const trace = parseTrace(candidate.trace)
  if (trace === undefined) throw new Error("Session event.trace must be an object")
  const base = {
    eventId,
    sessionId: eventSessionId,
    revision,
    timestamp,
    trace,
  }

  switch (candidate.type) {
    case "SessionCreated": {
      const payload = asRecord(candidate.payload, "SessionCreated.payload")
      const additionalDirectories =
        payload.additionalDirectories === undefined
          ? undefined
          : parseStringArray(payload.additionalDirectories, "SessionCreated.additionalDirectories")
      return {
        ...base,
        type: "SessionCreated",
        payload: {
          workspaceRoot: parseNonEmptyString(payload.workspaceRoot, "workspaceRoot"),
          ...(payload.workspaceId === undefined
            ? {}
            : {
                workspaceId: parseNonEmptyString(payload.workspaceId, "workspaceId"),
              }),
          ...(additionalDirectories === undefined ? {} : { additionalDirectories }),
          ...(payload.scopeRevision === undefined
            ? {}
            : {
                scopeRevision: parseNonNegativeInteger(payload.scopeRevision, "scopeRevision"),
              }),
          ...(payload.scopeDigest === undefined ? {} : { scopeDigest: parseDigest(payload.scopeDigest, "scopeDigest") }),
          permissionMode: parsePermissionMode(payload.permissionMode, "permissionMode"),
          permissionRules: parsePermissionRules(payload.permissionRules),
          policyRevision: parseNonNegativeInteger(payload.policyRevision, "policyRevision"),
        },
      }
    }
    case "SessionTitleSet": {
      const payload = asRecord(candidate.payload, "SessionTitleSet.payload")
      return {
        ...base,
        type: "SessionTitleSet",
        payload: {
          commandId: parseNonEmptyString(payload.commandId, "SessionTitleSet.commandId"),
          ...(payload.title === undefined
            ? {}
            : {
                title: parseNonEmptyString(payload.title, "SessionTitleSet.title"),
              }),
        },
      }
    }
    case "SessionArchived": {
      const payload = asRecord(candidate.payload, "SessionArchived.payload")
      return {
        ...base,
        type: "SessionArchived",
        payload: {
          commandId: parseNonEmptyString(payload.commandId, "SessionArchived.commandId"),
          archivedAt: parseNonEmptyString(payload.archivedAt, "SessionArchived.archivedAt"),
        },
      }
    }
    case "CommandAccepted": {
      const payload = asRecord(candidate.payload, "CommandAccepted.payload")
      return {
        ...base,
        type: "CommandAccepted",
        payload: {
          commandId: parseNonEmptyString(payload.commandId, "CommandAccepted.commandId"),
          family: parseNonEmptyString(payload.family, "CommandAccepted.family"),
          inputFingerprint: asRecord(payload.inputFingerprint, "CommandAccepted.inputFingerprint"),
        },
      }
    }
    case "InputAccepted": {
      const payload = asRecord(candidate.payload, "InputAccepted.payload")
      const kind = payload.kind
      if (kind !== "message" && kind !== "steer" && kind !== "notification") throw new Error("InputAccepted.kind is invalid")
      const delivery = payload.delivery
      if (delivery !== "fifo" && delivery !== "safe-boundary") throw new Error("InputAccepted.delivery is invalid")
      const context = payload.context === undefined ? undefined : parseStringArray(payload.context, "InputAccepted.context")
      const fileReferences = parseFileReferences(payload.fileReferences)
      return {
        ...base,
        type: "InputAccepted",
        payload: {
          inputId: parseNonEmptyString(payload.inputId, "InputAccepted.inputId"),
          commandId: parseNonEmptyString(payload.commandId, "InputAccepted.commandId"),
          kind,
          text: parseNonEmptyString(payload.text, "InputAccepted.text"),
          delivery,
          ...(payload.targetRunId === undefined ? {} : { targetRunId: parseRunId(payload.targetRunId) }),
          ...(context === undefined ? {} : { context }),
          ...(fileReferences === undefined ? {} : { fileReferences }),
        },
      }
    }
    case "InputCancellationRequested": {
      const payload = asRecord(candidate.payload, "InputCancellationRequested.payload")
      return {
        ...base,
        type: "InputCancellationRequested",
        payload: {
          inputId: parseNonEmptyString(payload.inputId, "InputCancellationRequested.inputId"),
          commandId: parseNonEmptyString(payload.commandId, "InputCancellationRequested.commandId"),
          ...(payload.reason === undefined
            ? {}
            : {
                reason: parseNonEmptyString(payload.reason, "InputCancellationRequested.reason"),
              }),
        },
      }
    }
    case "InputConsumed": {
      const payload = asRecord(candidate.payload, "InputConsumed.payload")
      const kind = payload.kind
      if (kind !== "message" && kind !== "steer" && kind !== "notification") throw new Error("InputConsumed.kind is invalid")
      const delivery = payload.delivery
      if (delivery !== "fifo" && delivery !== "safe-boundary") throw new Error("InputConsumed.delivery is invalid")
      const boundary = payload.boundary
      if (boundary !== "model-request" && boundary !== "safe-boundary") throw new Error("InputConsumed.boundary is invalid")
      return {
        ...base,
        type: "InputConsumed",
        payload: {
          inputId: parseNonEmptyString(payload.inputId, "InputConsumed.inputId"),
          commandId: parseNonEmptyString(payload.commandId, "InputConsumed.commandId"),
          kind,
          text: parseNonEmptyString(payload.text, "InputConsumed.text"),
          delivery,
          runId: parseRunId(payload.runId),
          executionGeneration: parseNonNegativeInteger(payload.executionGeneration, "InputConsumed.executionGeneration"),
          boundary,
          parent: parseHistoryCursor(payload.parent, eventSessionId, "InputConsumed.parent"),
        },
      }
    }
    case "RunStopRequested":
    case "RunRetryRequested": {
      const payload = asRecord(candidate.payload, `${String(candidate.type)}.payload`)
      return {
        ...base,
        type: candidate.type,
        payload: {
          runId: parseRunId(payload.runId),
          commandId: parseNonEmptyString(payload.commandId, `${String(candidate.type)}.commandId`),
          ...(payload.reason === undefined
            ? {}
            : {
                reason: parseNonEmptyString(payload.reason, `${String(candidate.type)}.reason`),
              }),
        },
      } as AgentEvent
    }
    case "ModelAttemptStarted": {
      const payload = asRecord(candidate.payload, "ModelAttemptStarted.payload")
      return {
        ...base,
        type: "ModelAttemptStarted",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "ModelAttemptStarted.turn"),
          attemptId: parseNonEmptyString(payload.attemptId, "ModelAttemptStarted.attemptId"),
          executionGeneration: parseNonNegativeInteger(payload.executionGeneration, "ModelAttemptStarted.executionGeneration"),
          branchId: parseNonEmptyString(payload.branchId, "ModelAttemptStarted.branchId"),
          inputCursor: parseHistoryCursor(payload.inputCursor, eventSessionId, "ModelAttemptStarted.inputCursor"),
          requestFingerprint: parseNonEmptyString(payload.requestFingerprint, "ModelAttemptStarted.requestFingerprint"),
          ...(payload.request === undefined ? {} : { request: parseCanonicalModelRequest(payload.request) }),
          ...(payload.context === undefined ? {} : { context: parseContextProvenance(payload.context, "ModelAttemptStarted.context") }),
          boundPolicyRevision: parseNonNegativeInteger(payload.boundPolicyRevision, "ModelAttemptStarted.boundPolicyRevision"),
        },
      }
    }
    case "ModelAttemptAbandoned": {
      const payload = asRecord(candidate.payload, "ModelAttemptAbandoned.payload")
      return {
        ...base,
        type: "ModelAttemptAbandoned",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "ModelAttemptAbandoned.turn"),
          attemptId: parseNonEmptyString(payload.attemptId, "ModelAttemptAbandoned.attemptId"),
          executionGeneration: parseNonNegativeInteger(payload.executionGeneration, "ModelAttemptAbandoned.executionGeneration"),
          reason: parseNonEmptyString(payload.reason, "ModelAttemptAbandoned.reason"),
          recoveryCommandId: parseNonEmptyString(payload.recoveryCommandId, "ModelAttemptAbandoned.recoveryCommandId"),
        },
      }
    }
    case "ModelResponseCommitted": {
      const payload = asRecord(candidate.payload, "ModelResponseCommitted.payload")
      return {
        ...base,
        type: "ModelResponseCommitted",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "ModelResponseCommitted.turn"),
          attemptId: parseNonEmptyString(payload.attemptId, "ModelResponseCommitted.attemptId"),
          executionGeneration: parseNonNegativeInteger(payload.executionGeneration, "ModelResponseCommitted.executionGeneration"),
          branchId: parseNonEmptyString(payload.branchId, "ModelResponseCommitted.branchId"),
          inputCursor: parseHistoryCursor(payload.inputCursor, eventSessionId, "ModelResponseCommitted.inputCursor"),
          requestFingerprint: parseNonEmptyString(payload.requestFingerprint, "ModelResponseCommitted.requestFingerprint"),
          parent: parseHistoryCursor(payload.parent, eventSessionId, "ModelResponseCommitted.parent"),
          content: parseContentBlocks(payload.content, "ModelResponseCommitted.content"),
          ...(payload.stopReason === undefined
            ? {}
            : {
                stopReason: parseNonEmptyString(payload.stopReason, "ModelResponseCommitted.stopReason"),
              }),
          ...(payload.metadata === undefined ? {} : { metadata: parseModelProviderMetadata(payload.metadata) }),
          ...(payload.durationMs === undefined
            ? {}
            : {
                durationMs: parseNonNegativeNumber(payload.durationMs, "ModelResponseCommitted.durationMs"),
              }),
        },
      }
    }
    case "ToolAttemptStarted": {
      const payload = asRecord(candidate.payload, "ToolAttemptStarted.payload")
      return {
        ...base,
        type: "ToolAttemptStarted",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "ToolAttemptStarted.turn"),
          attemptId: parseNonEmptyString(payload.attemptId, "ToolAttemptStarted.attemptId"),
          toolUseId: parseNonEmptyString(payload.toolUseId, "ToolAttemptStarted.toolUseId"),
          executionGeneration: parseNonNegativeInteger(payload.executionGeneration, "ToolAttemptStarted.executionGeneration"),
          branchId: parseNonEmptyString(payload.branchId, "ToolAttemptStarted.branchId"),
          inputCursor: parseHistoryCursor(payload.inputCursor, eventSessionId, "ToolAttemptStarted.inputCursor"),
          requestFingerprint: parseNonEmptyString(payload.requestFingerprint, "ToolAttemptStarted.requestFingerprint"),
        },
      }
    }
    case "ToolAttemptAbandoned": {
      const payload = asRecord(candidate.payload, "ToolAttemptAbandoned.payload")
      return {
        ...base,
        type: "ToolAttemptAbandoned",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "ToolAttemptAbandoned.turn"),
          attemptId: parseNonEmptyString(payload.attemptId, "ToolAttemptAbandoned.attemptId"),
          toolUseId: parseNonEmptyString(payload.toolUseId, "ToolAttemptAbandoned.toolUseId"),
          executionGeneration: parseNonNegativeInteger(payload.executionGeneration, "ToolAttemptAbandoned.executionGeneration"),
          reason: parseNonEmptyString(payload.reason, "ToolAttemptAbandoned.reason"),
          recoveryCommandId: parseNonEmptyString(payload.recoveryCommandId, "ToolAttemptAbandoned.recoveryCommandId"),
        },
      }
    }
    case "ToolResultCommitted": {
      const payload = asRecord(candidate.payload, "ToolResultCommitted.payload")
      return {
        ...base,
        type: "ToolResultCommitted",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "ToolResultCommitted.turn"),
          attemptId: parseNonEmptyString(payload.attemptId, "ToolResultCommitted.attemptId"),
          toolUseId: parseNonEmptyString(payload.toolUseId, "ToolResultCommitted.toolUseId"),
          executionGeneration: parseNonNegativeInteger(payload.executionGeneration, "ToolResultCommitted.executionGeneration"),
          branchId: parseNonEmptyString(payload.branchId, "ToolResultCommitted.branchId"),
          requestFingerprint: parseNonEmptyString(payload.requestFingerprint, "ToolResultCommitted.requestFingerprint"),
          parent: parseHistoryCursor(payload.parent, eventSessionId, "ToolResultCommitted.parent"),
          result: parseToolResult(payload.result, "ToolResultCommitted.result"),
        },
      }
    }
    case "BranchCreated": {
      const payload = asRecord(candidate.payload, "BranchCreated.payload")
      return {
        ...base,
        type: "BranchCreated",
        payload: {
          commandId: parseNonEmptyString(payload.commandId, "BranchCreated.commandId"),
          branchId: parseNonEmptyString(payload.branchId, "BranchCreated.branchId"),
          parentBranchId: parseNonEmptyString(payload.parentBranchId, "BranchCreated.parentBranchId"),
          parentCursor: parseHistoryCursor(payload.parentCursor, eventSessionId, "BranchCreated.parentCursor"),
          head: parseHistoryCursor(payload.head, eventSessionId, "BranchCreated.head"),
        },
      }
    }
    case "HeadMoved": {
      const payload = asRecord(candidate.payload, "HeadMoved.payload")
      return {
        ...base,
        type: "HeadMoved",
        payload: {
          commandId: parseNonEmptyString(payload.commandId, "HeadMoved.commandId"),
          from: parseHistoryCursor(payload.from, eventSessionId, "HeadMoved.from"),
          to: parseHistoryCursor(payload.to, eventSessionId, "HeadMoved.to"),
          branchId: parseNonEmptyString(payload.branchId, "HeadMoved.branchId"),
          head: parseHistoryCursor(payload.head, eventSessionId, "HeadMoved.head"),
          executionGeneration: parseNonNegativeInteger(payload.executionGeneration, "HeadMoved.executionGeneration"),
        },
      }
    }
    case "ForkRequested":
    case "ForkCompleted":
    case "ForkRejected": {
      const payload = asRecord(candidate.payload, `${String(candidate.type)}.payload`)
      const sourceSessionId = parseSessionId(payload.sourceSessionId)
      const targetSessionId = parseSessionId(payload.targetSessionId)
      const sourceCursor = parseHistoryCursor(payload.sourceCursor, sourceSessionId, `${String(candidate.type)}.sourceCursor`)
      if (candidate.type === "ForkRequested") {
        return {
          ...base,
          type: "ForkRequested",
          payload: {
            commandId: parseNonEmptyString(payload.commandId, "ForkRequested.commandId"),
            sourceSessionId,
            sourceCursor,
            targetSessionId,
          },
        }
      }
      if (candidate.type === "ForkRejected") {
        return {
          ...base,
          type: "ForkRejected",
          payload: {
            commandId: parseNonEmptyString(payload.commandId, "ForkRejected.commandId"),
            sourceSessionId,
            sourceCursor,
            targetSessionId,
            reason: parseNonEmptyString(payload.reason, "ForkRejected.reason"),
          },
        }
      }
      const foreignLineageRef = parseForeignLineageRef(payload.foreignLineageRef)
      return {
        ...base,
        type: "ForkCompleted",
        payload: {
          commandId: parseNonEmptyString(payload.commandId, "ForkCompleted.commandId"),
          sourceSessionId,
          sourceCursor,
          targetSessionId,
          materializedPrefixDigest: parseDigest(payload.materializedPrefixDigest, "ForkCompleted.materializedPrefixDigest"),
          foreignLineageRef,
        },
      }
    }
    case "SessionAdditionalDirectoryAdded": {
      const payload = asRecord(candidate.payload, "SessionAdditionalDirectoryAdded.payload")
      return {
        ...base,
        type: "SessionAdditionalDirectoryAdded",
        payload: {
          commandId: parseNonEmptyString(payload.commandId, "SessionAdditionalDirectoryAdded.commandId"),
          requestedDirectory: parseNonEmptyString(payload.requestedDirectory, "SessionAdditionalDirectoryAdded.requestedDirectory"),
          directory: parseNonEmptyString(payload.directory, "directory"),
          ...(payload.additionalDirectories === undefined
            ? {}
            : {
                additionalDirectories: parseStringArray(payload.additionalDirectories, "additionalDirectories"),
              }),
          scopeRevision: parseNonNegativeInteger(payload.scopeRevision, "scopeRevision"),
          policyRevision: parsePositiveInteger(payload.policyRevision, "policyRevision"),
          scopeDigest: parseDigest(payload.scopeDigest, "scopeDigest"),
          changed: parseBoolean(payload.changed, "SessionAdditionalDirectoryAdded.changed"),
        },
      }
    }
    case "SessionPermissionModeSet": {
      const payload = asRecord(candidate.payload, "SessionPermissionModeSet.payload")
      return {
        ...base,
        type: "SessionPermissionModeSet",
        payload: {
          mode: parsePermissionMode(payload.mode, "mode"),
          policyRevision: parsePositiveInteger(payload.policyRevision, "policyRevision"),
        },
      }
    }
    case "SessionPermissionRulesSet": {
      const payload = asRecord(candidate.payload, "SessionPermissionRulesSet.payload")
      return {
        ...base,
        type: "SessionPermissionRulesSet",
        payload: {
          rules: parsePermissionRules(payload.rules),
          policyRevision: parsePositiveInteger(payload.policyRevision, "policyRevision"),
        },
      }
    }
    case "SessionCheckpointCreated": {
      const payload = asRecord(candidate.payload, "SessionCheckpointCreated.payload")
      const kind = payload.kind
      if (kind !== "prompt" && kind !== "manual") throw new Error("SessionCheckpointCreated.kind is invalid")
      return {
        ...base,
        type: "SessionCheckpointCreated",
        payload: {
          checkpointId: parseNonEmptyString(payload.checkpointId, "checkpointId"),
          kind,
          headRevision: parseNonNegativeInteger(payload.headRevision, "headRevision"),
          generation: parseNonNegativeInteger(payload.generation, "generation"),
          head: parseHistoryCursor(payload.head, eventSessionId, "SessionCheckpointCreated.head"),
        },
      }
    }
    case "PlanCreated":
      return {
        ...base,
        type: "PlanCreated",
        payload: parsePlan(candidate.payload, eventSessionId),
      }
    case "PlanGenerationFailed": {
      const payload = asRecord(candidate.payload, "PlanGenerationFailed.payload")
      return {
        ...base,
        type: "PlanGenerationFailed",
        payload: { message: parseNonEmptyString(payload.message, "message") },
      }
    }
    case "PlanGenerationCancelled": {
      const payload = asRecord(candidate.payload, "PlanGenerationCancelled.payload")
      return {
        ...base,
        type: "PlanGenerationCancelled",
        payload: {
          ...(payload.reason === undefined ? {} : { reason: parseNonEmptyString(payload.reason, "reason") }),
        },
      }
    }
    case "RunStarted": {
      const payload = asRecord(candidate.payload, "RunStarted.payload")
      return {
        ...base,
        type: "RunStarted",
        payload: {
          runId: parseRunId(payload.runId),
          commandId: parseNonEmptyString(payload.commandId, "commandId"),
          goal: parseNonEmptyString(payload.goal, "goal"),
          ...(payload.maxTurns === undefined ? {} : { maxTurns: parsePositiveInteger(payload.maxTurns, "maxTurns") }),
        },
      }
    }
    case "ContextCompacted": {
      const payload = asRecord(candidate.payload, "ContextCompacted.payload")
      if (!Array.isArray(payload.messages)) throw new Error("ContextCompacted.messages must be an array")
      const inputTokens = parseOptionalNonNegativeInteger(payload.inputTokens, "ContextCompacted.inputTokens")
      return {
        ...base,
        type: "ContextCompacted",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "ContextCompacted.turn"),
          compactId: parseNonEmptyString(payload.compactId, "ContextCompacted.compactId"),
          inputMessageCount: parseNonNegativeInteger(payload.inputMessageCount, "ContextCompacted.inputMessageCount"),
          outputMessageCount: parseNonNegativeInteger(payload.outputMessageCount, "ContextCompacted.outputMessageCount"),
          messages: payload.messages.map((message, index) => parseMessage(message, index, "ContextCompacted.messages")),
          ...(inputTokens === undefined ? {} : { inputTokens }),
        },
      }
    }
    case "SessionContextCompacted": {
      const payload = asRecord(candidate.payload, "SessionContextCompacted.payload")
      if (!Array.isArray(payload.messages)) throw new Error("SessionContextCompacted.messages must be an array")
      const inputTokens = parseOptionalNonNegativeInteger(payload.inputTokens, "SessionContextCompacted.inputTokens")
      return {
        ...base,
        type: "SessionContextCompacted",
        payload: {
          commandId: parseNonEmptyString(payload.commandId, "SessionContextCompacted.commandId"),
          ...(payload.instructions === undefined
            ? {}
            : {
                instructions: parseNonEmptyString(payload.instructions, "SessionContextCompacted.instructions"),
              }),
          changed: parseBoolean(payload.changed, "SessionContextCompacted.changed"),
          compactId: parseNonEmptyString(payload.compactId, "SessionContextCompacted.compactId"),
          inputMessageCount: parseNonNegativeInteger(payload.inputMessageCount, "SessionContextCompacted.inputMessageCount"),
          outputMessageCount: parseNonNegativeInteger(payload.outputMessageCount, "SessionContextCompacted.outputMessageCount"),
          messages: payload.messages.map((message, index) => parseMessage(message, index, "SessionContextCompacted.messages")),
          ...(inputTokens === undefined ? {} : { inputTokens }),
        },
      }
    }
    case "SessionContextWindowSet": {
      const payload = asRecord(candidate.payload, "SessionContextWindowSet.payload")
      return {
        ...base,
        type: "SessionContextWindowSet",
        payload: {
          contextWindow: parseContextWindow(payload.contextWindow, "SessionContextWindowSet.contextWindow"),
        },
      }
    }
    case "SessionContextWindowCleared":
      asRecord(candidate.payload, "SessionContextWindowCleared.payload")
      return { ...base, type: "SessionContextWindowCleared", payload: {} }
    case "SessionAgentSelected": {
      const payload = asRecord(candidate.payload, "SessionAgentSelected.payload")
      if (payload.agentName === undefined) return { ...base, type: "SessionAgentSelected", payload: {} }
      return {
        ...base,
        type: "SessionAgentSelected",
        payload: {
          agentName: parseNonEmptyString(payload.agentName, "SessionAgentSelected.agentName"),
        },
      }
    }
    case "SessionGoalUpdated":
      return {
        ...base,
        type: "SessionGoalUpdated",
        payload: parseSessionGoal(candidate.payload, "SessionGoalUpdated.payload"),
      }
    case "BackgroundTaskCreated": {
      const payload = asRecord(candidate.payload, "BackgroundTaskCreated.payload")
      return {
        ...base,
        type: "BackgroundTaskCreated",
        payload: { task: parseTaskSnapshot(payload.task) },
      }
    }
    case "BackgroundTaskStarted": {
      const payload = asRecord(candidate.payload, "BackgroundTaskStarted.payload")
      return {
        ...base,
        type: "BackgroundTaskStarted",
        payload: {
          taskId: parseTaskId(payload.taskId),
          runNumber: parsePositiveInteger(payload.runNumber, "BackgroundTaskStarted.runNumber"),
        },
      }
    }
    case "BackgroundTaskOutputAppended": {
      const payload = asRecord(candidate.payload, "BackgroundTaskOutputAppended.payload")
      const chunk = parseNonEmptyString(payload.chunk, "BackgroundTaskOutputAppended.chunk")
      if (chunk.length > MAX_TASK_OUTPUT_CHUNK) throw new Error("BackgroundTaskOutputAppended.chunk is too long")
      const totalBytes = parseNonNegativeInteger(payload.totalBytes, "BackgroundTaskOutputAppended.totalBytes")
      if (totalBytes > MAX_TASK_OUTPUT_BYTES) throw new Error("BackgroundTaskOutputAppended.totalBytes is too large")
      return {
        ...base,
        type: "BackgroundTaskOutputAppended",
        payload: {
          taskId: parseTaskId(payload.taskId),
          sequence: parsePositiveInteger(payload.sequence, "BackgroundTaskOutputAppended.sequence"),
          chunk,
          totalBytes,
        },
      }
    }
    case "BackgroundTaskCompleted": {
      const payload = asRecord(candidate.payload, "BackgroundTaskCompleted.payload")
      return {
        ...base,
        type: "BackgroundTaskCompleted",
        payload: {
          taskId: parseTaskId(payload.taskId),
          runNumber: parsePositiveInteger(payload.runNumber, "BackgroundTaskCompleted.runNumber"),
          ...(payload.nextRunAt === undefined
            ? {}
            : {
                nextRunAt: parseNonEmptyString(payload.nextRunAt, "BackgroundTaskCompleted.nextRunAt"),
              }),
        },
      }
    }
    case "BackgroundTaskFailed": {
      const payload = asRecord(candidate.payload, "BackgroundTaskFailed.payload")
      return {
        ...base,
        type: "BackgroundTaskFailed",
        payload: {
          taskId: parseTaskId(payload.taskId),
          message: parseNonEmptyString(payload.message, "BackgroundTaskFailed.message"),
        },
      }
    }
    case "BackgroundTaskCancelled": {
      const payload = asRecord(candidate.payload, "BackgroundTaskCancelled.payload")
      return {
        ...base,
        type: "BackgroundTaskCancelled",
        payload: {
          taskId: parseTaskId(payload.taskId),
          ...(payload.reason === undefined
            ? {}
            : {
                reason: parseNonEmptyString(payload.reason, "BackgroundTaskCancelled.reason"),
              }),
        },
      }
    }
    case "ModelRetryScheduled": {
      const payload = asRecord(candidate.payload, "ModelRetryScheduled.payload")
      return {
        ...base,
        type: "ModelRetryScheduled",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "ModelRetryScheduled.turn"),
          ...(payload.callId === undefined
            ? {}
            : {
                callId: parseNonEmptyString(payload.callId, "ModelRetryScheduled.callId"),
              }),
          attempt: parsePositiveInteger(payload.attempt, "ModelRetryScheduled.attempt"),
          nextAttempt: parsePositiveInteger(payload.nextAttempt, "ModelRetryScheduled.nextAttempt"),
          delayMs: parseNonNegativeNumber(payload.delayMs, "ModelRetryScheduled.delayMs"),
          category: parseNonEmptyString(payload.category, "ModelRetryScheduled.category"),
        },
      }
    }
    case "ToolCallRequested": {
      const payload = asRecord(candidate.payload, "ToolCallRequested.payload")
      return {
        ...base,
        type: "ToolCallRequested",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "turn"),
          toolUseId: parseNonEmptyString(payload.toolUseId, "toolUseId"),
          name: parseNonEmptyString(payload.name, "name"),
          input: payload.input,
        },
      }
    }
    case "ToolCallPrepared": {
      const payload = asRecord(candidate.payload, "ToolCallPrepared.payload")
      const status = payload.status
      if (status !== "ready" && status !== "invalid" && status !== "blocked" && status !== "denied" && status !== "reused") {
        throw new Error("ToolCallPrepared.status is invalid")
      }
      const decision = payload.decision
      if (decision !== undefined && decision !== "allow" && decision !== "ask" && decision !== "deny") {
        throw new Error("ToolCallPrepared.decision is invalid")
      }
      if (status === "ready" && decision === undefined) throw new Error("ToolCallPrepared.ready must include decision")
      if (status === "ready" && decision === "deny") throw new Error("ToolCallPrepared.ready must not use decision=deny")
      if ((status === "invalid" || status === "blocked" || status === "denied") && decision !== "deny") {
        throw new Error("ToolCallPrepared denied status must include decision=deny")
      }
      if (status === "reused" && decision !== undefined) throw new Error("ToolCallPrepared.reused must not include decision")
      // A fingerprint binds an executable model Bash preparation to the exact
      // command/cwd analysis. Terminal deny/block facts do not execute and do
      // not need one (for example an unknown Bash call when Bash is disabled).
      if (
        payload.name === "bash" &&
        payload.policyVersion !== "user-owned" &&
        status === "ready" &&
        typeof payload.approvalFingerprint !== "string"
      ) {
        throw new Error("model Bash ToolCallPrepared.ready must include approvalFingerprint")
      }
      if (
        payload.name === "bash" &&
        payload.policyVersion !== "user-owned" &&
        status === "ready" &&
        !isModelBashInput(payload.preparedInput)
      ) {
        throw new Error("model Bash ToolCallPrepared.ready must include the strict command input")
      }
      // Same display-channel class as the result denial: an unknown code or
      // shape degrades to no denial rather than rejecting the event.
      const denial = payload.denial === undefined ? undefined : parseResultDenial(payload.denial)
      // The security fact can only widen admission, so an unrecognized fact
      // degrades to absent instead of surviving to mint an allow on resume;
      // a recognized kind reconstructs with unknown sibling fields dropped,
      // same convention as the denial channel.
      const securityFact =
        payload.securityFact === undefined
          ? undefined
          : isPreparedSecurityFact(payload.securityFact)
            ? { kind: payload.securityFact.kind }
            : undefined
      return {
        ...base,
        type: "ToolCallPrepared",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "ToolCallPrepared.turn"),
          toolUseId: parseNonEmptyString(payload.toolUseId, "ToolCallPrepared.toolUseId"),
          name: parseNonEmptyString(payload.name, "ToolCallPrepared.name"),
          ...(payload.preparedInput === undefined ? {} : { preparedInput: payload.preparedInput }),
          status,
          ...(decision === undefined ? {} : { decision }),
          reasons: parseStringArray(payload.reasons, "ToolCallPrepared.reasons") ?? [],
          analyzerVersion: parseNonEmptyString(payload.analyzerVersion, "ToolCallPrepared.analyzerVersion"),
          policyVersion: parseNonEmptyString(payload.policyVersion, "ToolCallPrepared.policyVersion"),
          ...(payload.approvalFingerprint === undefined
            ? {}
            : {
                approvalFingerprint: parseNonEmptyString(payload.approvalFingerprint, "ToolCallPrepared.approvalFingerprint"),
              }),
          ...(payload.cwd === undefined
            ? {}
            : {
                cwd: parseNonEmptyString(payload.cwd, "ToolCallPrepared.cwd"),
              }),
          ...(payload.scopeRevision === undefined
            ? {}
            : {
                scopeRevision: parseNonNegativeInteger(payload.scopeRevision, "ToolCallPrepared.scopeRevision"),
              }),
          ...(payload.scopeDigest === undefined
            ? {}
            : {
                scopeDigest: parseDigest(payload.scopeDigest, "ToolCallPrepared.scopeDigest"),
              }),
          ...(payload.policyRevision === undefined
            ? {}
            : {
                policyRevision: parseNonNegativeInteger(payload.policyRevision, "ToolCallPrepared.policyRevision"),
              }),
          ...(denial === undefined ? {} : { denial }),
          ...(securityFact === undefined ? {} : { securityFact }),
        },
      }
    }
    case "ToolApprovalRequested": {
      const payload = asRecord(candidate.payload, "ToolApprovalRequested.payload")
      return {
        ...base,
        type: "ToolApprovalRequested",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "turn"),
          toolUseId: parseNonEmptyString(payload.toolUseId, "toolUseId"),
          name: parseNonEmptyString(payload.name, "name"),
          preparedEventId: parseNonEmptyString(payload.preparedEventId, "preparedEventId"),
          inputFingerprint: parseNonEmptyString(payload.inputFingerprint, "inputFingerprint"),
          ...(payload.ownedBy === undefined ? {} : { ownedBy: parseApprovalOwnedBy(payload.ownedBy) }),
          ...(payload.scopeRevision === undefined
            ? {}
            : {
                scopeRevision: parseNonNegativeInteger(payload.scopeRevision, "scopeRevision"),
              }),
          ...(payload.policyRevision === undefined
            ? {}
            : {
                policyRevision: parseNonNegativeInteger(payload.policyRevision, "policyRevision"),
              }),
        },
      }
    }
    case "ToolApprovalResolved": {
      const payload = asRecord(candidate.payload, "ToolApprovalResolved.payload")
      if (payload.decision !== "approved" && payload.decision !== "denied") {
        throw new Error("ToolApprovalResolved.decision is invalid")
      }
      const resolvedBy = payload.resolvedBy === undefined ? undefined : parseApprovalResolvedBy(payload.resolvedBy)
      // System outcomes only ever force denials; the wire never carries an
      // approved system resolution.
      if (resolvedBy === "system" && payload.decision !== "denied") {
        throw new Error("ToolApprovalResolved.resolvedBy system requires a denied decision")
      }
      const guardian = payload.guardian === undefined ? undefined : parseGuardianAttribution(payload.guardian, resolvedBy, payload.decision)
      if (resolvedBy === "guardian" && guardian === undefined) {
        throw new Error("ToolApprovalResolved.resolvedBy guardian requires the guardian block")
      }
      const supersededApproval =
        payload.supersededApproval === undefined
          ? undefined
          : parseSupersededApproval(payload.supersededApproval, resolvedBy, payload.decision)
      return {
        ...base,
        type: "ToolApprovalResolved",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "turn"),
          toolUseId: parseNonEmptyString(payload.toolUseId, "toolUseId"),
          preparedEventId: parseNonEmptyString(payload.preparedEventId, "preparedEventId"),
          decision: payload.decision,
          ...(resolvedBy === undefined ? {} : { resolvedBy }),
          ...(guardian === undefined ? {} : { guardian }),
          ...(supersededApproval === undefined ? {} : { supersededApproval }),
        },
      }
    }
    case "ToolCallExecutionStarted": {
      const payload = asRecord(candidate.payload, "ToolCallExecutionStarted.payload")
      const executionValue = payload.execution === undefined ? undefined : asRecord(payload.execution, "ToolCallExecutionStarted.execution")
      let execution: Extract<AgentEvent, { type: "ToolCallExecutionStarted" }>["payload"]["execution"]
      if (executionValue !== undefined) {
        if (executionValue.shell !== "/bin/bash") throw new Error("ToolCallExecutionStarted.execution.shell is invalid")
        if (executionValue.argvShape !== "bash-noprofile-norc-c") throw new Error("ToolCallExecutionStarted.execution.argvShape is invalid")
        execution = {
          shell: "/bin/bash",
          argvShape: "bash-noprofile-norc-c",
          cwd: parseNonEmptyString(executionValue.cwd, "ToolCallExecutionStarted.execution.cwd"),
        }
      }
      return {
        ...base,
        type: "ToolCallExecutionStarted",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "ToolCallExecutionStarted.turn"),
          toolUseId: parseNonEmptyString(payload.toolUseId, "ToolCallExecutionStarted.toolUseId"),
          name: parseNonEmptyString(payload.name, "ToolCallExecutionStarted.name"),
          dispatchId: parseNonEmptyString(payload.dispatchId, "ToolCallExecutionStarted.dispatchId"),
          requestFingerprint: parseNonEmptyString(payload.requestFingerprint, "ToolCallExecutionStarted.requestFingerprint"),
          replayPolicy: payload.replayPolicy === "retry-safe" ? "retry-safe" : "never",
          ...(payload.preparedEventId === undefined
            ? {}
            : {
                preparedEventId: parseNonEmptyString(payload.preparedEventId, "ToolCallExecutionStarted.preparedEventId"),
              }),
          ...(execution === undefined ? {} : { execution }),
        },
      }
    }
    case "RunCompleted": {
      const payload = asRecord(candidate.payload, "RunCompleted.payload")
      return {
        ...base,
        type: "RunCompleted",
        payload: {
          runId: parseRunId(payload.runId),
          turns: parseNonNegativeInteger(payload.turns, "turns"),
          finalText:
            typeof payload.finalText === "string"
              ? payload.finalText
              : (() => {
                  throw new Error("finalText must be a string")
                })(),
        },
      }
    }
    case "RunFailed": {
      const payload = asRecord(candidate.payload, "RunFailed.payload")
      if (payload.code !== undefined && payload.code !== "approval_required") {
        throw new Error("RunFailed.code must be 'approval_required'")
      }
      return {
        ...base,
        type: "RunFailed",
        payload: {
          runId: parseRunId(payload.runId),
          turns: parseNonNegativeInteger(payload.turns, "turns"),
          message: parseNonEmptyString(payload.message, "message"),
          ...(payload.code === undefined ? {} : { code: "approval_required" as const }),
        },
      }
    }
    case "RunCancelled": {
      const payload = asRecord(candidate.payload, "RunCancelled.payload")
      return {
        ...base,
        type: "RunCancelled",
        payload: {
          runId: parseRunId(payload.runId),
          turns: parseNonNegativeInteger(payload.turns, "turns"),
          ...(payload.reason === undefined ? {} : { reason: parseNonEmptyString(payload.reason, "reason") }),
        },
      }
    }
    default:
      throw new Error(`unknown Session event: ${String(candidate.type)}`)
  }
}

/** Validate an ephemeral live event received from a transient stream. */
export function parseTransientStreamEvent(value: unknown, expectedSessionId?: SessionId): TransientStreamEvent {
  const candidate = asRecord(value, "Transient stream event")
  const eventSessionId = parseSessionId(candidate.sessionId)
  if (expectedSessionId !== undefined && eventSessionId !== expectedSessionId) {
    throw new Error("Transient stream event sessionId mismatch")
  }
  const eventId = parseNonEmptyString(candidate.eventId, "eventId")
  const sequence = parsePositiveInteger(candidate.sequence, "sequence")
  const timestamp = parseNonEmptyString(candidate.timestamp, "timestamp")
  const trace = parseTrace(candidate.trace)
  if (trace === undefined) throw new Error("Transient stream event.trace must be an object")
  const payload = asRecord(candidate.payload, "Transient stream event.payload")
  const base = {
    eventId,
    sessionId: eventSessionId,
    sequence,
    timestamp,
    trace,
  }
  switch (candidate.type) {
    case "model_text_delta": {
      const value = parseModelStreamBase(payload)
      return {
        ...base,
        type: "model_text_delta",
        payload: { ...value, delta: parseString(payload.delta, "delta") },
      }
    }
    case "model_tool_call_start": {
      const value = parseModelStreamBase(payload)
      return {
        ...base,
        type: "model_tool_call_start",
        payload: {
          ...value,
          toolUseId: parseNonEmptyString(payload.toolUseId, "toolUseId"),
          name: parseNonEmptyString(payload.name, "name"),
        },
      }
    }
    case "model_tool_call_delta": {
      const value = parseModelStreamBase(payload)
      return {
        ...base,
        type: "model_tool_call_delta",
        payload: {
          ...value,
          toolUseId: parseNonEmptyString(payload.toolUseId, "toolUseId"),
          delta: parseString(payload.delta, "delta"),
        },
      }
    }
    case "model_tool_call_end": {
      const value = parseModelStreamBase(payload)
      return {
        ...base,
        type: "model_tool_call_end",
        payload: {
          ...value,
          toolUseId: parseNonEmptyString(payload.toolUseId, "toolUseId"),
          input: payload.input,
        },
      }
    }
    case "tool_output_delta": {
      return {
        ...base,
        type: "tool_output_delta",
        payload: {
          runId: parseRunId(payload.runId),
          turn: parsePositiveInteger(payload.turn, "turn"),
          toolUseId: parseNonEmptyString(payload.toolUseId, "toolUseId"),
          name: parseNonEmptyString(payload.name, "name"),
          stream: payload.stream === "stderr" ? "stderr" : payload.stream === "stdout" ? "stdout" : invalid("stream"),
          delta: parseString(payload.delta, "delta"),
        },
      }
    }
    case "child_agent_started": {
      return {
        ...base,
        type: "child_agent_started",
        payload: {
          childSessionId: parseNonEmptyString(payload.childSessionId, "childSessionId"),
          description: parseNonEmptyString(payload.description, "description"),
          ...(payload.subagentType === undefined ? {} : { subagentType: parseNonEmptyString(payload.subagentType, "subagentType") }),
          ...(payload.toolUseId === undefined ? {} : { toolUseId: parseNonEmptyString(payload.toolUseId, "toolUseId") }),
        },
      }
    }
    default:
      throw new Error(`Transient stream event.type is unsupported: ${String(candidate.type)}`)
  }
}

function parseModelStreamBase(payload: Record<string, unknown>): {
  runId: ReturnType<typeof runId>
  turn: number
  callId: string
  childSessionId?: string
} {
  return {
    runId: parseRunId(payload.runId),
    turn: parsePositiveInteger(payload.turn, "turn"),
    callId: parseNonEmptyString(payload.callId, "callId"),
    ...(payload.childSessionId === undefined ? {} : { childSessionId: parseNonEmptyString(payload.childSessionId, "childSessionId") }),
  }
}

function parseSessionGoal(value: unknown, name: string): SessionGoal {
  const candidate = asRecord(value, name)
  const status = candidate.status
  if (status !== "unset" && status !== "active" && status !== "paused") {
    throw new Error(`${name}.status is invalid`)
  }
  const text = candidate.text === undefined ? undefined : parseNonEmptyString(candidate.text, `${name}.text`)
  return normalizeSessionGoal({
    status,
    ...(text === undefined ? {} : { text }),
  })
}

function invalid(name: string): never {
  throw new Error(`${name} is invalid`)
}

/** Parse a result crossing the Session transport boundary. */
export function parseSessionCommandResult(value: unknown, expectedSessionId?: SessionId): SessionCommandResult {
  const candidate = asRecord(value, "Session command result")
  if (candidate.protocolVersion !== SESSION_PROTOCOL_VERSION) {
    throw new Error(`Session protocol version is unsupported: ${String(candidate.protocolVersion)}`)
  }
  switch (candidate.type) {
    case "plan_created": {
      const plan = parsePlan(candidate.plan, expectedSessionId)
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "plan_created",
        plan,
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    }
    case "run_result":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "run_result",
        result: parseRunResult(candidate.result),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "input_accepted":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "input_accepted",
        inputId: parseNonEmptyString(candidate.inputId, "input_accepted.inputId"),
        queued: parseBoolean(candidate.queued, "input_accepted.queued"),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "input_cancelled":
      if (
        candidate.status !== "cancelled" &&
        candidate.status !== "cancelled-before-acceptance" &&
        candidate.status !== "already-delivered"
      ) {
        throw new Error("input_cancelled.status is invalid")
      }
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "input_cancelled",
        inputId: parseNonEmptyString(candidate.inputId, "input_cancelled.inputId"),
        status: candidate.status,
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "shell_result":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "shell_result",
        runId: parseRunId(candidate.runId),
        result: parseToolResult(candidate.result, "shell_result.result"),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "compacted":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "compacted",
        changed: parseBoolean(candidate.changed, "compacted.changed"),
        inputMessageCount: parseNonNegativeInteger(candidate.inputMessageCount, "compacted.inputMessageCount"),
        outputMessageCount: parseNonNegativeInteger(candidate.outputMessageCount, "compacted.outputMessageCount"),
        ...(candidate.inputTokens === undefined
          ? {}
          : {
              inputTokens: parseNonNegativeInteger(candidate.inputTokens, "compacted.inputTokens"),
            }),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "context_window_updated":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "context_window_updated",
        changed: parseBoolean(candidate.changed, "context_window_updated.changed"),
        ...(candidate.contextWindowOverride === undefined
          ? {}
          : {
              contextWindowOverride: parseContextWindow(candidate.contextWindowOverride, "context_window_updated.contextWindowOverride"),
            }),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "goal_updated":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "goal_updated",
        changed: parseBoolean(candidate.changed, "goal_updated.changed"),
        goal: parseSessionGoal(candidate.goal, "goal_updated.goal"),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "agent_updated": {
      const agentName = candidate.agentName === undefined ? undefined : parseNonEmptyString(candidate.agentName, "agent_updated.agentName")
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "agent_updated",
        changed: parseBoolean(candidate.changed, "agent_updated.changed"),
        ...(agentName === undefined ? {} : { agentName }),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    }
    case "task_created":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "task_created",
        task: parseTaskSnapshot(candidate.task),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "additional_directory_added":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "additional_directory_added",
        changed: parseBoolean(candidate.changed, "additional_directory_added.changed"),
        directory: parseNonEmptyString(candidate.directory, "additional_directory_added.directory"),
        additionalDirectories: parseStringArray(candidate.additionalDirectories, "additional_directory_added.additionalDirectories") ?? [],
        scopeRevision: parseNonNegativeInteger(candidate.scopeRevision, "additional_directory_added.scopeRevision"),
        ...(candidate.scopeDigest === undefined
          ? {}
          : {
              scopeDigest: parseDigest(candidate.scopeDigest, "additional_directory_added.scopeDigest"),
            }),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "permission_updated":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "permission_updated",
        changed: parseBoolean(candidate.changed, "permission_updated.changed"),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "tasks": {
      if (!Array.isArray(candidate.tasks)) throw new Error("tasks.tasks must be an array")
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "tasks",
        tasks: parseTasks(candidate.tasks),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    }
    case "task_cancelled":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "task_cancelled",
        task: parseTaskSnapshot(candidate.task),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "checkpoints": {
      if (!Array.isArray(candidate.checkpoints)) throw new Error("checkpoints.checkpoints must be an array")
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "checkpoints",
        checkpoints: candidate.checkpoints.map((item, index) => parseSessionCheckpoint(item, `checkpoints[${index}]`)),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    }
    case "rewind_preview":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "rewind_preview",
        preview: parseRewindPreview(candidate.preview),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "rewind_result":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "rewind_result",
        result: parseRewindResult(candidate.result, expectedSessionId),
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "snapshot":
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "snapshot",
        snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
      }
    case "events": {
      const rawEvents = candidate.events
      if (!Array.isArray(rawEvents)) throw new Error("events must be an array")
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "events",
        events: rawEvents.map((event) => parseAgentEvent(event, expectedSessionId)),
      }
    }
    case "trace": {
      const records = candidate.records
      if (!Array.isArray(records)) throw new Error("trace.records must be an array")
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "trace",
        records: records.map((record) => parseTraceRecord(record, expectedSessionId)),
      }
    }
    case "model_calls": {
      const records = candidate.records
      if (!Array.isArray(records)) throw new Error("model_calls.records must be an array")
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "model_calls",
        records: records.map((record) => parseModelCallRecord(record, expectedSessionId)),
      }
    }
    default:
      throw new Error(`unknown Session command result: ${String(candidate.type)}`)
  }
}

export function parseSessionSnapshot(value: unknown, expectedSessionId?: SessionId): SessionSnapshot {
  const candidate = asRecord(value, "Session snapshot")
  const snapshotSessionId = parseSessionId(candidate.sessionId)
  if (expectedSessionId !== undefined && snapshotSessionId !== expectedSessionId) {
    throw new Error("Session snapshot sessionId mismatch")
  }
  const status = candidate.status
  if (!isSessionStatus(status)) throw new Error(`unknown Session status: ${String(status)}`)
  const plans = parsePlans(candidate.plans, snapshotSessionId)
  const currentPlan = candidate.currentPlan === undefined ? undefined : parsePlan(candidate.currentPlan, snapshotSessionId)
  const runs = candidate.runs === undefined ? undefined : parseRuns(candidate.runs)
  const currentRun = candidate.currentRun === undefined ? undefined : parseRunSnapshot(candidate.currentRun)
  const tasks = candidate.tasks === undefined ? undefined : parseTasks(candidate.tasks)
  const additionalDirectories =
    candidate.additionalDirectories === undefined ? [] : (parseStringArray(candidate.additionalDirectories, "additionalDirectories") ?? [])
  const currentTask = candidate.currentTask === undefined ? undefined : parseTaskSnapshot(candidate.currentTask)
  const contextWindowOverride =
    candidate.contextWindowOverride === undefined ? undefined : parseContextWindow(candidate.contextWindowOverride, "contextWindowOverride")
  const activeAgent = candidate.activeAgent === undefined ? undefined : parseNonEmptyString(candidate.activeAgent, "activeAgent")
  const goal = candidate.goal === undefined ? undefined : parseSessionGoal(candidate.goal, "goal")
  const timeline = candidate.timeline === undefined ? undefined : parseSessionTimeline(candidate.timeline)
  const inputs = parseSessionInputs(candidate.inputs)
  return {
    sessionId: snapshotSessionId,
    lastRevision: parseNonNegativeInteger(candidate.lastRevision, "lastRevision"),
    status,
    plans,
    ...(candidate.workspaceRoot === undefined
      ? {}
      : {
          workspaceRoot: parseNonEmptyString(candidate.workspaceRoot, "workspaceRoot"),
        }),
    additionalDirectories,
    scopeRevision: parseNonNegativeInteger(candidate.scopeRevision ?? 0, "scopeRevision"),
    ...(candidate.scopeDigest === undefined ? {} : { scopeDigest: parseDigest(candidate.scopeDigest, "scopeDigest") }),
    permissionMode: parsePermissionMode(candidate.permissionMode, "permissionMode"),
    permissionRules: parsePermissionRules(candidate.permissionRules),
    policyRevision: parseNonNegativeInteger(candidate.policyRevision, "policyRevision"),
    inputs,
    ...(candidate.lastUserGoal === undefined
      ? {}
      : {
          lastUserGoal: parseNonEmptyString(candidate.lastUserGoal, "lastUserGoal"),
        }),
    ...(contextWindowOverride === undefined ? {} : { contextWindowOverride }),
    ...(activeAgent === undefined ? {} : { activeAgent }),
    ...(goal === undefined ? {} : { goal }),
    ...(timeline === undefined ? {} : { timeline }),
    ...(currentPlan === undefined ? {} : { currentPlan }),
    ...(runs === undefined ? {} : { runs }),
    ...(currentRun === undefined ? {} : { currentRun }),
    ...(tasks === undefined ? {} : { tasks }),
    ...(currentTask === undefined ? {} : { currentTask }),
    ...(candidate.lastError === undefined ? {} : { lastError: parseNonEmptyString(candidate.lastError, "lastError") }),
  }
}

function parseSessionTimeline(value: unknown): SessionTimelineSnapshot {
  const candidate = asRecord(value, "Session snapshot timeline")
  if (!Array.isArray(candidate.checkpoints)) throw new Error("Session snapshot timeline.checkpoints must be an array")
  return {
    generation: parseNonNegativeInteger(candidate.generation, "timeline.generation"),
    headRevision: parseNonNegativeInteger(candidate.headRevision, "timeline.headRevision"),
    checkpoints: candidate.checkpoints.map((checkpoint, index) => parseSessionCheckpoint(checkpoint, `timeline.checkpoints[${index}]`)),
  }
}

function parseSessionCheckpoint(value: unknown, name: string): SessionCheckpoint {
  const item = asRecord(value, name)
  const kind = item.kind
  if (kind !== "prompt" && kind !== "manual") throw new Error(`${name}.kind is invalid`)
  return {
    checkpointId: parseNonEmptyString(item.checkpointId, `${name}.checkpointId`),
    kind,
    headRevision: parseNonNegativeInteger(item.headRevision, `${name}.headRevision`),
    generation: parseNonNegativeInteger(item.generation, `${name}.generation`),
    createdAt: parseNonEmptyString(item.createdAt, `${name}.createdAt`),
    head: parseHistoryCursor(item.head, undefined, `${name}.head`),
  }
}

function parseHistoryCursor(value: unknown, expectedSessionId: SessionId | undefined, name: string): HistoryCursor {
  const candidate = asRecord(value, name)
  const cursorSessionId = parseSessionId(candidate.sessionId)
  if (expectedSessionId !== undefined && cursorSessionId !== expectedSessionId) {
    throw new Error(`${name}.sessionId mismatch`)
  }
  return {
    sessionId: cursorSessionId,
    branchId: parseNonEmptyString(candidate.branchId, `${name}.branchId`),
    nodeId: parseNonEmptyString(candidate.nodeId, `${name}.nodeId`),
    physicalRevision: parseNonNegativeInteger(candidate.physicalRevision, `${name}.physicalRevision`),
    recordHash: parseNonEmptyString(candidate.recordHash, `${name}.recordHash`),
  }
}

function parseForeignLineageRef(value: unknown) {
  const candidate = asRecord(value, "foreignLineageRef")
  const sourceSessionId = parseSessionId(candidate.sourceSessionId)
  return {
    sourceSessionId,
    sourceCursor: parseHistoryCursor(candidate.sourceCursor, sourceSessionId, "foreignLineageRef.sourceCursor"),
    materializedPrefixDigest: parseDigest(candidate.materializedPrefixDigest, "foreignLineageRef.materializedPrefixDigest"),
  }
}

function parseSessionInputs(value: unknown): SessionSnapshot["inputs"] {
  if (!Array.isArray(value)) throw new Error("Session snapshot inputs must be an array")
  return value.map((item, index) => {
    const candidate = asRecord(item, `Session snapshot inputs[${index}]`)
    const kind = candidate.kind
    if (kind !== "message" && kind !== "steer" && kind !== "notification")
      throw new Error(`Session snapshot inputs[${index}].kind is invalid`)
    const delivery = candidate.delivery
    if (delivery !== undefined && delivery !== "fifo" && delivery !== "safe-boundary") {
      throw new Error(`Session snapshot inputs[${index}].delivery is invalid`)
    }
    const status = candidate.status
    if (status !== "pending" && status !== "cancelled" && status !== "cancelled-before-acceptance" && status !== "consumed") {
      throw new Error(`Session snapshot inputs[${index}].status is invalid`)
    }
    if (typeof candidate.active !== "boolean") throw new Error(`Session snapshot inputs[${index}].active must be a boolean`)
    const text = candidate.text === undefined ? undefined : parseString(candidate.text, `Session snapshot inputs[${index}].text`)
    const targetRunId = candidate.targetRunId === undefined ? undefined : parseRunId(candidate.targetRunId)
    return {
      inputId: parseNonEmptyString(candidate.inputId, `Session snapshot inputs[${index}].inputId`),
      commandId: parseNonEmptyString(candidate.commandId, `Session snapshot inputs[${index}].commandId`),
      kind,
      ...(text === undefined ? {} : { text }),
      ...(delivery === undefined ? {} : { delivery }),
      status,
      active: candidate.active,
      ...(targetRunId === undefined ? {} : { targetRunId }),
    }
  })
}

function parseRewindPreview(value: unknown): ProtocolRewindPreview {
  const candidate = asRecord(value, "rewind_preview.preview")
  return {
    checkpoint: parseSessionCheckpoint(candidate.checkpoint, "rewind_preview.checkpoint"),
    currentRevision: parseNonNegativeInteger(candidate.currentRevision, "rewind_preview.currentRevision"),
    currentGeneration: parseNonNegativeInteger(candidate.currentGeneration, "rewind_preview.currentGeneration"),
    staleRevision: parseBoolean(candidate.staleRevision, "rewind_preview.staleRevision"),
    canCommit: parseBoolean(candidate.canCommit, "rewind_preview.canCommit"),
  }
}

function parseRewindResult(value: unknown, expectedSessionId?: SessionId): ProtocolRewindSessionResult {
  const candidate = asRecord(value, "rewind_result.result")
  const status = candidate.status
  if (status !== "rewound" && status !== "already_rewound" && status !== "failed" && status !== "already_failed") {
    throw new Error("rewind_result.result.status is invalid")
  }
  const error = candidate.error === undefined ? undefined : parseNonEmptyString(candidate.error, "rewind_result.result.error")
  if ((status === "failed" || status === "already_failed") && error === undefined) {
    throw new Error("rewind_result.result.error is missing")
  }
  return {
    status,
    rewindId: parseNonEmptyString(candidate.rewindId, "rewind_result.result.rewindId"),
    ...(error === undefined ? {} : { error }),
    snapshot: parseSessionSnapshot(candidate.snapshot, expectedSessionId),
  } as ProtocolRewindSessionResult
}

export function parseSessionRecord(value: unknown): ProtocolSessionRecord {
  const candidate = asRecord(value, "Session record")
  const id = parseSessionId(candidate.sessionId)
  const archived = candidate.archived
  if (typeof archived !== "boolean") throw new Error("Session record.archived must be a boolean")
  return {
    sessionId: id,
    ...(candidate.workspaceId === undefined
      ? {}
      : {
          workspaceId: parseNonEmptyString(candidate.workspaceId, "Session record.workspaceId"),
        }),
    snapshot: parseSessionSnapshot(candidate.snapshot, id),
    createdAt: parseNonEmptyString(candidate.createdAt, "Session record.createdAt"),
    archived,
    ...(candidate.title === undefined
      ? {}
      : {
          title: parseNonEmptyString(candidate.title, "Session record.title"),
        }),
    ...(candidate.archivedAt === undefined
      ? {}
      : {
          archivedAt: parseNonEmptyString(candidate.archivedAt, "Session record.archivedAt"),
        }),
  }
}

function parsePlan(value: unknown, expectedSessionId?: SessionId): Plan {
  const candidate = asRecord(value, "Plan")
  const planSessionId = parseSessionId(candidate.sessionId)
  if (expectedSessionId !== undefined && planSessionId !== expectedSessionId) {
    throw new Error("Plan sessionId mismatch")
  }
  const steps = candidate.steps
  if (!Array.isArray(steps)) throw new Error("Plan.steps must be an array")
  return {
    id: parsePlanId(candidate.id),
    sessionId: planSessionId,
    revision: parsePositiveInteger(candidate.revision, "Plan.revision"),
    goal: parseNonEmptyString(candidate.goal, "Plan.goal"),
    summary: parseNonEmptyString(candidate.summary, "Plan.summary"),
    steps: steps.map((step, index) => parsePlanStep(step, index)),
    risks: parseStringArray(candidate.risks, "Plan.risks") ?? [],
    assumptions: parseStringArray(candidate.assumptions, "Plan.assumptions") ?? [],
    createdAt: parseNonEmptyString(candidate.createdAt, "Plan.createdAt"),
  }
}

function parseTraceRecord(value: unknown, expectedSessionId?: SessionId): TraceRecord {
  const candidate = asRecord(value, "Trace record")
  const recordSessionId = parseSessionId(candidate.sessionId)
  if (expectedSessionId !== undefined && recordSessionId !== expectedSessionId) {
    throw new Error("Trace record sessionId mismatch")
  }
  const phase = candidate.phase
  if (!isTracePhase(phase)) throw new Error(`Trace record phase is invalid: ${String(phase)}`)
  if (!isTraceName(candidate.name)) throw new Error(`Trace record name is invalid: ${String(candidate.name)}`)
  const durationMs = candidate.durationMs
  if (durationMs !== undefined && (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)) {
    throw new Error("Trace record durationMs is invalid")
  }
  const attributes = candidate.attributes
  if (attributes !== undefined) parseAttributes(attributes)
  const safeAttributes =
    attributes === undefined ? undefined : sanitizeTraceAttributes(attributes as Readonly<Record<string, string | number | boolean>>)
  return {
    name: candidate.name,
    phase,
    sessionId: recordSessionId,
    trace: parseRequiredTrace(candidate.trace),
    timestamp: parseNonEmptyString(candidate.timestamp, "Trace record.timestamp"),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(safeAttributes === undefined ? {} : { attributes: safeAttributes }),
  }
}

function parseContentBlocks(value: unknown, name: string): readonly ContentBlock[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value.map((block, index) => parseContentBlock(block, `${name}[${index}]`))
}

function parseCanonicalModelRequest(value: unknown): CanonicalModelRequest {
  const candidate = asRecord(value, "model request")
  if (!Array.isArray(candidate.messages)) throw new Error("model request.messages must be an array")
  if (!Array.isArray(candidate.tools)) throw new Error("model request.tools must be an array")
  const systemPrompt =
    candidate.systemPrompt === undefined ? undefined : [...(parseStringArray(candidate.systemPrompt, "model request.systemPrompt") ?? [])]
  const maxTokens = candidate.maxTokens
  if (maxTokens !== undefined && (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
    throw new Error("model request.maxTokens is invalid")
  }
  const context = candidate.context === undefined ? undefined : parseContextProvenance(candidate.context, "model request.context")
  return {
    messages: candidate.messages.map((message, index) => parseMessage(message, index)),
    tools: candidate.tools.map((tool, index) => parseApiToolDefinition(tool, index)),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(context === undefined ? {} : { context }),
  }
}

function parseContextProvenance(value: unknown, label: string): ContextProvenance {
  const candidate = asRecord(value, label)
  const promptValue = candidate.prompt
  const prompt = promptValue === undefined ? undefined : parsePromptAssemblyManifest(promptValue, label)
  const compactValue = candidate.compact
  let compact: ContextProvenance["compact"]
  if (compactValue !== undefined) {
    const compactCandidate = asRecord(compactValue, `${label}.compact`)
    const status = compactCandidate.status
    if (status !== "disabled" && status !== "not-needed" && status !== "applied") {
      throw new Error(`${label}.compact.status is invalid`)
    }
    const inputMessageCount = parseNonNegativeInteger(compactCandidate.inputMessageCount, `${label}.compact.inputMessageCount`)
    const outputMessageCount = parseNonNegativeInteger(compactCandidate.outputMessageCount, `${label}.compact.outputMessageCount`)
    const inputTokens = parseOptionalNonNegativeInteger(compactCandidate.inputTokens, `${label}.compact.inputTokens`)
    compact = {
      status,
      inputMessageCount,
      outputMessageCount,
      ...(inputTokens === undefined ? {} : { inputTokens }),
    }
  }
  return {
    requestContextCount: parseNonNegativeInteger(candidate.requestContextCount, `${label}.requestContextCount`),
    memoryNames: parseStringArray(candidate.memoryNames, `${label}.memoryNames`) ?? [],
    skillNames: parseStringArray(candidate.skillNames, `${label}.skillNames`) ?? [],
    ...(prompt === undefined ? {} : { prompt }),
    ...(compact === undefined ? {} : { compact }),
  }
}

function parsePromptAssemblyManifest(value: unknown, label: string): ContextProvenance["prompt"] {
  const candidate = asRecord(value, `${label}.prompt`)
  return {
    systemSectionIds: parseStringArray(candidate.systemSectionIds, `${label}.prompt.systemSectionIds`) ?? [],
    contextFragmentIds: parseStringArray(candidate.contextFragmentIds, `${label}.prompt.contextFragmentIds`) ?? [],
  }
}

function parseMessage(value: unknown, index: number, name = "model request.messages"): Message {
  const prefix = `${name}[${index}]`
  const candidate = asRecord(value, prefix)
  if (candidate.type !== "user" && candidate.type !== "assistant") {
    throw new Error(`${prefix}.type is invalid`)
  }
  const type = candidate.type as "user" | "assistant"
  const message = asRecord(candidate.message, `${prefix}.message`)
  if (message.role !== type) {
    throw new Error(`${prefix}.message.role is invalid`)
  }
  const content =
    typeof message.content === "string" ? message.content : [...parseContentBlocks(message.content, `${prefix}.message.content`)]
  if (type === "user") return { type, message: { role: type, content } }
  if (typeof content === "string") {
    throw new Error(`${prefix}.assistant content must be an array`)
  }
  return { type, message: { role: type, content } }
}

function parseApiToolDefinition(value: unknown, index: number) {
  const candidate = asRecord(value, `model request.tools[${index}]`)
  const schema = asRecord(candidate.input_schema, `model request.tools[${index}].input_schema`)
  if (schema.type !== "object") {
    throw new Error(`model request.tools[${index}].input_schema.type must be an object`)
  }
  return {
    name: parseNonEmptyString(candidate.name, `model request.tools[${index}].name`),
    description: parseNonEmptyString(candidate.description, `model request.tools[${index}].description`),
    input_schema: schema as import("@ag2cli/core/tool-facts.js").ToolInputSchema,
  }
}

/** Deliberately a literal mirror of ModelCallPurpose, not an enum-derived
 * face: codec vocabulary growth stays review-visible here. */
function parseModelCallPurpose(value: unknown): ModelCallPurpose {
  if (value === "plan" || value === "execution" || value === "compact" || value === "auxiliary") {
    return value
  }
  throw new Error(`Model call purpose is invalid: ${String(value)}`)
}

/** Authority field: "user" is the absent encoding, so an explicit value is a wire error. */
function parseApprovalOwnedBy(value: unknown): "guardian" {
  if (value === "guardian") return value
  throw new Error(`ToolApprovalRequested.ownedBy is invalid: ${String(value)}`)
}

/** Same authority convention: user resolutions are the absent encoding, never an explicit value. */
function parseApprovalResolvedBy(value: unknown): "guardian" | "system" {
  if (value === "guardian" || value === "system") return value
  throw new Error(`ToolApprovalResolved.resolvedBy is invalid: ${String(value)}`)
}

/** Deliberately a literal mirror of GUARDIAN_DENIAL_REASON_CODES, not an
 * enum-derived face: codec vocabulary growth stays review-visible here. */
function parseGuardianReasonCode(value: unknown): GuardianDenialReasonCode {
  if (
    value === "unsafe-action" ||
    value === "out-of-scope" ||
    value === "goal-mismatch" ||
    value === "insufficient-context" ||
    value === "review-unavailable"
  ) {
    return value
  }
  throw new Error(`Guardian denial reason code is invalid: ${String(value)}`)
}

/** Bounded identity text shared by guardian attribution and superseded approvals. */
function parseGuardianIdText(value: unknown, field: string): string {
  const guardianId = parseNonEmptyString(value, field)
  if (guardianId.length > MAX_GUARDIAN_ID_LENGTH) {
    throw new Error(`${field} exceeds ${MAX_GUARDIAN_ID_LENGTH} characters`)
  }
  return guardianId
}

/** Model-authored display text: bounded and free of unreadable control characters. */
function parseGuardianReasonText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`)
  if (value.length === 0) throw new Error(`${field} must not be empty`)
  if (value.length > MAX_GUARDIAN_REASON_LENGTH) {
    throw new Error(`${field} exceeds ${MAX_GUARDIAN_REASON_LENGTH} characters`)
  }
  for (const character of value) {
    if (character === "\t" || character === "\n" || character === "\r") continue
    const code = character.codePointAt(0)!
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      throw new Error(`${field} must not contain control characters`)
    }
  }
  return value
}

/** Guardian attribution block; legal only beside resolvedBy "guardian" (checked here). */
function parseGuardianAttribution(
  value: unknown,
  resolvedBy: "guardian" | "system" | undefined,
  decision: "approved" | "denied",
): { guardianId: string; reasonCode?: GuardianDenialReasonCode; reason?: string } {
  if (resolvedBy !== "guardian") {
    throw new Error("ToolApprovalResolved.guardian requires resolvedBy guardian")
  }
  const candidate = asRecord(value, "ToolApprovalResolved.guardian")
  const guardianId = parseGuardianIdText(candidate.guardianId, "ToolApprovalResolved.guardian.guardianId")
  const reasonCode = candidate.reasonCode === undefined ? undefined : parseGuardianReasonCode(candidate.reasonCode)
  if (reasonCode !== undefined && decision !== "denied") {
    throw new Error("ToolApprovalResolved.guardian.reasonCode requires a denied decision")
  }
  const reason =
    candidate.reason === undefined ? undefined : parseGuardianReasonText(candidate.reason, "ToolApprovalResolved.guardian.reason")
  return {
    guardianId,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(reason === undefined ? {} : { reason }),
  }
}

/** The superseded guardian approval; legal only beside a system denial. */
function parseSupersededApproval(
  value: unknown,
  resolvedBy: "guardian" | "system" | undefined,
  decision: "approved" | "denied",
): { guardianId: string; reason?: string } {
  if (resolvedBy !== "system" || decision !== "denied") {
    throw new Error("ToolApprovalResolved.supersededApproval requires a system denial")
  }
  const candidate = asRecord(value, "ToolApprovalResolved.supersededApproval")
  const guardianId = parseGuardianIdText(candidate.guardianId, "ToolApprovalResolved.supersededApproval.guardianId")
  const reason =
    candidate.reason === undefined ? undefined : parseGuardianReasonText(candidate.reason, "ToolApprovalResolved.supersededApproval.reason")
  return reason === undefined ? { guardianId } : { guardianId, reason }
}

function parseModelProviderMetadata(value: unknown): ModelProviderMetadata {
  const candidate = asRecord(value, "model metadata")
  if (candidate.protocol !== "anthropic" && candidate.protocol !== "openai") {
    throw new Error("model metadata.protocol is invalid")
  }
  const usage = candidate.usage === undefined ? undefined : parseModelUsage(candidate.usage)
  return {
    protocol: candidate.protocol,
    ...(candidate.model === undefined ? {} : { model: parseNonEmptyString(candidate.model, "model") }),
    ...(candidate.providerRequestId === undefined
      ? {}
      : {
          providerRequestId: parseNonEmptyString(candidate.providerRequestId, "providerRequestId"),
        }),
    ...(usage === undefined ? {} : { usage }),
  }
}

function parseModelUsage(value: unknown): ModelUsage {
  const candidate = asRecord(value, "model metadata.usage")
  const inputTokens = parseOptionalNonNegativeInteger(candidate.inputTokens, "inputTokens")
  const outputTokens = parseOptionalNonNegativeInteger(candidate.outputTokens, "outputTokens")
  const totalTokens = parseOptionalNonNegativeInteger(candidate.totalTokens, "totalTokens")
  const estimated = candidate.estimated === undefined ? undefined : parseBoolean(candidate.estimated, "estimated")
  const cachedInputTokens = parseOptionalNonNegativeInteger(candidate.cachedInputTokens, "cachedInputTokens")
  const cacheCreationInputTokens = parseOptionalNonNegativeInteger(candidate.cacheCreationInputTokens, "cacheCreationInputTokens")
  const reasoningTokens = parseOptionalNonNegativeInteger(candidate.reasoningTokens, "reasoningTokens")
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(estimated === undefined ? {} : { estimated }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

function parseModelCallError(value: unknown) {
  const candidate = asRecord(value, "Model call record.error")
  return {
    name: parseNonEmptyString(candidate.name, "Model call record.error.name"),
    message: parseNonEmptyString(candidate.message, "Model call record.error.message"),
  }
}

function parseModelCallRecord(value: unknown, expectedSessionId?: SessionId): ModelCallRecord {
  const candidate = asRecord(value, "Model call record")
  const recordSessionId = parseSessionId(candidate.sessionId)
  if (expectedSessionId !== undefined && recordSessionId !== expectedSessionId) {
    throw new Error("Model call record sessionId mismatch")
  }
  const status = candidate.status
  if (status !== "started" && status !== "succeeded" && status !== "failed" && status !== "cancelled") {
    throw new Error("Model call record.status is invalid")
  }
  const request = candidate.request === undefined ? undefined : parseCanonicalModelRequest(candidate.request)
  const context = candidate.context === undefined ? undefined : parseContextProvenance(candidate.context, "Model call record.context")
  const response = candidate.response === undefined ? undefined : parseModelCallRecordResponse(candidate.response)
  const runId = candidate.runId === undefined ? undefined : parseRunId(candidate.runId)
  const turn = candidate.turn === undefined ? undefined : parsePositiveInteger(candidate.turn, "turn")
  const durationMs = candidate.durationMs === undefined ? undefined : parseNonNegativeNumber(candidate.durationMs, "durationMs")
  const error = candidate.error === undefined ? undefined : parseModelCallError(candidate.error)
  const retries = candidate.retries === undefined ? undefined : parseModelRetrySummaries(candidate.retries)
  return {
    sessionId: recordSessionId,
    callId: parseNonEmptyString(candidate.callId, "callId"),
    purpose: parseModelCallPurpose(candidate.purpose),
    ...(runId === undefined ? {} : { runId }),
    ...(turn === undefined ? {} : { turn }),
    trace: parseRequiredTrace(candidate.trace),
    status,
    startedAt: parseNonEmptyString(candidate.startedAt, "startedAt"),
    ...(candidate.completedAt === undefined
      ? {}
      : {
          completedAt: parseNonEmptyString(candidate.completedAt, "completedAt"),
        }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(retries === undefined ? {} : { retries }),
    ...(request === undefined ? {} : { request }),
    ...(context === undefined ? {} : { context }),
    ...(response === undefined ? {} : { response }),
    ...(error === undefined ? {} : { error }),
  }
}

function parseModelRetrySummaries(value: unknown): readonly ModelRetrySummary[] {
  if (!Array.isArray(value)) throw new Error("Model call record.retries must be an array")
  return value.map((item, index) => {
    const candidate = asRecord(item, `Model call record.retries[${index}]`)
    return {
      attempt: parsePositiveInteger(candidate.attempt, `Model call record.retries[${index}].attempt`),
      nextAttempt: parsePositiveInteger(candidate.nextAttempt, `Model call record.retries[${index}].nextAttempt`),
      delayMs: parseNonNegativeNumber(candidate.delayMs, `Model call record.retries[${index}].delayMs`),
      category: parseNonEmptyString(candidate.category, `Model call record.retries[${index}].category`),
    }
  })
}

function parseModelCallRecordResponse(value: unknown) {
  const candidate = asRecord(value, "Model call record.response")
  const content = candidate.content === undefined ? undefined : parseContentBlocks(candidate.content, "Model call record.response.content")
  return {
    ...(content === undefined ? {} : { content }),
    ...(candidate.stopReason === undefined
      ? {}
      : {
          stopReason: parseNonEmptyString(candidate.stopReason, "stopReason"),
        }),
    ...(candidate.metadata === undefined ? {} : { metadata: parseModelProviderMetadata(candidate.metadata) }),
  }
}

function parseContentBlock(value: unknown, name: string): ContentBlock {
  const candidate = asRecord(value, name)
  switch (candidate.type) {
    case "text":
      if (typeof candidate.text !== "string") throw new Error(`${name}.text must be a string`)
      return { type: "text", text: candidate.text }
    case "thinking":
      if (typeof candidate.thinking !== "string") throw new Error(`${name}.thinking must be a string`)
      return { type: "thinking", thinking: candidate.thinking }
    case "tool_use":
      return {
        type: "tool_use",
        id: parseNonEmptyString(candidate.id, `${name}.id`),
        name: parseNonEmptyString(candidate.name, `${name}.name`),
        input: candidate.input,
      }
    case "tool_result":
      return { type: "tool_result", ...parseToolResultBlock(candidate, name) }
    default:
      throw new Error(`${name}.type is invalid`)
  }
}

function parseToolResult(value: unknown, name: string): ToolResult {
  const candidate = asRecord(value, name)
  if (typeof candidate.content !== "string") throw new Error(`${name}.content must be a string`)
  if (candidate.isError !== undefined && typeof candidate.isError !== "boolean") {
    throw new Error(`${name}.isError must be a boolean`)
  }
  const appliedPatch = candidate.appliedPatch === undefined ? undefined : parseAppliedPatch(candidate.appliedPatch, `${name}.appliedPatch`)
  return {
    content: candidate.content,
    ...(candidate.isError === undefined ? {} : { isError: candidate.isError }),
    ...(candidate.metadata === undefined
      ? {}
      : {
          metadata: parseStringRecord(candidate.metadata, `${name}.metadata`),
        }),
    // Display-channel field: parsed defensively; any shape anomaly (including
    // unrecognized line types) degrades to no patch — display data never blocks
    // canonical event reconstruction.
    ...(appliedPatch === undefined ? {} : { appliedPatch }),
    // Same display-channel class as appliedPatch: an unknown code or shape
    // degrades to no denial rather than rejecting the event.
    ...(candidate.denial === undefined ? {} : { denial: parseResultDenial(candidate.denial) }),
  }
}

/** Optional structured denial; any anomaly drops the field (event stays valid). */
function parseResultDenial(value: unknown): ToolResultDenial | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.code !== "string" || !(PERMISSION_DENIAL_CODES as readonly string[]).includes(candidate.code)) return undefined
  if (candidate.reason !== undefined && typeof candidate.reason !== "string") return undefined
  const code = candidate.code as PermissionDenialCode
  return candidate.reason === undefined ? { code } : { code, reason: candidate.reason }
}

/** Optional display patch; parse failure returns undefined (field dropped, event stays valid). */
function parseAppliedPatch(value: unknown, name: string): StructuredPatch | undefined {
  try {
    const candidate = asRecord(value, name)
    if (!Array.isArray(candidate.hunks)) throw new Error("hunks")
    const hunks = candidate.hunks.map((hunk, hunkIndex) => {
      const h = asRecord(hunk, `${name}.hunks[${hunkIndex}]`)
      if (!Array.isArray(h.lines)) throw new Error("lines")
      const lines = h.lines.map((line, lineIndex): PatchLine => {
        const l = asRecord(line, `${name}.hunks[${hunkIndex}].lines[${lineIndex}]`)
        if (l.kind !== "context" && l.kind !== "added" && l.kind !== "removed") throw new Error("kind")
        if (typeof l.text !== "string") throw new Error("text")
        return { kind: l.kind, text: l.text }
      })
      return {
        oldStart: parseNonNegativeInteger(h.oldStart, `${name}.hunks[${hunkIndex}].oldStart`),
        newStart: parseNonNegativeInteger(h.newStart, `${name}.hunks[${hunkIndex}].newStart`),
        oldLines: parseNonNegativeInteger(h.oldLines, `${name}.hunks[${hunkIndex}].oldLines`),
        newLines: parseNonNegativeInteger(h.newLines, `${name}.hunks[${hunkIndex}].newLines`),
        lines,
      }
    })
    const nonNegative = (key: string): number => parseNonNegativeInteger(candidate[key], `${name}.${key}`)
    if (candidate.truncated !== undefined && typeof candidate.truncated !== "boolean") throw new Error("truncated")
    return {
      hunks,
      addedLines: nonNegative("addedLines"),
      removedLines: nonNegative("removedLines"),
      sites: nonNegative("sites"),
      ...(candidate.truncated === undefined ? {} : { truncated: candidate.truncated }),
    }
  } catch {
    return undefined
  }
}

function parseToolResultBlock(value: unknown, name: string | number): { tool_use_id: string; content: string; is_error?: boolean } {
  const candidate = asRecord(value, typeof name === "number" ? `tool results[${name}]` : name)
  const prefix = typeof name === "number" ? `tool results[${name}]` : name
  if (candidate.type !== undefined && candidate.type !== "tool_result") throw new Error(`${prefix}.type is invalid`)
  if (candidate.tool_use_id === undefined) throw new Error(`${prefix}.tool_use_id must be a non-empty string`)
  if (typeof candidate.content !== "string") throw new Error(`${prefix}.content must be a string`)
  if (candidate.is_error !== undefined && typeof candidate.is_error !== "boolean") {
    throw new Error(`${prefix}.is_error must be a boolean`)
  }
  return {
    tool_use_id: parseNonEmptyString(candidate.tool_use_id, `${prefix}.tool_use_id`),
    content: candidate.content,
    ...(candidate.is_error === undefined ? {} : { is_error: candidate.is_error }),
  }
}

function parseRuns(value: unknown): readonly RunSnapshot[] {
  if (!Array.isArray(value)) throw new Error("Session snapshot runs must be an array")
  return value.map((run) => parseRunSnapshot(run))
}

function parseRunSnapshot(value: unknown): RunSnapshot {
  const candidate = asRecord(value, "Run snapshot")
  const status = candidate.status
  if (!isRunStatus(status)) throw new Error(`unknown Run status: ${String(status)}`)
  return {
    id: parseRunId(candidate.id),
    commandId: parseNonEmptyString(candidate.commandId, "Run.commandId"),
    status,
    turn: parseNonNegativeInteger(candidate.turn, "Run.turn"),
    startedAt: parseNonEmptyString(candidate.startedAt, "Run.startedAt"),
    ...(candidate.completedAt === undefined
      ? {}
      : {
          completedAt: parseNonEmptyString(candidate.completedAt, "Run.completedAt"),
        }),
    ...(candidate.finalText === undefined
      ? {}
      : {
          finalText:
            typeof candidate.finalText === "string"
              ? candidate.finalText
              : (() => {
                  throw new Error("Run.finalText must be a string")
                })(),
        }),
    ...(candidate.lastError === undefined
      ? {}
      : {
          lastError: parseNonEmptyString(candidate.lastError, "Run.lastError"),
        }),
  }
}

function parseRunResult(value: unknown): RunResult {
  const candidate = asRecord(value, "Run result")
  const status = candidate.status
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    throw new Error(`Run result.status is invalid: ${String(status)}`)
  }
  if (candidate.failureCode !== undefined && candidate.failureCode !== "approval_required") {
    throw new Error("Run result.failureCode must be 'approval_required'")
  }
  const result: RunResult = {
    runId: parseRunId(candidate.runId),
    status,
    turns: parseNonNegativeInteger(candidate.turns, "Run result.turns"),
    ...(candidate.finalText === undefined
      ? {}
      : {
          finalText:
            typeof candidate.finalText === "string"
              ? candidate.finalText
              : (() => {
                  throw new Error("Run result.finalText must be a string")
                })(),
        }),
    ...(candidate.error === undefined ? {} : { error: parseNonEmptyString(candidate.error, "Run result.error") }),
    ...(candidate.failureCode === undefined ? {} : { failureCode: "approval_required" as const }),
  }
  return result
}

function parseTasks(value: unknown): readonly TaskSnapshot[] {
  if (!Array.isArray(value)) throw new Error("Session snapshot tasks must be an array")
  return value.map((task) => parseTaskSnapshot(task))
}

function parseTaskSnapshot(value: unknown): TaskSnapshot {
  const candidate = asRecord(value, "Task snapshot")
  const status = candidate.status
  if (!isTaskStatus(status)) throw new Error(`unknown Task status: ${String(status)}`)
  const type = candidate.type
  if (!isTaskType(type)) throw new Error(`unknown Task type: ${String(type)}`)
  const argv = candidate.argv === undefined ? undefined : parseStringArray(candidate.argv, "Task.argv")
  const intervalMs = candidate.intervalMs === undefined ? undefined : parsePositiveInteger(candidate.intervalMs, "Task.intervalMs")
  const maxRuns = candidate.maxRuns === undefined ? undefined : parsePositiveInteger(candidate.maxRuns, "Task.maxRuns")
  const outputBytes = parseNonNegativeInteger(candidate.outputBytes, "Task.outputBytes")
  if (outputBytes > MAX_TASK_OUTPUT_BYTES) throw new Error("Task.outputBytes is too large")
  const task: TaskSnapshot = {
    id: parseTaskId(candidate.id),
    type,
    title: parseNonEmptyString(candidate.title, "Task.title"),
    status,
    createdAt: parseNonEmptyString(candidate.createdAt, "Task.createdAt"),
    runCount: parseNonNegativeInteger(candidate.runCount, "Task.runCount"),
    outputBytes,
    ...(candidate.prompt === undefined ? {} : { prompt: parseNonEmptyString(candidate.prompt, "Task.prompt") }),
    ...(argv === undefined ? {} : { argv }),
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(maxRuns === undefined ? {} : { maxRuns }),
    ...(candidate.startedAt === undefined
      ? {}
      : {
          startedAt: parseNonEmptyString(candidate.startedAt, "Task.startedAt"),
        }),
    ...(candidate.completedAt === undefined
      ? {}
      : {
          completedAt: parseNonEmptyString(candidate.completedAt, "Task.completedAt"),
        }),
    ...(candidate.nextRunAt === undefined
      ? {}
      : {
          nextRunAt: parseNonEmptyString(candidate.nextRunAt, "Task.nextRunAt"),
        }),
    ...(candidate.lastOutput === undefined ? {} : { lastOutput: parseString(candidate.lastOutput, "Task.lastOutput") }),
    ...(candidate.lastError === undefined
      ? {}
      : {
          lastError: parseNonEmptyString(candidate.lastError, "Task.lastError"),
        }),
    ...(candidate.parentRunId === undefined ? {} : { parentRunId: parseRunId(candidate.parentRunId) }),
  }
  if (task.lastOutput && task.lastOutput.length > 8_192) throw new Error("Task.lastOutput is too long")
  return task
}

function parseRequiredTrace(value: unknown): NonNullable<EventTrace> {
  const trace = parseTrace(value)
  if (trace === undefined) throw new Error("Trace record.trace must be an object")
  return trace
}

function parseAttributes(value: unknown): void {
  const attributes = asRecord(value, "Trace record.attributes")
  for (const [key, item] of Object.entries(attributes)) {
    if (!["string", "number", "boolean"].includes(typeof item)) {
      throw new Error(`Trace record.attributes.${key} has an invalid type`)
    }
  }
}

function isTracePhase(value: unknown): value is TracePhase {
  return value === "started" || value === "succeeded" || value === "failed" || value === "cancelled"
}

function parsePlans(value: unknown, expectedSessionId: SessionId): readonly Plan[] {
  if (!Array.isArray(value)) throw new Error("Session snapshot plans must be an array")
  return value.map((plan) => parsePlan(plan, expectedSessionId))
}

function parsePlanStep(value: unknown, index: number) {
  const candidate = asRecord(value, `Plan.steps[${index}]`)
  const status = candidate.status
  if (status !== "pending" && status !== "blocked" && status !== "ready") {
    throw new Error(`Plan.steps[${index}].status is invalid`)
  }
  return {
    id: parseNonEmptyString(candidate.id, `Plan.steps[${index}].id`),
    order: parsePositiveInteger(candidate.order, `Plan.steps[${index}].order`),
    title: parseNonEmptyString(candidate.title, `Plan.steps[${index}].title`),
    description: parseNonEmptyString(candidate.description, `Plan.steps[${index}].description`),
    dependencies: parseStringArray(candidate.dependencies, `Plan.steps[${index}].dependencies`) ?? [],
    status: status as PlanStepStatus,
  }
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return (
    value === "created" ||
    value === "planning" ||
    value === "plan_ready" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  )
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "cancelled"
}

function isTaskStatus(value: unknown): value is BackgroundTaskStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "cancelled"
}

function isTaskType(value: unknown): value is BackgroundTaskType {
  return value === "agent" || value === "shell" || value === "loop"
}

function parsePermissionMode(value: unknown, name: string): SessionPermissionMode {
  if (!SESSION_PERMISSION_MODES.includes(value as SessionPermissionMode)) throw new Error(`${name} is invalid`)
  return value as SessionPermissionMode
}

function parsePermissionRules(value: unknown): readonly {
  readonly name: string
  readonly behavior: "allow" | "ask" | "deny"
}[] {
  if (!Array.isArray(value)) throw new Error("permissionRules must be an array")
  return normalizeSessionPermissionRules(
    value.map((item, index) => {
      const candidate = asRecord(item, `permissionRules[${index}]`)
      const behavior = candidate.behavior
      if (!SESSION_PERMISSION_RULE_BEHAVIORS.includes(behavior as never)) throw new Error(`permissionRules[${index}].behavior is invalid`)
      return {
        name: parseNonEmptyString(candidate.name, `permissionRules[${index}].name`),
        behavior: behavior as "allow" | "ask" | "deny",
      }
    }),
  )
}

function parseDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} is invalid`)
  return value
}
