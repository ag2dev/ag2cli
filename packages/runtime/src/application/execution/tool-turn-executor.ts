import type { AgentEvent, EventTrace } from "@ag2cli/core/events/event.js"
import type { RunId, SessionId } from "@ag2cli/core/ids.js"
import type { ApprovalBroker, ApprovalDecision, DenialReason } from "../../ports/approval-broker.js"
import { approvalDecisionOf } from "../../ports/approval-broker.js"
import type {
  Guardian,
  GuardianDeadlineTimer,
  GuardianDenialReasonCode,
  GuardianReviewRequest,
  GuardianVerdict,
  GuardianWaitRegistry,
} from "../../ports/guardian.js"
import { createGuardianDeadlineTimer, DEFAULT_GUARDIAN_REVIEW_DEADLINE_MS } from "../../ports/guardian.js"
import type { ApprovalResolutionWriter } from "../session/approval-resolution.js"
import { hasModelBashAuthority, toolIdempotencyKey, type ToolExecutor } from "../../ports/tool-executor.js"
import type { ToolFailureLoopGuardDecision } from "./tool-failure-loop-guard.js"
import { observeToolFailure } from "./tool-failure-loop-guard.js"
import { judgeModelToolCall, modelToolEffectOf, type PermissionDenialCode, type PermissionSurfaces } from "./permission-judgment.js"
import { ApprovalRequiredError } from "./approval-required-error.js"
import { deniedReasons } from "./denial-reasons.js"
import type { TransientEventPublisher } from "./transient-events.js"
import { traceAttributesFromToolMetadata, type TraceSink } from "../../ports/trace-sink.js"
import type { ContentBlock } from "@ag2cli/core/message.js"
import type { ToolExecutionMetadata, ToolPreparation, ToolResult } from "@ag2cli/core/tool-facts.js"
import { GUARDIAN_DENIAL_REASON_CODES, MAX_GUARDIAN_REASON_LENGTH } from "@ag2cli/core/tool-facts.js"
import type { RuntimeEnvironment } from "../../ports/environment.js"
import type { BashSecurityPort } from "../../ports/security.js"
import type { PolicySerialPoint } from "../../ports/policy-serial-point.js"
import {
  APPROVAL_INPUT_MISMATCH_REASON,
  isStalePolicySpawnDenial,
  sessionSecurityDrifted,
  PREVIOUS_RESULT_NOT_REUSABLE_NOTICE,
  STALE_POLICY_RECOVERY_DENIAL,
  type PreSpawnGate,
  type SessionSecurityStamp,
} from "./policy-serial-point.js"
import type { WorkspacePolicyFactory, WorkspaceScopeDigest } from "../../ports/workspace.js"
import type { SessionSecuritySnapshot } from "@ag2cli/core/session/session-snapshot.js"
import { reduceCanonicalSession } from "@ag2cli/core/session/canonical-session.js"

export interface ToolTurnInput {
  readonly sessionId: SessionId
  readonly signal?: AbortSignal
}

export type AgentEventFactory = (
  sessionId: SessionId,
  revision: number,
  type: AgentEvent["type"],
  payload: unknown,
  nextTrace: (eventId: string) => EventTrace,
) => AgentEvent

export interface ToolTurnExecutorDependencies {
  readonly approval: ApprovalBroker
  readonly approvalResolution: ApprovalResolutionWriter
  readonly permissionSurfaces: PermissionSurfaces
  /** Answers auto-mode asks; absent means every auto ask converges guardian_denied. */
  readonly guardian?: Guardian
  /** Aborts in-flight guardian reviews when session security changes. */
  readonly guardianWaits?: GuardianWaitRegistry
  /** Runtime-owned review deadline; defaults to the port constant. */
  readonly guardianDeadlineMs?: number
  /** Deadline race injectable for tests; defaults to a real timer. */
  readonly guardianDeadlineTimer?: GuardianDeadlineTimer
  /** Reads the canonical log; used only to reconcile foreign mid-turn commits. */
  readonly readEvents: (sessionId: SessionId) => Promise<readonly AgentEvent[]>
  readonly identity: { now(): string }
  readonly workspacePolicyFactory?: WorkspacePolicyFactory
  readonly workspaceScopeDigest?: WorkspaceScopeDigest
  readonly environment?: RuntimeEnvironment
  readonly bashSecurity?: BashSecurityPort
  /** Serializes dispatch against mid-run permission commits on one session. */
  readonly serialPoint: PolicySerialPoint
  /** Fresh canonical security read used inside the dispatch gate. */
  readonly readSessionSecurity: (sessionId: SessionId) => Promise<SessionSecurityStamp | undefined>
  /** Builds the spawn fence stamped into every tool execution context. */
  readonly preSpawnGateFor: (sessionId: SessionId, taskId: string, bound: SessionSecurityStamp) => PreSpawnGate
  readonly traceSink: TraceSink
  readonly transientPublisher: TransientEventPublisher
  readonly makeEvent: AgentEventFactory
  readonly append: (events: readonly AgentEvent[]) => Promise<readonly AgentEvent[]> | Promise<void>
}

export interface ExecuteToolCallsInput {
  readonly input: ToolTurnInput
  readonly run: RunId
  readonly turn: number
  readonly executionGeneration?: number
  readonly branchId?: string
  readonly toolUses: readonly Extract<ContentBlock, { type: "tool_use" }>[]
  readonly revision: number
  readonly nextTrace: (eventId: string) => EventTrace
  readonly knownEvents: readonly AgentEvent[]
  /** Canonical security state captured by the session server for this turn. */
  readonly security?: SessionSecuritySnapshot
  /** Active agent profile name for this turn; undefined = no active agent. */
  readonly agentName?: string
  /**
   * Set only by the resume path: a durable approval recorded before the host
   * died must never execute unattended on recovery.
   */
  readonly recovered?: boolean
  readonly toolResultCache: Map<string, ToolResult>
  readonly repeatedToolCalls: Map<string, number>
  readonly toolFailureGuard: Parameters<typeof observeToolFailure>[0]
  readonly tools: ToolExecutor
}

export type ToolInteractionOutcome = "answered" | "declined" | "rejected"

/**
 * Marker stamped into a duplicate's reused preparation when it converges on
 * a policy-denied sibling; a re-drive of that orphaned fact must deny for
 * the same policy reason, not advise a needless input change.
 */
// Bare like the other stale_policy reason constants: render sites compose
// the `stale_policy: ` prefix so the denial reason mirrors only the
// post-code text.
const SIBLING_POLICY_DENIAL_REASON = "sibling call denied by policy change; reusing its result"

type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>

export interface ExecuteToolCallsResult {
  readonly results: {
    tool_use_id: string
    content: string
    is_error?: boolean
  }[]
  readonly revision: number
  readonly loopGuard?: Extract<ToolFailureLoopGuardDecision, { tripped: true }>
  readonly interactionOutcome?: ToolInteractionOutcome
}

// The turn judges and dispatches every sibling against one security value,
// so a tool or prepare step must not be able to rewrite mode/rules in memory
// between siblings. The executor therefore works on a deep-frozen copy and
// never freezes the caller-owned snapshot.
function freezeSessionSecurity(security: SessionSecuritySnapshot): SessionSecuritySnapshot {
  return Object.freeze({
    ...security,
    additionalDirectories: Object.freeze([...security.additionalDirectories]),
    permissionRules: Object.freeze(security.permissionRules.map((rule) => Object.freeze({ ...rule }))),
  })
}

/** Owns tool lifecycle, approval, idempotency and live tool output. */
export class ToolTurnExecutor {
  constructor(private readonly deps: ToolTurnExecutorDependencies) {}

  async execute(options: ExecuteToolCallsInput): Promise<ExecuteToolCallsResult> {
    let revision = options.revision
    const results: {
      tool_use_id: string
      content: string
      is_error?: boolean
    }[] = []
    let loopGuard: Extract<ToolFailureLoopGuardDecision, { tripped: true }> | undefined
    let interactionOutcome: ToolInteractionOutcome | undefined
    const security = options.security === undefined ? undefined : freezeSessionSecurity(options.security)
    // The event log is the only fact source during this turn. Newly appended
    // events are immediately added to this local replay cursor so retries never
    // consult a stale snapshot or an in-memory approval cache as truth.
    const knownEvents: AgentEvent[] = [...options.knownEvents]
    // A mid-turn permission commit takes revisions between the local cursor
    // and the next local write; merge those foreign events from the
    // canonical log so the replay cursor stays contiguous and the turn
    // keeps running under the new policy instead of crashing on a gap.
    const mergeForeignUpTo = async (exclusiveEnd: number): Promise<void> => {
      const localTail = knownEvents.at(-1)?.revision
      if (localTail === undefined || exclusiveEnd <= localTail + 1) return
      const canonical = await this.deps.readEvents(options.input.sessionId)
      for (const event of canonical) {
        if (event.revision > localTail && event.revision < exclusiveEnd) knownEvents.push(event)
      }
    }
    const appendEvents = async (events: readonly AgentEvent[]): Promise<void> => {
      const committed = await this.deps.append(events)
      const persisted = Array.isArray(committed) ? committed : [...events]
      const firstPersisted = persisted[0]?.revision
      if (firstPersisted !== undefined) await mergeForeignUpTo(firstPersisted)
      knownEvents.push(...persisted)
      revision = Math.max(revision, (persisted.at(-1)?.revision ?? events.at(-1)?.revision ?? revision - 1) + 1)
    }
    const appendEvent = async (event: AgentEvent): Promise<void> => {
      await appendEvents([event])
    }
    const observeResult = (toolName: string, input: unknown, result: ToolResult): void => {
      const outcome = toolInteractionOutcome(result)
      if (outcome === "declined" || outcome === "rejected") return
      const decision = observeToolFailure(options.toolFailureGuard, {
        toolName,
        input,
        result,
      })
      if (decision.tripped) loopGuard = decision
    }
    const commitResult = async (toolUse: Extract<ContentBlock, { type: "tool_use" }>, result: ToolResult): Promise<void> => {
      const existing = [...knownEvents]
        .reverse()
        .find(
          (event): event is Extract<AgentEvent, { type: "ToolResultCommitted" }> =>
            event.type === "ToolResultCommitted" &&
            event.payload.runId === options.run &&
            event.payload.turn === options.turn &&
            event.payload.toolUseId === toolUse.id,
        )
      if (existing) return
      let attempt = [...knownEvents]
        .reverse()
        .find(
          (event): event is Extract<AgentEvent, { type: "ToolAttemptStarted" }> =>
            event.type === "ToolAttemptStarted" &&
            event.payload.runId === options.run &&
            event.payload.turn === options.turn &&
            event.payload.toolUseId === toolUse.id &&
            !knownEvents.some(
              (candidate) =>
                (candidate.type === "ToolResultCommitted" || candidate.type === "ToolAttemptAbandoned") &&
                candidate.payload.attemptId === event.payload.attemptId,
            ),
        )
      if (attempt === undefined) {
        const attemptId = nextToolAttemptId(knownEvents, options.run, options.turn, toolUse.id)
        const inputCursor = reduceCanonicalSession(knownEvents).activeHead
        if (inputCursor === undefined) throw new Error("Cannot start a tool attempt without an active history head")
        const started = this.deps.makeEvent(
          options.input.sessionId,
          revision++,
          "ToolAttemptStarted",
          {
            runId: options.run,
            turn: options.turn,
            attemptId,
            toolUseId: toolUse.id,
            executionGeneration: options.executionGeneration ?? 0,
            branchId: options.branchId ?? "main",
            inputCursor,
            requestFingerprint: toolRequestFingerprint(toolUse.name, toolUse.input),
          },
          options.nextTrace,
        ) as Extract<AgentEvent, { type: "ToolAttemptStarted" }>
        await appendEvent(started)
        attempt = started
      }
      if (knownEvents[0]?.type !== "SessionCreated") return
      const parent = reduceCanonicalSession(knownEvents).activeHead
      if (parent === undefined) throw new Error("Cannot commit a tool result without an active history head")
      const committed = this.deps.makeEvent(
        options.input.sessionId,
        revision++,
        "ToolResultCommitted",
        {
          runId: options.run,
          turn: options.turn,
          attemptId: attempt.payload.attemptId,
          toolUseId: toolUse.id,
          executionGeneration: options.executionGeneration ?? 0,
          branchId: options.branchId ?? "main",
          requestFingerprint: attempt.payload.requestFingerprint,
          parent,
          result,
        },
        options.nextTrace,
      ) as Extract<AgentEvent, { type: "ToolResultCommitted" }>
      await appendEvent(committed)
    }

    interface SettledOutcome {
      /** The member finished without an executor dispatch; `settle` persists its facts. */
      readonly kind: "settled"
      readonly stopAfter: boolean
      readonly settle: () => Promise<void>
      /** Terminal judgment denial: the run must end once this member's facts are durable. */
      readonly terminalAfter?: ApprovalRequiredError
    }
    interface ReuseWaitOutcome {
      /** Duplicate of an earlier same-batch call; reuses its committed result. */
      readonly kind: "reuse-wait"
      readonly toolUse: ToolUseBlock
      readonly cacheKey: string
    }
    interface PlanOutcome {
      /** Approved for dispatch; execution is deferred so siblings can fan out. */
      readonly kind: "plan"
      readonly cacheKey: string
      readonly executeOne: () => Promise<ToolResult>
      readonly finalize: (result: ToolResult) => Promise<boolean>
    }
    type MemberOutcome = SettledOutcome | ReuseWaitOutcome | PlanOutcome

    const settleFromCache = async (toolUse: ToolUseBlock, cacheKey: string, siblingDenied?: ToolResult): Promise<void> => {
      const cached = siblingDenied ?? options.toolResultCache.get(cacheKey)
      if (!cached) throw new Error("idempotent tool reuse requires a committed canonical result")
      let reusedResult: ToolResult
      let reasons: string
      if (siblingDenied === undefined) {
        const repeatCount = (options.repeatedToolCalls.get(cacheKey) ?? 0) + 1
        options.repeatedToolCalls.set(cacheKey, repeatCount)
        reusedResult = {
          content:
            repeatCount >= 2
              ? `The model called ${toolUse.name} again with identical arguments. Stop calling tools and answer the user using the existing result.\nPrevious result:\n${cached.content}`
              : `This ${toolUse.name} call is identical to the previous one, so the previous result was reused. Do not call the tool again; answer the user using that result.\nPrevious result:\n${cached.content}`,
          ...(repeatCount >= 2 ? { isError: true } : {}),
        }
        reasons = "Reused the same canonical tool result"
      } else {
        // The duplicate never executed; it converges on the sibling's
        // dispatch-gate denial without entering the repeat-call counter,
        // carrying the same stable code the sibling settled with.
        reusedResult = {
          content: `tool ${toolUse.name} denied (stale_policy: ${SIBLING_POLICY_DENIAL_REASON}):\n${cached.content}`,
          isError: true,
          ...(cached.denial === undefined
            ? {}
            : {
                denial: {
                  code: cached.denial.code,
                  reason: SIBLING_POLICY_DENIAL_REASON,
                },
              }),
        }
        reasons = SIBLING_POLICY_DENIAL_REASON
      }
      const reusedPrepared = this.deps.makeEvent(
        options.input.sessionId,
        revision++,
        "ToolCallPrepared",
        {
          runId: options.run,
          turn: options.turn,
          toolUseId: toolUse.id,
          name: toolUse.name,
          status: "reused",
          reasons: [reasons],
          analyzerVersion: "executor",
          policyVersion: "executor",
        },
        options.nextTrace,
      ) as Extract<AgentEvent, { type: "ToolCallPrepared" }>
      await appendEvent(reusedPrepared)
      await commitResult(toolUse, reusedResult)
      results.push(toolResultForModel(toolUse.id, reusedResult))
    }

    const prepareMember = async (toolUse: ToolUseBlock, pendingKeys?: ReadonlySet<string>): Promise<MemberOutcome> => {
      if (options.input.signal?.aborted) throw abortError()
      const committedResult = [...knownEvents]
        .reverse()
        .find(
          (event): event is Extract<AgentEvent, { type: "ToolResultCommitted" }> =>
            event.type === "ToolResultCommitted" &&
            event.payload.runId === options.run &&
            event.payload.turn === options.turn &&
            event.payload.toolUseId === toolUse.id,
        )
      if (committedResult) {
        interactionOutcome = toolInteractionOutcome(committedResult.payload.result) ?? interactionOutcome
        observeResult(toolUse.name, toolUse.input, committedResult.payload.result)
        return {
          kind: "settled",
          stopAfter: loopGuard !== undefined || interactionOutcome === "declined",
          settle: async () => {
            results.push(toolResultForModel(toolUse.id, committedResult.payload.result))
          },
        }
      }

      const pendingAttempt = [...knownEvents]
        .reverse()
        .find(
          (event): event is Extract<AgentEvent, { type: "ToolAttemptStarted" }> =>
            event.type === "ToolAttemptStarted" &&
            event.payload.runId === options.run &&
            event.payload.turn === options.turn &&
            event.payload.toolUseId === toolUse.id &&
            !knownEvents.some(
              (candidate) =>
                (candidate.type === "ToolResultCommitted" || candidate.type === "ToolAttemptAbandoned") &&
                candidate.payload.attemptId === event.payload.attemptId,
            ),
        )
      if (pendingAttempt) {
        return {
          kind: "settled",
          stopAfter: false,
          settle: async () => {
            const abandoned = this.deps.makeEvent(
              options.input.sessionId,
              revision++,
              "ToolAttemptAbandoned",
              {
                runId: options.run,
                turn: options.turn,
                attemptId: pendingAttempt.payload.attemptId,
                toolUseId: toolUse.id,
                executionGeneration: pendingAttempt.payload.executionGeneration,
                reason: "recovered after an incomplete tool attempt",
                recoveryCommandId: `recovery:tool-abandon:${pendingAttempt.payload.attemptId}`,
              },
              options.nextTrace,
            ) as Extract<AgentEvent, { type: "ToolAttemptAbandoned" }>
            const recovered: ToolResult = {
              content: `The previous ${toolUse.name} execution did not reach its durable result. It was not retried automatically; start a new call if needed.`,
              isError: true,
            }
            const recoveryAttemptId = nextToolAttemptId([...knownEvents, abandoned], options.run, options.turn, toolUse.id)
            const recoveryStarted = this.deps.makeEvent(
              options.input.sessionId,
              revision++,
              "ToolAttemptStarted",
              {
                runId: options.run,
                turn: options.turn,
                attemptId: recoveryAttemptId,
                toolUseId: toolUse.id,
                executionGeneration: pendingAttempt.payload.executionGeneration,
                branchId: pendingAttempt.payload.branchId,
                inputCursor: pendingAttempt.payload.inputCursor,
                requestFingerprint: pendingAttempt.payload.requestFingerprint,
              },
              options.nextTrace,
            ) as Extract<AgentEvent, { type: "ToolAttemptStarted" }>
            const recoveryCommitted = this.deps.makeEvent(
              options.input.sessionId,
              revision++,
              "ToolResultCommitted",
              {
                runId: options.run,
                turn: options.turn,
                attemptId: recoveryAttemptId,
                toolUseId: toolUse.id,
                executionGeneration: pendingAttempt.payload.executionGeneration,
                branchId: pendingAttempt.payload.branchId,
                requestFingerprint: pendingAttempt.payload.requestFingerprint,
                parent: pendingAttempt.payload.inputCursor,
                result: recovered,
              },
              options.nextTrace,
            ) as Extract<AgentEvent, { type: "ToolResultCommitted" }>
            // The recovery decision is one canonical transition. A crash before
            // this append leaves the original attempt pending; a crash after it
            // leaves a committed deterministic result, so no external tool is run
            // again on either restart path.
            await appendEvents([abandoned, recoveryStarted, recoveryCommitted])
            results.push(toolResultForModel(toolUse.id, recovered))
          },
        }
      }

      const existingRequested = [...knownEvents]
        .reverse()
        .find(
          (event): event is Extract<AgentEvent, { type: "ToolCallRequested" }> =>
            event.type === "ToolCallRequested" &&
            event.payload.runId === options.run &&
            event.payload.turn === options.turn &&
            event.payload.toolUseId === toolUse.id,
        )
      const requested =
        existingRequested ??
        (this.deps.makeEvent(
          options.input.sessionId,
          revision++,
          "ToolCallRequested",
          {
            runId: options.run,
            turn: options.turn,
            toolUseId: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          },
          options.nextTrace,
        ) as Extract<AgentEvent, { type: "ToolCallRequested" }>)
      if (!existingRequested) await appendEvent(requested)
      if (options.input.signal?.aborted) throw abortError()

      const cacheKey = toolCallKey(toolUse.name, toolUse.input)
      const cached = options.toolResultCache.get(cacheKey)
      if (cached) {
        return {
          kind: "settled",
          stopAfter: false,
          settle: () => settleFromCache(toolUse, cacheKey),
        }
      }
      if (pendingKeys?.has(cacheKey)) {
        // An earlier sibling in this same batch already planned the identical
        // call; its committed result reaches the cache before this settle runs.
        return { kind: "reuse-wait", toolUse, cacheKey }
      }

      // Once a preparation fact exists, it is authoritative: on resume the
      // persisted preparedInput/decision is the only input allowed below.
      const existingPreparedBeforeHooks = [...knownEvents]
        .reverse()
        .find(
          (event): event is Extract<AgentEvent, { type: "ToolCallPrepared" }> =>
            event.type === "ToolCallPrepared" &&
            event.payload.runId === options.run &&
            event.payload.turn === options.turn &&
            event.payload.toolUseId === toolUse.id,
        )
      let toolInput = toolUse.input
      if (options.input.signal?.aborted) throw abortError()

      const toolMetadata: ToolExecutionMetadata | undefined = options.tools.describeTool?.(toolUse.name, toolInput)
      const existingPrepared = existingPreparedBeforeHooks
      const missingModelBashAuthority = toolUse.name === "bash" && !hasModelBashAuthority(options.tools)
      const sessionWorkspace =
        security?.workspaceRoot === undefined
          ? undefined
          : this.deps.workspacePolicyFactory?.({
              workspaceRoot: security.workspaceRoot,
              additionalDirectories: security.additionalDirectories,
              sessionId: options.input.sessionId,
            })
      const executionContextBase = {
        sessionId: options.input.sessionId,
        runId: options.run,
        turn: options.turn,
        toolUseId: toolUse.id,
        idempotencyKey: toolIdempotencyKey({
          sessionId: options.input.sessionId,
          runId: options.run,
          turn: options.turn,
          toolUseId: toolUse.id,
        }),
        trace: requested.trace,
        ...(sessionWorkspace === undefined ? {} : { workspace: sessionWorkspace }),
        ...(security === undefined ? {} : { security }),
        ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
        onOutput: (output: import("@ag2cli/core/tool-facts.js").ToolOutputChunk) => {
          this.deps.transientPublisher.emit(options.input.sessionId, requested.trace, "tool_output_delta", {
            runId: options.run,
            turn: options.turn,
            toolUseId: toolUse.id,
            name: toolUse.name,
            stream: output.stream,
            delta: output.text,
          })
        },
      }
      let rawPreparation: ToolPreparation
      if (missingModelBashAuthority) {
        rawPreparation = {
          status: "invalid",
          decision: "deny",
          preparedInput: toolInput,
          reasons: ["Model Bash has no local canonical security authority; execution is denied"],
          analyzerVersion: "executor-contract",
          policyVersion: "executor-contract",
        }
      } else if (existingPrepared) {
        rawPreparation = {
          status: existingPrepared.payload.status,
          // An adopted fact without a decision is fail-closed for every
          // status: "reused" replays from the cache path and never executes.
          decision: existingPrepared.payload.decision ?? "deny",
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
          ...(existingPrepared.payload.scopeRevision === undefined ? {} : { scopeRevision: existingPrepared.payload.scopeRevision }),
          ...(existingPrepared.payload.scopeDigest === undefined ? {} : { scopeDigest: existingPrepared.payload.scopeDigest }),
          ...(existingPrepared.payload.policyRevision === undefined ? {} : { policyRevision: existingPrepared.payload.policyRevision }),
          ...(existingPrepared.payload.denial === undefined ? {} : { denial: existingPrepared.payload.denial }),
          ...(existingPrepared.payload.securityFact === undefined ? {} : { securityFact: existingPrepared.payload.securityFact }),
        }
      } else if (options.tools.prepare) {
        try {
          rawPreparation = await options.tools.prepare({
            name: toolUse.name,
            input: toolInput,
            signal: options.input.signal,
            context: executionContextBase,
          })
        } catch (error) {
          rawPreparation = {
            status: "invalid",
            decision: "deny",
            preparedInput: toolInput,
            reasons: [`Preparation failed for tool ${toolUse.name}: ${error instanceof Error ? error.message : String(error)}`],
            analyzerVersion: "executor",
            policyVersion: "executor",
          }
        }
      } else {
        rawPreparation =
          toolUse.name === "bash"
            ? {
                status: "invalid",
                decision: "deny",
                preparedInput: toolInput,
                reasons: ["Bash security preparation is not injected; execution is denied"],
                analyzerVersion: "executor",
                policyVersion: "executor",
              }
            : {
                status: "ready",
                decision: "ask",
                preparedInput: toolInput,
                reasons: ["The tool did not provide canonical preparation; approval is required"],
                analyzerVersion: "executor",
                policyVersion: "executor",
              }
      }
      const preparation =
        toolUse.name === "bash"
          ? (this.deps.bashSecurity?.normalizeModelBashPreparation(toolInput, rawPreparation) ?? {
              ...rawPreparation,
              status: "invalid" as const,
              decision: "deny" as const,
              reasons: [...rawPreparation.reasons, "Bash security authority is not injected"],
            })
          : rawPreparation
      const preparedSecurityMismatch =
        existingPrepared !== undefined &&
        security?.workspaceRoot !== undefined &&
        ((existingPrepared.payload.scopeDigest !== undefined &&
          existingPrepared.payload.scopeDigest !==
            (security.scopeDigest ?? this.deps.workspaceScopeDigest?.(security.workspaceRoot, security.additionalDirectories))) ||
          (existingPrepared.payload.policyRevision !== undefined && existingPrepared.payload.policyRevision !== security.policyRevision))
      const securityBoundPreparation: ToolPreparation = preparedSecurityMismatch
        ? {
            ...preparation,
            status: "denied",
            decision: "deny",
            reasons: ["stale_policy: canonical session policy revision changed; a prepared approval cannot be reused"],
            // The override must also win the code: an adopted producer code
            // (e.g. outside_workspace) describes the old policy's verdict,
            // not the staleness that actually settled this call.
            denial: { code: "stale_policy" },
          }
        : security?.workspaceRoot === undefined
          ? preparation
          : {
              ...preparation,
              scopeRevision: security.scopeRevision,
              ...(security.scopeDigest === undefined && this.deps.workspaceScopeDigest === undefined
                ? {}
                : {
                    scopeDigest:
                      security.scopeDigest ?? this.deps.workspaceScopeDigest?.(security.workspaceRoot, security.additionalDirectories),
                  }),
              policyRevision: security.policyRevision,
            }
      if (securityBoundPreparation.preparedInput !== undefined) toolInput = securityBoundPreparation.preparedInput
      const preparedEvent =
        existingPrepared ??
        (this.deps.makeEvent(
          options.input.sessionId,
          revision++,
          "ToolCallPrepared",
          {
            runId: options.run,
            turn: options.turn,
            toolUseId: toolUse.id,
            name: toolUse.name,
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
          options.nextTrace,
        ) as Extract<AgentEvent, { type: "ToolCallPrepared" }>)
      if (!existingPrepared) await appendEvent(preparedEvent)

      // No default: an approval decision exists only where a branch recorded
      // one. The non-ask path never consults approval and executes directly.
      let decision: ApprovalDecision | undefined
      let denialReason: DenialReason | undefined
      let terminalDenial = false
      // Every authorization denial settles through one fact sequence: a
      // failed trace, the committed denied result, then the model-facing entry.
      const settledDenial = (denied: ToolResult, terminalAfter?: ApprovalRequiredError): SettledOutcome => ({
        kind: "settled",
        stopAfter: terminalAfter !== undefined,
        ...(terminalAfter !== undefined ? { terminalAfter } : {}),
        settle: async () => {
          this.deps.traceSink.record({
            name: "execution.tool",
            phase: "failed",
            sessionId: options.input.sessionId,
            trace: {
              causationId: requested.eventId,
              traceId: requested.trace.traceId,
              operationId: requested.trace.operationId,
            },
            timestamp: this.deps.identity.now(),
            attributes: {
              toolName: toolUse.name,
              executionMode: "model",
              executionStatus: "denied",
            },
          })
          await commitResult(toolUse, denied)
          results.push(toolResultForModel(toolUse.id, denied))
        },
      })
      if (
        securityBoundPreparation.status === "invalid" ||
        securityBoundPreparation.status === "blocked" ||
        securityBoundPreparation.status === "denied" ||
        securityBoundPreparation.status === "reused"
      ) {
        const denial: ToolDenial =
          securityBoundPreparation.status === "invalid"
            ? { kind: "invalid", reasons: securityBoundPreparation.reasons }
            : securityBoundPreparation.status === "reused"
              ? { kind: "reused", reasons: securityBoundPreparation.reasons }
              : {
                  kind: "policy",
                  reasons: securityBoundPreparation.reasons,
                  ...(securityBoundPreparation.denial === undefined ? {} : { code: securityBoundPreparation.denial.code }),
                }
        const denied = deniedResult(toolUse.name, denial)
        return settledDenial(denied)
      }
      const judgment = judgeModelToolCall(
        {
          name: toolUse.name,
          // The early settle above already rejects invalid preparations;
          // this keeps the judgment input honest so reordering the two
          // statements cannot silently admit an invalid input. The cast
          // widens the control-flow-narrowed status back to its union.
          inputValid: (securityBoundPreparation.status as ToolPreparation["status"]) !== "invalid",
          ...(securityBoundPreparation.policyRevision === undefined
            ? {}
            : {
                preparedAtPolicyRevision: securityBoundPreparation.policyRevision,
              }),
          ...(securityBoundPreparation.securityFact === undefined ? {} : { securityFact: securityBoundPreparation.securityFact }),
        },
        security,
        // Surfaces are a composition-level fact: injected through
        // dependencies, they decide whether an ask reaches the approval
        // broker or terminates the call.
        this.deps.permissionSurfaces,
      )
      if (judgment.decision === "deny") {
        const denied = deniedResult(toolUse.name, {
          kind: "judgment",
          code: judgment.code,
        })
        return settledDenial(denied, judgment.terminal === true ? new ApprovalRequiredError(toolUse.name) : undefined)
      }
      if (judgment.decision === "ask") {
        const guardianMode = security?.permissionMode === "auto"
        if (guardianMode && this.deps.guardian === undefined) {
          // Auto owns every ask to the guardian; without one there is no
          // answerer and no fallback surface. Converge immediately with the
          // surface-less approval_required terminal shape — no lifecycle
          // request/resolution events, no fabricated guardian identity.
          return settledDenial(
            deniedResult(toolUse.name, {
              kind: "judgment",
              code: "guardian_denied",
              reason: "no guardian reviewer configured",
            }),
            new ApprovalRequiredError(toolUse.name),
          )
        }
        const existingApprovalRequested = [...knownEvents]
          .reverse()
          .find(
            (event): event is Extract<AgentEvent, { type: "ToolApprovalRequested" }> =>
              event.type === "ToolApprovalRequested" &&
              event.payload.runId === options.run &&
              event.payload.turn === options.turn &&
              event.payload.toolUseId === toolUse.id &&
              event.payload.preparedEventId === preparedEvent.eventId,
          )
        const approvalRequested =
          existingApprovalRequested ??
          (this.deps.makeEvent(
            options.input.sessionId,
            revision++,
            "ToolApprovalRequested",
            {
              runId: options.run,
              turn: options.turn,
              toolUseId: toolUse.id,
              name: toolUse.name,
              preparedEventId: preparedEvent.eventId,
              inputFingerprint: toolRequestFingerprint(toolUse.name, toolInput),
              // Ownership: absent means the user answers; auto asks are
              // guardian-owned so no human surface may resolve them.
              ...(guardianMode ? { ownedBy: "guardian" as const } : {}),
              ...(securityBoundPreparation.scopeRevision === undefined ? {} : { scopeRevision: securityBoundPreparation.scopeRevision }),
              ...(securityBoundPreparation.policyRevision === undefined ? {} : { policyRevision: securityBoundPreparation.policyRevision }),
            },
            options.nextTrace,
          ) as Extract<AgentEvent, { type: "ToolApprovalRequested" }>)
        if (!existingApprovalRequested) await appendEvent(approvalRequested)

        let resolved = [...knownEvents]
          .reverse()
          .find(
            (event): event is Extract<AgentEvent, { type: "ToolApprovalResolved" }> =>
              event.type === "ToolApprovalResolved" &&
              event.payload.runId === options.run &&
              event.payload.turn === options.turn &&
              event.payload.toolUseId === toolUse.id &&
              event.payload.preparedEventId === preparedEvent.eventId,
          )
        if (options.recovered === true && resolved?.payload.decision === "approved") {
          // Recovery fence: an approval recorded before the host died must
          // never execute unattended on resume. Reaching here means no
          // committed result exists for this call; a recorded approval for
          // it cannot be re-asked, so denying with the stable code is the
          // only honest convergence and a resubmitted call gets a fresh
          // approval cycle. An unresolved ask is not fenced — it re-asks
          // through the broker below like any pending decision.
          return settledDenial({
            content: `tool ${toolUse.name} denied (stale_policy: ${STALE_POLICY_RECOVERY_DENIAL})`,
            isError: true,
            denial: {
              code: "stale_policy",
              reason: STALE_POLICY_RECOVERY_DENIAL,
            },
          })
        }
        // TS drops assignment narrowing across an awaited callback
        // initializer, and the record below needs the decision at its
        // non-optional type, so capture the outcome in a local first.
        let brokerDecision: ApprovalDecision
        let guardianAttribution: { guardianId: string; reasonCode?: GuardianDenialReasonCode; reason?: string } | undefined
        let systemResolution = false
        if (resolved !== undefined) {
          brokerDecision = resolved.payload.decision
          // A replayed resolution keeps its attribution on display: guardian
          // denials re-settle as guardian_denied, system ones as stale_policy.
          // A guardian-owned ask denied without guardian attribution (an
          // absent/user encoding that slipped past the write-time fence)
          // settles as the guardian terminal, never as user_denied.
          if (resolved.payload.decision === "denied") {
            if (resolved.payload.resolvedBy === "guardian") denialReason = "guardian-denied"
            else if (resolved.payload.resolvedBy === "system") denialReason = "invalidated"
            else if (approvalRequested.payload.ownedBy === "guardian") denialReason = "guardian-denied"
          }
          // Ownership fence on the replay path: an ask dispatches only on its
          // own answerer's approval — source and identity both. The system
          // answerer only ever stamps denials, so an approved system encoding
          // is impossible on any ask; a guardian-owned ask approves only as
          // this guardian's own record; a user-owned ask approves only as the
          // user's. Every violation fail-closes — never dispatch.
          if (resolved.payload.decision === "approved") {
            if (resolved.payload.resolvedBy === "system") {
              return settledDenial(deniedResult(toolUse.name, { kind: "approval", reason: "invalidated" }))
            }
            if (approvalRequested.payload.ownedBy === "guardian") {
              if (resolved.payload.resolvedBy !== "guardian" || resolved.payload.guardian?.guardianId !== this.deps.guardian?.guardianId) {
                return settledDenial(deniedResult(toolUse.name, { kind: "approval", reason: "guardian-denied" }))
              }
            } else if (resolved.payload.resolvedBy === "guardian") {
              return settledDenial(deniedResult(toolUse.name, { kind: "approval", reason: "invalidated" }))
            }
          }
        } else if (guardianMode) {
          if (approvalRequested.payload.ownedBy !== "guardian") {
            // The ask predates the flip onto auto: it stays user-owned and
            // the guardian is not its answerer. One ask, one answerer —
            // converge on the stale-policy family instead of spending a
            // review on somebody else's ask.
            return settledDenial(deniedResult(toolUse.name, { kind: "approval", reason: "invalidated" }))
          }
          // Auto asks are guardian-owned: the review race replaces the human
          // broker wait. One ask, one answerer — the broker is never consulted.
          const goal = [...knownEvents]
            .reverse()
            .find(
              (event): event is Extract<AgentEvent, { type: "RunStarted" }> =>
                event.type === "RunStarted" && event.payload.runId === options.run,
            )?.payload.goal
          const review = await this.requestGuardianReview(options, {
            toolUse,
            toolInput,
            preparation: securityBoundPreparation,
            approvalRequested,
            security,
            ...(goal === undefined ? {} : { goal }),
          })
          brokerDecision = review.decision
          denialReason = review.denialReason
          guardianAttribution = review.guardian
          systemResolution = review.systemResolution
        } else {
          if (approvalRequested.payload.ownedBy === "guardian") {
            // Mode drifted off auto after the ask was created: the ask stays
            // guardian-owned and the human broker is not its answerer.
            return settledDenial(deniedResult(toolUse.name, { kind: "approval", reason: "guardian-denied" }))
          }
          const outcome = await this.deps.approval.request({
            sessionId: options.input.sessionId,
            runId: options.run,
            turn: options.turn,
            toolUseId: toolUse.id,
            name: toolUse.name,
            input: toolInput,
            ...(toolMetadata ? { tool: toolMetadata } : {}),
            signal: options.input.signal,
          })
          if (typeof outcome !== "string") {
            denialReason = outcome.reason
            // Terminality rides only the broker answer; record-channel
            // invalidations stay retryable in-run results.
            terminalDenial = outcome.terminal === true
          }
          brokerDecision = approvalDecisionOf(outcome)
        }
        decision = brokerDecision
        if (options.input.signal?.aborted) throw abortError()
        if (!resolved) {
          const outcome = await this.deps.approvalResolution.record({
            sessionId: options.input.sessionId,
            runId: options.run,
            turn: options.turn,
            toolUseId: toolUse.id,
            preparedEventId: preparedEvent.eventId,
            expectedScopeRevision: securityBoundPreparation.scopeRevision ?? approvalRequested.payload.scopeRevision ?? 0,
            expectedPolicyRevision: securityBoundPreparation.policyRevision ?? approvalRequested.payload.policyRevision ?? 0,
            decision: brokerDecision,
            ...(systemResolution ? { resolvedBy: "system" as const } : {}),
            ...(guardianAttribution === undefined ? {} : { guardian: guardianAttribution }),
          })
          decision = outcome.decision
          // The forced-denial channel (and any residual CAS disagreement)
          // converges as a policy denial; an approved verdict can never
          // dispatch under a disagreeing recorded outcome.
          if (outcome.reason !== undefined) denialReason = outcome.reason
          else if (brokerDecision === "approved" && outcome.decision === "denied") denialReason = "invalidated"
          // Post-record ownership fence: an approved durable outcome on a
          // guardian-owned ask must be the guardian's own record — source and
          // identity both. Anything else is a residual race and converges as
          // the guardian terminal, never dispatch.
          if (guardianMode && outcome.decision === "approved" && !systemResolution) {
            const attributed =
              outcome.event.payload.resolvedBy === "guardian" &&
              outcome.event.payload.guardian?.guardianId === guardianAttribution?.guardianId
            if (!attributed) {
              decision = "denied"
              denialReason = "guardian-denied"
            }
          }
          resolved = outcome.event
          // The service owns persistence/publication. Advance this turn's local
          // trace/revision cursor to the canonical event before writing the
          // following tool lifecycle facts. A security change can commit
          // between the ask and the recorded decision (it is what invalidates
          // the ask); merge those foreign canonical events so the replay
          // cursor stays contiguous instead of throwing a revision gap when
          // the settled outcome commits its lifecycle facts.
          options.nextTrace(resolved.eventId)
          await mergeForeignUpTo(resolved.revision)
          if (!knownEvents.some((event) => event.eventId === resolved?.eventId)) knownEvents.push(resolved)
          revision = Math.max(revision, resolved.revision + 1)
        }
        // The approval is bound to the exact canonical input it was requested
        // for; an input that no longer matches that fingerprint must not
        // execute under the recorded decision.
        if (decision === "approved" && approvalRequested.payload.inputFingerprint !== toolRequestFingerprint(toolUse.name, toolInput)) {
          // Binding invalidation, same family as the recovery fence: the
          // recorded approval never covered this exact input, so converge on
          // the stale-approval code, not user_denied.
          return settledDenial({
            content: `tool ${toolUse.name} denied (stale_policy: ${APPROVAL_INPUT_MISMATCH_REASON})`,
            isError: true,
            denial: {
              code: "stale_policy",
              reason: APPROVAL_INPUT_MISMATCH_REASON,
            },
          })
        }
      }

      if (decision === "denied") {
        const denied = deniedResult(
          toolUse.name,
          denialReason === undefined ? { kind: "approval" } : { kind: "approval", reason: denialReason },
        )
        return settledDenial(
          denied,
          terminalDenial
            ? new ApprovalRequiredError(toolUse.name, denialReason === "invalidated" ? "stale_policy" : "approval_required")
            : undefined,
        )
      }

      const toolAttemptId = nextToolAttemptId(knownEvents, options.run, options.turn, toolUse.id)
      const inputCursor = reduceCanonicalSession(knownEvents).activeHead
      if (inputCursor === undefined) throw new Error("Cannot start a tool attempt without an active history head")
      const toolAttemptStarted = this.deps.makeEvent(
        options.input.sessionId,
        revision++,
        "ToolAttemptStarted",
        {
          runId: options.run,
          turn: options.turn,
          attemptId: toolAttemptId,
          toolUseId: toolUse.id,
          executionGeneration: options.executionGeneration ?? 0,
          branchId: options.branchId ?? "main",
          inputCursor,
          requestFingerprint: toolRequestFingerprint(toolUse.name, toolInput),
        },
        options.nextTrace,
      ) as Extract<AgentEvent, { type: "ToolAttemptStarted" }>
      await appendEvent(toolAttemptStarted)
      const toolStartedAt = performance.now()
      const executionStarted = this.deps.makeEvent(
        options.input.sessionId,
        revision++,
        "ToolCallExecutionStarted",
        {
          runId: options.run,
          turn: options.turn,
          toolUseId: toolUse.id,
          name: toolUse.name,
          dispatchId: toolAttemptId,
          requestFingerprint: toolRequestFingerprint(toolUse.name, toolInput),
          replayPolicy: "never",
          preparedEventId: preparedEvent.eventId,
          ...(toolUse.name === "bash"
            ? {
                execution: {
                  shell: "/bin/bash" as const,
                  argvShape: "bash-noprofile-norc-c" as const,
                  cwd: securityBoundPreparation.cwd ?? this.deps.environment?.cwd ?? ".",
                },
              }
            : {}),
        },
        options.nextTrace,
      ) as Extract<AgentEvent, { type: "ToolCallExecutionStarted" }>
      await appendEvent(executionStarted)
      this.deps.traceSink.record({
        name: "execution.tool",
        phase: "started",
        sessionId: options.input.sessionId,
        trace: {
          causationId: requested.eventId,
          traceId: requested.trace.traceId,
          operationId: requested.trace.operationId,
        },
        timestamp: this.deps.identity.now(),
        attributes: {
          toolName: toolUse.name,
          executionMode: "model",
        },
      })
      const boundSecurity: SessionSecurityStamp = {
        ...(securityBoundPreparation.policyRevision === undefined ? {} : { policyRevision: securityBoundPreparation.policyRevision }),
        ...(securityBoundPreparation.scopeRevision === undefined ? {} : { scopeRevision: securityBoundPreparation.scopeRevision }),
        ...(securityBoundPreparation.scopeDigest === undefined ? {} : { scopeDigest: securityBoundPreparation.scopeDigest }),
      }
      // The spawn fence carries its own token so a tool that reaches the
      // gate before the dispatch section releases queues behind it instead
      // of tripping the reentry guard; the wrapper observes fence denials
      // so a stale-policy result is never treated as a reusable outcome.
      let spawnFenceDenied = false
      const spawnSection = this.deps.preSpawnGateFor(options.input.sessionId, `spawn:${toolUse.id}`, boundSecurity)
      const spawnGate: PreSpawnGate = async (spawn) => {
        try {
          return await spawnSection(spawn)
        } catch (error) {
          if (isStalePolicySpawnDenial(error)) spawnFenceDenied = true
          throw error
        }
      }
      const executionContext = {
        ...executionContextBase,
        preparation: securityBoundPreparation,
        approvalDecision: decision,
        // The judgment is the canonical authorization for calls that execute
        // without an approval; the tool's authorization gate accepts it in
        // place of a broker decision for preparation "ask" calls.
        ...(judgment.decision === "allow" ? { judgmentDecision: "allow" as const } : {}),
        ...(securityBoundPreparation.cwd === undefined ? {} : { cwd: securityBoundPreparation.cwd }),
        preSpawnGate: spawnGate,
      }
      // The dispatch gate holds its serial section only while it re-reads
      // canonical security and initiates execution; completion is awaited
      // outside the section so queued permission commits never starve.
      let dispatchDenied = false
      return {
        kind: "plan",
        cacheKey,
        executeOne: async () => {
          let execution: Promise<ToolResult> | undefined
          await this.deps.serialPoint.critical(options.input.sessionId, `dispatch:${toolUse.id}`, "tool-dispatch", async () => {
            const fresh = await this.deps.readSessionSecurity(options.input.sessionId)
            if (fresh !== undefined && sessionSecurityDrifted(boundSecurity, fresh)) {
              dispatchDenied = true
              return
            }
            execution = options.tools.execute({
              name: toolUse.name,
              input: toolInput,
              signal: options.input.signal,
              context: executionContext,
            })
          })
          if (dispatchDenied) {
            return {
              content: `tool ${toolUse.name} denied (stale_policy: session policy changed before dispatch; call not started)`,
              isError: true,
              denial: {
                code: "stale_policy",
                reason: "session policy changed before dispatch; call not started",
              },
            }
          }
          if (execution === undefined) throw new Error("dispatch gate must either deny the call or initiate its execution")
          return await execution
        },
        finalize: async (result: ToolResult): Promise<boolean> => {
          interactionOutcome = toolInteractionOutcome(result) ?? interactionOutcome
          // A dispatch- or fence-level policy denial is not a canonical
          // execution outcome; keep it out of the idempotency cache so a
          // policy-matching retry re-executes.
          if (!dispatchDenied && !spawnFenceDenied) options.toolResultCache.set(cacheKey, result)
          // The result is the canonical completion point; persist it before
          // anything derived from it so recovery never re-executes a
          // completed tool.
          await commitResult(toolUse, result)
          this.deps.traceSink.record({
            name: "execution.tool",
            phase: result.isError ? "failed" : "succeeded",
            sessionId: options.input.sessionId,
            trace: {
              causationId: requested.eventId,
              traceId: requested.trace.traceId,
              operationId: requested.trace.operationId,
            },
            timestamp: this.deps.identity.now(),
            durationMs: Math.round(performance.now() - toolStartedAt),
            attributes: {
              toolName: toolUse.name,
              executionMode: "model",
              executionStatus: dispatchDenied || spawnFenceDenied ? "denied" : result.isError ? "failed" : "succeeded",
              ...traceAttributesFromToolMetadata(result.metadata),
            },
          })
          observeResult(toolUse.name, toolInput, result)
          results.push(toolResultForModel(toolUse.id, result))
          return loopGuard !== undefined || interactionOutcome === "declined"
        },
      }
    }

    const isConcurrencySafe = (toolUse: ToolUseBlock): boolean => {
      try {
        return options.tools.describeTool?.(toolUse.name, toolUse.input)?.concurrencySafe === true
      } catch {
        return false
      }
    }
    // Maximal runs of consecutive concurrency-safe calls become one batch;
    // everything else keeps the strictly serial turn semantics.
    const batches: { parallel: boolean; members: ToolUseBlock[] }[] = []
    for (const toolUse of options.toolUses) {
      const safe = isConcurrencySafe(toolUse)
      const last = batches.at(-1)
      if (safe && last?.parallel) last.members.push(toolUse)
      else batches.push({ parallel: safe, members: [toolUse] })
    }
    for (const batch of batches) {
      if (batch.parallel && batch.members.length > 1) {
        const outcomes: MemberOutcome[] = []
        const pendingKeys = new Set<string>()
        let stopDeclaring = false
        for (const toolUse of batch.members) {
          if (stopDeclaring) break
          const outcome = await prepareMember(toolUse, pendingKeys)
          outcomes.push(outcome)
          if (outcome.kind === "plan") pendingKeys.add(outcome.cacheKey)
          else if (outcome.kind === "settled" && outcome.stopAfter) stopDeclaring = true
        }
        const planned = outcomes.filter((outcome): outcome is PlanOutcome => outcome.kind === "plan")
        // Concurrency-safe siblings dispatch together; canonical results
        // commit in declaration order (QR-9), never completion order. A
        // sibling's rejection must not strand its completed siblings, so
        // every dispatch settles before any failure is surfaced.
        const executed = await Promise.allSettled(planned.map((plan) => plan.executeOne()))
        let planCursor = 0
        // Settled plan results keyed by cacheKey; a sibling denied by the
        // dispatch gate never reaches the idempotency cache, so its duplicate
        // converges on the denied result through this batch-local map.
        const committedBatch = new Map<string, ToolResult>()
        const failedKeys = new Set<string>()
        const failures: unknown[] = []
        for (const outcome of outcomes) {
          if (outcome.kind === "plan") {
            const settled = executed[planCursor]!
            planCursor += 1
            if (settled.status === "rejected") {
              failedKeys.add(outcome.cacheKey)
              failures.push(settled.reason)
              continue
            }
            try {
              await outcome.finalize(settled.value)
              committedBatch.set(outcome.cacheKey, settled.value)
            } catch (error) {
              failedKeys.add(outcome.cacheKey)
              failures.push(error)
            }
          } else if (outcome.kind === "reuse-wait") {
            if (options.toolResultCache.has(outcome.cacheKey)) {
              await settleFromCache(outcome.toolUse, outcome.cacheKey)
            } else if (committedBatch.has(outcome.cacheKey)) {
              await settleFromCache(outcome.toolUse, outcome.cacheKey, committedBatch.get(outcome.cacheKey))
            } else if (failedKeys.has(outcome.cacheKey)) {
              // Its planned sibling produced no durable result; the surfaced
              // batch failure ends the run and a resumed turn re-prepares it.
              continue
            } else {
              throw new Error("idempotent tool reuse requires a committed canonical result")
            }
          } else {
            await outcome.settle()
          }
        }
        // Throwing inside the settle loop would race sibling commits past the
        // run's RunFailed; surface the first failure or terminal only after
        // the full pass, with the failure — the actual cause — taking
        // precedence over a controlled approval terminal.
        const terminalOutcome = outcomes.find(
          (
            outcome,
          ): outcome is SettledOutcome & {
            terminalAfter: ApprovalRequiredError
          } => outcome.kind === "settled" && outcome.terminalAfter !== undefined,
        )
        if (failures.length > 0) throw failures[0]
        if (terminalOutcome !== undefined) throw terminalOutcome.terminalAfter
      } else {
        for (const toolUse of batch.members) {
          const outcome = await prepareMember(toolUse)
          if (outcome.kind === "plan") {
            const stop = await outcome.finalize(await outcome.executeOne())
            if (stop) break
          } else if (outcome.kind === "reuse-wait") {
            await settleFromCache(outcome.toolUse, outcome.cacheKey)
          } else {
            await outcome.settle()
            // Terminal denials end the run only after every sibling's facts
            // are committed, so RunFailed stays the last durable event.
            if (outcome.terminalAfter !== undefined) throw outcome.terminalAfter
            if (outcome.stopAfter) break
          }
        }
      }
      if (loopGuard !== undefined || interactionOutcome === "declined") break
    }
    return {
      results,
      revision,
      ...(loopGuard ? { loopGuard } : {}),
      ...(interactionOutcome ? { interactionOutcome } : {}),
    }
  }

  /**
   * Auto-mode ask resolution: race the guardian review against the runtime
   * deadline and the security-invalidation channel. Every seam failure
   * (throw, deadline, disconnect, unparsable output, binding mismatch) is a
   * fail-closed guardian denial; policy drift records a system denial; run
   * cancellation propagates as AbortError exactly like the human ask path.
   */
  private async requestGuardianReview(
    options: ExecuteToolCallsInput,
    facts: {
      readonly toolUse: ToolUseBlock
      readonly toolInput: unknown
      readonly preparation: ToolPreparation
      readonly approvalRequested: Extract<AgentEvent, { type: "ToolApprovalRequested" }>
      readonly security: ExecuteToolCallsInput["security"]
      /** The user's own run text found by the caller; absent only on a corrupted log. */
      readonly goal?: string
    },
  ): Promise<{
    readonly decision: ApprovalDecision
    readonly denialReason?: DenialReason
    readonly guardian?: { readonly guardianId: string; readonly reasonCode?: GuardianDenialReasonCode; readonly reason?: string }
    readonly systemResolution: boolean
  }> {
    const guardian = this.deps.guardian
    if (guardian === undefined) throw new Error("requestGuardianReview requires a configured guardian")
    const goal = facts.goal
    const effect = modelToolEffectOf(facts.toolUse.name)
    // Defensive fence only: a run that reached an ask carries a durable
    // RunStarted goal equal to its accepted input, so a missing or blank
    // goal means a corrupted log — fail closed without calling the guardian.
    if (effect === undefined || goal === undefined || goal.trim().length === 0) {
      return {
        decision: "denied",
        denialReason: "guardian-denied",
        guardian: {
          guardianId: guardian.guardianId,
          reasonCode: "review-unavailable",
          reason: "guardian review context unavailable",
        },
        systemResolution: false,
      }
    }
    const deadlineMs = this.deps.guardianDeadlineMs ?? DEFAULT_GUARDIAN_REVIEW_DEADLINE_MS
    // One revision chain feeds the review payload, the wait basis, and the
    // record expectations: the preparation's own revision, else the revision
    // the ask was minted under, else the run's security snapshot.
    const basisPolicyRevision =
      facts.preparation.policyRevision ?? facts.approvalRequested.payload.policyRevision ?? facts.security?.policyRevision ?? 0
    const request: GuardianReviewRequest = {
      sessionId: options.input.sessionId,
      runId: options.run,
      turn: options.turn,
      toolUseId: facts.toolUse.id,
      name: facts.toolUse.name,
      preparedInput: facts.preparation.preparedInput ?? facts.toolInput,
      inputFingerprint: facts.approvalRequested.payload.inputFingerprint,
      ...(facts.preparation.cwd === undefined ? {} : { cwd: facts.preparation.cwd }),
      effect,
      policyRevision: basisPolicyRevision,
      ...(facts.preparation.scopeRevision === undefined ? {} : { scopeRevision: facts.preparation.scopeRevision }),
      ...(facts.preparation.approvalFingerprint === undefined ? {} : { approvalFingerprint: facts.preparation.approvalFingerprint }),
      goal,
      deadlineMs,
      ...(options.input.signal === undefined ? {} : { signal: options.input.signal }),
    }
    const wait = this.deps.guardianWaits?.register(options.input.sessionId, basisPolicyRevision)
    const deadlineTimer = (this.deps.guardianDeadlineTimer ?? createGuardianDeadlineTimer()).start(deadlineMs)
    let raced: GuardianVerdict | "invalidated" | "deadline"
    const review = guardian.review(request)
    try {
      raced = await Promise.race([review, ...(wait === undefined ? [] : [wait.aborted]), deadlineTimer.expired])
    } catch (error) {
      // Run cancellation is not a denial: the abort propagates through the
      // same cancel semantics as the human ask path.
      if (options.input.signal?.aborted) throw error
      // Any other review-seam failure is a fail-closed guardian denial —
      // never a crash, never a fallback surface.
      return {
        decision: "denied",
        denialReason: "guardian-denied",
        guardian: { guardianId: guardian.guardianId, reasonCode: "review-unavailable", reason: "guardian review failed" },
        systemResolution: false,
      }
    } finally {
      // A verdict or failure settling after the race ended is a late result:
      // swallow it so a discarded rejection never surfaces as unhandled.
      void review.catch(() => undefined)
      deadlineTimer.cancel()
      wait?.dispose()
    }
    if (raced === "invalidated") {
      // Policy drift during the wait is a system outcome, not a guardian
      // verdict: the denial records resolvedBy "system" and maps to
      // stale_policy.
      return { decision: "denied", denialReason: "invalidated", systemResolution: true }
    }
    if (raced === "deadline") {
      return {
        decision: "denied",
        denialReason: "guardian-denied",
        guardian: { guardianId: guardian.guardianId, reasonCode: "review-unavailable", reason: "guardian review deadline" },
        systemResolution: false,
      }
    }
    // Binding verification before anything is recorded: a verdict must echo
    // this request instance and this exact input; mismatched or late
    // approvals are discarded and denied.
    if (raced.toolUseId !== facts.toolUse.id || raced.inputFingerprint !== request.inputFingerprint) {
      return {
        decision: "denied",
        denialReason: "guardian-denied",
        guardian: {
          guardianId: guardian.guardianId,
          reasonCode: "review-unavailable",
          reason: "guardian verdict binding mismatch",
        },
        systemResolution: false,
      }
    }
    // Payload validation before anything is recorded: a verdict's own text is
    // foreign input, and recording an out-of-closure code or oversized
    // attribution would poison the canonical log and every resume after it.
    if (!guardianVerdictIsRecordable(raced, guardian.guardianId)) {
      return {
        decision: "denied",
        denialReason: "guardian-denied",
        guardian: {
          guardianId: guardian.guardianId,
          reasonCode: "review-unavailable",
          reason: "guardian verdict identity or payload invalid",
        },
        systemResolution: false,
      }
    }
    // The recorded identity is always the configured guardian's own, never
    // the verdict's self-report — a matched payload proves the verdict came
    // through this adapter, and the adapter owns the identity. The decision
    // is mapped from the validated verdict's own outcome (recordable closed
    // it to approve or deny), so no non-verdict path can mint approval here.
    return {
      decision: raced.decision === "deny" ? "denied" : "approved",
      ...(raced.decision === "deny" ? { denialReason: "guardian-denied" as const } : {}),
      guardian: {
        guardianId: guardian.guardianId,
        ...(raced.decision === "deny" ? { reasonCode: raced.reasonCode } : {}),
        ...(raced.reason === undefined ? {} : { reason: raced.reason }),
      },
      systemResolution: false,
    }
  }
}

/**
 * Local payload validation of a guardian verdict before anything is
 * recorded: the decision must sit in the closure, the identity must be the
 * configured guardian's own, a denial code must sit in the stable closure,
 * and display text must fit canonical bounds. Anything else fails closed
 * instead of poisoning the log.
 */
function guardianVerdictIsRecordable(verdict: GuardianVerdict, guardianId: string): boolean {
  if (verdict.guardianId !== guardianId) return false
  if (verdict.decision !== "approve" && verdict.decision !== "deny") return false
  if (verdict.decision === "deny" && !(GUARDIAN_DENIAL_REASON_CODES as readonly string[]).includes(verdict.reasonCode)) {
    return false
  }
  if (verdict.reason === undefined) return true
  if (verdict.reason.length === 0 || verdict.reason.length > MAX_GUARDIAN_REASON_LENGTH) return false
  for (const character of verdict.reason) {
    if (character === "\t" || character === "\n" || character === "\r") continue
    const code = character.codePointAt(0)!
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false
  }
  return true
}

function toolResultForModel(toolUseId: string, result: ToolResult): { tool_use_id: string; content: string; is_error?: boolean } {
  return {
    tool_use_id: toolUseId,
    content: result.content,
    ...(result.isError ? { is_error: true } : {}),
  }
}

function toolInteractionOutcome(result: ToolResult): ToolInteractionOutcome | undefined {
  const value = result.metadata?.askUserOutcome
  return value === "answered" || value === "declined" || value === "rejected" ? value : undefined
}

function toolCallKey(name: string, input: unknown): string {
  return `${name}\u0000${stableJson(input)}`
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

function nextToolAttemptId(events: readonly AgentEvent[], run: RunId, turn: number, toolUseId: string): string {
  const prefix = `${run}:${turn}:tool:${toolUseId}:attempt:`
  const used = new Set(
    events
      .filter((event): event is Extract<AgentEvent, { type: "ToolAttemptStarted" }> => event.type === "ToolAttemptStarted")
      .filter((event) => event.payload.runId === run && event.payload.turn === turn && event.payload.toolUseId === toolUseId)
      .map((event) => event.payload.attemptId),
  )
  let sequence = 1
  while (used.has(`${prefix}${sequence}`)) sequence += 1
  return `${prefix}${sequence}`
}

function toolRequestFingerprint(name: string, input: unknown): string {
  return `tool:${name}:${stableJson(input)}`
}

type ToolDenial =
  | { readonly kind: "invalid"; readonly reasons: readonly string[] }
  | {
      readonly kind: "policy"
      readonly reasons: readonly string[]
      readonly code?: PermissionDenialCode
    }
  | { readonly kind: "reused"; readonly reasons?: readonly string[] }
  | { readonly kind: "approval"; readonly reason?: DenialReason }
  | { readonly kind: "judgment"; readonly code: PermissionDenialCode; readonly reason?: string }

function deniedResult(name: string, denial: ToolDenial): ToolResult {
  switch (denial.kind) {
    case "approval": {
      // An invalidated pending request was denied by a policy change, and a
      // guardian-denied one by the review seam — neither is the user: surface
      // the real cause, not user_denied.
      const code =
        denial.reason === "invalidated" ? "stale_policy" : denial.reason === "guardian-denied" ? "guardian_denied" : "user_denied"
      const text =
        denial.reason === undefined
          ? "user_denied"
          : denial.reason === "invalidated"
            ? "stale_policy"
            : denial.reason === "guardian-denied"
              ? "guardian_denied"
              : `user_denied: ${denial.reason}`
      return {
        content: `tool ${name} denied (${text})`,
        isError: true,
        denial: {
          code,
          ...(denial.reason !== undefined && denial.reason !== "invalidated" && denial.reason !== "guardian-denied"
            ? { reason: denial.reason }
            : {}),
        },
      }
    }
    case "judgment":
      return {
        content: `tool ${name} denied (${denial.code}${denial.reason === undefined ? "" : `: ${denial.reason}`})`,
        isError: true,
        denial: {
          code: denial.code,
          ...(denial.reason === undefined ? {} : { reason: denial.reason }),
        },
      }
    case "reused":
      // An orphaned sibling-convergence fact re-drives to the same policy
      // denial (a dispatch-gate stale_policy); only a plain reuse miss
      // advises changing the input.
      if (denial.reasons?.includes(SIBLING_POLICY_DENIAL_REASON)) {
        return {
          content: `tool ${name} denied (stale_policy: ${SIBLING_POLICY_DENIAL_REASON})`,
          isError: true,
          denial: {
            code: "stale_policy",
            reason: SIBLING_POLICY_DENIAL_REASON,
          },
        }
      }
      // Advisory retry hint, not a permission denial terminal: no code.
      return {
        content: `tool ${name} denied (${PREVIOUS_RESULT_NOT_REUSABLE_NOTICE})`,
        isError: true,
      }
    case "invalid":
    case "policy": {
      // Settlement faces reuse the judgment vocabulary: preparation
      // validation maps to unknown_tool_or_input, rule denial to
      // denied_by_rule, matching what judgeModelToolCall would emit. A
      // producer-declared code (preparation.denial) wins over the default;
      // only the code is adopted — the reason renders from the fact's own
      // reasons list, never the producer's optional denial.reason.
      const code =
        denial.kind === "policy" && denial.code !== undefined
          ? denial.code
          : denial.kind === "invalid"
            ? "unknown_tool_or_input"
            : "denied_by_rule"
      const reasons = deniedReasons(denial.reasons)
      return {
        content: reasons === "" ? `tool ${name} denied (${code})` : `tool ${name} denied (${code}: ${reasons})`,
        isError: true,
        ...(reasons === "" ? { denial: { code } } : { denial: { code, reason: reasons } }),
      }
    }
  }
}

function abortError(): DOMException {
  return new DOMException("Agent run was cancelled", "AbortError")
}
