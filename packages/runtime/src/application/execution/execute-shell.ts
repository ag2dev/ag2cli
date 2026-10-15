import type { AgentEvent, EventTrace } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import type { RunId, SessionId } from "@ag2cli/core/ids.js"
import { DEFAULT_SESSION_PERMISSION_MODE } from "@ag2cli/core/session/session-security.js"
import type { ApprovalBroker, DenialReason } from "../../ports/approval-broker.js"
import { approvalDecisionOf } from "../../ports/approval-broker.js"
import type { EventStore } from "../../ports/event-store.js"
import { hasModelBashAuthority, type ToolExecutor } from "../../ports/tool-executor.js"
import { toolIdempotencyKey } from "../../ports/tool-executor.js"
import { safeTraceSink, traceAttributesFromToolMetadata, type TraceSink } from "../../ports/trace-sink.js"
import type { PermissionDenialCode, ToolPreparation, ToolResult, ToolResultDenial } from "@ag2cli/core/tool-facts.js"
import type { RuntimeEnvironment } from "../../ports/environment.js"
import type { BashSecurityPort } from "../../ports/security.js"
import type { WorkspacePolicyFactory, WorkspaceScopeDigest } from "../../ports/workspace.js"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import { reduceCanonicalSession } from "@ag2cli/core/session/canonical-session.js"
import { TransientEventPublisher } from "./transient-events.js"
import { judgeModelToolCall, type PermissionSurfaces } from "./permission-judgment.js"
import type { ApprovalResolutionWriter } from "../session/approval-resolution.js"
import {
  commandIdempotencyConflictError,
  resolveCommandIdempotency,
  type CommandIdempotencyFamily,
} from "../session/command-idempotency.js"
import type { SessionExecutionReservation } from "../../ports/session-execution-reservation.js"
import { commitSessionEvents, SessionAuthority } from "../session/session-authority.js"
import {
  APPROVAL_INPUT_MISMATCH_REASON,
  PREVIOUS_RESULT_NOT_REUSABLE_NOTICE,
  STALE_POLICY_RECOVERY_DENIAL,
  type PolicySerialDeps,
} from "./policy-serial-point.js"
import { deniedReasons } from "./denial-reasons.js"

/**
 * Recovery-fence cause for an adopted execution whose completion never
 * committed durably: a blind retry is refused; the caller must resubmit.
 * Rendered as `stale_policy: <reason>`.
 */
const INTERRUPTED_EXECUTION_RETRY_STOPPED_REASON =
  "previous Bash execution was interrupted before its completion event was durable; resubmit the command to run it again"

export interface ExecuteShellInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly workspace?: string
  readonly signal?: AbortSignal
}

export interface ExecuteUserShellInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

type ExecuteShellRequest = ExecuteShellInput | ExecuteUserShellInput

interface ExecuteShellFingerprint {
  readonly goal: string
  readonly input: unknown
}

export const EXECUTE_SHELL_FAMILY: CommandIdempotencyFamily<ExecuteShellFingerprint> = {
  family: "execute_shell",
  findAnchor: (events, commandId) => {
    const runStarted = events.find(
      (event): event is Extract<AgentEvent, { type: "RunStarted" }> => event.type === "RunStarted" && event.payload.commandId === commandId,
    )
    if (runStarted === undefined) return undefined
    const requested = events.find(
      (event): event is Extract<AgentEvent, { type: "ToolCallRequested" }> =>
        event.type === "ToolCallRequested" && event.payload.runId === runStarted.payload.runId,
    )
    return {
      event:
        events.find(
          (event): event is Extract<AgentEvent, { type: "InputAccepted" }> =>
            event.type === "InputAccepted" && event.payload.commandId === commandId,
        ) ?? runStarted,
      inputFingerprint: {
        goal: runStarted.payload.goal,
        input: requested?.payload.input,
      },
    }
  },
  findTerminal: (events, anchor) => {
    const runStarted = events.find(
      (event): event is Extract<AgentEvent, { type: "RunStarted" }> =>
        event.type === "RunStarted" && event.payload.commandId === (anchor.type === "InputAccepted" ? anchor.payload.commandId : ""),
    )
    if (runStarted === undefined) return undefined
    return events.find((event) => event.type === "ToolResultCommitted" && event.payload.runId === runStarted.payload.runId)
  },
  fingerprintsEqual: (recorded, attempted) => {
    if (recorded.goal !== attempted.goal) return false
    // A RunStarted and its ToolCallRequested are appended as one canonical setup
    // batch. This fallback only protects recovery of older partial histories where
    // the first event was durable but the requested input was not.
    if (recorded.input === undefined) return true
    return JSON.stringify(recorded.input) === JSON.stringify(attempted.input)
  },
}

export interface ExecuteShellResult {
  readonly runId: RunId
  readonly result: ToolResult
}

export interface ExecuteShellDependencies {
  readonly tools: ToolExecutor
  /** Private executor for explicit user `!` input; never advertised to the model. */
  readonly shellTools?: ToolExecutor
  readonly approval: ApprovalBroker
  readonly approvalResolution: ApprovalResolutionWriter
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly identity: {
    nextEventId(): string
    nextRunId(): RunId
    now(): string
  }
  readonly workspacePolicyFactory?: WorkspacePolicyFactory
  readonly workspaceScopeDigest?: WorkspaceScopeDigest
  readonly environment?: RuntimeEnvironment
  readonly bashSecurity?: BashSecurityPort
  /** Interactive surfaces for the canonical permission judgment. */
  readonly permissionSurfaces: PermissionSurfaces
  /** Builds the spawn fence stamped into the shell execution context. */
  readonly preSpawnGateFor: PolicySerialDeps["preSpawnGateFor"]
  readonly traceSink?: TraceSink
  readonly onEventsAppended?: (events: readonly AgentEvent[]) => Promise<void> | void
  readonly onTransientEvent?: (event: TransientStreamEvent) => void
  readonly executionReservation?: SessionExecutionReservation
  readonly reservationOwnerId?: string
}

/** Execute one server shell command without entering the model loop. */
export class ExecuteShellUseCase {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly transientPublisher: TransientEventPublisher
  private readonly traceSink: TraceSink
  private readonly authority: SessionAuthority

  constructor(private readonly deps: ExecuteShellDependencies) {
    this.transientPublisher = new TransientEventPublisher(deps.identity, deps.onTransientEvent)
    this.traceSink = safeTraceSink(deps.traceSink)
    this.authority = deps.authority ?? new SessionAuthority(deps.eventStore)
  }

  async execute(input: ExecuteShellRequest): Promise<ExecuteShellResult> {
    const previous = this.pending.get(input.sessionId)
    const operation = (previous ?? Promise.resolve()).then(async () => {
      if (this.deps.executionReservation === undefined) return this.executeNow(input)
      const events = await this.deps.eventStore.read(input.sessionId)
      const idempotency = resolveCommandIdempotency(EXECUTE_SHELL_FAMILY, events, {
        family: EXECUTE_SHELL_FAMILY.family,
        commandId: input.commandId,
        inputFingerprint: {
          goal: `! ${this.shellDisplayCommand(input)}`,
          input: this.shellInput(input),
        },
      })
      if (idempotency.status === "replay" || idempotency.status === "conflict") return this.executeNow(input)
      const lease = await this.deps.executionReservation.acquire({
        sessionId: input.sessionId,
        commandId: input.commandId,
        ownerId: this.deps.reservationOwnerId ?? `pid-${process.pid}`,
        baseRevision: events.length,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      try {
        return await this.executeNow(input)
      } catch (error) {
        // A cancelled shell may already have spawned a process. Preserve the
        // unknown-side-effect marker unless a terminal event was durably
        // appended and the normal path reaches finally.
        await lease.release("aborted").catch(() => {})
        throw error
      } finally {
        await lease.release(input.signal?.aborted ? "aborted" : "released").catch(() => {})
      }
    })
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    )
    this.pending.set(input.sessionId, tracked)
    try {
      return await operation
    } finally {
      if (this.pending.get(input.sessionId) === tracked) this.pending.delete(input.sessionId)
    }
  }

  private async executeNow(input: ExecuteShellRequest): Promise<ExecuteShellResult> {
    validateInput(input)
    const previous = await this.deps.eventStore.read(input.sessionId)
    const idempotency = resolveCommandIdempotency(EXECUTE_SHELL_FAMILY, previous, {
      family: EXECUTE_SHELL_FAMILY.family,
      commandId: input.commandId,
      inputFingerprint: {
        goal: `! ${this.shellDisplayCommand(input)}`,
        input: this.shellInput(input),
      },
    })
    if (idempotency.status === "conflict") throw commandIdempotencyConflictError(idempotency.record)
    if (idempotency.status === "replay") return replayShellTerminal(idempotency.terminal)
    const existingRun = previous.find(
      (event): event is Extract<AgentEvent, { type: "RunStarted" }> =>
        event.type === "RunStarted" && event.payload.commandId === input.commandId,
    )
    if (existingRun) {
      const requested = previous.find(
        (event): event is Extract<AgentEvent, { type: "ToolCallRequested" }> =>
          event.type === "ToolCallRequested" && event.payload.runId === existingRun.payload.runId,
      )
      return this.resume(input, previous, existingRun, requested)
    }

    const run = this.deps.identity.nextRunId()
    const traceId = this.deps.identity.nextEventId()
    const operationId = this.deps.identity.nextEventId()
    const trace = this.createTrace(traceId, operationId, input.commandId)
    let revision = previous.length + 1
    const setup: AgentEvent[] = []
    if (previous.length === 0) {
      setup.push(
        this.makeEvent(
          input.sessionId,
          revision++,
          "SessionCreated",
          {
            workspaceRoot: ("workspace" in input ? input.workspace : undefined) ?? ".",
            permissionMode: DEFAULT_SESSION_PERMISSION_MODE,
            permissionRules: [],
            policyRevision: 0,
            scopeRevision: 0,
          },
          trace.nextTrace,
        ),
      )
    }
    const accepted = this.makeEvent(
      input.sessionId,
      revision++,
      "InputAccepted",
      {
        inputId: shellInputId(input.commandId),
        commandId: input.commandId,
        kind: "message",
        text: `! ${this.shellDisplayCommand(input)}`,
        delivery: "fifo",
      },
      trace.nextTrace,
    )
    const requested = this.makeEvent(
      input.sessionId,
      revision++,
      "RunStarted",
      {
        runId: run,
        commandId: input.commandId,
        goal: `! ${this.shellDisplayCommand(input)}`,
        maxTurns: 1,
      },
      trace.nextTrace,
    )
    const toolRequested = this.makeEvent(
      input.sessionId,
      revision++,
      "ToolCallRequested",
      {
        runId: run,
        turn: 1,
        toolUseId: shellToolUseId(input.commandId),
        name: "bash",
        input: this.shellInput(input),
      },
      trace.nextTrace,
    )
    const setupEvents: AgentEvent[] = [accepted, requested, toolRequested]
    setup.push(...setupEvents)
    await this.append(setup)
    return this.finish(input, requested, toolRequested, revision, trace)
  }

  private async resume(
    input: ExecuteShellRequest,
    previous: readonly AgentEvent[],
    runStarted: Extract<AgentEvent, { type: "RunStarted" }>,
    requested: Extract<AgentEvent, { type: "ToolCallRequested" }> | undefined,
  ): Promise<ExecuteShellResult> {
    let revision = previous.length + 1
    const toolRequested =
      requested ??
      this.makeEvent(
        input.sessionId,
        revision++,
        "ToolCallRequested",
        {
          runId: runStarted.payload.runId,
          turn: 1,
          toolUseId: shellToolUseId(input.commandId),
          name: "bash",
          input: this.shellInput(input),
        },
        (eventId) => ({
          traceId: runStarted.trace.traceId,
          operationId: runStarted.trace.operationId,
          causationId: eventId,
        }),
      )
    if (!requested) await this.append([toolRequested])
    const existingPrepared = [...previous]
      .reverse()
      .find(
        (event): event is Extract<AgentEvent, { type: "ToolCallPrepared" }> =>
          event.type === "ToolCallPrepared" &&
          event.payload.runId === runStarted.payload.runId &&
          event.payload.turn === 1 &&
          event.payload.toolUseId === toolRequested.payload.toolUseId,
      )
    const existingExecution = [...previous]
      .reverse()
      .find(
        (event): event is Extract<AgentEvent, { type: "ToolCallExecutionStarted" }> =>
          event.type === "ToolCallExecutionStarted" &&
          event.payload.runId === runStarted.payload.runId &&
          event.payload.turn === 1 &&
          event.payload.toolUseId === toolRequested.payload.toolUseId,
      )
    const existingApproval = [...previous]
      .reverse()
      .find(
        (event): event is Extract<AgentEvent, { type: "ToolApprovalResolved" }> =>
          event.type === "ToolApprovalResolved" &&
          event.payload.runId === runStarted.payload.runId &&
          event.payload.turn === 1 &&
          event.payload.toolUseId === toolRequested.payload.toolUseId,
      )
    const existingApprovalRequested = [...previous]
      .reverse()
      .find(
        (event): event is Extract<AgentEvent, { type: "ToolApprovalRequested" }> =>
          event.type === "ToolApprovalRequested" &&
          event.payload.runId === runStarted.payload.runId &&
          event.payload.turn === 1 &&
          event.payload.toolUseId === toolRequested.payload.toolUseId,
      )
    const trace = this.createTrace(
      runStarted.trace.traceId,
      runStarted.trace.operationId,
      existingExecution?.eventId ??
        existingApproval?.eventId ??
        existingApprovalRequested?.eventId ??
        existingPrepared?.eventId ??
        toolRequested.eventId,
    )
    return this.finish(input, runStarted, toolRequested, revision, trace)
  }

  private async finish(
    input: ExecuteShellRequest,
    runStarted: Extract<AgentEvent, { type: "RunStarted" }>,
    requested: Extract<AgentEvent, { type: "ToolCallRequested" }>,
    revision: number,
    trace: ReturnType<ExecuteShellUseCase["createTrace"]>,
  ): Promise<ExecuteShellResult> {
    const startedAt = performance.now()
    const userShell = isUserShellInput(input)
    // `execute_shell` is a server-facing model command and must clear the
    // same canonical permission judgment and guarded executor as model tool
    // calls. Only the local `execute_user_shell` command may use the private
    // raw shell registry.
    const executionTools = userShell ? this.deps.shellTools : this.deps.tools
    // An explicit `!` command is a user action, not a model tool call. Match
    // the interactive clients by keeping it outside model approval and tool
    // hooks; bounded output, cancellation and durable tracing still apply.
    let currentEvents = await this.deps.eventStore.read(input.sessionId)
    let currentState = reduceCanonicalSession(currentEvents)
    const pendingInput = currentState.inputs.get(shellInputId(input.commandId))
    if (pendingInput?.status === "pending") {
      const parent = currentState.activeHead
      if (parent === undefined) throw new Error("Cannot consume shell input without an active history head")
      await this.append([
        this.makeEvent(
          input.sessionId,
          currentEvents.length + 1,
          "InputConsumed",
          {
            inputId: pendingInput.inputId,
            commandId: pendingInput.commandId,
            kind: pendingInput.kind,
            text: pendingInput.text ?? "",
            delivery: pendingInput.delivery ?? "fifo",
            runId: runStarted.payload.runId,
            executionGeneration: currentState.executionGeneration,
            boundary: "model-request",
            parent,
          },
          trace.nextTrace,
        ),
      ])
      currentEvents = await this.deps.eventStore.read(input.sessionId)
      currentState = reduceCanonicalSession(currentEvents)
    }
    const sessionSnapshot = currentEvents.length === 0 ? undefined : replaySession(currentEvents)
    const existingResult = [...currentEvents]
      .reverse()
      .find(
        (event): event is Extract<AgentEvent, { type: "ToolResultCommitted" }> =>
          event.type === "ToolResultCommitted" &&
          event.payload.runId === runStarted.payload.runId &&
          event.payload.toolUseId === requested.payload.toolUseId,
      )
    if (existingResult) {
      const terminal = currentEvents.find(
        (event): event is Extract<AgentEvent, { type: "RunCompleted" }> =>
          event.type === "RunCompleted" && event.payload.runId === runStarted.payload.runId,
      )
      if (terminal === undefined) {
        await this.append([
          this.makeEvent(
            input.sessionId,
            currentEvents.length + 1,
            "RunCompleted",
            {
              runId: runStarted.payload.runId,
              turns: 1,
              finalText: existingResult.payload.result.content,
            },
            trace.nextTrace,
          ),
        ])
      }
      return {
        runId: runStarted.payload.runId,
        result: existingResult.payload.result,
      }
    }
    const sessionWorkspace =
      !userShell && sessionSnapshot?.workspaceRoot !== undefined
        ? this.deps.workspacePolicyFactory?.({
            workspaceRoot: sessionSnapshot.workspaceRoot,
            additionalDirectories: sessionSnapshot.additionalDirectories,
            sessionId: input.sessionId,
          })
        : undefined
    const existingPreparedBeforeHooks = [...currentEvents]
      .reverse()
      .find(
        (event): event is Extract<AgentEvent, { type: "ToolCallPrepared" }> =>
          event.type === "ToolCallPrepared" &&
          event.payload.runId === runStarted.payload.runId &&
          event.payload.turn === 1 &&
          event.payload.toolUseId === requested.payload.toolUseId,
      )
    const command = userShell ? input.command : this.quoteArgvAsBashCommand(input.argv)
    const executionInput = { command }
    const existingPrepared = existingPreparedBeforeHooks
    const existingApprovalRequested = [...currentEvents]
      .reverse()
      .find(
        (event): event is Extract<AgentEvent, { type: "ToolApprovalRequested" }> =>
          event.type === "ToolApprovalRequested" &&
          event.payload.runId === runStarted.payload.runId &&
          event.payload.turn === 1 &&
          event.payload.toolUseId === requested.payload.toolUseId,
      )
    const existingApprovalResolved = [...currentEvents]
      .reverse()
      .find(
        (event): event is Extract<AgentEvent, { type: "ToolApprovalResolved" }> =>
          event.type === "ToolApprovalResolved" &&
          event.payload.runId === runStarted.payload.runId &&
          event.payload.turn === 1 &&
          event.payload.toolUseId === requested.payload.toolUseId,
      )
    const existingExecutionStarted = [...currentEvents]
      .reverse()
      .find(
        (event): event is Extract<AgentEvent, { type: "ToolCallExecutionStarted" }> =>
          event.type === "ToolCallExecutionStarted" &&
          event.payload.runId === runStarted.payload.runId &&
          event.payload.turn === 1 &&
          event.payload.toolUseId === requested.payload.toolUseId,
      )
    const executionContext = {
      sessionId: input.sessionId,
      runId: runStarted.payload.runId,
      turn: 1,
      toolUseId: requested.payload.toolUseId,
      idempotencyKey: toolIdempotencyKey({
        sessionId: input.sessionId,
        runId: runStarted.payload.runId,
        turn: 1,
        toolUseId: requested.payload.toolUseId,
      }),
      trace: requested.trace,
      ...(sessionWorkspace === undefined ? {} : { workspace: sessionWorkspace }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    }
    const missingModelBashAuthority = !userShell && (!executionTools || !hasModelBashAuthority(executionTools))
    const rawPreparation: ToolPreparation = missingModelBashAuthority
      ? {
          status: "invalid" as const,
          decision: "deny" as const,
          preparedInput: executionInput,
          reasons: ["Model Bash has no local canonical security authority; execution is denied"],
          analyzerVersion: "executor-contract",
          policyVersion: "executor-contract",
        }
      : existingPrepared
        ? {
            status: existingPrepared.payload.status,
            // An adopted fact without a decision is fail-closed for every
            // status: "reused" replays from the cache path and never executes.
            decision: existingPrepared.payload.decision ?? ("deny" as const),
            ...(existingPrepared.payload.preparedInput === undefined ? {} : { preparedInput: existingPrepared.payload.preparedInput }),
            reasons: existingPrepared.payload.reasons,
            analyzerVersion: existingPrepared.payload.analyzerVersion,
            policyVersion: existingPrepared.payload.policyVersion,
            ...(existingPrepared.payload.approvalFingerprint === undefined
              ? {}
              : {
                  approvalFingerprint: existingPrepared.payload.approvalFingerprint,
                }),
            ...(existingPrepared.payload.cwd === undefined ? {} : { cwd: existingPrepared.payload.cwd }),
            ...(existingPrepared.payload.denial === undefined ? {} : { denial: existingPrepared.payload.denial }),
            ...(existingPrepared.payload.securityFact === undefined ? {} : { securityFact: existingPrepared.payload.securityFact }),
          }
        : executionTools?.prepare
          ? await executionTools
              .prepare({
                name: "bash",
                input: executionInput,
                signal: input.signal,
                context: executionContext,
              })
              .catch((error): ToolPreparation => ({
                status: "invalid",
                decision: "deny",
                preparedInput: executionInput,
                reasons: [`Bash tool preparation failed: ${error instanceof Error ? error.message : String(error)}`],
                analyzerVersion: "executor",
                policyVersion: "executor",
              }))
          : userShell
            ? {
                status: "ready" as const,
                decision: "allow" as const,
                preparedInput: executionInput,
                reasons: [],
                analyzerVersion: "user-shell",
                policyVersion: "user-owned",
              }
            : {
                status: "invalid" as const,
                decision: "deny" as const,
                preparedInput: executionInput,
                reasons: ["Bash security preparation is not injected; execution is denied"],
                analyzerVersion: "executor",
                policyVersion: "executor",
              }
    const preparation = userShell
      ? rawPreparation
      : (this.deps.bashSecurity?.normalizeModelBashPreparation(executionInput, rawPreparation) ?? {
          ...rawPreparation,
          status: "invalid" as const,
          decision: "deny" as const,
          reasons: [...rawPreparation.reasons, "Bash security authority is not injected"],
        })
    const currentScopeDigest =
      sessionSnapshot?.workspaceRoot === undefined
        ? undefined
        : (sessionSnapshot.scopeDigest ??
          this.deps.workspaceScopeDigest?.(sessionSnapshot.workspaceRoot, sessionSnapshot.additionalDirectories))
    const securityBoundPreparation: ToolPreparation =
      sessionSnapshot?.workspaceRoot === undefined
        ? preparation
        : existingPrepared !== undefined &&
            ((existingPrepared.payload.scopeDigest !== undefined && existingPrepared.payload.scopeDigest !== currentScopeDigest) ||
              (existingPrepared.payload.policyRevision !== undefined &&
                existingPrepared.payload.policyRevision !== sessionSnapshot.policyRevision))
          ? {
              ...preparation,
              status: "denied",
              decision: "deny",
              reasons: ["canonical Session security revision changed; old shell approval cannot be reused"],
              // The staleness override must also win the code; an adopted
              // producer code describes the old policy, not this settlement.
              denial: { code: "stale_policy" },
            }
          : {
              ...preparation,
              scopeRevision: sessionSnapshot.scopeRevision,
              scopeDigest: currentScopeDigest,
              policyRevision: sessionSnapshot.policyRevision,
            }
    const canonicalExecutionInput = userShell ? executionInput : modelBashInput(securityBoundPreparation.preparedInput)
    const prepared =
      existingPrepared ??
      this.makeEvent(
        input.sessionId,
        revision++,
        "ToolCallPrepared",
        {
          runId: runStarted.payload.runId,
          turn: 1,
          toolUseId: requested.payload.toolUseId,
          name: "bash",
          ...(securityBoundPreparation.preparedInput === undefined ? {} : { preparedInput: securityBoundPreparation.preparedInput }),
          status: securityBoundPreparation.status,
          decision: securityBoundPreparation.decision,
          reasons: securityBoundPreparation.reasons,
          analyzerVersion: securityBoundPreparation.analyzerVersion,
          policyVersion: securityBoundPreparation.policyVersion,
          ...(securityBoundPreparation.approvalFingerprint === undefined
            ? {}
            : {
                approvalFingerprint: securityBoundPreparation.approvalFingerprint,
              }),
          ...(securityBoundPreparation.cwd === undefined ? {} : { cwd: securityBoundPreparation.cwd }),
          ...(securityBoundPreparation.scopeRevision === undefined ? {} : { scopeRevision: securityBoundPreparation.scopeRevision }),
          ...(securityBoundPreparation.scopeDigest === undefined ? {} : { scopeDigest: securityBoundPreparation.scopeDigest }),
          ...(securityBoundPreparation.policyRevision === undefined ? {} : { policyRevision: securityBoundPreparation.policyRevision }),
          ...(securityBoundPreparation.denial === undefined ? {} : { denial: securityBoundPreparation.denial }),
          ...(securityBoundPreparation.securityFact === undefined ? {} : { securityFact: securityBoundPreparation.securityFact }),
        },
        trace.nextTrace,
      )
    if (!existingPrepared) await this.append([prepared])
    const approvalRequestedForPreparation =
      existingApprovalRequested?.payload.preparedEventId === prepared.eventId ? existingApprovalRequested : undefined
    const approvalResolvedForPreparation =
      existingApprovalResolved?.payload.preparedEventId === prepared.eventId ? existingApprovalResolved : undefined
    this.traceSink.record({
      name: "execution.tool",
      phase: "started",
      sessionId: input.sessionId,
      trace: {
        traceId: requested.trace.traceId,
        operationId: requested.trace.operationId,
        causationId: requested.eventId,
      },
      timestamp: this.deps.identity.now(),
      attributes: {
        toolName: "bash",
        executionMode: userShell ? "user-shell" : "model",
      },
    })
    // The server-facing model branch shares the model loop's single judgment
    // authority: the canonical permission policy settles allow/ask/deny
    // before any broker is consulted, so deny rules, the plan floor and the
    // full-access default bind this path exactly like a model-loop bash call.
    const judgment = userShell
      ? undefined
      : judgeModelToolCall(
          {
            name: "bash",
            // Only executable preparations may host a judgment ask; a
            // denied/blocked preparation settles through the preparation
            // failure branch and must never reach the broker.
            inputValid: securityBoundPreparation.status === "ready" || securityBoundPreparation.status === "reused",
            ...(securityBoundPreparation.policyRevision === undefined
              ? {}
              : {
                  preparedAtPolicyRevision: securityBoundPreparation.policyRevision,
                }),
            ...(securityBoundPreparation.securityFact === undefined ? {} : { securityFact: securityBoundPreparation.securityFact }),
          },
          sessionSnapshot === undefined
            ? undefined
            : {
                permissionMode: sessionSnapshot.permissionMode,
                permissionRules: sessionSnapshot.permissionRules,
                policyRevision: sessionSnapshot.policyRevision,
              },
          this.deps.permissionSurfaces,
        )
    // No default: an approval decision exists only where the ask branch
    // records one. The judgment alone routes the broker, exactly like the
    // model loop — a preparation "allow" is a fact from an untrusted surface,
    // never an authorization — so judgment-allow executes under its stamp
    // and every judgment-ask consults approval.
    let approvalDecision: "approved" | "denied" | undefined
    let brokerDenialReason: DenialReason | undefined
    if (!userShell && judgment?.decision === "ask") {
      if (!approvalRequestedForPreparation) {
        const approvalRequested = this.makeEvent(
          input.sessionId,
          revision++,
          "ToolApprovalRequested",
          {
            runId: runStarted.payload.runId,
            turn: 1,
            toolUseId: requested.payload.toolUseId,
            name: "bash",
            preparedEventId: prepared.eventId,
            inputFingerprint: shellToolRequestFingerprint(canonicalExecutionInput ?? executionInput),
            ...(securityBoundPreparation.scopeRevision === undefined ? {} : { scopeRevision: securityBoundPreparation.scopeRevision }),
            ...(securityBoundPreparation.policyRevision === undefined ? {} : { policyRevision: securityBoundPreparation.policyRevision }),
          },
          trace.nextTrace,
        )
        await this.append([approvalRequested])
      }
      if (approvalResolvedForPreparation !== undefined) {
        approvalDecision = approvalResolvedForPreparation.payload.decision
      } else {
        const outcome = await this.deps.approval.request({
          sessionId: input.sessionId,
          runId: runStarted.payload.runId,
          turn: 1,
          toolUseId: requested.payload.toolUseId,
          name: "bash",
          input: canonicalExecutionInput ?? executionInput,
          signal: input.signal,
        })
        // A structured denial carries its cause (invalidated, quota, ...);
        // keep it so the settlement can attribute the stable code, exactly
        // like the tool-turn executor does for model tool calls.
        if (typeof outcome !== "string") brokerDenialReason = outcome.reason
        approvalDecision = approvalDecisionOf(outcome)
      }
      if (!approvalResolvedForPreparation) {
        const outcome = await this.deps.approvalResolution.record({
          sessionId: input.sessionId,
          runId: runStarted.payload.runId,
          turn: 1,
          toolUseId: requested.payload.toolUseId,
          preparedEventId: prepared.eventId,
          expectedScopeRevision: securityBoundPreparation.scopeRevision ?? approvalRequestedForPreparation?.payload.scopeRevision ?? 0,
          expectedPolicyRevision: securityBoundPreparation.policyRevision ?? approvalRequestedForPreparation?.payload.policyRevision ?? 0,
          decision: approvalDecision,
        })
        approvalDecision = outcome.decision
        // The approval service has already persisted and published the event;
        // continue subsequent shell facts after its canonical revision.
        revision = Math.max(revision, outcome.event.revision + 1)
      }
    }
    // Recovery fence: an approval recorded before this invocation must never
    // spawn unattended. Reaching here means no committed result exists (the
    // result adoption above already returned). Unlike the executor fence
    // this fires without a recovered gate — any adopted approved-without-
    // result call, including a same-process retry after a post-approval
    // crash, converges on the stable stale_policy denial, because a
    // commandId's approval is one-shot: a resubmitted call under a new
    // commandId gets a fresh approval cycle. Adopted denials stay denied.
    const staleApprovedRecovery = !userShell && approvalResolvedForPreparation?.payload.decision === "approved"
    // The approval is bound to the exact canonical input it was requested
    // for; an adopted durable approval whose fingerprint no longer matches
    // the execution input must not reach a spawn.
    const approvalInputMismatch =
      approvalDecision === "approved" &&
      approvalRequestedForPreparation !== undefined &&
      approvalRequestedForPreparation.payload.inputFingerprint !== shellToolRequestFingerprint(canonicalExecutionInput ?? executionInput)
    currentEvents = await this.deps.eventStore.read(input.sessionId)
    currentState = reduceCanonicalSession(currentEvents)
    const liveAttempt = [...currentState.attempts.values()].find(
      (attempt) =>
        attempt.runId === runStarted.payload.runId && attempt.toolUseId === requested.payload.toolUseId && attempt.status === "started",
    )
    if (liveAttempt?.toolUseId !== undefined) {
      await this.append([
        this.makeEvent(
          input.sessionId,
          currentEvents.length + 1,
          "ToolAttemptAbandoned",
          {
            runId: liveAttempt.runId,
            turn: liveAttempt.turn,
            attemptId: liveAttempt.attemptId,
            toolUseId: liveAttempt.toolUseId,
            executionGeneration: liveAttempt.executionGeneration,
            reason: "recovered after an incomplete shell attempt",
            recoveryCommandId: `recovery:tool-abandon:${liveAttempt.attemptId}`,
          },
          trace.nextTrace,
        ),
      ])
      currentEvents = await this.deps.eventStore.read(input.sessionId)
      currentState = reduceCanonicalSession(currentEvents)
    }
    const toolAttemptId = shellToolAttemptId(currentEvents, runStarted.payload.runId, requested.payload.toolUseId)
    const inputCursor = currentState.activeHead
    if (inputCursor === undefined) throw new Error("Cannot start a shell attempt without an active history head")
    const toolAttemptStarted = this.makeEvent(
      input.sessionId,
      currentEvents.length + 1,
      "ToolAttemptStarted",
      {
        runId: runStarted.payload.runId,
        turn: 1,
        attemptId: toolAttemptId,
        toolUseId: requested.payload.toolUseId,
        executionGeneration: currentState.executionGeneration,
        branchId: currentState.activeHead?.branchId ?? "main",
        inputCursor,
        requestFingerprint: shellToolRequestFingerprint(canonicalExecutionInput ?? executionInput),
      },
      trace.nextTrace,
    )
    await this.append([toolAttemptStarted])
    currentEvents = await this.deps.eventStore.read(input.sessionId)
    currentState = reduceCanonicalSession(currentEvents)
    const preparationFailed =
      securityBoundPreparation.decision === "deny" ||
      securityBoundPreparation.status === "invalid" ||
      securityBoundPreparation.status === "blocked" ||
      securityBoundPreparation.status === "denied" ||
      securityBoundPreparation.status === "reused" ||
      (!userShell && canonicalExecutionInput === undefined)
    // A ready preparation whose executable input never materialized is a
    // malformed model-bash call, not a rule denial: it settles as an input
    // problem so the caller can fix the input.
    const malformedShellInput = !userShell && canonicalExecutionInput === undefined
    const judgmentDenied = judgment?.decision === "deny"
    // Settlement reuses the judgment vocabulary: a producer-declared code
    // wins, then the caller-supplied fallback, then the status default; a
    // decision-less reuse stays advisory, without a code.
    const preparationDenial = shellPreparationDenial(
      securityBoundPreparation,
      malformedShellInput ? "unknown_tool_or_input" : undefined,
    ).denial
    const executionStarted =
      !userShell &&
      !preparationFailed &&
      !judgmentDenied &&
      approvalDecision !== "denied" &&
      !approvalInputMismatch &&
      !staleApprovedRecovery
        ? (existingExecutionStarted ??
          (this.makeEvent(
            input.sessionId,
            revision++,
            "ToolCallExecutionStarted",
            {
              runId: runStarted.payload.runId,
              turn: 1,
              toolUseId: requested.payload.toolUseId,
              name: "bash",
              dispatchId: requested.payload.toolUseId,
              requestFingerprint: shellToolRequestFingerprint(canonicalExecutionInput ?? executionInput),
              replayPolicy: "never",
              preparedEventId: prepared.eventId,
              execution: {
                shell: "/bin/bash",
                argvShape: "bash-noprofile-norc-c",
                cwd: securityBoundPreparation.cwd ?? input.cwd ?? this.deps.environment?.cwd ?? ".",
              },
            },
            trace.nextTrace,
          ) as Extract<AgentEvent, { type: "ToolCallExecutionStarted" }>))
        : undefined
    if (executionStarted && !existingExecutionStarted) await this.append([executionStarted])
    const result: ToolResult = preparationFailed
      ? preparationDenial === undefined
        ? {
            // Advisory only, mirroring the executor's reuse miss: a
            // decision-less adopted fact stays fail-closed with a resubmit
            // hint instead of a code.
            content: userShell
              ? `command denied: ${PREVIOUS_RESULT_NOT_REUSABLE_NOTICE}`
              : `tool bash denied (${PREVIOUS_RESULT_NOT_REUSABLE_NOTICE})`,
            isError: true,
          }
        : {
            content: userShell
              ? `command denied: ${preparationDenial.reason ?? preparationDenial.code}`
              : preparationDenial.reason === undefined
                ? `tool bash denied (${preparationDenial.code})`
                : `tool bash denied (${preparationDenial.code}: ${preparationDenial.reason})`,
            isError: true,
            denial: preparationDenial,
          }
      : judgmentDenied
        ? {
            content: `tool bash denied (${judgment.code})`,
            isError: true,
            denial: { code: judgment.code },
          }
        : approvalDecision === "denied"
          ? {
              // An invalidated pending ask was denied by a policy change,
              // not by the user: surface the policy cause, exactly like the
              // model loop's approval settlement.
              content:
                brokerDenialReason === undefined
                  ? "tool bash denied (user_denied)"
                  : brokerDenialReason === "invalidated"
                    ? "tool bash denied (stale_policy)"
                    : `tool bash denied (user_denied: ${brokerDenialReason})`,
              isError: true,
              denial: {
                code: brokerDenialReason === "invalidated" ? "stale_policy" : "user_denied",
                ...(brokerDenialReason !== undefined && brokerDenialReason !== "invalidated" ? { reason: brokerDenialReason } : {}),
              },
            }
          : staleApprovedRecovery
            ? {
                content: `tool bash denied (stale_policy: ${STALE_POLICY_RECOVERY_DENIAL})`,
                isError: true,
                denial: {
                  code: "stale_policy",
                  reason: STALE_POLICY_RECOVERY_DENIAL,
                },
              }
            : approvalInputMismatch
              ? {
                  // Binding invalidation, same family as the recovery fence:
                  // converge on the stale-approval code, not user_denied.
                  content: `tool bash denied (stale_policy: ${APPROVAL_INPUT_MISMATCH_REASON})`,
                  isError: true,
                  denial: {
                    code: "stale_policy",
                    reason: APPROVAL_INPUT_MISMATCH_REASON,
                  },
                }
              : existingExecutionStarted
                ? {
                    // Recovery fence for an interrupted execution: the started
                    // process's result never committed durably, so a blind
                    // retry is stopped and the caller must resubmit. Only the
                    // model drive writes this fact, but a user re-drive of the
                    // same commandId adopts it, so the render splits by the
                    // driving surface like every other terminal.
                    content: userShell
                      ? `command denied: ${INTERRUPTED_EXECUTION_RETRY_STOPPED_REASON}`
                      : `tool bash denied (stale_policy: ${INTERRUPTED_EXECUTION_RETRY_STOPPED_REASON})`,
                    isError: true,
                    denial: {
                      code: "stale_policy",
                      reason: INTERRUPTED_EXECUTION_RETRY_STOPPED_REASON,
                    },
                  }
                : executionTools
                  ? await executionTools.execute({
                      name: "bash",
                      input: {
                        ...(canonicalExecutionInput ?? executionInput),
                        ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
                      },
                      signal: input.signal,
                      context: {
                        ...executionContext,
                        cwd: securityBoundPreparation.cwd ?? input.cwd ?? this.deps.environment?.cwd ?? ".",
                        preparation: securityBoundPreparation,
                        approvalDecision,
                        // Judgment-allow is the canonical authorization for
                        // calls that execute without an approval; the tool's
                        // authorization gate accepts it in place of a broker
                        // decision for preparation "ask" calls.
                        ...(judgment?.decision === "allow" ? { judgmentDecision: "allow" as const } : {}),
                        // The spawn fence guards model-judged bash only; a
                        // user-owned `!` command is the policy actor itself and
                        // must never be fenced by a permission switch.
                        ...(userShell
                          ? {}
                          : {
                              preSpawnGate: this.deps.preSpawnGateFor(input.sessionId, `spawn:${requested.payload.toolUseId}`, {
                                ...(securityBoundPreparation.policyRevision === undefined
                                  ? {}
                                  : {
                                      policyRevision: securityBoundPreparation.policyRevision,
                                    }),
                                ...(securityBoundPreparation.scopeRevision === undefined
                                  ? {}
                                  : {
                                      scopeRevision: securityBoundPreparation.scopeRevision,
                                    }),
                                ...(securityBoundPreparation.scopeDigest === undefined
                                  ? {}
                                  : {
                                      scopeDigest: securityBoundPreparation.scopeDigest,
                                    }),
                              }),
                            }),
                        onOutput: (output: import("@ag2cli/core/tool-facts.js").ToolOutputChunk) => {
                          this.transientPublisher.emit(input.sessionId, requested.trace, "tool_output_delta", {
                            runId: runStarted.payload.runId,
                            turn: 1,
                            toolUseId: requested.payload.toolUseId,
                            name: "bash",
                            stream: output.stream,
                            delta: output.text,
                          })
                        },
                      },
                    })
                  : { content: "Bash executor is not injected; the command was not started", isError: true }
    currentEvents = await this.deps.eventStore.read(input.sessionId)
    currentState = reduceCanonicalSession(currentEvents)
    const parent = currentState.activeHead
    if (parent === undefined) throw new Error("Cannot commit a shell result without an active history head")
    const resultCommitted = this.makeEvent(
      input.sessionId,
      currentEvents.length + 1,
      "ToolResultCommitted",
      {
        runId: runStarted.payload.runId,
        turn: 1,
        attemptId: toolAttemptStarted.payload.attemptId,
        toolUseId: requested.payload.toolUseId,
        executionGeneration: toolAttemptStarted.payload.executionGeneration,
        branchId: toolAttemptStarted.payload.branchId,
        requestFingerprint: toolAttemptStarted.payload.requestFingerprint,
        parent,
        result,
      },
      trace.nextTrace,
    )
    const terminal = this.makeEvent(
      input.sessionId,
      currentEvents.length + 2,
      "RunCompleted",
      {
        runId: runStarted.payload.runId,
        turns: 1,
        finalText: result.content,
      },
      trace.nextTrace,
    )
    await this.append([resultCommitted, terminal])
    this.traceSink.record({
      name: "execution.tool",
      phase: result.isError ? "failed" : "succeeded",
      sessionId: input.sessionId,
      trace: {
        traceId: requested.trace.traceId,
        operationId: requested.trace.operationId,
        causationId: requested.eventId,
      },
      timestamp: this.deps.identity.now(),
      durationMs: Math.round(performance.now() - startedAt),
      attributes: {
        toolName: "bash",
        ...traceAttributesFromToolMetadata(result.metadata),
      },
    })
    return { runId: runStarted.payload.runId, result }
  }

  private createTrace(traceId: string, operationId: string, initialCausationId: string) {
    let causationId = initialCausationId
    return {
      nextTrace: (eventId: string): EventTrace => {
        const trace: EventTrace = { traceId, operationId, causationId }
        causationId = eventId
        return trace
      },
    }
  }

  private makeEvent<TType extends AgentEvent["type"]>(
    sessionId: SessionId,
    revision: number,
    type: TType,
    payload: Extract<AgentEvent, { type: TType }>["payload"],
    nextTrace: (eventId: string) => EventTrace,
  ): Extract<AgentEvent, { type: TType }> {
    const eventId = this.deps.identity.nextEventId()
    return {
      eventId,
      sessionId,
      revision,
      type,
      timestamp: this.deps.identity.now(),
      trace: nextTrace(eventId),
      payload,
    } as Extract<AgentEvent, { type: TType }>
  }

  private async append(events: readonly AgentEvent[]): Promise<void> {
    if (events.length === 0) return
    await commitSessionEvents({
      authority: this.authority,
      events,
      onCommitted: this.deps.onEventsAppended,
    })
  }

  private shellInput(input: ExecuteShellRequest): Record<string, unknown> {
    return {
      command: isUserShellInput(input) ? input.command : this.quoteArgvAsBashCommand(input.argv),
      ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
      cwd: input.cwd ?? this.deps.environment?.cwd ?? null,
    }
  }

  private shellDisplayCommand(input: ExecuteShellRequest): string {
    return isUserShellInput(input) ? input.command : this.quoteArgvAsBashCommand(input.argv)
  }

  private quoteArgvAsBashCommand(argv: readonly string[]): string {
    const result = this.deps.bashSecurity?.quoteShellArgs(argv)
    if (result === undefined) throw new Error("Bash security authority is not injected")
    if (!result.success) throw new Error(`execute_shell argv cannot be safely converted to a Bash command: ${result.error}`)
    return result.quoted
  }
}

function replayShellTerminal(terminal: AgentEvent): ExecuteShellResult {
  if (terminal.type === "ToolResultCommitted") return { runId: terminal.payload.runId, result: terminal.payload.result }
  throw new Error(`execute_shell terminal event has an invalid type: ${terminal.type}`)
}

function validateInput(input: ExecuteShellRequest): void {
  if (input.commandId.trim().length === 0) throw new Error("commandId must not be empty")
  if (isUserShellInput(input)) {
    if (input.command.trim().length === 0) throw new Error("command must not be empty")
    if (input.command.length > 65_536) throw new Error("command must not exceed 65,536 characters")
  } else {
    if (input.argv.length === 0) throw new Error("argv must not be empty")
    if (input.argv.some((arg) => typeof arg !== "string")) throw new Error("argv must be an array of strings")
  }
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)) {
    throw new Error("timeoutMs must be a positive integer")
  }
}

function shellToolUseId(commandId: string): string {
  return `shell:${commandId}`
}

function shellInputId(commandId: string): string {
  return `input:${commandId}`
}

function shellToolAttemptId(events: readonly AgentEvent[], runIdValue: RunId, toolUseId: string): string {
  const prefix = `${runIdValue}:1:tool:${toolUseId}:attempt:`
  const used = new Set(
    events
      .filter((event): event is Extract<AgentEvent, { type: "ToolAttemptStarted" }> => event.type === "ToolAttemptStarted")
      .filter((event) => event.payload.runId === runIdValue && event.payload.turn === 1 && event.payload.toolUseId === toolUseId)
      .map((event) => event.payload.attemptId),
  )
  let sequence = 1
  while (used.has(`${prefix}${sequence}`)) sequence += 1
  return `${prefix}${sequence}`
}

function shellToolRequestFingerprint(input: unknown): string {
  return `tool:bash:${stableJson(input)}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`
}

function isUserShellInput(input: ExecuteShellRequest): input is ExecuteUserShellInput {
  return "command" in input
}

function modelBashInput(value: unknown): { readonly command: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const command = (value as Record<string, unknown>).command
  return typeof command === "string" && command.length > 0 ? { command } : undefined
}

/** Structured denial for a failed shell preparation; empty when advisory. */
function shellPreparationDenial(
  preparation: ToolPreparation,
  fallbackCode?: PermissionDenialCode,
): {
  readonly denial?: ToolResultDenial
} {
  if (preparation.status === "reused") return {}
  const code = preparation.denial?.code ?? fallbackCode ?? (preparation.status === "invalid" ? "unknown_tool_or_input" : "denied_by_rule")
  const reasons = deniedReasons(preparation.reasons)
  return reasons === "" ? { denial: { code } } : { denial: { code, reason: reasons } }
}
