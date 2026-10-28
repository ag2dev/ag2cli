import { basename } from "node:path"
import {
  type JsonValue,
  type PublicCheckpoint,
  type PublicPermissionPolicy,
  type SessionAddDirectoryResult,
  type SessionCancelInputResult,
  type SessionClearContextWindowResult,
  type SessionCompactResult,
  type SessionCreateParams,
  type SessionResolveInteractionParams,
  type SessionResolveInteractionResult,
  type SessionRewindResult,
  type SessionSelectAgentResult,
  type SessionSetContextWindowResult,
  type SessionSteerResult,
  type SessionSubmitParams,
  type SessionSubmitResult,
  type SessionUpdateGoalResult,
} from "@ag2cli/app-server-protocol/types.js"
import type { PublicPermissionModeValue, PublicSessionSnapshot, PublicSessionSummary } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import { assertJsonValue } from "@ag2cli/app-server-protocol/validation.js"
import { runId, type SessionId } from "@ag2cli/core/ids.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionGoalUpdate } from "@ag2cli/core/session/session-goal.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import type { SessionCheckpoint } from "@ag2cli/core/session/session-timeline.js"
import type { SessionPermissionMode, SessionPermissionRule } from "@ag2cli/core/session/session-security.js"
import { IncompatibleSessionEventError } from "@ag2cli/core/session/session-security.js"
import { SessionIdConflictError, type SessionCatalog, type SessionRecord } from "@ag2cli/runtime/ports/session-catalog.js"
import { CommandIdempotencyConflictError } from "@ag2cli/runtime/application/session/command-idempotency.js"
import { RunNotActiveError } from "@ag2cli/runtime/application/execution/run-not-active.js"
import { SessionPolicyRevisionConflictError } from "@ag2cli/runtime/application/session/permission-state.js"
import { SessionRevisionConflictError } from "@ag2cli/runtime/application/session/revision-conflict.js"
import { SessionWriterConflictError } from "@ag2cli/runtime/application/session/session-authority.js"
import { SessionExecutionReservationConflictError } from "@ag2cli/runtime/ports/session-execution-reservation.js"
import { ApprovalResolutionError } from "@ag2cli/runtime/application/session/approval-resolution.js"
import { AskResolutionError } from "@ag2cli/runtime/application/session/ask-resolution.js"
import {
  addAdditionalDirectoryCommand,
  cancelInputCommand,
  cancelRunCommand,
  clearContextWindowCommand,
  compactSessionCommand,
  createPlanCommand,
  previewRewindCommand,
  resolveApprovalCommand,
  resolveAskCommand,
  rewindCommand,
  setAgentCommand,
  setContextWindowCommand,
  setPermissionModeCommand,
  setPermissionRulesCommand,
  startRunCommand,
  steerCommand,
  updateGoalCommand,
  type SessionCommand,
  type SessionCommandResult,
} from "@ag2cli/session-protocol/session-command.js"
import { PublicSessionProjector } from "./public-projection.js"
import type { ServeWorkspaceRegistry } from "./rpc/method-context.js"
import { askOptionId, askQuestionId } from "./interaction-identity.js"

/**
 * Shared, connection-free mapping between the public session method face and
 * the internal command contract. Both consumers — the wire RPC handlers
 * (which add scope/lease/operation connection semantics) and the
 * in-process command facade (which deliberately adds none) — must derive
 * commands, results, and public error codes from this one source, so the two
 * faces cannot drift.
 */

export class RpcApplicationError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly details?: JsonValue,
  ) {
    super(message)
    this.name = "RpcApplicationError"
  }
}

export function toJson(value: unknown): JsonValue {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown
  return assertJsonValue(normalized, "App Server value")
}

export type PublicCommandError = {
  readonly code: string
  readonly message: string
  readonly details?: JsonValue
}

/**
 * Runtime-domain errors crossing the public boundary as stable §16 codes.
 * The wire error envelope and the in-process facade must classify these
 * identically; anything unrecognized returns undefined so each face can apply
 * its own terminal fallback.
 */
export function classifyRuntimeCommandError(
  error: unknown,
  isWorkspaceUnavailableError: (error: unknown) => error is { readonly message: string; readonly workspaceRoot: string },
): PublicCommandError | undefined {
  if (error instanceof CommandIdempotencyConflictError) {
    return {
      code: "command_idempotency_conflict",
      message: error.message,
      details: toJson({ family: error.family, commandId: error.commandId }),
    }
  }
  if (error instanceof RunNotActiveError) {
    // Steer raced a run that terminated between the snapshot check and the
    // serialized admission: the same typed refusal as the pre-check.
    return { code: "run_not_active", message: error.message, details: toJson({ runId: error.runId }) }
  }
  if (error instanceof SessionExecutionReservationConflictError) {
    return { code: "reservation_conflict", message: error.message, details: toJson({ sessionId: error.sessionId }) }
  }
  if (error instanceof SessionWriterConflictError) {
    return { code: "reservation_conflict", message: error.message, details: toJson({ sessionId: error.sessionId }) }
  }
  if (error instanceof SessionRevisionConflictError) {
    return {
      code: "revision_conflict",
      message: error.message,
      details: toJson({ sessionId: error.sessionId, expectedRevision: error.expectedRevision }),
    }
  }
  if (error instanceof SessionPolicyRevisionConflictError) {
    return {
      code: "policy_revision_conflict",
      message: error.message,
      details: toJson({
        sessionId: error.sessionId,
        expectedPolicyRevision: error.expectedPolicyRevision,
        actualPolicyRevision: error.actualPolicyRevision,
      }),
    }
  }
  if (error instanceof IncompatibleSessionEventError) {
    // A rules commit the current policy contract forbids (e.g. Allow(bash))
    // or incompatible persisted history: the typed reason crosses the wire
    // instead of an opaque internal error.
    return { code: "incompatible_session_event", message: error.message }
  }
  if (error instanceof SessionIdConflictError) {
    return { code: "session_id_conflict", message: error.message, details: toJson({ sessionId: error.sessionId }) }
  }
  if (isWorkspaceUnavailableError(error)) {
    return { code: "workspace_unavailable", message: error.message, details: toJson({ workspaceRoot: error.workspaceRoot }) }
  }
  return undefined
}

/**
 * Structural slice of the connection context the public snapshot projection
 * needs. MethodContext satisfies it; the in-process facade supplies the same
 * facts from its host assembly without any connection state.
 */
export interface PublicSnapshotContext {
  readonly workspaceRoot?: string
  readonly workspaceRegistry?: ServeWorkspaceRegistry
  readonly workspaceIdForRoot: (workspaceRoot: string) => string
  readonly selectableModes: readonly PublicPermissionModeValue[]
  readEvents(id: SessionId, afterRevision: number): Promise<readonly AgentEvent[]>
}

type PublicWorkspaceDescriptor = PublicSessionSummary["workspace"]

function workspaceDisplayName(workspaceRoot: string | undefined, workspaceId: string): string {
  const name = workspaceRoot === undefined ? "" : basename(workspaceRoot)
  return name.length > 0 ? name : workspaceId
}

/**
 * Workspace identity comes from the record (workspaceId, else derived from
 * its workspace root); availability is registry membership. A serve registry
 * that no longer knows the id — including legacy records that never carried
 * one — reports `unavailable` instead of hiding the session. Hosts without a
 * registry serve exactly one implicit live workspace, reported `available`.
 */
export async function publicWorkspaceFor(context: PublicSnapshotContext, record: SessionRecord): Promise<PublicWorkspaceDescriptor> {
  const root = record.snapshot.workspaceRoot ?? context.workspaceRoot
  const workspaceId = record.workspaceId ?? (root === undefined ? undefined : context.workspaceIdForRoot(root))
  if (workspaceId === undefined) {
    return { workspaceId: "unknown", displayName: "unknown", availability: "unavailable" }
  }
  if (context.workspaceRegistry !== undefined) {
    const registration = await context.workspaceRegistry.get(workspaceId)
    if (registration === undefined) {
      return { workspaceId, displayName: workspaceDisplayName(root, workspaceId), availability: "unavailable" }
    }
    return {
      workspaceId: registration.workspaceId,
      displayName: workspaceDisplayName(registration.workspaceRoot, registration.workspaceId),
      availability: "available",
    }
  }
  return { workspaceId, displayName: workspaceDisplayName(root, workspaceId), availability: "available" }
}

/**
 * Rebuilds the public snapshot of a record by replaying its full canonical
 * event stream through the projector; the record's own snapshot supplies the
 * authoritative session-level reducer facts.
 */
export async function assemblePublicSessionSnapshot(
  context: PublicSnapshotContext,
  record: SessionRecord,
  limits?: { readonly recentMessagesLimit?: number },
): Promise<PublicSessionSnapshot> {
  const projector = new PublicSessionProjector()
  for (const event of await context.readEvents(record.sessionId, 0)) projector.apply(event)
  return projector.snapshot(record.snapshot, {
    ...(record.title === undefined ? {} : { title: record.title }),
    workspace: await publicWorkspaceFor(context, record),
    selectableModes: context.selectableModes,
    ...(limits?.recentMessagesLimit === undefined ? {} : { recentMessagesLimit: limits.recentMessagesLimit }),
  })
}

/** Payload equality for create idempotency, normalized the same way the
 * catalog normalizes stored titles (trim; empty means absent). */
export function normalizePayloadTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim()
  return normalized || undefined
}

/**
 * Create replay: an existing record under the requested id is either the
 * same-payload retry (returns the record) or a `command_idempotency_conflict`.
 * A missing record returns undefined so the caller proceeds to create.
 */
export async function existingCreateReplay(
  catalog: SessionCatalog,
  id: SessionId,
  params: SessionCreateParams,
): Promise<SessionRecord | undefined> {
  const existing = await catalog.get(id).catch(() => undefined)
  if (existing === undefined) return undefined
  if (existing.workspaceId !== params.workspaceId || normalizePayloadTitle(existing.title) !== normalizePayloadTitle(params.title)) {
    throw new RpcApplicationError("command_idempotency_conflict", `sessionId already exists with a different payload: ${id}`)
  }
  return existing
}

/**
 * Unregistered workspace identities are `workspace_unavailable`;
 * `workspace_access_denied` stays reserved for registered-but-unauthorized
 * workspaces (connection-scope checks elsewhere).
 */
export async function resolveCreateWorkspaceRoot(workspaceId: string, context: PublicSnapshotContext): Promise<string> {
  if (context.workspaceRegistry !== undefined) {
    const workspace = await context.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) {
      throw new RpcApplicationError("workspace_unavailable", `workspaceId is not registered on this server: ${workspaceId}`)
    }
    return workspace.workspaceRoot
  }
  const workspaceRoot = context.workspaceRoot
  if (workspaceRoot !== undefined && context.workspaceIdForRoot(workspaceRoot) === workspaceId) return workspaceRoot
  throw new RpcApplicationError(
    "workspace_unavailable",
    workspaceRoot === undefined
      ? "No workspace is registered on this server"
      : `workspaceId is not registered on this server: ${workspaceId}`,
  )
}

/** Facade-level start_run extensions beyond the wire submit params: the
 * in-process host-local control path (contract §1.3) seeds mode, rules, and
 * the turn ceiling atomically with admission, exactly like the internal
 * session client — the recorded input fingerprint must not depend on which
 * face submitted the run. */
export interface StartRunExtensions {
  readonly permissionMode?: SessionPermissionMode
  readonly permissionRules?: readonly SessionPermissionRule[]
  readonly maxTurns?: number
}

export function startRunCommandFromSubmitParams(params: SessionSubmitParams, extensions?: StartRunExtensions): SessionCommand {
  return startRunCommand({
    commandId: params.commandId,
    goal: params.text,
    ...(params.context === undefined ? {} : { context: params.context }),
    ...(params.fileReferences === undefined ? {} : { fileReferences: params.fileReferences.map((ref) => ref.path) }),
    ...((params.maxTurns ?? extensions?.maxTurns) === undefined ? {} : { maxTurns: params.maxTurns ?? extensions?.maxTurns }),
    ...(extensions?.permissionMode === undefined ? {} : { permissionMode: extensions.permissionMode }),
    ...(extensions?.permissionRules === undefined ? {} : { permissionRules: extensions.permissionRules }),
  })
}

export function assertInputAcceptedAdmission(
  admission: SessionCommandResult,
): asserts admission is Extract<SessionCommandResult, { type: "input_accepted" }> {
  if (admission.type !== "input_accepted") {
    throw new RpcApplicationError("invalid_host_result", "Host did not return input_accepted")
  }
}

export function inputAdmissionResult(
  id: SessionId,
  commandId: string,
  admission: SessionCommandResult,
): SessionSubmitResult | SessionSteerResult {
  assertInputAcceptedAdmission(admission)
  return {
    accepted: true,
    sessionId: id,
    commandId,
    inputId: admission.inputId,
    queued: admission.queued,
  }
}

type RunEntry = NonNullable<SessionSnapshot["runs"]>[number]

/** Steer only targets a live run: a run the snapshot does not show as
 * running is `run_not_active`, never a silent queue for a future run. */
export function requireRunningRun(snapshot: SessionSnapshot, requestedRunId: string): RunEntry {
  const run = snapshot.runs?.find((candidate) => candidate.id.toString() === requestedRunId)
  if (run === undefined || run.status !== "running") {
    throw new RpcApplicationError("run_not_active", `Run is not running: ${requestedRunId}`)
  }
  return run
}

export function steerCommandFromParams(requestedRunId: string, commandId: string, text: string): SessionCommand {
  return steerCommand({ commandId, runId: runId(requestedRunId), text })
}

export type CancelPrecheck = { readonly state: "not_found" | "already_terminal" } | { readonly state: "running"; readonly run: RunEntry }

/**
 * CancelRun reports a request state, not a completion: the terminal fact is
 * the run.updated event. The snapshot is the same durable history the Host
 * reduces, so a run it does not know is `not_found` and a terminal one
 * `already_terminal` — both converge without a Host write, keeping cancel
 * usable while the workspace root is gone.
 */
export function cancelRunPrecheck(snapshot: SessionSnapshot, requestedRunId: string): CancelPrecheck {
  const run = snapshot.runs?.find((candidate) => candidate.id.toString() === requestedRunId)
  if (run === undefined) return { state: "not_found" }
  if (run.status !== "running") return { state: "already_terminal" }
  return { state: "running", run }
}

export function cancelRunCommandFor(requestedRunId: string): SessionCommand {
  return cancelRunCommand({ commandId: `session-cancelRun:${requestedRunId}`, runId: runId(requestedRunId), reason: "run cancelled" })
}

export function cancelInputPrecheck(snapshot: SessionSnapshot, inputId: string): "not_found" | "already_terminal" | "pending" {
  const input = snapshot.inputs.find((candidate) => candidate.inputId === inputId)
  if (input === undefined) return "not_found"
  if (input.status === "cancelled" || input.status === "cancelled-before-acceptance") return "already_terminal"
  return "pending"
}

export function cancelInputCommandFor(inputId: string): SessionCommand {
  return cancelInputCommand({ commandId: `session-cancelInput:${inputId}`, inputId })
}

export function inputCancelResultFromDurableStatus(status: string): SessionCancelInputResult {
  // "cancelled-before-acceptance" can only surface for an inputId the
  // snapshot never accepted: the mailbox serializes acceptance, so no
  // in-flight admission can still land behind this cancellation.
  if (status === "cancelled-before-acceptance") return { requested: false, state: "not_found" }
  return status === "already-delivered" ? { requested: false, state: "already_terminal" } : { requested: true, state: "requested" }
}

export function requireSelectableMode(selectableModes: readonly PublicPermissionModeValue[], mode: PublicPermissionModeValue): void {
  if (!selectableModes.includes(mode)) {
    throw new RpcApplicationError("invalid_params", `mode is not selectable on this server: ${mode}`)
  }
}

export function setPermissionModeCommandFor(
  commandId: string,
  mode: PublicPermissionModeValue,
  expectedPolicyRevision: number,
): SessionCommand {
  return setPermissionModeCommand({ commandId, mode, expectedPolicyRevision })
}

export function setPermissionRulesCommandFor(
  commandId: string,
  rules: readonly { readonly name: string; readonly behavior: "allow" | "ask" | "deny" }[],
  expectedPolicyRevision: number,
): SessionCommand {
  return setPermissionRulesCommand({ commandId, rules, expectedPolicyRevision })
}

/** Policy face (contract §13): reads and writes share one result — the full
 * policy document — so a writer sees the new `policyRevision` it must carry
 * into its next CAS. Rule bodies travel only through this face, never
 * through the snapshot projection. */
export function policyDocument(
  id: SessionId,
  snapshot: SessionSnapshot,
  selectableModes: readonly PublicPermissionModeValue[],
): PublicPermissionPolicy {
  return {
    sessionId: id,
    mode: snapshot.permissionMode,
    policyRevision: snapshot.policyRevision,
    rules: snapshot.permissionRules.map((rule) => ({ name: rule.name, behavior: rule.behavior })),
    selectableModes: [...selectableModes],
  }
}

/**
 * Unified interaction resolution (contract §10) core, shared by the wire and
 * the in-process facade. Idempotency is resource-keyed on the interaction
 * with canonical first-writer-wins; the `resolutionId` stays the caller's
 * private retry identity. The result echoes the canonical resolution read
 * back from durable events, never a client-supplied echo.
 */
export interface ResolveInteractionDeps {
  readEvents(id: SessionId): Promise<readonly AgentEvent[]>
  execute(id: SessionId, command: SessionCommand): Promise<SessionCommandResult>
}

export async function resolveToolApprovalInteraction(
  deps: ResolveInteractionDeps,
  id: SessionId,
  params: Extract<SessionResolveInteractionParams, { kind: "tool_approval" }>,
): Promise<SessionResolveInteractionResult> {
  // The public option vocabulary is fixed: approve_once / deny.
  const decision = params.optionId === "approve_once" ? "approved" : params.optionId === "deny" ? "denied" : undefined
  if (decision === undefined) {
    throw new RpcApplicationError("invalid_params", `Unknown tool approval optionId: ${params.optionId}`)
  }
  const requested = (await deps.readEvents(id)).find(
    (event): event is Extract<AgentEvent, { type: "ToolApprovalRequested" }> =>
      event.type === "ToolApprovalRequested" && event.eventId === params.interactionId,
  )
  if (requested === undefined) {
    throw new RpcApplicationError("stale_approval", `No tool approval with interactionId: ${params.interactionId}`)
  }
  let result: SessionCommandResult
  try {
    result = await deps.execute(
      id,
      resolveApprovalCommand({
        runId: requested.payload.runId,
        turn: requested.payload.turn,
        toolUseId: requested.payload.toolUseId,
        preparedEventId: requested.payload.preparedEventId,
        expectedScopeRevision: params.expectedScopeRevision,
        expectedPolicyRevision: params.expectedPolicyRevision,
        decision,
      }),
    )
  } catch (error) {
    if (error instanceof ApprovalResolutionError) throw await approvalResolutionFailure(deps, id, error, requested)
    throw error
  }
  if (result.type !== "snapshot") throw new RpcApplicationError("invalid_host_result", "Host did not return an approval snapshot")
  const resolved = findToolApprovalResolution(await deps.readEvents(id), requested)
  if (resolved === undefined) {
    throw new RpcApplicationError("invalid_host_result", "Host committed no tool approval resolution event")
  }
  return {
    resolved: true,
    interactionId: params.interactionId,
    kind: "tool_approval",
    resolution: {
      interactionId: params.interactionId,
      kind: "tool_approval",
      outcome: resolved.payload.decision,
      resolvedAt: resolved.timestamp,
    },
  }
}

function findToolApprovalResolution(
  events: readonly AgentEvent[],
  requested: Extract<AgentEvent, { type: "ToolApprovalRequested" }>,
): Extract<AgentEvent, { type: "ToolApprovalResolved" }> | undefined {
  return [...events]
    .reverse()
    .find(
      (event): event is Extract<AgentEvent, { type: "ToolApprovalResolved" }> =>
        event.type === "ToolApprovalResolved" &&
        event.payload.runId === requested.payload.runId &&
        event.payload.turn === requested.payload.turn &&
        event.payload.toolUseId === requested.payload.toolUseId &&
        event.payload.preparedEventId === requested.payload.preparedEventId,
    )
}

async function approvalResolutionFailure(
  deps: ResolveInteractionDeps,
  id: SessionId,
  error: ApprovalResolutionError,
  requested: Extract<AgentEvent, { type: "ToolApprovalRequested" }>,
): Promise<never> {
  if (error.code === "stale_approval") throw new RpcApplicationError("stale_approval", error.message)
  // The remaining runtime codes (already resolved, ownership conflicts)
  // all mean the interaction carries a canonical decision the caller
  // cannot replace; the public face reports it with that decision.
  const resolved = findToolApprovalResolution(await deps.readEvents(id), requested)
  throw new RpcApplicationError(
    "interaction_already_resolved",
    error.message,
    resolved === undefined
      ? undefined
      : toJson({
          interactionId: requested.eventId,
          kind: "tool_approval",
          outcome: resolved.payload.decision,
          resolvedAt: resolved.timestamp,
        }),
  )
}

export async function resolveAskUserInteraction(
  deps: ResolveInteractionDeps,
  id: SessionId,
  params: Extract<SessionResolveInteractionParams, { kind: "ask_user" }>,
): Promise<SessionResolveInteractionResult> {
  const requested = (await deps.readEvents(id)).find(
    (event): event is Extract<AgentEvent, { type: "AskUserRequested" }> =>
      event.type === "AskUserRequested" && event.eventId === params.interactionId,
  )
  if (requested === undefined) {
    throw new RpcApplicationError("interaction_expired", `No ask user interaction with interactionId: ${params.interactionId}`)
  }
  // Ids decode by recomputing the derived candidates (see interaction-identity.ts).
  const rows = askAnswerRows(requested, params.answer)
  let result: SessionCommandResult
  try {
    result = await deps.execute(
      id,
      resolveAskCommand({
        runId: requested.payload.runId,
        turn: requested.payload.turn,
        toolUseId: requested.payload.toolUseId,
        outcome: params.answer.outcome,
        ...(params.answer.outcome === "answered" && rows !== undefined ? { answers: rows } : {}),
        ...(params.answer.outcome === "chat" && rows !== undefined ? { contextAnswers: rows } : {}),
      }),
    )
  } catch (error) {
    if (error instanceof AskResolutionError) throw await askResolutionFailure(deps, id, error, requested)
    throw error
  }
  if (result.type !== "snapshot") throw new RpcApplicationError("invalid_host_result", "Host did not return an ask snapshot")
  const resolved = findAskResolution(await deps.readEvents(id), requested)
  if (resolved === undefined) {
    throw new RpcApplicationError("invalid_host_result", "Host committed no ask resolution event")
  }
  return {
    resolved: true,
    interactionId: params.interactionId,
    kind: "ask_user",
    resolution: {
      interactionId: params.interactionId,
      kind: "ask_user",
      outcome: resolved.payload.outcome,
      resolvedAt: resolved.timestamp,
    },
  }
}

function findAskResolution(
  events: readonly AgentEvent[],
  requested: Extract<AgentEvent, { type: "AskUserRequested" }>,
): Extract<AgentEvent, { type: "AskUserResolved" }> | undefined {
  return [...events]
    .reverse()
    .find(
      (event): event is Extract<AgentEvent, { type: "AskUserResolved" }> =>
        event.type === "AskUserResolved" &&
        event.payload.runId === requested.payload.runId &&
        event.payload.turn === requested.payload.turn &&
        event.payload.toolUseId === requested.payload.toolUseId,
    )
}

async function askResolutionFailure(
  deps: ResolveInteractionDeps,
  id: SessionId,
  error: AskResolutionError,
  requested: Extract<AgentEvent, { type: "AskUserRequested" }>,
): Promise<never> {
  // The runtime codes are internal vocabulary; the closed public catalog
  // maps staleness to interaction_expired and answer-shape problems to
  // invalid_params.
  if (error.code === "stale_ask") throw new RpcApplicationError("interaction_expired", error.message)
  if (error.code === "invalid_answers") throw new RpcApplicationError("invalid_params", error.message)
  // ask_already_resolved: report the canonical decision the caller cannot
  // replace, including on a same-outcome replay the runtime accepted.
  const resolved = findAskResolution(await deps.readEvents(id), requested)
  throw new RpcApplicationError(
    "interaction_already_resolved",
    error.message,
    resolved === undefined
      ? undefined
      : toJson({
          interactionId: requested.eventId,
          kind: "ask_user",
          outcome: resolved.payload.outcome,
          resolvedAt: resolved.timestamp,
        }),
  )
}

/**
 * Maps public selection rows onto the runtime's label-keyed answer rows, in
 * durable question order. Every id must match a recomputed derived id (see
 * interaction-identity.ts); anything else — unknown or missing question,
 * unknown or repeated option, or a selection count the question's
 * multiSelect does not admit — is an invalid_params before the Host is
 * involved. Returns undefined when the outcome carries no selections.
 */
function askAnswerRows(
  requested: Extract<AgentEvent, { type: "AskUserRequested" }>,
  answer: Extract<SessionResolveInteractionParams, { kind: "ask_user" }>["answer"],
): readonly { questionIndex: number; header: string; selected: readonly string[]; freeText?: string }[] | undefined {
  if (answer.outcome === "declined") return undefined
  const byQuestion = new Map<string, readonly string[]>()
  for (const row of answer.answers ?? []) {
    if (byQuestion.has(row.questionId)) {
      throw new RpcApplicationError("invalid_params", `Answer repeats a question: ${row.questionId}`)
    }
    byQuestion.set(row.questionId, row.selectedOptionIds)
  }
  const freeTextByQuestion = new Map<string, string>()
  for (const row of answer.freeText ?? []) {
    if (freeTextByQuestion.has(row.questionId)) {
      throw new RpcApplicationError("invalid_params", `Answer repeats freeText for a question: ${row.questionId}`)
    }
    freeTextByQuestion.set(row.questionId, row.text)
  }
  const outcome = answer.outcome
  const rows = requested.payload.questions.map((question, questionIndex) => {
    const questionId = askQuestionId(requested.eventId, questionIndex)
    const selectedOptionIds = byQuestion.get(questionId) ?? []
    const text = freeTextByQuestion.get(questionId)
    const isAnswered = outcome === "answered"
    if (isAnswered && !byQuestion.has(questionId)) {
      throw new RpcApplicationError("invalid_params", `Answer is missing the question: ${questionId}`)
    }
    if (byQuestion.has(questionId)) byQuestion.delete(questionId)
    if (freeTextByQuestion.has(questionId)) freeTextByQuestion.delete(questionId)
    const multiSelect = question.multiSelect ?? false
    const hasText = text?.trim().length !== undefined && text.trim().length > 0
    const seen = new Set<string>()
    const selected = selectedOptionIds.map((optionId) => {
      const optionIndex = question.options.findIndex((_, candidate) => askOptionId(questionId, candidate) === optionId)
      if (optionIndex < 0 || seen.has(optionId)) {
        throw new RpcApplicationError("invalid_params", `Question ${questionId} has an unusable selection: ${optionId}`)
      }
      seen.add(optionId)
      return question.options[optionIndex]!.label
    })
    if (isAnswered && selected.length === 0 && !hasText) {
      throw new RpcApplicationError("invalid_params", `Question ${questionId} requires a selection or non-empty freeText`)
    }
    if (!multiSelect && ((hasText && selected.length > 0) || selected.length > 1)) {
      throw new RpcApplicationError("invalid_params", `Question ${questionId} violates single-select rules`)
    }
    if (!isAnswered && selected.length === 0 && !hasText) return undefined
    return {
      questionIndex,
      header: question.header ?? question.question.slice(0, 12),
      selected,
      ...(text === undefined ? {} : { freeText: text }),
    }
  })
  if (byQuestion.size > 0) {
    throw new RpcApplicationError("invalid_params", `Answer names unknown questions: ${[...byQuestion.keys()].join(", ")}`)
  }
  if (freeTextByQuestion.size > 0) {
    throw new RpcApplicationError("invalid_params", `Answer names unknown questions: ${[...freeTextByQuestion.keys()].join(", ")}`)
  }
  return rows.filter((row): row is NonNullable<typeof row> => row !== undefined)
}

export function planCommandFromParams(params: {
  readonly commandId: string
  readonly text: string
  readonly context?: readonly string[]
  readonly workspace?: string
}): SessionCommand {
  return createPlanCommand({
    commandId: params.commandId,
    goal: params.text,
    ...(params.context === undefined ? {} : { context: params.context }),
    ...(params.workspace === undefined ? {} : { workspace: params.workspace }),
  })
}

export function planResultFrom(
  id: SessionId,
  commandId: string,
  result: SessionCommandResult,
): { accepted: true; sessionId: SessionId; commandId: string; intent: "plan"; result: JsonValue; snapshot: JsonValue } {
  if (result.type !== "plan_created") throw new RpcApplicationError("invalid_host_result", "Host did not return plan_created")
  return {
    accepted: true as const,
    sessionId: id,
    commandId,
    intent: "plan",
    result: toJson(result.plan),
    snapshot: toJson(result.snapshot),
  }
}

export function compactCommandFromParams(params: { readonly commandId: string; readonly instructions?: string }): SessionCommand {
  return compactSessionCommand({
    commandId: params.commandId,
    ...(params.instructions === undefined ? {} : { instructions: params.instructions }),
  })
}

export function compactResultFrom(id: SessionId, commandId: string, result: SessionCommandResult): SessionCompactResult {
  if (result.type !== "compacted") throw new RpcApplicationError("invalid_host_result", "Host did not return compacted")
  return {
    accepted: true as const,
    sessionId: id,
    commandId,
    changed: result.changed,
    inputMessageCount: result.inputMessageCount,
    outputMessageCount: result.outputMessageCount,
    ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
  }
}

export function addDirectoryCommandFromParams(params: {
  readonly commandId: string
  readonly directory: string
  readonly workspaceRoot?: string
  readonly expectedScopeRevision?: number
}): SessionCommand {
  return addAdditionalDirectoryCommand({
    commandId: params.commandId,
    directory: params.directory,
    ...(params.workspaceRoot === undefined ? {} : { workspaceRoot: params.workspaceRoot }),
    ...(params.expectedScopeRevision === undefined ? {} : { expectedScopeRevision: params.expectedScopeRevision }),
  })
}

export function addDirectoryResultFrom(id: SessionId, commandId: string, result: SessionCommandResult): SessionAddDirectoryResult {
  if (result.type !== "additional_directory_added") {
    throw new RpcApplicationError("invalid_host_result", "Host did not return additional_directory_added")
  }
  return {
    accepted: true as const,
    sessionId: id,
    commandId,
    changed: result.changed,
    directory: result.directory,
    additionalDirectories: [...result.additionalDirectories],
    scopeRevision: result.scopeRevision,
    ...(result.scopeDigest === undefined ? {} : { scopeDigest: result.scopeDigest }),
  }
}

export function setContextWindowCommandFromParams(params: { readonly commandId: string; readonly contextWindow: number }): SessionCommand {
  return setContextWindowCommand({ commandId: params.commandId, contextWindow: params.contextWindow })
}

export function setContextWindowResultFrom(id: SessionId, commandId: string, result: SessionCommandResult): SessionSetContextWindowResult {
  if (result.type !== "context_window_updated") {
    throw new RpcApplicationError("invalid_host_result", "Host did not return context_window_updated")
  }
  return {
    accepted: true as const,
    sessionId: id,
    commandId,
    changed: result.changed,
    ...(result.contextWindowOverride === undefined ? {} : { contextWindowOverride: result.contextWindowOverride }),
  }
}

export function clearContextWindowCommandFromParams(params: { readonly commandId: string }): SessionCommand {
  return clearContextWindowCommand({ commandId: params.commandId })
}

export function clearContextWindowResultFrom(
  id: SessionId,
  commandId: string,
  result: SessionCommandResult,
): SessionClearContextWindowResult {
  if (result.type !== "context_window_updated") {
    throw new RpcApplicationError("invalid_host_result", "Host did not return context_window_updated")
  }
  return { accepted: true as const, sessionId: id, commandId, changed: result.changed }
}

export function selectAgentCommandFromParams(params: { readonly commandId: string; readonly agentName?: string }): SessionCommand {
  return setAgentCommand({ commandId: params.commandId, ...(params.agentName === undefined ? {} : { agentName: params.agentName }) })
}

export function selectAgentResultFrom(id: SessionId, commandId: string, result: SessionCommandResult): SessionSelectAgentResult {
  if (result.type !== "agent_updated") throw new RpcApplicationError("invalid_host_result", "Host did not return agent_updated")
  return {
    accepted: true as const,
    sessionId: id,
    commandId,
    changed: result.changed,
    ...(result.agentName === undefined ? {} : { agentName: result.agentName }),
  }
}

export function updateGoalCommandFromParams(params: { readonly commandId: string; readonly update: SessionGoalUpdate }): SessionCommand {
  return updateGoalCommand({ commandId: params.commandId, update: params.update })
}

export function updateGoalResultFrom(id: SessionId, commandId: string, result: SessionCommandResult): SessionUpdateGoalResult {
  if (result.type !== "goal_updated") throw new RpcApplicationError("invalid_host_result", "Host did not return goal_updated")
  return { accepted: true as const, sessionId: id, commandId, changed: result.changed, goal: result.goal }
}

export function previewRewindCommandFromParams(params: {
  readonly checkpointId: string
  readonly expectedRevision?: number
}): SessionCommand {
  return previewRewindCommand({
    checkpointId: params.checkpointId,
    ...(params.expectedRevision === undefined ? {} : { expectedRevision: params.expectedRevision }),
  })
}

export function rewindCommandFromParams(params: {
  readonly commandId: string
  readonly checkpointId: string
  readonly expectedRevision?: number
}): SessionCommand {
  return rewindCommand({
    commandId: params.commandId,
    checkpointId: params.checkpointId,
    ...(params.expectedRevision === undefined ? {} : { expectedRevision: params.expectedRevision }),
  })
}

/** Rewind results carry facts, not a snapshot (contract §15.7); `failed`
 * rewind states are canonical facts, not RPC errors. */
export function rewindResultFrom(id: SessionId, commandId: string, result: SessionCommandResult): SessionRewindResult {
  if (result.type !== "rewind_result") throw new RpcApplicationError("invalid_host_result", "Host did not return rewind_result")
  const rewind = result.result
  return {
    accepted: true as const,
    sessionId: id,
    commandId,
    status: rewind.status,
    rewindId: rewind.rewindId,
    ...(rewind.status === "failed" || rewind.status === "already_failed" ? { error: rewind.error } : {}),
  }
}

/** Internal checkpoint to the public projection: the `head` DAG cursor is a
 * physical-history address and never reaches the wire — clients address
 * checkpoints by business identity plus canonical revision/generation. */
export function toPublicCheckpoint(checkpoint: SessionCheckpoint): PublicCheckpoint {
  return {
    checkpointId: checkpoint.checkpointId,
    kind: checkpoint.kind,
    headRevision: checkpoint.headRevision,
    generation: checkpoint.generation,
    createdAt: checkpoint.createdAt,
  }
}

export function traceResultFrom(id: SessionId, result: SessionCommandResult): { sessionId: SessionId; records: JsonValue } {
  if (result.type !== "trace") throw new RpcApplicationError("invalid_host_result", "Host did not return a trace")
  return { sessionId: id, records: toJson(result.records) }
}

export function modelCallsResultFrom(id: SessionId, result: SessionCommandResult): { sessionId: SessionId; records: JsonValue } {
  if (result.type !== "model_calls") throw new RpcApplicationError("invalid_host_result", "Host did not return model_calls")
  return { sessionId: id, records: toJson(result.records) }
}
