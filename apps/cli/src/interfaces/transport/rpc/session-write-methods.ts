import { randomUUID } from "node:crypto"
import { interactionLeaseScopeForIntent, parseInputIntent } from "@ag2cli/app-server-protocol/input-intent.js"
import {
  isAppServerPermissionMode,
  isPermissionRuleBehavior,
  type AppServerScope,
  type InteractionLeaseScope,
  type JsonValue,
  type SessionCommandParams,
  type SessionSubmitParams,
} from "@ag2cli/app-server-protocol/types.js"
import {
  asRecord,
  parseNonEmptyString,
  parseSessionArchiveParams,
  parseSessionCommandParams,
  parseSessionCreateParams,
  parseSessionDeleteParams,
  parseSessionForkParams,
  parseSessionPlanParams,
  parseSessionResolveApprovalParams,
  parseSessionSubmitParams,
} from "@ag2cli/app-server-protocol/validation.js"
import { runId, sessionId, taskId, type SessionId } from "@ag2cli/core/ids.js"
import type { HistoryCursor } from "@ag2cli/core/events/event.js"
import { CommandIdempotencyConflictError } from "@ag2cli/runtime/application/session/command-idempotency.js"
import { SessionExecutionReservationConflictError } from "@ag2cli/runtime/ports/session-execution-reservation.js"
import { SessionPolicyRevisionConflictError } from "@ag2cli/runtime/application/session/permission-state.js"
import { SessionRevisionConflictError } from "@ag2cli/runtime/application/session/revision-conflict.js"
import { SessionWriterConflictError } from "@ag2cli/runtime/application/session/session-authority.js"
import { ApprovalResolutionError } from "@ag2cli/runtime/application/session/approval-resolution.js"
import type { SessionCommand, SessionCommandResult } from "@ag2cli/protocol/session-command.js"
import { appServerOperationKey, type AppServerOperation } from "../app-server-operation-registry.js"
import {
  addAdditionalDirectoryCommand,
  cancelTaskCommand,
  clearContextWindowCommand,
  compactSessionCommand,
  createPlanCommand,
  createTaskCommand,
  executeShellCommand,
  executeUserShellCommand,
  listCheckpointsCommand,
  listTasksCommand,
  previewRewindCommand,
  resolveApprovalCommand,
  rewindCommand,
  setAgentCommand,
  setContextWindowCommand,
  setPermissionModeCommand,
  setPermissionRulesCommand,
  startRunCommand,
  steerCommand,
  cancelInputCommand,
  updateGoalCommand,
} from "@ag2cli/protocol/session-command.js"
import { RpcApplicationError, toJson, type MethodContext } from "./method-context.js"

/**
 * Commands a remote client may never run while the session snapshot holds
 * full-access (ADR §3): model runs, broker-bypassing model calls, shell
 * execution, live policy mutation, and history restore.
 */
const FULL_ACCESS_OPERATION_COMMANDS: ReadonlySet<SessionCommand["type"]> = new Set([
  "start_run",
  "create_plan",
  "steer",
  "create_task",
  "compact",
  "execute_shell",
  "execute_user_shell",
  "set_permission_rules",
  "rewind",
])

export class SessionWriteMethods {
  constructor(private readonly context: MethodContext) {}

  async createSession(value: unknown): Promise<import("@ag2cli/runtime/ports/session-catalog.js").SessionRecord> {
    this.context.requireScope("session:write")
    const catalog = this.context.requireCatalog()
    const params = parseSessionCreateParams(value)
    const id = sessionId(params.sessionId ?? randomUUID())
    if (this.context.workspaceRegistry !== undefined) {
      const workspace = await this.context.workspaceRegistry.get(params.workspaceId)
      if (workspace === undefined)
        throw new RpcApplicationError("workspace_access_denied", `workspaceId is not authorized: ${params.workspaceId}`)
      return catalog.create(id, workspace.workspaceRoot, {
        ...(params.title === undefined ? {} : { title: params.title }),
        workspaceId: workspace.workspaceId,
      })
    }
    const workspaceRoot = this.context.workspaceRoot
    if (workspaceRoot === undefined)
      throw new RpcApplicationError("workspace_access_denied", "No available workspace is registered on this server")
    const workspaceId = params.workspaceId
    if (workspaceId !== this.context.workspaceIdForRoot(workspaceRoot)) {
      throw new RpcApplicationError("workspace_access_denied", `workspaceId is not authorized: ${workspaceId}`)
    }
    return catalog.create(id, workspaceRoot, {
      ...(params.title === undefined ? {} : { title: params.title }),
      workspaceId,
    })
  }

  /**
   * `session.fork`/`session.archive`/`session.delete` reorder or change a
   * Session's own existence and therefore always require the
   * `session-control` interaction lease, unlike the `session.command`
   * actions whose required scope varies per action.
   */
  async forkSession(value: unknown): Promise<import("@ag2cli/runtime/ports/session-catalog.js").SessionRecord> {
    this.context.requireScope("session:write")
    this.requireClientAction("fork")
    const catalog = this.context.requireCatalog()
    const params = parseSessionForkParams(value)
    const source = sessionId(params.sourceSessionId)
    const target = sessionId(params.targetSessionId ?? randomUUID())
    const access = this.context.assertWriteAccess(source, "session-control", params.lease?.generation)
    try {
      if (params.cursor === undefined) return await catalog.fork(source, target, params.title)
      const cursor: HistoryCursor = {
        sessionId: sessionId(params.cursor.sessionId),
        branchId: params.cursor.branchId,
        nodeId: params.cursor.nodeId,
        physicalRevision: params.cursor.physicalRevision,
        recordHash: params.cursor.recordHash,
      }
      return await catalog.forkAtCursor(source, target, cursor, params.title)
    } finally {
      this.context.releaseWriteAccess(source, access)
    }
  }

  async archiveSession(value: unknown): Promise<import("@ag2cli/runtime/ports/session-catalog.js").SessionRecord> {
    this.context.requireScope("session:write")
    const catalog = this.context.requireCatalog()
    const params = parseSessionArchiveParams(value)
    const id = sessionId(params.sessionId)
    const access = this.context.assertWriteAccess(id, "session-control", params.lease?.generation)
    try {
      return await catalog.archive(id)
    } finally {
      this.context.releaseWriteAccess(id, access)
    }
  }

  async deleteSession(value: unknown): Promise<JsonValue> {
    this.context.requireScope("session:write")
    this.requireClientAction("delete")
    const catalog = this.context.requireCatalog()
    const params = parseSessionDeleteParams(value)
    const id = sessionId(params.sessionId)
    const access = this.context.assertWriteAccess(id, "session-control", params.lease?.generation)
    try {
      await catalog.delete(id)
      return { sessionId: id, deleted: true }
    } finally {
      this.context.releaseWriteAccess(id, access)
    }
  }

  async command(value: unknown): Promise<JsonValue> {
    const params = parseSessionCommandParams(value)
    this.requireClientAction(params.action.type)
    this.context.requireScope(requiredRpcScopeFor(params.action.type))
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    if (params.expectedRevision !== undefined) await this.context.requireRevision(id, params.expectedRevision)
    const command = commandForAction(params)
    await this.denyFullAccessOperation(id, command)
    const interactionScope = requiredInteractionScopeFor(params.action.type)
    if (params.lease !== undefined && interactionScope !== "none" && params.lease.scope !== interactionScope) {
      throw new RpcApplicationError(
        "interaction_lease_scope_mismatch",
        `Action ${params.action.type} requires a lease with the ${interactionScope} scope; received ${params.lease.scope}`,
      )
    }
    const access = this.context.assertWriteAccess(id, interactionScope, params.lease?.generation)
    const operationKey = appServerOperationKey(id.toString(), params.commandId)
    let operation: AppServerOperation
    try {
      operation = this.context.operationRegistry.begin(operationKey)
    } catch {
      throw new RpcApplicationError("command_in_progress", `commandId is already running: ${params.commandId}`)
    }
    try {
      const result = await this.context.sessionServer.execute(id, command, { signal: operation.signal })
      return commandResult(id, params.commandId, result)
    } finally {
      operation.release()
      this.context.releaseWriteAccess(id, access)
    }
  }

  async submit(value: unknown): Promise<JsonValue> {
    const params = parseSessionSubmitParams(value)
    const intent = parseInputIntent(params.text)
    this.requireClientAction(intent.kind === "shell" ? "shell" : "prompt")
    this.context.requireScope(intent.kind === "shell" ? "shell:execute" : "session:write")
    const id = sessionId(params.sessionId)
    if (this.context.catalog) await this.context.requireExistingSession(id)
    if (params.expectedRevision !== undefined) {
      const snapshot = await this.context.readSnapshot(id)
      if (snapshot.lastRevision !== params.expectedRevision) {
        throw new RpcApplicationError(
          "revision_conflict",
          `Session revision changed: expected ${params.expectedRevision}, got ${snapshot.lastRevision}`,
        )
      }
    }
    const command = await this.commandForIntent(id, params.commandId, intent, params)
    // A slash intent is parsed into the canonical session command before the
    // capability check. Checking only the outer `prompt` intent would let a
    // mobile client tunnel rewind/permission/shell actions through submit.
    this.requireClientAction(command.type)
    // The same produced-command rule covers full-access snapshots: a slash
    // intent must not tunnel a guarded command past the action route.
    await this.denyFullAccessOperation(id, command)
    const interactionScope = requiredInteractionScopeForIntent(intent)
    const access = this.context.assertWriteAccess(id, interactionScope, params.lease?.[interactionScope])
    const operationKey = appServerOperationKey(id.toString(), params.commandId)
    let operation: AppServerOperation
    try {
      operation = this.context.operationRegistry.begin(operationKey)
    } catch {
      throw new RpcApplicationError("command_in_progress", `commandId is already running: ${params.commandId}`)
    }
    let backgroundOwnership = false
    try {
      const intentKind = intent.kind
      if (intent.kind === "prompt" || intent.kind === "mention") {
        const admission = await this.context.sessionServer.execute(id, command, {
          signal: operation.signal,
          acceptOnly: true,
        })
        if (admission.type !== "input_accepted") {
          throw new RpcApplicationError("invalid_host_result", "Host did not return input_accepted")
        }
        this.context.releaseWriteAccess(id, access)
        backgroundOwnership = true
        if (!admission.queued) {
          void this.runInBackground(id, params.commandId, intent.kind, command, operation)
        } else {
          operation.release()
        }
        return {
          accepted: true,
          sessionId: id,
          commandId: params.commandId,
          intent: intent.kind,
          inputId: admission.inputId,
        }
      }
      if (isAsyncIntent(intent)) {
        this.context.releaseWriteAccess(id, access)
        backgroundOwnership = true
        void this.runInBackground(id, params.commandId, intent.kind, command, operation)
        return {
          accepted: true,
          sessionId: id,
          commandId: params.commandId,
          intent: intent.kind,
        }
      }
      const result = await this.context.sessionServer.execute(id, command, { signal: operation.signal })
      if (intent.kind === "slash") {
        return toJson({
          ...asRecord(commandResult(id, params.commandId, result), "session.submit.result"),
          intent: "slash",
        })
      }
      return {
        accepted: true,
        sessionId: id,
        commandId: params.commandId,
        intent: intentKind,
        ...(resultWithRunId(result) ? { runId: result.runId.toString() } : {}),
        ...(resultWithResult(result) ? { result: toJson(result.result) } : {}),
        ...(resultWithSnapshot(result) ? { snapshot: toJson(result.snapshot) } : {}),
      }
    } finally {
      if (!backgroundOwnership) {
        operation.release()
        this.context.releaseWriteAccess(id, access)
      }
    }
  }

  async plan(value: unknown): Promise<JsonValue> {
    this.requireClientAction("plan")
    const params = parseSessionPlanParams(value)
    this.context.requireScope("session:write")
    const id = sessionId(params.sessionId)
    if (this.context.catalog) await this.context.requireExistingSession(id)
    if (params.expectedRevision !== undefined) await this.context.requireRevision(id, params.expectedRevision)
    const command = createPlanCommand({
      commandId: params.commandId,
      goal: params.text,
      ...(params.context === undefined ? {} : { context: params.context }),
      ...(params.workspace === undefined ? {} : { workspace: params.workspace }),
    })
    await this.denyFullAccessOperation(id, command)
    const access = this.context.assertWriteAccess(id, "composer", params.lease?.generation)
    const operationKey = appServerOperationKey(id.toString(), params.commandId)
    let operation: AppServerOperation
    try {
      operation = this.context.operationRegistry.begin(operationKey)
    } catch {
      throw new RpcApplicationError("command_in_progress", `commandId is already running: ${params.commandId}`)
    }
    try {
      const result = await this.context.sessionServer.execute(id, command, { signal: operation.signal })
      if (result.type !== "plan_created") throw new RpcApplicationError("invalid_host_result", "Host did not return plan_created")
      return {
        accepted: true,
        sessionId: id,
        commandId: params.commandId,
        intent: "plan",
        result: toJson(result.plan),
        snapshot: toJson(result.snapshot),
      }
    } finally {
      operation.release()
      this.context.releaseWriteAccess(id, access)
    }
  }

  async resolveApproval(value: unknown): Promise<JsonValue> {
    this.context.requireScope("approval:write")
    this.requireClientAction("approval")
    const params = parseSessionResolveApprovalParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    let result: SessionCommandResult
    try {
      result = await this.context.sessionServer.execute(
        id,
        resolveApprovalCommand({
          runId: runId(params.runId),
          turn: params.turn,
          toolUseId: params.toolUseId,
          preparedEventId: params.preparedEventId,
          expectedScopeRevision: params.expectedScopeRevision,
          expectedPolicyRevision: params.expectedPolicyRevision,
          decision: params.decision,
        }),
      )
    } catch (error) {
      if (error instanceof ApprovalResolutionError) {
        throw new RpcApplicationError(error.code, error.message, error.details === undefined ? undefined : toJson(error.details))
      }
      throw error
    }
    if (result.type !== "snapshot") throw new RpcApplicationError("invalid_host_result", "Host did not return an approval snapshot")
    return { sessionId: id, snapshot: toJson(result.snapshot) }
  }

  async cancel(value: unknown): Promise<JsonValue> {
    this.context.requireScope("session:write")
    this.requireClientAction("cancel")
    const record = asRecord(value, "session.cancel.params")
    const id = sessionId(parseNonEmptyString(record.sessionId, "sessionId"))
    const commandId = record.commandId === undefined ? undefined : parseNonEmptyString(record.commandId, "commandId")
    const requestedRunId = record.runId === undefined ? undefined : parseNonEmptyString(record.runId, "runId")
    const key = commandId === undefined ? undefined : appServerOperationKey(id.toString(), commandId)
    const snapshot = await this.context.readSnapshot(id)
    const targetRun =
      requestedRunId === undefined ? snapshot.currentRun : snapshot.runs?.find((run) => run.id.toString() === requestedRunId)
    const targetCommandId =
      commandId === undefined ? targetRun?.commandId : snapshot.runs?.some((run) => run.commandId === commandId) ? commandId : undefined
    let durableStatus: "cancelled" | "cancelled-before-acceptance" | "already-delivered" | undefined
    if (targetCommandId !== undefined) {
      const durable = await this.context.sessionServer.execute(
        id,
        cancelInputCommand({
          commandId: `session-cancel:${targetCommandId}`,
          inputId: `input:${targetCommandId}`,
          reason: "session.cancel",
        }),
      )
      if (durable.type !== "input_cancelled") throw new RpcApplicationError("invalid_host_result", "Host did not return input_cancelled")
      durableStatus = durable.status
    }
    const cancelled = (key === undefined ? false : this.context.operationRegistry.cancel(key)) || durableStatus !== undefined
    return {
      sessionId: id,
      cancelled,
      ...(commandId === undefined ? {} : { commandId }),
      ...(requestedRunId === undefined ? {} : { runId: requestedRunId }),
      ...(durableStatus === undefined ? {} : { status: durableStatus }),
    }
  }

  private requireClientAction(action: string): void {
    if (this.context.clientKind !== "mobile") return
    const denied = new Set([
      "fork",
      "delete",
      "rewind",
      "shell",
      "executeShell",
      "executeUserShell",
      "execute_user_shell",
      "setPermissionMode",
      "setPermissionRules",
      "addDirectory",
      "set_permission_mode",
      "set_permission_rules",
      "add_additional_directory",
    ])
    if (denied.has(action)) throw new RpcApplicationError("capability_denied", `The mobile client does not support action: ${action}`)
  }

  /**
   * ADR §3: a remote client may not operate a full-access session. The guard
   * keys on the produced command type — it is applied to the command every
   * construction route returns — so no route can tunnel a guarded command
   * past it; selecting one of manual|accept-edits|plan stays open as the
   * escape hatch.
   */
  private async denyFullAccessOperation(id: SessionId, command: SessionCommand): Promise<void> {
    if (!FULL_ACCESS_OPERATION_COMMANDS.has(command.type)) return
    const snapshot = await this.context.readSnapshot(id)
    if (snapshot.permissionMode === "full-access") {
      throw new RpcApplicationError("capability_denied", "a full-access session cannot be operated from a remote client")
    }
  }

  private async runInBackground(
    id: SessionId,
    commandId: string,
    intent: "prompt" | "mention" | "shell",
    command: import("@ag2cli/protocol/session-command.js").SessionCommand,
    operation: AppServerOperation,
  ): Promise<void> {
    try {
      await this.context.sessionServer.execute(id, command, { signal: operation.signal })
    } catch (error) {
      const code =
        error instanceof CommandIdempotencyConflictError
          ? "command_idempotency_conflict"
          : error instanceof SessionExecutionReservationConflictError
            ? "reservation_conflict"
            : error instanceof SessionWriterConflictError
              ? "reservation_conflict"
              : error instanceof SessionRevisionConflictError
                ? "revision_conflict"
                : error instanceof SessionPolicyRevisionConflictError
                  ? "policy_revision_conflict"
                  : this.context.isWorkspaceUnavailableError(error)
                    ? "workspace_unavailable"
                    : undefined
      this.context.emit("session.operation.failed", {
        sessionId: id,
        commandId,
        intent,
        message: error instanceof Error ? error.message : String(error),
        ...(code === undefined ? {} : { code }),
      })
    } finally {
      operation.release()
    }
  }

  private async commandForIntent(
    id: SessionId,
    commandId: string,
    intent: ReturnType<typeof parseInputIntent>,
    params: SessionSubmitParams,
  ): Promise<import("@ag2cli/protocol/session-command.js").SessionCommand> {
    switch (intent.kind) {
      case "prompt":
        return startRunCommand({
          commandId,
          goal: intent.text,
          ...(params.context === undefined ? {} : { context: params.context }),
          ...(intent.fileReferences ? { fileReferences: intent.fileReferences } : {}),
          ...(params.fileReferences === undefined ? {} : { fileReferences: params.fileReferences }),
          ...(params.workspace === undefined ? {} : { workspace: params.workspace }),
        })
      case "mention":
        return startRunCommand({
          commandId,
          goal: intent.text,
          ...(params.context === undefined ? {} : { context: params.context }),
          fileReferences: params.fileReferences ?? intent.references,
          ...(params.workspace === undefined ? {} : { workspace: params.workspace }),
        })
      case "shell":
        return executeUserShellCommand({ commandId, command: intent.command })
      case "slash":
        return this.commandForSlash(id, commandId, intent.name, intent.args)
    }
    throw new RpcApplicationError("invalid_intent", "Unknown input intent")
  }

  private async commandForSlash(
    id: SessionId,
    commandId: string,
    name: string,
    args: readonly string[],
  ): Promise<import("@ag2cli/protocol/session-command.js").SessionCommand> {
    switch (name) {
      case "compact":
        return compactSessionCommand({
          commandId,
          ...(args.length === 0 ? {} : { instructions: args.join(" ") }),
        })
      case "set-context-window": {
        if (args.length !== 1) throw new RpcApplicationError("invalid_slash_args", "usage: /set-context-window <tokens>")
        const tokens = parsePositiveInteger(args[0], "tokens")
        return setContextWindowCommand({ commandId, contextWindow: tokens })
      }
      case "clear-context-window":
        if (args.length !== 0) throw new RpcApplicationError("invalid_slash_args", "usage: /clear-context-window")
        return clearContextWindowCommand({ commandId })
      case "permissions": {
        // Three grammars: direct mode set, rule upsert, and rule removal.
        // Rules ride
        // the full-set setPermissionRules command with the snapshot's
        // policyRevision baked in — a lost race surfaces as the host's
        // stale_policy, and a retry after an unknown outcome
        // replays idempotently (a retry after a visible success re-reads
        // the bumped revision and is rejected as a stale race instead of
        // double-applying).
        const usage =
          "usage: /permissions <manual|accept-edits|plan> | /permissions rules add <tool> <allow|ask|deny> | /permissions rules remove <tool>"
        if (args.length === 0) throw new RpcApplicationError("invalid_slash_args", usage)
        if (args[0] === "rules") {
          const rulesUsage = "usage: /permissions rules add <tool> <allow|ask|deny> | /permissions rules remove <tool>"
          if (args[1] === "add") {
            const tool = args[2]
            const behavior = args[3]
            if (args.length !== 4 || tool === undefined || behavior === undefined || !isPermissionRuleBehavior(behavior)) {
              throw new RpcApplicationError("invalid_slash_args", rulesUsage)
            }
            // Trim-bound exactly as the core ingest asserts it, so a
            // whitespace-only name is a validation error here rather than
            // a deep host rejection.
            const name = tool.trim()
            if (name.length === 0 || name.length > 128) {
              throw new RpcApplicationError("invalid_slash_args", "tool name must be 1-128 characters")
            }
            const snapshot = await this.context.readSnapshot(id)
            // Upsert: read the snapshot's rules, replace the one entry for
            // the tool (or append), and set the full list back.
            const others = snapshot.permissionRules.filter((rule) => rule.name !== name)
            return setPermissionRulesCommand({
              commandId,
              rules: [...others, { name, behavior }],
              expectedPolicyRevision: snapshot.policyRevision,
            })
          }
          if (args[1] === "remove") {
            const tool = args[2]
            if (args.length !== 3 || tool === undefined) {
              throw new RpcApplicationError("invalid_slash_args", rulesUsage)
            }
            const name = tool.trim()
            if (name.length === 0 || name.length > 128) {
              throw new RpcApplicationError("invalid_slash_args", "tool name must be 1-128 characters")
            }
            const snapshot = await this.context.readSnapshot(id)
            if (!snapshot.permissionRules.some((rule) => rule.name === name)) {
              throw new RpcApplicationError("invalid_slash_args", `no permission rule for tool: ${name}`)
            }
            return setPermissionRulesCommand({
              commandId,
              rules: snapshot.permissionRules.filter((rule) => rule.name !== name),
              expectedPolicyRevision: snapshot.policyRevision,
            })
          }
          throw new RpcApplicationError("invalid_slash_args", rulesUsage)
        }
        const mode = args.length === 1 ? args[0] : undefined
        if (mode === undefined || !isAppServerPermissionMode(mode)) {
          throw new RpcApplicationError("invalid_slash_args", usage)
        }
        // Same selection rule as the setPermissionMode action: full-access
        // never enters from a remote client, slash route included.
        if (mode === "full-access") {
          throw new RpcApplicationError("capability_denied", "full-access cannot be selected from a remote client")
        }
        const snapshot = await this.context.readSnapshot(id)
        return setPermissionModeCommand({
          commandId,
          mode,
          expectedPolicyRevision: snapshot.policyRevision,
        })
      }
      case "goal":
        return goalCommand(commandId, args)
      default:
        throw new RpcApplicationError("slash_not_available", `This App Server does not provide /${name}`)
    }
  }
}

type SessionCommandActionType = SessionCommandParams["action"]["type"]

export const APP_SERVER_SESSION_COMMAND_POLICIES: Readonly<
  Record<SessionCommandActionType, { readonly rpcScope: AppServerScope; readonly interactionScope: InteractionLeaseScope | "none" }>
> = {
  addDirectory: { rpcScope: "session:write", interactionScope: "composer" },
  setPermissionMode: { rpcScope: "session:write", interactionScope: "session-control" },
  setPermissionRules: { rpcScope: "session:write", interactionScope: "session-control" },
  compact: { rpcScope: "session:write", interactionScope: "composer" },
  setContextWindow: { rpcScope: "session:write", interactionScope: "composer" },
  clearContextWindow: { rpcScope: "session:write", interactionScope: "composer" },
  setAgent: { rpcScope: "session:write", interactionScope: "composer" },
  updateGoal: { rpcScope: "session:write", interactionScope: "composer" },
  createTask: { rpcScope: "session:write", interactionScope: "composer" },
  listTasks: { rpcScope: "session:read", interactionScope: "none" },
  cancelTask: { rpcScope: "session:write", interactionScope: "none" },
  listCheckpoints: { rpcScope: "session:read", interactionScope: "none" },
  previewRewind: { rpcScope: "session:write", interactionScope: "session-control" },
  rewind: { rpcScope: "session:write", interactionScope: "session-control" },
  steer: { rpcScope: "session:write", interactionScope: "composer" },
  cancelInput: { rpcScope: "session:write", interactionScope: "none" },
  executeShell: { rpcScope: "shell:execute", interactionScope: "composer" },
  executeUserShell: { rpcScope: "shell:execute", interactionScope: "composer" },
}

function sessionCommandPolicy(action: SessionCommandActionType): (typeof APP_SERVER_SESSION_COMMAND_POLICIES)[SessionCommandActionType] {
  const policy = APP_SERVER_SESSION_COMMAND_POLICIES[action]
  if (policy === undefined) {
    throw new RpcApplicationError(
      "interaction_scope_unclassified",
      `Action is not classified in the session.command policy: ${String(action)}`,
    )
  }
  return policy
}

/**
 * RPC write-vs-read permission (one of two independent matrices — the other
 * being {@link requiredInteractionScopeFor}'s interaction-lease scope).
 * Whether an action needs `session:write` and whether it needs an
 * interaction lease are independent questions (e.g. `cancelTask` needs
 * `session:write` but no lease; `previewRewind` needs both).
 */
function requiredRpcScopeFor(action: SessionCommandActionType): AppServerScope {
  return sessionCommandPolicy(action).rpcScope
}

/**
 * Interaction lease scope (the second of the two independent matrices, see
 * {@link requiredRpcScopeFor}). `"none"` means the action is not protected by
 * an interaction lease at all — either genuinely read-only, or deliberately
 * excluded, e.g. `cancelTask` is a convergent, always-safe cancellation and
 * lease protection would only get in the way of escaping a runaway operation.
 */
function requiredInteractionScopeFor(action: SessionCommandActionType): InteractionLeaseScope | "none" {
  return sessionCommandPolicy(action).interactionScope
}

/**
 * `session.submit` only knows its target scope after parsing the raw text
 * into an {@link InputIntent}; `/permissions` is the
 * one server-backed slash that requires `session-control`, everything else
 * (prompt/mention/shell and the remaining server-backed slashes) is `composer`.
 */
function requiredInteractionScopeForIntent(intent: ReturnType<typeof parseInputIntent>): InteractionLeaseScope {
  return interactionLeaseScopeForIntent(intent)
}

function isAsyncIntent(
  intent: ReturnType<typeof parseInputIntent>,
): intent is Extract<ReturnType<typeof parseInputIntent>, { readonly kind: "prompt" | "mention" | "shell" }> {
  return intent.kind === "prompt" || intent.kind === "mention" || intent.kind === "shell"
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value)
  if (!value || !Number.isSafeInteger(parsed) || parsed < 1)
    throw new RpcApplicationError("invalid_slash_args", `${name} must be a positive integer`)
  return parsed
}

function goalCommand(commandId: string, args: readonly string[]): import("@ag2cli/protocol/session-command.js").SessionCommand {
  if (args.length === 0 || args[0] === "status")
    throw new RpcApplicationError("slash_not_available", "/goal status requires reading the dedicated goal projection")
  const action = args[0]
  if (action === "clear" || action === "pause" || action === "resume") {
    if (args.length !== 1) throw new RpcApplicationError("invalid_slash_args", `usage: /goal ${action}`)
    return updateGoalCommand({ commandId, update: { action } })
  }
  return updateGoalCommand({ commandId, update: { action: "set", text: args.join(" ") } })
}

function commandForAction(params: SessionCommandParams): import("@ag2cli/protocol/session-command.js").SessionCommand {
  const action = params.action
  switch (action.type) {
    case "addDirectory":
      return addAdditionalDirectoryCommand({
        commandId: params.commandId,
        directory: action.directory,
        ...(action.workspaceRoot === undefined ? {} : { workspaceRoot: action.workspaceRoot }),
        ...(action.expectedScopeRevision === undefined ? {} : { expectedScopeRevision: action.expectedScopeRevision }),
      })
    case "setPermissionMode":
      // ADR §3: remote selection covers manual|accept-edits|plan only;
      // full-access never enters through session.command.
      if (action.mode === "full-access") {
        throw new RpcApplicationError("capability_denied", "full-access cannot be selected from a remote client")
      }
      return setPermissionModeCommand({
        commandId: params.commandId,
        mode: action.mode,
        ...(action.expectedPolicyRevision === undefined ? {} : { expectedPolicyRevision: action.expectedPolicyRevision }),
      })
    case "setPermissionRules":
      return setPermissionRulesCommand({
        commandId: params.commandId,
        rules: action.rules,
        ...(action.expectedPolicyRevision === undefined ? {} : { expectedPolicyRevision: action.expectedPolicyRevision }),
      })
    case "compact":
      return compactSessionCommand({
        commandId: params.commandId,
        ...(action.instructions === undefined ? {} : { instructions: action.instructions }),
      })
    case "setContextWindow":
      return setContextWindowCommand({ commandId: params.commandId, contextWindow: action.contextWindow })
    case "clearContextWindow":
      return clearContextWindowCommand({ commandId: params.commandId })
    case "setAgent":
      return setAgentCommand({ commandId: params.commandId, ...(action.agentName === undefined ? {} : { agentName: action.agentName }) })
    case "updateGoal":
      return updateGoalCommand({ commandId: params.commandId, update: action.update })
    case "createTask":
      return createTaskCommand({
        commandId: params.commandId,
        taskType: action.taskType,
        title: action.title,
        ...(action.prompt === undefined ? {} : { prompt: action.prompt }),
        ...(action.argv === undefined ? {} : { argv: action.argv }),
        ...(action.intervalMs === undefined ? {} : { intervalMs: action.intervalMs }),
        ...(action.maxRuns === undefined ? {} : { maxRuns: action.maxRuns }),
        ...(action.workspace === undefined ? {} : { workspace: action.workspace }),
        ...(action.parentRunId === undefined ? {} : { parentRunId: runId(action.parentRunId) }),
      })
    case "listTasks":
      return listTasksCommand()
    case "cancelTask":
      return cancelTaskCommand({
        taskId: taskId(action.taskId),
        ...(action.reason === undefined ? {} : { reason: action.reason }),
      })
    case "listCheckpoints":
      return listCheckpointsCommand()
    case "previewRewind":
      return previewRewindCommand({
        checkpointId: action.checkpointId,
        ...(params.expectedRevision === undefined ? {} : { expectedRevision: params.expectedRevision }),
      })
    case "rewind":
      return rewindCommand({
        commandId: params.commandId,
        checkpointId: action.checkpointId,
        ...(params.expectedRevision === undefined ? {} : { expectedRevision: params.expectedRevision }),
      })
    case "steer":
      return steerCommand({
        commandId: params.commandId,
        runId: runId(action.runId),
        text: action.text,
      })
    case "cancelInput":
      return cancelInputCommand({
        commandId: params.commandId,
        inputId: action.inputId,
        ...(action.reason === undefined ? {} : { reason: action.reason }),
      })
    case "executeShell":
      return executeShellCommand({
        commandId: params.commandId,
        argv: action.argv,
        ...(action.cwd === undefined ? {} : { cwd: action.cwd }),
        ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
      })
    case "executeUserShell":
      return executeUserShellCommand({
        commandId: params.commandId,
        command: action.command,
        ...(action.cwd === undefined ? {} : { cwd: action.cwd }),
        ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
      })
  }
}

function commandResult(id: SessionId, commandId: string, result: SessionCommandResult): JsonValue {
  switch (result.type) {
    case "additional_directory_added":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "directoryAdded",
        result: toJson({
          changed: result.changed,
          directory: result.directory,
          additionalDirectories: result.additionalDirectories,
          scopeRevision: result.scopeRevision,
          ...(result.scopeDigest === undefined ? {} : { scopeDigest: result.scopeDigest }),
        }),
        snapshot: toJson(result.snapshot),
      }
    case "permission_updated":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "permissionUpdated",
        result: toJson({ changed: result.changed }),
        snapshot: toJson(result.snapshot),
      }
    case "compacted":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "compacted",
        result: toJson({
          changed: result.changed,
          inputMessageCount: result.inputMessageCount,
          outputMessageCount: result.outputMessageCount,
          ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
        }),
        snapshot: toJson(result.snapshot),
      }
    case "context_window_updated":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "contextWindowUpdated",
        result: toJson({
          changed: result.changed,
          ...(result.contextWindowOverride === undefined ? {} : { contextWindowOverride: result.contextWindowOverride }),
        }),
        snapshot: toJson(result.snapshot),
      }
    case "agent_updated":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "agentUpdated",
        result: toJson({ changed: result.changed, ...(result.agentName === undefined ? {} : { agentName: result.agentName }) }),
        snapshot: toJson(result.snapshot),
      }
    case "goal_updated":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "goalUpdated",
        result: toJson({ changed: result.changed, goal: result.goal }),
        snapshot: toJson(result.snapshot),
      }
    case "task_created":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "taskCreated",
        result: toJson({ task: result.task }),
        snapshot: toJson(result.snapshot),
      }
    case "tasks":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "tasksListed",
        result: toJson({ tasks: result.tasks }),
        snapshot: toJson(result.snapshot),
      }
    case "task_cancelled":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "taskCancelled",
        result: toJson({ task: result.task }),
        snapshot: toJson(result.snapshot),
      }
    case "checkpoints":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "checkpointsListed",
        result: toJson({ checkpoints: result.checkpoints }),
        snapshot: toJson(result.snapshot),
      }
    case "rewind_preview":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "rewindPreviewed",
        result: toJson({ preview: result.preview }),
        snapshot: toJson(result.snapshot),
      }
    case "rewind_result":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "rewound",
        result: toJson({ result: result.result }),
        snapshot: toJson(result.snapshot),
      }
    case "shell_result":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "shellResult",
        result: toJson({ runId: result.runId, result: result.result }),
        snapshot: toJson(result.snapshot),
      }
    case "input_accepted":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "inputAccepted",
        result: toJson({ inputId: result.inputId }),
        snapshot: toJson(result.snapshot),
      }
    case "input_cancelled":
      return {
        accepted: true,
        sessionId: id,
        commandId,
        action: "inputCancelled",
        result: toJson({ inputId: result.inputId, status: result.status }),
        snapshot: toJson(result.snapshot),
      }
    default:
      throw new RpcApplicationError("invalid_host_result", `Host did not return a public session.command result: ${result.type}`)
  }
}

function resultWithSnapshot(value: SessionCommandResult): value is Extract<SessionCommandResult, { readonly snapshot: unknown }> {
  return "snapshot" in value
}

function resultWithResult(value: SessionCommandResult): value is Extract<SessionCommandResult, { readonly result: unknown }> {
  return "result" in value
}

function resultWithRunId(value: SessionCommandResult): value is Extract<SessionCommandResult, { readonly runId: unknown }> {
  return "runId" in value
}
