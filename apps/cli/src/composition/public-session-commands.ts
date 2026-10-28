import { randomUUID } from "node:crypto"
import type {
  JsonValue,
  SessionAddDirectoryResult,
  SessionArchiveResult,
  SessionCancelInputResult,
  SessionCancelRunResult,
  SessionClearContextWindowResult,
  SessionCompactResult,
  SessionCreateParams,
  SessionDeleteResult,
  SessionForkParams,
  SessionGetPermissionPolicyResult,
  SessionListCheckpointsResult,
  SessionPreviewRewindResult,
  SessionResolveInteractionParams,
  SessionResolveInteractionResult,
  SessionRewindResult,
  SessionSelectAgentResult,
  SessionSetContextWindowResult,
  SessionSetPermissionModeResult,
  SessionSetPermissionRulesResult,
  SessionSnapshotResult,
  SessionSteerResult,
  SessionSubmitParams,
  SessionSubmitResult,
  SessionUpdateGoalResult,
} from "@ag2cli/app-server-protocol/types.js"
import type { PublicPermissionModeValue } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import { sessionId, type SessionId } from "@ag2cli/core/ids.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionGoalUpdate } from "@ag2cli/core/session/session-goal.js"
import { projectActiveSessionEvents } from "@ag2cli/core/session/session-projection.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import { isSessionPermissionMode, type SessionPermissionMode, type SessionPermissionRule } from "@ag2cli/core/session/session-security.js"
import { findResumableRun } from "@ag2cli/runtime/application/session/resumable-run.js"
import type { SessionCatalog } from "@ag2cli/runtime/ports/session-catalog.js"
import {
  executeUserShellCommand,
  getSnapshotCommand,
  listCheckpointsCommand,
  readEventsCommand,
  type SessionCommand,
  type SessionCommandResult,
} from "@ag2cli/session-protocol/session-command.js"
import {
  type PublicSnapshotContext,
  type ResolveInteractionDeps,
  type StartRunExtensions,
  addDirectoryCommandFromParams,
  addDirectoryResultFrom,
  assemblePublicSessionSnapshot,
  assertInputAcceptedAdmission,
  cancelInputCommandFor,
  cancelInputPrecheck,
  cancelRunCommandFor,
  cancelRunPrecheck,
  classifyRuntimeCommandError,
  clearContextWindowCommandFromParams,
  clearContextWindowResultFrom,
  compactCommandFromParams,
  compactResultFrom,
  existingCreateReplay,
  inputAdmissionResult,
  inputCancelResultFromDurableStatus,
  modelCallsResultFrom,
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
  traceResultFrom,
  updateGoalCommandFromParams,
  updateGoalResultFrom,
} from "../interfaces/transport/public-session-command-mapping.js"
import { PublicSessionProjector } from "../interfaces/transport/public-projection.js"

// The facade is the transport seam its clients may reach: the typed
// error surface rides it so embedded assemblies stay off the wire
// modules.
export { RpcApplicationError } from "../interfaces/transport/public-session-command-mapping.js"

export interface SessionCommandExecuteOptions {
  readonly signal?: AbortSignal
  readonly acceptOnly?: boolean
}

/**
 * Structural execution port over one authoritative Session host. The
 * client package's SessionServer satisfies it; the facade must not reach
 * into `@ag2cli/session-client`, which the wire layer owns.
 */
export interface SessionCommandPort {
  execute(id: SessionId, command: SessionCommand, options?: SessionCommandExecuteOptions): Promise<SessionCommandResult>
}

/** Structural workspace registry membership (same shape the wire context carries). */
export interface PublicWorkspaceRegistryPort {
  list(): Promise<
    readonly { readonly workspaceId: string; readonly workspaceRoot: string; readonly createdAt: string; readonly updatedAt: string }[]
  >
  get(
    workspaceId: string,
  ): Promise<
    { readonly workspaceId: string; readonly workspaceRoot: string; readonly createdAt: string; readonly updatedAt: string } | undefined
  >
}

export interface PublicSessionCommandsOptions {
  readonly sessionServer: SessionCommandPort
  readonly catalog: SessionCatalog
  readonly workspaceIdForRoot: (workspaceRoot: string) => string
  readonly isWorkspaceUnavailableError: (error: unknown) => error is { readonly message: string; readonly workspaceRoot: string }
  readonly selectableModes: readonly PublicPermissionModeValue[]
  readonly workspaceRoot?: string
  readonly workspaceRegistry?: PublicWorkspaceRegistryPort
}

/** The recorded start_run seed of an unfinished run, reconstructed for resume.
 * `fileReferences` are plain paths because the recorded fingerprint keeps
 * paths only; callers re-attach the workspace identity when resubmitting. */
export interface ResumableSubmit {
  readonly commandId: string
  readonly goal: string
  readonly context?: readonly string[]
  readonly fileReferences?: readonly string[]
  readonly permissionRules?: readonly SessionPermissionRule[]
  readonly maxTurns?: number
  readonly permissionMode?: SessionPermissionMode
}

/**
 * In-process public session command face: the same method semantics and
 * error codes as the App Server wire, minus every connection concern — no
 * scopes, interaction leases, or operation registry. A trusted
 * host-local caller (headless entrypoints) is the
 * authority itself; submit therefore owns run driving through local abort
 * signals instead of a connection operation registry.
 */
export class PublicSessionCommands {
  /** Local driving signals by `${sessionId}:${commandId}`, mirroring the wire operation keys. */
  private readonly driving = new Map<string, AbortController>()

  constructor(private readonly options: PublicSessionCommandsOptions) {}

  private snapshotContext(): PublicSnapshotContext {
    const { workspaceRoot, workspaceRegistry } = this.options
    return {
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(workspaceRegistry === undefined ? {} : { workspaceRegistry }),
      workspaceIdForRoot: this.options.workspaceIdForRoot,
      selectableModes: this.options.selectableModes,
      readEvents: (id: SessionId, afterRevision: number) => this.readEvents(id, afterRevision),
    }
  }

  /**
   * Full public event history of the ACTIVE lineage, strictly projected:
   * dead-branch events stay in the durable log but never reach a
   * consumer that rebuilds its view from this read.
   */
  async readPublicEvents(params: { readonly sessionId: string }): Promise<readonly PublicSessionEvent[]> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    const projector = new PublicSessionProjector()
    const events: PublicSessionEvent[] = []
    for (const event of projectActiveSessionEvents(await this.readEvents(id, 0))) {
      events.push(...projector.apply(event))
    }
    return events
  }

  /** Snapshot assembly from the canonical stream, without a live attachment. */
  async snapshot(params: { readonly sessionId: string }): Promise<SessionSnapshotResult> {
    const id = sessionId(params.sessionId)
    const record = await this.options.catalog.get(id)
    if (record === undefined) {
      throw new RpcApplicationError("session_not_found", `Session does not exist: ${id}`)
    }
    return { session: await assemblePublicSessionSnapshot(this.snapshotContext(), record) }
  }

  /**
   * Both public faces must classify runtime-domain failures identically.
   * Unlike the wire, which collapses the unclassified remainder into an
   * opaque internal error, the in-process caller keeps the original error.
   */
  private commandError(error: unknown): unknown {
    if (error instanceof RpcApplicationError) return error
    const classified = classifyRuntimeCommandError(error, this.options.isWorkspaceUnavailableError)
    if (classified === undefined) return error
    return new RpcApplicationError(classified.code, classified.message, classified.details)
  }

  private async execute(id: SessionId, command: SessionCommand, options?: SessionCommandExecuteOptions): Promise<SessionCommandResult> {
    try {
      return await this.options.sessionServer.execute(id, command, options)
    } catch (error) {
      throw this.commandError(error)
    }
  }

  private async readSnapshot(id: SessionId): Promise<SessionSnapshot> {
    const result = await this.execute(id, getSnapshotCommand())
    if (result.type !== "snapshot") throw new RpcApplicationError("invalid_host_result", "Host did not return a snapshot")
    return result.snapshot
  }

  private async readEvents(id: SessionId, afterRevision: number): Promise<readonly AgentEvent[]> {
    const result = await this.execute(id, readEventsCommand(afterRevision))
    if (result.type !== "events") throw new RpcApplicationError("invalid_host_result", "Host did not return events")
    return result.events
  }

  private async requireExistingSession(id: SessionId): Promise<void> {
    if (!(await this.options.catalog.get(id))) {
      throw new RpcApplicationError("session_not_found", `Session does not exist: ${id}`)
    }
  }

  private async requireRevision(id: SessionId, expectedRevision: number): Promise<void> {
    const snapshot = await this.readSnapshot(id)
    if (snapshot.lastRevision !== expectedRevision) {
      throw new RpcApplicationError(
        "revision_conflict",
        `Session revision changed: expected ${expectedRevision}, got ${snapshot.lastRevision}`,
      )
    }
  }

  /**
   * Client-generated resource identity: `sessionId` is required and create
   * is idempotent per (sessionId, payload). A same-payload retry replays
   * the canonical snapshot result — checked before workspace validation so
   * a replay survives the workspace leaving the registry — and a divergent
   * payload on the same id is a `command_idempotency_conflict`.
   */
  async createSession(params: SessionCreateParams): Promise<SessionSnapshotResult> {
    const id = sessionId(params.sessionId)
    const replay = async (): Promise<SessionSnapshotResult | undefined> => {
      const existing = await existingCreateReplay(this.options.catalog, id, params)
      return existing === undefined ? undefined : { session: await assemblePublicSessionSnapshot(this.snapshotContext(), existing) }
    }
    try {
      const replayed = await replay()
      if (replayed !== undefined) return replayed
      const workspaceRoot = await resolveCreateWorkspaceRoot(params.workspaceId, this.snapshotContext())
      const record = await this.options.catalog.create(id, workspaceRoot, {
        workspaceId: params.workspaceId,
        ...(params.title === undefined ? {} : { title: params.title }),
      })
      return { session: await assemblePublicSessionSnapshot(this.snapshotContext(), record) }
    } catch (error) {
      // Lost a race against a concurrent create with the same id; classify
      // by payload exactly like the pre-check above. A divergent payload on
      // the occupied id propagates its own conflict, matching the wire face.
      const raced = await replay()
      if (raced !== undefined) return raced
      throw this.commandError(error)
    }
  }

  /**
   * Catalog faces that reorder or end a Session's own existence. Fork
   * addresses history by business identity only (fork-at-head); a retry
   * whose target id already exists with a different payload is a
   * `command_idempotency_conflict`.
   */
  async forkSession(params: SessionForkParams): Promise<SessionSnapshotResult> {
    const source = sessionId(params.sourceSessionId)
    const target = sessionId(params.targetSessionId ?? randomUUID())
    await this.requireExistingSession(source)
    try {
      const record = await this.options.catalog.fork(source, target, params.title)
      return { session: await assemblePublicSessionSnapshot(this.snapshotContext(), record) }
    } catch (error) {
      if ((await this.options.catalog.get(target).catch(() => undefined)) === undefined) throw this.commandError(error)
      throw new RpcApplicationError("command_idempotency_conflict", `targetSessionId already exists with a different payload: ${target}`)
    }
  }

  async archiveSession(params: { readonly sessionId: string }): Promise<SessionArchiveResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    const record = await this.options.catalog.archive(id)
    if (record.archivedAt === undefined) {
      throw new RpcApplicationError("invalid_host_result", "Archive produced no archivedAt timestamp")
    }
    return { sessionId: id, archived: true, archivedAt: record.archivedAt }
  }

  async deleteSession(params: { readonly sessionId: string }): Promise<SessionDeleteResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    await this.options.catalog.delete(id)
    return { sessionId: id, deleted: true }
  }

  /**
   * Mailbox admission only; the run (if started) keeps driving in the
   * background under a local abort signal. The extensions are the
   * host-local control path the wire never exposes: they seed mode, rules,
   * and the turn ceiling atomically with admission so the recorded input
   * fingerprint never depends on which face submitted the run.
   */
  async submit(params: Omit<SessionSubmitParams, "lease">, extensions?: StartRunExtensions): Promise<SessionSubmitResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    if (params.expectedRevision !== undefined) await this.requireRevision(id, params.expectedRevision)
    const command = startRunCommandFromSubmitParams(params, extensions)
    const admission = await this.execute(id, command, { acceptOnly: true })
    assertInputAcceptedAdmission(admission)
    if (!admission.queued) {
      const controller = new AbortController()
      const key = `${id}:${params.commandId}`
      this.driving.set(key, controller)
      void this.driveRun(id, command, controller, key)
    }
    return inputAdmissionResult(id, params.commandId, admission)
  }

  /** Drives the admitted run; failure surfaces as canonical durable facts, never as an unhandled rejection. */
  private async driveRun(id: SessionId, command: SessionCommand, controller: AbortController, key: string): Promise<void> {
    try {
      await this.options.sessionServer.execute(id, command, { signal: controller.signal })
    } catch {
      // Admitted work reports failure as canonical input.failed /
      // run.updated facts the Host records.
    } finally {
      this.driving.delete(key)
    }
  }

  async plan(params: {
    readonly sessionId: string
    readonly commandId: string
    readonly text: string
    readonly context?: readonly string[]
    readonly workspace?: string
    readonly expectedRevision?: number
  }): Promise<JsonValue> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    if (params.expectedRevision !== undefined) await this.requireRevision(id, params.expectedRevision)
    return planResultFrom(id, params.commandId, await this.execute(id, planCommandFromParams(params)))
  }

  /** Steer only targets a live run: a run the snapshot does not show as running is `run_not_active`, never a silent queue. */
  async steer(params: {
    readonly sessionId: string
    readonly runId: string
    readonly commandId: string
    readonly text: string
  }): Promise<SessionSteerResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    requireRunningRun(await this.readSnapshot(id), params.runId)
    const admission = await this.execute(id, steerCommandFromParams(params.runId, params.commandId, params.text))
    return inputAdmissionResult(id, params.commandId, admission)
  }

  /** The durable stop command is the authority; aborting the local signal only stops this facade's own driving execution. */
  async cancelRun(params: { readonly sessionId: string; readonly runId: string }): Promise<SessionCancelRunResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    const precheck = cancelRunPrecheck(await this.readSnapshot(id), params.runId)
    if (precheck.state !== "running") return { requested: false, state: precheck.state }
    const durable = await this.execute(id, cancelRunCommandFor(params.runId))
    if (durable.type !== "run_cancellation") throw new RpcApplicationError("invalid_host_result", "Host did not return run_cancellation")
    if (durable.status === "requested") {
      this.driving.get(`${id}:${precheck.run.commandId}`)?.abort()
    }
    return { requested: durable.status === "requested", state: durable.status }
  }

  /** An input the snapshot never accepted is `not_found`; one already cancelled is `already_terminal`. */
  async cancelInput(params: { readonly sessionId: string; readonly inputId: string }): Promise<SessionCancelInputResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    const precheck = cancelInputPrecheck(await this.readSnapshot(id), params.inputId)
    if (precheck === "not_found") return { requested: false, state: "not_found" }
    if (precheck === "already_terminal") return { requested: false, state: "already_terminal" }
    const durable = await this.execute(id, cancelInputCommandFor(params.inputId))
    if (durable.type !== "input_cancelled") throw new RpcApplicationError("invalid_host_result", "Host did not return input_cancelled")
    return inputCancelResultFromDurableStatus(durable.status)
  }

  /**
   * Foreground user shell — a deliberate, recorded divergence from the
   * wire face: the wire's `session.executeUserShell` admits a background
   * user_shell task for remote clients, while the host-local TUI `!`
   * flow renders one synchronous run (goal row, shell tool row, committed
   * output) in place. This method therefore dispatches the internal
   * foreground `execute_user_shell` command and resolves only with its
   * committed content; a caller whose session stopped mid-flight sees the
   * host execution's own rejection, never content.
   */
  async executeUserShell(
    params: {
      readonly sessionId: string
      readonly commandId: string
      readonly command: string
      readonly cwd?: string
      readonly timeoutMs?: number
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<string> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    const result = await this.execute(
      id,
      executeUserShellCommand({
        commandId: params.commandId,
        command: params.command,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      }),
      options,
    )
    if (result.type !== "shell_result") throw new RpcApplicationError("invalid_host_result", "Host did not return shell_result")
    return result.result.content
  }

  /** Unified interaction resolution; the result echoes the canonical resolution read back from durable events. */
  async resolveInteraction(params: SessionResolveInteractionParams): Promise<SessionResolveInteractionResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    const deps: ResolveInteractionDeps = {
      readEvents: (session: SessionId) => this.readEvents(session, 0),
      execute: (session: SessionId, command: SessionCommand) => this.execute(session, command),
    }
    return params.kind === "tool_approval" ? resolveToolApprovalInteraction(deps, id, params) : resolveAskUserInteraction(deps, id, params)
  }

  /** Policy face: reads and writes share one result — the full policy document with the CAS revision. */
  async getPermissionPolicy(params: { readonly sessionId: string }): Promise<SessionGetPermissionPolicyResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    return { policy: policyDocument(id, await this.readSnapshot(id), this.options.selectableModes) }
  }

  async setPermissionMode(params: {
    readonly sessionId: string
    readonly mode: PublicPermissionModeValue
    readonly expectedPolicyRevision: number
  }): Promise<SessionSetPermissionModeResult> {
    requireSelectableMode(this.options.selectableModes, params.mode)
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    const command = setPermissionModeCommandFor(`session-setPermissionMode:${randomUUID()}`, params.mode, params.expectedPolicyRevision)
    const result = await this.execute(id, command)
    if (result.type !== "permission_updated") throw new RpcApplicationError("invalid_host_result", "Host did not return permission_updated")
    return { policy: policyDocument(id, result.snapshot, this.options.selectableModes) }
  }

  async setPermissionRules(params: {
    readonly sessionId: string
    readonly rules: readonly { readonly name: string; readonly behavior: "allow" | "ask" | "deny" }[]
    readonly expectedPolicyRevision: number
  }): Promise<SessionSetPermissionRulesResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    const command = setPermissionRulesCommandFor(`session-setPermissionRules:${randomUUID()}`, params.rules, params.expectedPolicyRevision)
    const result = await this.execute(id, command)
    if (result.type !== "permission_updated") throw new RpcApplicationError("invalid_host_result", "Host did not return permission_updated")
    return { policy: policyDocument(id, result.snapshot, this.options.selectableModes) }
  }

  async compact(params: {
    readonly sessionId: string
    readonly commandId: string
    readonly instructions?: string
  }): Promise<SessionCompactResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    return compactResultFrom(id, params.commandId, await this.execute(id, compactCommandFromParams(params)))
  }

  async addDirectory(params: {
    readonly sessionId: string
    readonly commandId: string
    readonly directory: string
    readonly workspaceRoot?: string
    readonly expectedScopeRevision?: number
  }): Promise<SessionAddDirectoryResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    return addDirectoryResultFrom(id, params.commandId, await this.execute(id, addDirectoryCommandFromParams(params)))
  }

  async setContextWindow(params: {
    readonly sessionId: string
    readonly commandId: string
    readonly contextWindow: number
  }): Promise<SessionSetContextWindowResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    return setContextWindowResultFrom(id, params.commandId, await this.execute(id, setContextWindowCommandFromParams(params)))
  }

  async clearContextWindow(params: { readonly sessionId: string; readonly commandId: string }): Promise<SessionClearContextWindowResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    return clearContextWindowResultFrom(id, params.commandId, await this.execute(id, clearContextWindowCommandFromParams(params)))
  }

  async selectAgent(params: {
    readonly sessionId: string
    readonly commandId: string
    readonly agentName?: string
  }): Promise<SessionSelectAgentResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    return selectAgentResultFrom(id, params.commandId, await this.execute(id, selectAgentCommandFromParams(params)))
  }

  async updateGoal(params: {
    readonly sessionId: string
    readonly commandId: string
    readonly update: SessionGoalUpdate
  }): Promise<SessionUpdateGoalResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    return updateGoalResultFrom(id, params.commandId, await this.execute(id, updateGoalCommandFromParams(params)))
  }

  /** Checkpoints travel as business facts only; the internal DAG cursor never reaches the caller. */
  async listCheckpoints(params: { readonly sessionId: string }): Promise<SessionListCheckpointsResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    const result = await this.execute(id, listCheckpointsCommand())
    if (result.type !== "checkpoints") throw new RpcApplicationError("invalid_host_result", "Host did not return checkpoints")
    return { sessionId: id, checkpoints: result.checkpoints.map(toPublicCheckpoint) }
  }

  /** Read-only preview: it leaves no durable history, so there is no commandId and no idempotency registry. */
  async previewRewind(params: {
    readonly sessionId: string
    readonly checkpointId: string
    readonly expectedRevision?: number
  }): Promise<SessionPreviewRewindResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    if (params.expectedRevision !== undefined) await this.requireRevision(id, params.expectedRevision)
    const result = await this.execute(id, previewRewindCommandFromParams(params))
    if (result.type !== "rewind_preview") throw new RpcApplicationError("invalid_host_result", "Host did not return rewind_preview")
    return {
      sessionId: id,
      checkpoint: toPublicCheckpoint(result.preview.checkpoint),
      currentRevision: result.preview.currentRevision,
      currentGeneration: result.preview.currentGeneration,
      staleRevision: result.preview.staleRevision,
      canCommit: result.preview.canCommit,
    }
  }

  /** Timeline move with revision CAS and commandId idempotency; `failed` rewind states are canonical facts, not errors. */
  async rewind(params: {
    readonly sessionId: string
    readonly commandId: string
    readonly checkpointId: string
    readonly expectedRevision?: number
  }): Promise<SessionRewindResult> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    if (params.expectedRevision !== undefined) await this.requireRevision(id, params.expectedRevision)
    return rewindResultFrom(id, params.commandId, await this.execute(id, rewindCommandFromParams(params)))
  }

  async trace(params: { readonly sessionId: string }): Promise<{ readonly sessionId: SessionId; readonly records: JsonValue }> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    return traceResultFrom(id, await this.execute(id, { protocolVersion: 1, type: "read_trace" }))
  }

  async modelCalls(params: {
    readonly sessionId: string
    readonly includePayload?: boolean
  }): Promise<{ readonly sessionId: SessionId; readonly records: JsonValue }> {
    const id = sessionId(params.sessionId)
    await this.requireExistingSession(id)
    return modelCallsResultFrom(
      id,
      await this.execute(id, {
        protocolVersion: 1,
        type: "read_model_calls",
        ...(params.includePayload === undefined ? {} : { includePayload: params.includePayload }),
      }),
    )
  }

  /**
   * Reconstructs the exact recorded start_run seed of the newest
   * unfinished run: the retry must repeat the recorded input — the
   * fingerprint is the authoritative seed (goal, context, files, rules,
   * maxTurns, permissionMode), so resubmitting anything else is an
   * idempotency conflict. Payload fields only backfill a legacy record
   * whose fingerprint never carried them. The anchor matches the
   * runtime's start_run family so a foreign family's CommandAccepted
   * sharing the commandId never feeds the retry.
   */
  async resumableSubmit(id: SessionId): Promise<ResumableSubmit> {
    const events = await this.readEvents(id, 0)
    const resumable = findResumableRun(events)
    if (resumable === undefined) {
      throw new RpcApplicationError("run_not_active", `Session has no unfinished run to resume: ${id}`)
    }
    const anchor = events.find(
      (event) =>
        event.type === "CommandAccepted" && event.payload.family === "start_run" && event.payload.commandId === resumable.payload.commandId,
    )
    const fingerprint = anchor?.type === "CommandAccepted" ? anchor.payload.inputFingerprint : undefined
    const recordedGoal = typeof fingerprint?.goal === "string" && fingerprint.goal !== "" ? fingerprint.goal : undefined
    const recordedContext = stringArrayField(fingerprint?.context)
    const recordedFileReferences = stringArrayField(fingerprint?.fileReferences)
    const recordedRules = permissionRulesField(fingerprint?.permissionRules)
    const recordedMaxTurns = typeof fingerprint?.maxTurns === "number" && fingerprint.maxTurns > 0 ? fingerprint.maxTurns : undefined
    const resumeMode = isSessionPermissionMode(fingerprint?.permissionMode) ? fingerprint?.permissionMode : undefined
    return {
      commandId: resumable.payload.commandId,
      goal: recordedGoal ?? resumable.payload.goal,
      ...(recordedContext === undefined ? {} : { context: recordedContext }),
      ...(recordedFileReferences === undefined ? {} : { fileReferences: recordedFileReferences }),
      ...(recordedRules === undefined ? {} : { permissionRules: recordedRules }),
      ...((recordedMaxTurns ?? resumable.payload.maxTurns) === undefined
        ? {}
        : { maxTurns: recordedMaxTurns ?? resumable.payload.maxTurns }),
      ...(resumeMode === undefined ? {} : { permissionMode: resumeMode }),
    }
  }
}

function stringArrayField(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string") ? value : undefined
}

function permissionRulesField(value: unknown): readonly SessionPermissionRule[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "object" && item !== null)
    ? (value as SessionPermissionRule[])
    : undefined
}
