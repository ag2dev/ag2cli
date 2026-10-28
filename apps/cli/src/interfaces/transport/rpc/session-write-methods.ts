import { randomUUID } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import {
  type JsonValue,
  type SessionAddDirectoryResult,
  type SessionArchiveResult,
  type SessionCancelInputResult,
  type SessionCancelRunResult,
  type SessionCancelTaskResult,
  type SessionClearContextWindowResult,
  type SessionCompactResult,
  type SessionCreateParams,
  type SessionCreateTaskResult,
  type SessionDeleteResult,
  type SessionExecuteShellResult,
  type SessionExecuteUserShellResult,
  type SessionGetPermissionPolicyResult,
  type SessionGetTaskLogsResult,
  type SessionListCheckpointsResult,
  type SessionListTasksResult,
  type SessionPreviewRewindResult,
  type SessionResolveInteractionResult,
  type SessionRewindResult,
  type SessionSelectAgentResult,
  type SessionSetContextWindowResult,
  type SessionSetPermissionModeResult,
  type SessionSetPermissionRulesResult,
  type SessionSnapshotResult,
  type SessionSteerResult,
  type SessionSubmitResult,
  type SessionUpdateGoalResult,
} from "@ag2cli/app-server-protocol/types.js"
import type { PublicTaskSummary } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import { MAX_TASK_TITLE_LENGTH } from "@ag2cli/app-server-protocol/dto/task-methods.js"
import {
  parseSessionAddDirectoryParams,
  parseSessionArchiveParams,
  parseSessionCancelInputParams,
  parseSessionCancelRunParams,
  parseSessionCancelTaskParams,
  parseSessionClearContextWindowParams,
  parseSessionCompactParams,
  parseSessionCreateParams,
  parseSessionCreateTaskParams,
  parseSessionDeleteParams,
  parseSessionExecuteShellParams,
  parseSessionExecuteUserShellParams,
  parseSessionForkParams,
  parseSessionGetPermissionPolicyParams,
  parseSessionGetTaskLogsParams,
  parseSessionListCheckpointsParams,
  parseSessionListTasksParams,
  parseSessionPlanParams,
  parseSessionPreviewRewindParams,
  parseSessionResolveInteractionParams,
  parseSessionRewindParams,
  parseSessionSelectAgentParams,
  parseSessionSetContextWindowParams,
  parseSessionSetPermissionModeParams,
  parseSessionSetPermissionRulesParams,
  parseSessionSteerParams,
  parseSessionSubmitParams,
  parseSessionUpdateGoalParams,
} from "@ag2cli/app-server-protocol/validation.js"
import { sessionId, taskId, type SessionId } from "@ag2cli/core/ids.js"
import { isTerminalTaskStatus, type TaskSnapshot } from "@ag2cli/core/task/task.js"
import type { SessionCommand, SessionCommandResult } from "@ag2cli/session-protocol/session-command.js"
import { appServerOperationKey, type AppServerOperation } from "../app-server-operation-registry.js"
import {
  cancelTaskCommand,
  createTaskCommand,
  listCheckpointsCommand,
  listTasksCommand,
  readTaskLogsCommand,
} from "@ag2cli/session-protocol/session-command.js"
import type { MethodContext } from "./method-context.js"
import { resolveSessionWorkspace } from "./workspace-methods.js"
import {
  addDirectoryCommandFromParams,
  addDirectoryResultFrom,
  assemblePublicSessionSnapshot,
  assertInputAcceptedAdmission,
  cancelInputCommandFor,
  cancelInputPrecheck,
  cancelRunCommandFor,
  cancelRunPrecheck,
  clearContextWindowCommandFromParams,
  clearContextWindowResultFrom,
  compactCommandFromParams,
  compactResultFrom,
  existingCreateReplay,
  inputAdmissionResult,
  inputCancelResultFromDurableStatus,
  planCommandFromParams,
  planResultFrom,
  policyDocument,
  previewRewindCommandFromParams,
  requireRunningRun,
  requireSelectableMode,
  resolveAskUserInteraction,
  resolveCreateWorkspaceRoot,
  resolveToolApprovalInteraction,
  rewindCommandFromParams,
  rewindResultFrom,
  RpcApplicationError,
  selectAgentCommandFromParams,
  selectAgentResultFrom,
  setContextWindowCommandFromParams,
  setContextWindowResultFrom,
  setPermissionModeCommandFor,
  setPermissionRulesCommandFor,
  startRunCommandFromSubmitParams,
  steerCommandFromParams,
  toPublicCheckpoint,
  updateGoalCommandFromParams,
  updateGoalResultFrom,
} from "../public-session-command-mapping.js"

export class SessionWriteMethods {
  constructor(private readonly context: MethodContext) {}

  /**
   * Client-generated resource identity: `sessionId` is required and create is
   * idempotent per (sessionId, payload). A retry with the same workspaceId
   * and title replays the existing session's canonical `{session}` result —
   * checked before workspace validation so a replay survives the workspace
   * leaving the registry — and a divergent payload on the same id is a
   * `command_idempotency_conflict`.
   */
  async createSession(value: unknown): Promise<SessionSnapshotResult> {
    this.context.requireScope("session:write")
    const catalog = this.context.requireCatalog()
    const params = parseSessionCreateParams(value)
    const id = sessionId(params.sessionId)
    const replayed = await this.replayCreatePayload(catalog, id, params)
    if (replayed !== undefined) return replayed
    const workspaceRoot = await resolveCreateWorkspaceRoot(params.workspaceId, this.context)
    try {
      const record = await catalog.create(id, workspaceRoot, {
        workspaceId: params.workspaceId,
        ...(params.title === undefined ? {} : { title: params.title }),
      })
      return { session: await assemblePublicSessionSnapshot(this.context, record) }
    } catch (error) {
      // Lost a race against a concurrent create with the same id; classify
      // by payload exactly like the pre-check above.
      const raced = await this.replayCreatePayload(catalog, id, params)
      if (raced === undefined) throw error
      return raced
    }
  }

  private async replayCreatePayload(
    catalog: ReturnType<MethodContext["requireCatalog"]>,
    id: SessionId,
    params: SessionCreateParams,
  ): Promise<SessionSnapshotResult | undefined> {
    const existing = await existingCreateReplay(catalog, id, params)
    return existing === undefined ? undefined : { session: await assemblePublicSessionSnapshot(this.context, existing) }
  }

  /**
   * `session.fork`/`session.archive`/`session.delete` reorder or change a
   * Session's own existence and therefore always require the
   * `session-control` interaction lease, unlike the write faces whose
   * required scope varies per method. Fork addresses history by business
   * identity only (fork-at-head); same-payload retries replay inside the
   * catalog, and any other occupied target id is a conflict.
   */
  async forkSession(value: unknown): Promise<SessionSnapshotResult> {
    this.context.requireScope("session:write")
    const catalog = this.context.requireCatalog()
    const params = parseSessionForkParams(value)
    const source = sessionId(params.sourceSessionId)
    const target = sessionId(params.targetSessionId ?? randomUUID())
    await this.context.requireExistingSession(source)
    const access = this.context.assertWriteAccess(source, "session-control", params.lease?.generation)
    try {
      const record = await catalog.fork(source, target, params.title)
      return { session: await assemblePublicSessionSnapshot(this.context, record) }
    } catch (error) {
      if ((await catalog.get(target).catch(() => undefined)) === undefined) throw error
      throw new RpcApplicationError("command_idempotency_conflict", `targetSessionId already exists with a different payload: ${target}`)
    } finally {
      this.context.releaseWriteAccess(source, access)
    }
  }

  async archiveSession(value: unknown): Promise<SessionArchiveResult> {
    this.context.requireScope("session:write")
    const catalog = this.context.requireCatalog()
    const params = parseSessionArchiveParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const access = this.context.assertWriteAccess(id, "session-control", params.lease?.generation)
    try {
      const record = await catalog.archive(id)
      if (record.archivedAt === undefined) {
        throw new RpcApplicationError("invalid_host_result", "Archive produced no archivedAt timestamp")
      }
      return { sessionId: id, archived: true, archivedAt: record.archivedAt }
    } finally {
      this.context.releaseWriteAccess(id, access)
    }
  }

  async deleteSession(value: unknown): Promise<SessionDeleteResult> {
    this.context.requireScope("session:write")
    const catalog = this.context.requireCatalog()
    const params = parseSessionDeleteParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const access = this.context.assertWriteAccess(id, "session-control", params.lease?.generation)
    try {
      await catalog.delete(id)
      return { sessionId: id, deleted: true }
    } finally {
      this.context.releaseWriteAccess(id, access)
    }
  }

  /** Policy face (contract §13): reads and writes share one result — the full
   * policy document — so a writer sees the new `policyRevision` it must carry
   * into its next CAS. Rule bodies travel only through this face, never
   * through the snapshot projection. */
  async getPermissionPolicy(value: unknown): Promise<SessionGetPermissionPolicyResult> {
    this.context.requireScope("session:policy")
    const params = parseSessionGetPermissionPolicyParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    return { policy: policyDocument(id, await this.context.readSnapshot(id), this.context.selectableModes) }
  }

  /** Selecting one of manual|accept-edits|plan on a full-access session is
   * the escape hatch and stays open. A mode the server does not offer in
   * selectableModes is `invalid_params`; a stale `expectedPolicyRevision`
   * surfaces as `policy_revision_conflict`. */
  async setPermissionMode(value: unknown): Promise<SessionSetPermissionModeResult> {
    this.context.requireScope("session:policy")
    const params = parseSessionSetPermissionModeParams(value)
    requireSelectableMode(this.context.selectableModes, params.mode)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const command = setPermissionModeCommandFor(`session-setPermissionMode:${randomUUID()}`, params.mode, params.expectedPolicyRevision)
    const access = this.context.assertWriteAccess(id, "session-control", params.lease.generation)
    try {
      const result = await this.context.sessionServer.execute(id, command)
      if (result.type !== "permission_updated") {
        throw new RpcApplicationError("invalid_host_result", "Host did not return permission_updated")
      }
      return { policy: policyDocument(id, result.snapshot, this.context.selectableModes) }
    } finally {
      this.context.releaseWriteAccess(id, access)
    }
  }

  async setPermissionRules(value: unknown): Promise<SessionSetPermissionRulesResult> {
    this.context.requireScope("session:policy")
    const params = parseSessionSetPermissionRulesParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const command = setPermissionRulesCommandFor(`session-setPermissionRules:${randomUUID()}`, params.rules, params.expectedPolicyRevision)
    const access = this.context.assertWriteAccess(id, "session-control", params.lease.generation)
    try {
      const result = await this.context.sessionServer.execute(id, command)
      if (result.type !== "permission_updated") {
        throw new RpcApplicationError("invalid_host_result", "Host did not return permission_updated")
      }
      return { policy: policyDocument(id, result.snapshot, this.context.selectableModes) }
    } finally {
      this.context.releaseWriteAccess(id, access)
    }
  }

  /** Submit is mailbox admission only: the text is a literal prompt —
   * slash/shell intents are retired, their actions ride the dedicated
   * methods — and the run (if started) continues in the background. */
  async submit(value: unknown): Promise<SessionSubmitResult> {
    const params = parseSessionSubmitParams(value)
    this.context.requireScope("session:write")
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
    const command = startRunCommandFromSubmitParams(params)
    // An omitted lease means the server acquires the composer scope for this
    // connection one-shot; an explicit lease is a strict generation CAS.
    const access =
      params.lease === undefined
        ? this.context.acquireWriteAccess(id, "composer")
        : this.context.assertWriteAccess(id, "composer", params.lease.generation)
    const operationKey = appServerOperationKey(id.toString(), params.commandId)
    let operation: AppServerOperation
    try {
      operation = this.context.operationRegistry.begin(operationKey)
    } catch {
      // A retry joins the in-flight admission: the runtime's commandId
      // idempotency reads back the recorded admission, or rejects a reused
      // commandId whose input diverges.
      try {
        const replay = await this.context.sessionServer.execute(id, command, { acceptOnly: true })
        assertInputAcceptedAdmission(replay)
        return inputAdmissionResult(id, params.commandId, replay)
      } finally {
        this.context.releaseWriteAccess(id, access)
      }
    }
    let backgroundOwnership = false
    try {
      const admission = await this.context.sessionServer.execute(id, command, {
        signal: operation.signal,
        acceptOnly: true,
      })
      assertInputAcceptedAdmission(admission)
      this.context.releaseWriteAccess(id, access)
      backgroundOwnership = true
      if (!admission.queued) {
        void this.runInBackground(id, command, operation)
      } else {
        operation.release()
      }
      return inputAdmissionResult(id, params.commandId, admission)
    } finally {
      if (!backgroundOwnership) {
        operation.release()
        this.context.releaseWriteAccess(id, access)
      }
    }
  }

  async plan(value: unknown): Promise<JsonValue> {
    const params = parseSessionPlanParams(value)
    this.context.requireScope("session:write")
    const id = sessionId(params.sessionId)
    if (this.context.catalog) await this.context.requireExistingSession(id)
    if (params.expectedRevision !== undefined) await this.context.requireRevision(id, params.expectedRevision)
    const command = planCommandFromParams(params)
    const access = this.context.assertWriteAccess(id, "composer", params.lease?.generation)
    const operationKey = appServerOperationKey(id.toString(), params.commandId)
    let operation: AppServerOperation
    try {
      operation = this.context.operationRegistry.begin(operationKey)
    } catch {
      // A retry joins the in-flight command: per-session serialization makes
      // this execute a read-back of the first attempt's durable result.
      const replay = await this.context.sessionServer.execute(id, command)
      this.context.releaseWriteAccess(id, access)
      return planResultFrom(id, params.commandId, replay)
    }
    try {
      return planResultFrom(id, params.commandId, await this.context.sessionServer.execute(id, command, { signal: operation.signal }))
    } finally {
      operation.release()
      this.context.releaseWriteAccess(id, access)
    }
  }

  /**
   * Unified interaction resolution (contract §10): one entry point whose
   * `kind` selects both the required scope (`approval:write` vs
   * `session:write`) and the resolution machinery. Idempotency is
   * resource-keyed on the interaction with canonical first-writer-wins; the
   * `resolutionId` stays the caller's private retry identity. The result
   * echoes the canonical resolution read back from durable events, never a
   * client-supplied echo.
   */
  async resolveInteraction(value: unknown): Promise<SessionResolveInteractionResult> {
    const params = parseSessionResolveInteractionParams(value)
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const deps = {
      readEvents: (session: SessionId) => this.context.readEvents(session, 0),
      execute: (session: SessionId, command: SessionCommand) => this.context.sessionServer.execute(session, command),
    }
    if (params.kind === "tool_approval") {
      this.context.requireScope("approval:write")
      return resolveToolApprovalInteraction(deps, id, params)
    }
    this.context.requireScope("session:write")
    return resolveAskUserInteraction(deps, id, params)
  }

  /** Steer only targets a live run: a run the snapshot does not show as
   * running is `run_not_active`, never a silent queue for a future run.
   * Admission is the mailbox fact; delivery arrives as durable input events.
   * The wire carries no lease, so the composer scope is acquired one-shot
   * like a submit that omits it; another holder still fences with
   * `interaction_lease_held`. */
  async steer(value: unknown): Promise<SessionSteerResult> {
    const params = parseSessionSteerParams(value)
    this.context.requireScope("session:write")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const snapshot = await this.context.readSnapshot(id)
    requireRunningRun(snapshot, params.runId)
    const command = steerCommandFromParams(params.runId, params.commandId, params.text)
    const access = this.context.acquireWriteAccess(id, "composer")
    try {
      const admission = await this.context.sessionServer.execute(id, command)
      return inputAdmissionResult(id, params.commandId, admission)
    } finally {
      this.context.releaseWriteAccess(id, access)
    }
  }

  /** CancelRun reports a request state, not a completion: the terminal fact
   * is the run.updated event. The snapshot is the same durable history the
   * Host reduces, so a run it does not know is `not_found` and a terminal one
   * `already_terminal` — both converge without a Host write, keeping cancel
   * usable while the workspace root is gone (cancelInput holds the same
   * boundary). */
  async cancelRun(value: unknown): Promise<SessionCancelRunResult> {
    const params = parseSessionCancelRunParams(value)
    this.context.requireScope("session:write")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const precheck = cancelRunPrecheck(await this.context.readSnapshot(id), params.runId)
    if (precheck.state !== "running") return { requested: false, state: precheck.state }
    const durable = await this.context.sessionServer.execute(id, cancelRunCommandFor(params.runId))
    if (durable.type !== "run_cancellation") throw new RpcApplicationError("invalid_host_result", "Host did not return run_cancellation")
    if (durable.status === "requested") {
      this.context.operationRegistry.cancel(appServerOperationKey(id.toString(), precheck.run.commandId))
    }
    return { requested: durable.status === "requested", state: durable.status }
  }

  /** CancelInput addresses the mailbox by inputId. An input the snapshot
   * never accepted is `not_found`; one already cancelled is
   * `already_terminal`; everything else is a cancellation request whose
   * outcome arrives as input.updated. */
  async cancelInput(value: unknown): Promise<SessionCancelInputResult> {
    const params = parseSessionCancelInputParams(value)
    this.context.requireScope("session:write")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const precheck = cancelInputPrecheck(await this.context.readSnapshot(id), params.inputId)
    if (precheck === "not_found") return { requested: false, state: "not_found" }
    if (precheck === "already_terminal") return { requested: false, state: "already_terminal" }
    const durable = await this.context.sessionServer.execute(id, cancelInputCommandFor(params.inputId))
    if (durable.type !== "input_cancelled") throw new RpcApplicationError("invalid_host_result", "Host did not return input_cancelled")
    return inputCancelResultFromDurableStatus(durable.status)
  }

  /** Contract §11.7 session action face: convergent session-state mutations
   * behind the composer interaction lease. Results carry the reducer facts
   * only — structural updates keep arriving as durable session events. */
  private async runSessionAction<R>(
    params: { readonly sessionId: string; readonly commandId: string; readonly lease?: { readonly generation: number } },
    command: SessionCommand,
    toResult: (id: SessionId, commandId: string, result: SessionCommandResult) => R,
  ): Promise<R> {
    this.context.requireScope("session:write")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const access = this.context.assertWriteAccess(id, "composer", params.lease?.generation)
    let operation: AppServerOperation
    try {
      operation = this.context.operationRegistry.begin(appServerOperationKey(id.toString(), params.commandId))
    } catch {
      // A retry joins the in-flight command: per-session serialization makes
      // this execute a read-back of the first attempt's durable result.
      const replay = await this.context.sessionServer.execute(id, command)
      this.context.releaseWriteAccess(id, access)
      return toResult(id, params.commandId, replay)
    }
    try {
      const result = await this.context.sessionServer.execute(id, command, { signal: operation.signal })
      return toResult(id, params.commandId, result)
    } finally {
      operation.release()
      this.context.releaseWriteAccess(id, access)
    }
  }

  async compact(value: unknown): Promise<SessionCompactResult> {
    const params = parseSessionCompactParams(value)
    return this.runSessionAction(params, compactCommandFromParams(params), compactResultFrom)
  }

  async addDirectory(value: unknown): Promise<SessionAddDirectoryResult> {
    const params = parseSessionAddDirectoryParams(value)
    return this.runSessionAction(params, addDirectoryCommandFromParams(params), addDirectoryResultFrom)
  }

  async setContextWindow(value: unknown): Promise<SessionSetContextWindowResult> {
    const params = parseSessionSetContextWindowParams(value)
    return this.runSessionAction(params, setContextWindowCommandFromParams(params), setContextWindowResultFrom)
  }

  async clearContextWindow(value: unknown): Promise<SessionClearContextWindowResult> {
    const params = parseSessionClearContextWindowParams(value)
    return this.runSessionAction(params, clearContextWindowCommandFromParams(params), clearContextWindowResultFrom)
  }

  async selectAgent(value: unknown): Promise<SessionSelectAgentResult> {
    const params = parseSessionSelectAgentParams(value)
    return this.runSessionAction(params, selectAgentCommandFromParams(params), selectAgentResultFrom)
  }

  async updateGoal(value: unknown): Promise<SessionUpdateGoalResult> {
    const params = parseSessionUpdateGoalParams(value)
    return this.runSessionAction(params, updateGoalCommandFromParams(params), updateGoalResultFrom)
  }

  /** Rewind face (contract §11.7): a plain read — checkpoints travel as
   * business facts only, the internal DAG cursor never reaches the wire. */
  async listCheckpoints(value: unknown): Promise<SessionListCheckpointsResult> {
    const params = parseSessionListCheckpointsParams(value)
    this.context.requireScope("session:read")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const result = await this.context.sessionServer.execute(id, listCheckpointsCommand())
    if (result.type !== "checkpoints") throw new RpcApplicationError("invalid_host_result", "Host did not return checkpoints")
    return { sessionId: id, checkpoints: result.checkpoints.map(toPublicCheckpoint) }
  }

  /** Read-only preview behind the `session-control` lease: it leaves no
   * durable history, so there is no commandId and no idempotency registry —
   * §16 idempotency applies to mutations only. */
  async previewRewind(value: unknown): Promise<SessionPreviewRewindResult> {
    const params = parseSessionPreviewRewindParams(value)
    this.context.requireScope("session:write")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    if (params.expectedRevision !== undefined) await this.context.requireRevision(id, params.expectedRevision)
    const access = this.context.assertWriteAccess(id, "session-control", params.lease?.generation)
    try {
      const result = await this.context.sessionServer.execute(id, previewRewindCommandFromParams(params))
      if (result.type !== "rewind_preview") throw new RpcApplicationError("invalid_host_result", "Host did not return rewind_preview")
      return {
        sessionId: id,
        checkpoint: toPublicCheckpoint(result.preview.checkpoint),
        currentRevision: result.preview.currentRevision,
        currentGeneration: result.preview.currentGeneration,
        staleRevision: result.preview.staleRevision,
        canCommit: result.preview.canCommit,
      }
    } finally {
      this.context.releaseWriteAccess(id, access)
    }
  }

  /** Timeline move behind the `session-control` lease with revision CAS and
   * commandId idempotency. The physical revision log is never rewritten —
   * old projections are invalidated by a resync barrier, so the result
   * carries facts, not a snapshot (contract §15.7); `failed` rewind states
   * are canonical facts, not RPC errors. */
  async rewind(value: unknown): Promise<SessionRewindResult> {
    const params = parseSessionRewindParams(value)
    this.context.requireScope("session:write")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    if (params.expectedRevision !== undefined) await this.context.requireRevision(id, params.expectedRevision)
    const command = rewindCommandFromParams(params)
    const access = this.context.assertWriteAccess(id, "session-control", params.lease?.generation)
    let operation: AppServerOperation
    try {
      operation = this.context.operationRegistry.begin(appServerOperationKey(id.toString(), params.commandId))
    } catch {
      // A retry joins the in-flight command: per-session serialization makes
      // this execute a read-back of the first attempt's durable result.
      const replay = await this.context.sessionServer.execute(id, command)
      this.context.releaseWriteAccess(id, access)
      return rewindResultFrom(id, params.commandId, replay)
    }
    try {
      const result = await this.context.sessionServer.execute(id, command, { signal: operation.signal })
      return rewindResultFrom(id, params.commandId, result)
    } finally {
      operation.release()
      this.context.releaseWriteAccess(id, access)
    }
  }

  /** Standalone task face (contract §11.7): agent work is the only kind
   * creatable here — shell execution rides the dedicated execute methods,
   * periodic loops stay a local-runtime concern. */
  async createTask(value: unknown): Promise<SessionCreateTaskResult> {
    const params = parseSessionCreateTaskParams(value)
    this.context.requireScope("session:write")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const command = createTaskCommand({
      commandId: params.commandId,
      taskType: "agent",
      title: params.title,
      prompt: params.prompt,
    })
    const access = this.context.assertWriteAccess(id, "composer", params.lease?.generation)
    let operation: AppServerOperation
    try {
      operation = this.context.operationRegistry.begin(appServerOperationKey(id.toString(), params.commandId))
    } catch {
      // A retry joins the in-flight command: per-session serialization makes
      // this execute a read-back of the first attempt's durable result.
      const replay = await this.context.sessionServer.execute(id, command)
      this.context.releaseWriteAccess(id, access)
      return taskCreatedResult(id, params.commandId, replay)
    }
    try {
      return taskCreatedResult(id, params.commandId, await this.context.sessionServer.execute(id, command, { signal: operation.signal }))
    } finally {
      operation.release()
      this.context.releaseWriteAccess(id, access)
    }
  }

  /** Public listings never surface periodic loop tasks; their agent
   * masquerade only guards direct task summaries elsewhere. */
  async listTasks(value: unknown): Promise<SessionListTasksResult> {
    const params = parseSessionListTasksParams(value)
    this.context.requireScope("session:read")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const result = await this.context.sessionServer.execute(id, listTasksCommand())
    if (result.type !== "tasks") throw new RpcApplicationError("invalid_host_result", "Host did not return tasks")
    return { sessionId: id, tasks: result.tasks.filter((task) => task.type !== "loop").map(publicTaskSummaryOf) }
  }

  /** `cancelled` reports the post-call transition only: an already terminal
   * task is a convergent no-op returning false, never an error. */
  async cancelTask(value: unknown): Promise<SessionCancelTaskResult> {
    const params = parseSessionCancelTaskParams(value)
    this.context.requireScope("session:write")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const snapshot = await this.context.readSnapshot(id)
    const existing = snapshot.tasks?.find((candidate) => candidate.id.toString() === params.taskId)
    if (existing === undefined) {
      throw new RpcApplicationError("invalid_params", `session has no background task: ${params.taskId}`, { taskId: params.taskId })
    }
    if (isTerminalTaskStatus(existing.status)) {
      return { cancelled: false, sessionId: id, taskId: params.taskId, task: publicTaskSummaryOf(existing) }
    }
    const result = await this.context.sessionServer.execute(
      id,
      cancelTaskCommand({
        taskId: taskId(params.taskId),
        ...(params.reason === undefined ? {} : { reason: params.reason }),
      }),
    )
    if (result.type !== "task_cancelled") throw new RpcApplicationError("invalid_host_result", "Host did not return task_cancelled")
    return {
      cancelled: result.task.status === "cancelled",
      sessionId: id,
      taskId: params.taskId,
      task: publicTaskSummaryOf(result.task),
    }
  }

  /** Authoritative paged task output: chunks live behind this face, never in
   * the durable public event stream. The cursor is present only on a partial
   * page; a missing task is a client addressing error. */
  async getTaskLogs(value: unknown): Promise<SessionGetTaskLogsResult> {
    const params = parseSessionGetTaskLogsParams(value)
    this.context.requireScope("session:read")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const snapshot = await this.context.readSnapshot(id)
    const known = snapshot.tasks?.some((candidate) => candidate.id.toString() === params.taskId) ?? false
    if (!known) {
      throw new RpcApplicationError("invalid_params", `session has no background task: ${params.taskId}`, { taskId: params.taskId })
    }
    const result = await this.context.sessionServer.execute(
      id,
      readTaskLogsCommand({
        taskId: taskId(params.taskId),
        ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      }),
    )
    if (result.type !== "task_logs") throw new RpcApplicationError("invalid_host_result", "Host did not return task_logs")
    return {
      sessionId: id,
      taskId: params.taskId,
      status: result.status,
      outputBytes: result.outputBytes,
      chunks: result.chunks.map((chunk) => ({ sequence: chunk.sequence, text: chunk.text })),
      ...(result.nextAfterSequence === undefined ? {} : { nextAfterSequence: result.nextAfterSequence }),
    }
  }

  /** Remote shell admission (contract §11.8): reuses the background task
   * lifecycle — the admitted task is the identity progress, output and
   * cancellation ride; there is no foreground shell_result path here. The
   * `shell:execute` scope is the whole authorization; shell admission never
   * takes the composer lease, which §14 reserves for submit-level work. */
  async executeShell(value: unknown): Promise<SessionExecuteShellResult> {
    const params = parseSessionExecuteShellParams(value)
    this.context.requireScope("shell:execute")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    const command = await this.shellAdmissionCommand(id, params.commandId, {
      taskType: "shell",
      title: shellTaskTitle(params.argv.join(" ")),
      argv: [...params.argv],
      cwdRelative: params.cwdRelative,
      timeoutMs: params.timeoutMs,
    })
    return this.admitShellTask(id, params.commandId, command)
  }

  async executeUserShell(value: unknown): Promise<SessionExecuteUserShellResult> {
    const params = parseSessionExecuteUserShellParams(value)
    this.context.requireScope("shell:execute")
    const id = sessionId(params.sessionId)
    const command = await this.shellAdmissionCommand(id, params.commandId, {
      taskType: "user_shell",
      title: shellTaskTitle(params.command),
      command: params.command,
      cwdRelative: params.cwdRelative,
      timeoutMs: params.timeoutMs,
    })
    return this.admitShellTask(id, params.commandId, command)
  }

  private async shellAdmissionCommand(
    id: SessionId,
    commandId: string,
    input: {
      readonly taskType: "shell" | "user_shell"
      readonly title: string
      readonly argv?: readonly string[]
      readonly command?: string
      readonly cwdRelative?: string
      readonly timeoutMs?: number
    },
  ): Promise<SessionCommand> {
    const cwd =
      input.cwdRelative === undefined
        ? undefined
        : resolvePath((await resolveSessionWorkspace(this.context, id.toString())).root, input.cwdRelative)
    return createTaskCommand({
      commandId,
      taskType: input.taskType,
      title: input.title,
      ...(input.argv === undefined ? {} : { argv: input.argv }),
      ...(input.command === undefined ? {} : { command: input.command }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    })
  }

  private async admitShellTask(id: SessionId, commandId: string, command: SessionCommand): Promise<SessionExecuteShellResult> {
    const project = (result: SessionCommandResult): SessionExecuteShellResult => {
      if (result.type !== "task_created") throw new RpcApplicationError("invalid_host_result", "Host did not return task_created")
      return {
        accepted: true,
        sessionId: id,
        commandId,
        taskId: result.task.id,
        queued: result.task.status === "queued",
      }
    }
    let operation: AppServerOperation
    try {
      operation = this.context.operationRegistry.begin(appServerOperationKey(id.toString(), commandId))
    } catch {
      // A retry joins the in-flight command: per-session serialization makes
      // this execute a read-back of the first attempt's durable result.
      const replay = await this.context.sessionServer.execute(id, command)
      return project(replay)
    }
    try {
      return project(await this.context.sessionServer.execute(id, command, { signal: operation.signal }))
    } finally {
      operation.release()
    }
  }

  private async runInBackground(
    id: SessionId,
    command: import("@ag2cli/session-protocol/session-command.js").SessionCommand,
    operation: AppServerOperation,
  ): Promise<void> {
    try {
      await this.context.sessionServer.execute(id, command, { signal: operation.signal })
    } catch {
      // Admitted work reports failure as canonical input.failed /
      // run.updated facts the Host records; the retired v0 notification is
      // gone. The catch contains the rejection of this floating promise so
      // it cannot surface as an unhandled process-level crash.
    } finally {
      operation.release()
    }
  }
}

/** Internal task snapshot to the public summary: the wire carries no
 * createdAt/startedAt split, so `updatedAt` collapses to the latest known
 * timestamp; loop tasks masquerade as agent exactly like the live projection
 * (public listings filter them out before this mapping). */
function publicTaskSummaryOf(task: TaskSnapshot): PublicTaskSummary {
  return {
    taskId: task.id,
    kind: task.type === "loop" ? "agent" : task.type,
    title: task.title,
    status: task.status,
    updatedAt: task.completedAt ?? task.startedAt ?? task.createdAt,
  }
}

function taskCreatedResult(id: SessionId, commandId: string, result: SessionCommandResult): SessionCreateTaskResult {
  if (result.type !== "task_created") throw new RpcApplicationError("invalid_host_result", "Host did not return task_created")
  return {
    accepted: true,
    sessionId: id,
    commandId,
    task: publicTaskSummaryOf(result.task),
    queued: result.task.status === "queued",
  }
}

/** Shell task titles derive from the command line, bounded to the task title
 * limit; a whitespace-only join (empty argv entries only) falls back rather
 * than violating the non-empty title constraint. */
function shellTaskTitle(candidate: string): string {
  const title = candidate.slice(0, MAX_TASK_TITLE_LENGTH)
  return title.trim().length > 0 ? title : "shell task"
}
