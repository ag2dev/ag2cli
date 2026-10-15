/**
 * Foreground child-agent runner (delegation, D5).
 *
 * Each `run` drives one ephemeral canonical session: a private memory event
 * store seeded with the parent's dispatch-frozen security facts, a private
 * policy serial bundle, and the host tool pool minus `agent`, narrowed by
 * the enclosing agent scopes (parent profile, subagent profile, spawn
 * request). Permission surfaces are minted per spawn request from the
 * injected seams, never mirrored from the host: a wired approval bridge
 * bubbles asks to the parent's human card (frozen mode ≠ auto only), a
 * configured guardian answers frozen-auto asks, and anything else stays
 * surface-less so a surviving ask converges to the `approval_required`
 * terminal instead of widening authority. Storage ownership stays in
 * composition: the runner only receives factories.
 *
 * The runner also keeps a process-local registry of live children (D11):
 * an entry exists from child id mint until settlement, and the parent side
 * can cancel exactly one child through it. The registry is runtime state,
 * never durable; restart empties it, matching child-session privacy.
 *
 * Async face (E1): `spawn` starts the same seeded child but returns its
 * handle immediately — the child's lifetime is independent of the parent
 * turn, its terminal lands in a bounded outcome retention that `join` reads,
 * and the optional `onChildSettled` callback lets composition project the
 * settle (notification + durable observation). `drain` bounds shutdown
 * waiting without ever cancelling by itself.
 *
 * Live projection (D12): spawns that carry parent attribution publish one
 * `child_agent_started` fact and bridge the child's model stream onto the
 * parent session's transient stream with `childSessionId` on every payload,
 * so a parent-side client can route attributed events to a child panel. The
 * child's own `tool_output_delta` is not bridged; child tool output already
 * rides the parent's tool stream through the delegation context.
 */

import type { AgentEvent, EventTrace } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import type { RunResult } from "@ag2cli/core/execution/run.js"
import { sessionId, type SessionId } from "@ag2cli/core/ids.js"
import type { SessionSecuritySnapshot } from "@ag2cli/core/session/session-snapshot.js"
import type { ToolOutputChunk } from "@ag2cli/core/tool-facts.js"
import { RunAgentUseCase, type ExecutionIdentity } from "@ag2cli/runtime/application/execution/run-agent.js"
import { TransientEventPublisher } from "@ag2cli/runtime/application/execution/transient-events.js"
import { ApprovalRequiredError } from "@ag2cli/runtime/application/execution/approval-required-error.js"
import { createInProcessPolicySerialPoint } from "@ag2cli/runtime/application/execution/policy-serial-point.js"
import { ApprovalResolutionService } from "@ag2cli/runtime/application/session/approval-resolution.js"
import { SessionAuthority } from "@ag2cli/runtime/application/session/session-authority.js"
import type { AgentProfile, AgentProfileResolver } from "@ag2cli/runtime/ports/agent-profile.js"
import type { ApprovalBroker } from "@ag2cli/runtime/ports/approval-broker.js"
import type { RuntimeEnvironment } from "@ag2cli/runtime/ports/environment.js"
import type { EventStore } from "@ag2cli/runtime/ports/event-store.js"
import type { ExecutionModelProvider } from "@ag2cli/runtime/ports/execution-model-provider.js"
import type { Guardian } from "@ag2cli/runtime/ports/guardian.js"
import { createGuardianWaitRegistry, type GuardianWaitRegistry } from "@ag2cli/runtime/ports/guardian.js"
import type { ObservabilityPolicy } from "@ag2cli/runtime/ports/observability.js"
import type { BashSecurityPort } from "@ag2cli/runtime/ports/security.js"
import type { TraceStore } from "@ag2cli/runtime/ports/trace-sink.js"
import type { AskUser } from "@ag2cli/runtime/ports/tool/contract.js"
import type { ToolExecutionContext } from "@ag2cli/runtime/ports/tool/contract.js"
import { hasModelBashAuthority, registerModelBashAuthority, restrictTools, type ToolExecutor } from "@ag2cli/runtime/ports/tool-executor.js"
import type { WorkspacePolicyFactory, WorkspaceScopeDigest } from "@ag2cli/runtime/ports/workspace.js"

/** Bound on the final text handed back to the parent model context. */
export const CHILD_AGENT_FINAL_TEXT_MAX_CHARS = 10_000
export const CHILD_AGENT_FINAL_TEXT_TRUNCATION_MARKER = "\n…[child agent output truncated]"

/** Default concurrent-children bound; excess spawns fail with a structured error. */
export const DEFAULT_CHILD_AGENT_CONCURRENCY = 5

/** Terminal outcomes kept for `agent_join`; oldest settles evict first. */
export const CHILD_OUTCOME_RETENTION_LIMIT = 32

/** Upper bound on one `agent_join` wait regardless of the requested timeout. */
export const AGENT_JOIN_MAX_TIMEOUT_MS = 300_000

/** Default shutdown budget for running async children to settle before cancels. */
export const CHILD_DRAIN_TIMEOUT_MS = 5_000

/** Grace for cancelled children to land their cancelled terminals in durable history. */
export const CHILD_CANCEL_GRACE_MS = 1_000

/**
 * Bounded shutdown drain over a runner face: wait for running async
 * children to settle on their own, then cancel the remainder and let the
 * aborts settle within a short grace. An emptied running map implies each
 * settle's projection — durable task terminal plus notification — already
 * landed, so no extra quiescence wait remains. Children still running
 * after the grace belong to the startup recovery pass.
 */
export async function drainChildAgents(
  runner: Pick<ChildAgentRunner, "drain" | "cancelChild">,
  budgetMs: number = CHILD_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const remaining = await runner.drain(budgetMs)
  if (remaining.length === 0) return
  for (const childSessionId of remaining) runner.cancelChild(childSessionId)
  await runner.drain(CHILD_CANCEL_GRACE_MS)
}

export interface ChildAgentRunRequest {
  readonly prompt: string
  /** 3-5 word spawn summary; labels the child in the running registry. */
  readonly description: string
  readonly subagentType?: string
  /**
   * Agent profile the parent turn is running under. Its non-empty `tools`
   * scope the child pool; an unknown name fails the spawn closed.
   */
  readonly parentAgentName?: string
  readonly model?: string
  readonly maxTurns?: number
  /** Requested tool names; intersects the child pool, never widens it. */
  readonly tools?: readonly string[]
  /** Parent security facts frozen at dispatch; the spawn was judged against these. */
  readonly security: SessionSecuritySnapshot
  /** Parent tool-call trace; seeds child events for causation linkage. */
  readonly trace: EventTrace
  /** Parent-side attribution recorded in the running-children registry. */
  readonly parentSessionId?: string
  /** Parent turn's run; durable child-task records carry it as lineage. */
  readonly parentRunId?: string
  readonly toolUseId?: string
  readonly signal?: AbortSignal
  readonly onOutput?: (chunk: ToolOutputChunk) => void
}

export interface ChildAgentRunOutcome {
  readonly status: "completed" | "failed" | "cancelled"
  readonly turns: number
  readonly finalText?: string
  readonly error?: string
  /** Absent when the request failed before any child session was created. */
  readonly childSessionId?: string
  readonly childRunId?: string
}

/** Which parent/child a bubbled question belongs to. */
export interface ChildAskAttribution {
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
  readonly description: string
  readonly subagentType?: string
}

/**
 * One async child settle plus the spawn attribution its composition
 * projection needs: the durable task record and the completion
 * notification are minted from these facts, never re-derived.
 */
export interface ChildAgentSettled {
  readonly outcome: ChildAgentRunOutcome
  readonly parentSessionId?: string
  readonly parentRunId?: string
  readonly description: string
  readonly prompt: string
}

/**
 * Composition-level ingress for child approval asks. The runner derives
 * each spawn's surfaces from it plus the frozen security facts; the port
 * owns no sequencing — FIFO discipline, single-winner settles and the
 * invalidation sweep stay with whatever the composition wires behind it.
 */
export interface ChildApprovalRunnerSurface {
  /** Bubbling broker for one attributed child; the human card is the parent's. */
  brokerFor(attribution: ChildAskAttribution): ApprovalBroker
  /** Child ask_user callback parking questions on the same surface. */
  askUserFor(attribution: ChildAskAttribution, signal?: AbortSignal): AskUser
  /** Parent policy changed: settle that parent's waiting children stale. */
  invalidateChildren(parentSessionId: SessionId): number
}

/** Immediate result of a fire-and-forget spawn: the handle, or a pre-flight refusal. */
export type ChildAgentSpawnResult =
  { readonly status: "spawned"; readonly childSessionId: string } | { readonly status: "failed"; readonly error: string }

/** `agent_join` answer: unknown handle, live child, or one terminal shape. */
export type ChildAgentJoinResult =
  | { readonly status: "unknown"; readonly known: readonly string[] }
  | { readonly status: "running" }
  | { readonly status: "completed"; readonly turns: number; readonly finalText?: string }
  | { readonly status: "failed"; readonly turns: number; readonly error: string }
  | { readonly status: "cancelled"; readonly turns: number }

export interface ChildAgentRunnerDependencies {
  readonly model: ExecutionModelProvider
  /** Host model tool executor; the child pool is this pool minus `agent`, scope-narrowed. */
  readonly tools: ToolExecutor
  /** Deny-fast broker; the fail-closed backstop when no branch claims a spawn. */
  readonly approval: ApprovalBroker
  /**
   * Bubbling ingress (TUI bridge). Present only in interactive hosts; its
   * clause is gated off in frozen auto mode, where asks are the
   * guardian's alone.
   */
  readonly childApprovals?: ChildApprovalRunnerSurface
  /** Answers frozen-auto child asks; injected whenever the host configured one. */
  readonly guardian?: Guardian
  readonly agentProfiles: AgentProfileResolver
  readonly eventStoreFactory: () => EventStore
  readonly traceSinkFactory: () => TraceStore
  /** Governs whether child attempts persist the full model request. */
  readonly observability?: ObservabilityPolicy
  readonly identity: ExecutionIdentity
  readonly bashSecurity: BashSecurityPort
  readonly workspacePolicyFactory: WorkspacePolicyFactory
  readonly workspaceScopeDigest?: WorkspaceScopeDigest
  readonly environment?: RuntimeEnvironment
  /**
   * Composition seam onto the parent session's live stream: attributed child
   * events land here. Absent in hosts that assemble no parent projection.
   */
  readonly onTransientEvent?: (event: TransientStreamEvent) => void
  /**
   * Async-settle callback: fired (failures swallowed) when a
   * fire-and-forget spawn reaches its terminal; a returned promise is
   * awaited before the registry entry drops, so an emptied running map
   * implies the composition's settle projection (durable task record plus
   * completion notification) already landed. Sync `run` settles never
   * fire it.
   */
  readonly onChildSettled?: (settled: ChildAgentSettled) => void | Promise<void>
  /** Composition-level turn cap; explicit `maxTurns` clamps to it. */
  readonly maxTurnsDefault?: number
  readonly maxConcurrentChildren?: number
}

export interface ChildAgentRunner {
  run(request: ChildAgentRunRequest): Promise<ChildAgentRunOutcome>
  /**
   * Fire-and-forget spawn: same pre-flight (profile resolution, concurrency
   * gate, frozen-fact seed, registry entry) as `run`, but the caller gets
   * the child handle immediately and the child's lifetime is independent of
   * the parent turn — the parent request signal is deliberately NOT
   * composed into the child's execution signal. Settles land in the bounded
   * outcome retention and fire `onChildSettled`.
   */
  spawn(request: ChildAgentRunRequest): Promise<ChildAgentSpawnResult>
  /**
   * Read the outcome retention: terminal children answer their outcome,
   * running children answer `running` (immediately for a missing/zero
   * timeout, else a bounded wait clamped to `AGENT_JOIN_MAX_TIMEOUT_MS`
   * that the given signal may interrupt), unknown ids answer the bounded
   * in-register id list.
   */
  join(childSessionId: string, options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<ChildAgentJoinResult>
  /**
   * Wait (bounded, never cancelling) for every live child to settle; the
   * answer lists the child ids still running when the budget ran out. An
   * empty answer implies each settle's projection was awaited, so the
   * durable task terminal and notification already landed. The caller
   * decides whether to `cancelChild` the remainder.
   */
  drain(timeoutMs: number): Promise<readonly string[]>
  /**
   * Abort one running child by id. False for an unknown or already-settled
   * id; true while the entry lives (a raced repeat aborts a dead controller
   * harmlessly) until the run's finally deregisters it.
   */
  cancelChild(childSessionId: string): boolean
  /**
   * Parent policy changed (post-change revision given): settle that
   * parent's waiting bridge asks through the port and abort its frozen-auto
   * children's guardian reviews. Returns the port's settle tally.
   */
  invalidateChildren(parentSessionId: string, policyRevision: number): number
}

/** Registry entry for one live child: the cancel handle plus spawn attribution. */
interface RunningChild {
  readonly controller: AbortController
  readonly description: string
  readonly startedAt: string
  readonly subagentType?: string
  readonly parentSessionId?: string
  readonly toolUseId?: string
}

export function createChildAgentRunner(deps: ChildAgentRunnerDependencies): ChildAgentRunner {
  const concurrencyLimit = deps.maxConcurrentChildren ?? DEFAULT_CHILD_AGENT_CONCURRENCY
  const running = new Map<string, RunningChild>()
  // Second, read-mostly projection over settled children: join reads it,
  // settle writes it once. Bounded; oldest terminal evicts first.
  const retention = new Map<string, ChildAgentRunOutcome>()
  const transientPublisher =
    deps.onTransientEvent === undefined ? undefined : new TransientEventPublisher(deps.identity, deps.onTransientEvent)
  // Frozen-auto children register their guardian reviews here, keyed by
  // child session id, so a parent policy change can abort exactly the
  // reviews that started under now-dead policy.
  const childGuardianWaits: GuardianWaitRegistry | undefined = deps.guardian === undefined ? undefined : createGuardianWaitRegistry()
  const limitError = `child agent concurrency limit reached (${concurrencyLimit}); retry after running children settle`
  const limitFailure = (): ChildAgentRunOutcome => ({ status: "failed", turns: 0, error: limitError })
  const settleHooks = { running, retention, onChildSettled: deps.onChildSettled }
  let active = 0
  return {
    async run(request) {
      if (active >= concurrencyLimit) return limitFailure()
      active += 1
      try {
        const child = beginChild(deps, request, transientPublisher, childGuardianWaits, settleHooks, false)
        if (child.kind === "failed") return child.outcome
        // Sync delegation keeps byte-identical semantics: exceptions from
        // the seeded run still propagate to the awaiting caller (after the
        // settle bookkeeping below has run).
        return await child.floating
      } finally {
        active -= 1
      }
    },
    async spawn(request) {
      if (active >= concurrencyLimit) return { status: "failed", error: limitError }
      active += 1
      const child = beginChild(deps, request, transientPublisher, childGuardianWaits, settleHooks, true)
      if (child.kind === "failed") {
        active -= 1
        return { status: "failed", error: child.outcome.error ?? "child agent spawn failed" }
      }
      // The gate is held for the child's whole independent lifetime; the
      // floating settle (never a rejection — the catch-all owns errors)
      // releases it.
      void child.floating.then(
        () => {
          active -= 1
        },
        () => {
          active -= 1
        },
      )
      return { status: "spawned", childSessionId: child.childSessionId }
    },
    async join(childSessionId, options = {}) {
      const settled = retention.get(childSessionId)
      if (settled !== undefined) return joinResultFromOutcome(settled)
      if (!running.has(childSessionId)) {
        return { status: "unknown", known: [...new Set([...running.keys(), ...retention.keys()])] }
      }
      const timeoutMs = options.timeoutMs ?? 0
      if (timeoutMs <= 0) return { status: "running" }
      const deadline = Date.now() + Math.min(timeoutMs, AGENT_JOIN_MAX_TIMEOUT_MS)
      for (;;) {
        if (options.signal?.aborted) throw new DOMException("agent join cancelled", "AbortError")
        const outcome = retention.get(childSessionId)
        if (outcome !== undefined) return joinResultFromOutcome(outcome)
        if (Date.now() >= deadline) return { status: "running" }
        await sleep(10)
      }
    },
    async drain(timeoutMs) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (running.size === 0) return []
        if (Date.now() >= deadline) return [...running.keys()]
        await sleep(10)
      }
    },
    cancelChild(childSessionId) {
      const entry = running.get(childSessionId)
      if (entry === undefined) return false
      entry.controller.abort()
      return true
    },
    invalidateChildren(parentSessionId, policyRevision) {
      if (childGuardianWaits !== undefined) {
        for (const [childId, entry] of running) {
          if (entry.parentSessionId !== parentSessionId) continue
          childGuardianWaits.invalidate(sessionId(childId), policyRevision)
        }
      }
      return deps.childApprovals?.invalidateChildren(sessionId(parentSessionId)) ?? 0
    },
  }
}

function joinResultFromOutcome(outcome: ChildAgentRunOutcome): ChildAgentJoinResult {
  switch (outcome.status) {
    case "completed":
      return { status: "completed", turns: outcome.turns, ...(outcome.finalText === undefined ? {} : { finalText: outcome.finalText }) }
    case "failed":
      return { status: "failed", turns: outcome.turns, error: outcome.error ?? "unknown error" }
    case "cancelled":
      return { status: "cancelled", turns: outcome.turns }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type BeginChild =
  | { readonly kind: "failed"; readonly outcome: ChildAgentRunOutcome }
  | { readonly kind: "started"; readonly childSessionId: string; readonly floating: Promise<ChildAgentRunOutcome> }

/**
 * Shared pre-flight for `run` and `spawn`: profile resolution, id mint,
 * registry entry, attribution transient. `fireAndForget` picks the async
 * contract — the child's execution signal is the controller alone (a parent
 * turn cancel must not cascade into an async child), and the floating
 * continuation records the settle (retention, `onChildSettled`, registry
 * drop) no matter how the run ends. Pre-flight failures return structured
 * outcomes without registering anything.
 */
function beginChild(
  deps: ChildAgentRunnerDependencies,
  request: ChildAgentRunRequest,
  transientPublisher: TransientEventPublisher | undefined,
  childGuardianWaits: GuardianWaitRegistry | undefined,
  settleHooks: {
    readonly running: Map<string, RunningChild>
    readonly retention: Map<string, ChildAgentRunOutcome>
    readonly onChildSettled?: (settled: ChildAgentSettled) => void | Promise<void>
  },
  fireAndForget: boolean,
): BeginChild {
  const profile = request.subagentType === undefined ? undefined : deps.agentProfiles.resolve(request.subagentType)
  if (request.subagentType !== undefined && profile === undefined) {
    return { kind: "failed", outcome: { status: "failed", turns: 0, error: `unknown subagent type: ${request.subagentType}` } }
  }
  const parentProfile = request.parentAgentName === undefined ? undefined : deps.agentProfiles.resolve(request.parentAgentName)
  if (request.parentAgentName !== undefined && parentProfile === undefined) {
    return { kind: "failed", outcome: { status: "failed", turns: 0, error: `unknown parent agent: ${request.parentAgentName}` } }
  }
  const childSessionId = sessionId(`agent-child-${deps.identity.nextEventId()}`)
  const controller = new AbortController()
  // Async contract: controller-only. Composing request.signal here would
  // cascade a parent-turn cancel into a child whose lifetime is independent
  // by definition.
  const signal = !fireAndForget && request.signal !== undefined ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
  settleHooks.running.set(String(childSessionId), {
    controller,
    description: request.description,
    startedAt: deps.identity.now(),
    ...(request.subagentType === undefined ? {} : { subagentType: request.subagentType }),
    ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
    ...(request.toolUseId === undefined ? {} : { toolUseId: request.toolUseId }),
  })
  const parentId = request.parentSessionId === undefined ? undefined : sessionId(request.parentSessionId)
  const bridge =
    transientPublisher === undefined || parentId === undefined
      ? undefined
      : bridgeChildTransientEvents(transientPublisher, parentId, childSessionId)
  if (transientPublisher !== undefined && parentId !== undefined) {
    transientPublisher.emit(parentId, request.trace, "child_agent_started", {
      childSessionId: String(childSessionId),
      description: request.description,
      ...(request.subagentType === undefined ? {} : { subagentType: request.subagentType }),
      ...(request.toolUseId === undefined ? {} : { toolUseId: request.toolUseId }),
    })
  }
  const childKey = String(childSessionId)
  const recordSettle = async (outcome: ChildAgentRunOutcome): Promise<ChildAgentRunOutcome> => {
    // Retention first so join never observes a settled child as unknown.
    settleHooks.retention.set(childKey, outcome)
    if (settleHooks.retention.size > CHILD_OUTCOME_RETENTION_LIMIT) {
      const oldest = settleHooks.retention.keys().next().value
      if (oldest !== undefined) settleHooks.retention.delete(oldest)
    }
    if (fireAndForget) {
      try {
        await settleHooks.onChildSettled?.({
          outcome,
          ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
          ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
          description: request.description,
          prompt: request.prompt,
        })
      } catch {
        // The callback is a projection: its failure cannot change the child
        // terminal, and no unhandled rejection may escape the floating run.
      }
    }
    settleHooks.running.delete(childKey)
    return outcome
  }
  const seeded = runSeededChild(deps, request, childSessionId, { profile, parentProfile }, signal, bridge, childGuardianWaits)
  const floating = fireAndForget
    ? seeded.then(
        (outcome) => recordSettle(outcome),
        (error) =>
          recordSettle({
            status: "failed",
            turns: 0,
            error: error instanceof Error ? error.message : String(error),
            childSessionId,
          }),
      )
    : seeded.then(
        (outcome) => recordSettle(outcome),
        (error) =>
          recordSettle({
            status: "failed",
            turns: 0,
            error: error instanceof Error ? error.message : String(error),
            childSessionId,
          }).then(() => {
            // Sync callers keep their exception contract.
            throw error
          }),
      )
  return { kind: "started", childSessionId: childKey, floating }
}

/**
 * Re-emits the child runtime's model stream onto the parent session's live
 * stream with `childSessionId` stamped on every payload. Everything else —
 * the child's own `tool_output_delta` in particular — stays child-side: tool
 * output already reaches the parent through the delegation context.
 */
function bridgeChildTransientEvents(
  publisher: TransientEventPublisher,
  parentId: SessionId,
  childSessionId: SessionId,
): (event: TransientStreamEvent) => void {
  return (event) => {
    switch (event.type) {
      case "model_text_delta":
      case "model_tool_call_start":
      case "model_tool_call_delta":
      case "model_tool_call_end":
        publisher.emit(parentId, event.trace, event.type, { ...event.payload, childSessionId: String(childSessionId) })
        return
      default:
        return
    }
  }
}

/** Everything after the id mint, isolated so registration and deregistration
 * bracket the seeded run exactly. */
async function runSeededChild(
  deps: ChildAgentRunnerDependencies,
  request: ChildAgentRunRequest,
  childSessionId: SessionId,
  profiles: { readonly profile?: AgentProfile; readonly parentProfile?: AgentProfile },
  signal: AbortSignal,
  bridge?: (event: TransientStreamEvent) => void,
  childGuardianWaits?: GuardianWaitRegistry,
): Promise<ChildAgentRunOutcome> {
  const { profile, parentProfile } = profiles
  const eventStore = deps.eventStoreFactory()
  const traceSink = deps.traceSinkFactory()
  let revision = 0
  const makeEvent = (type: "SessionCreated" | "SessionAgentSelected", payload: unknown): AgentEvent =>
    ({
      eventId: deps.identity.nextEventId(),
      sessionId: childSessionId,
      revision: ++revision,
      type,
      timestamp: deps.identity.now(),
      trace: request.trace,
      payload,
    }) as AgentEvent
  const security = request.security
  const seedAgentName = profile?.name ?? parentProfile?.name
  const seed: AgentEvent[] = [
    makeEvent("SessionCreated", {
      workspaceRoot: security.workspaceRoot,
      additionalDirectories: [...security.additionalDirectories],
      ...(security.scopeRevision === 0 ? {} : { scopeRevision: security.scopeRevision }),
      ...(security.scopeDigest === undefined ? {} : { scopeDigest: security.scopeDigest }),
      permissionMode: security.permissionMode,
      permissionRules: [...security.permissionRules],
      policyRevision: security.policyRevision,
    }),
    ...(seedAgentName === undefined ? [] : [makeEvent("SessionAgentSelected", { agentName: seedAgentName })]),
  ]
  const writer = await eventStore.acquireWriter(childSessionId, "child-agent-runner")
  try {
    const seeded = await eventStore.appendIfRevision(childSessionId, 0, seed, writer)
    if (!seeded) throw new Error("child session seed lost the revision race")
  } finally {
    await eventStore.releaseWriter(writer)
  }
  const parentId = request.parentSessionId === undefined ? undefined : sessionId(request.parentSessionId)
  const attribution: ChildAskAttribution | undefined =
    parentId === undefined
      ? undefined
      : {
          parentSessionId: parentId,
          childSessionId,
          description: request.description,
          ...(request.subagentType === undefined ? {} : { subagentType: request.subagentType }),
        }
  // Frozen-mode branch table: the bridge owns non-auto asks, the guardian
  // owns auto asks, and every other spawn stays surface-less so its asks
  // converge to the approval_required terminal instead of widening authority.
  const bubbling = deps.childApprovals !== undefined && attribution !== undefined && security.permissionMode !== "auto"
  const guardianChild = security.permissionMode === "auto" && deps.guardian !== undefined
  const childAskUser =
    attribution === undefined || deps.childApprovals === undefined ? undefined : deps.childApprovals.askUserFor(attribution, signal)
  const pool = childToolPool(deps.tools, {
    parentTools: parentProfile?.tools,
    profileTools: profile?.tools,
    requested: request.tools,
  })
  // One shared write authority: the executor holds the session writer for
  // the run, and approval resolutions recorded mid-run must commit through
  // the same authority instead of racing a second private one.
  const authority = new SessionAuthority(eventStore)
  const runtime = new RunAgentUseCase({
    model: deps.model,
    tools: childAskUser === undefined ? pool : withChildAskUser(pool, childAskUser),
    approval: bubbling ? deps.childApprovals!.brokerFor(attribution!) : deps.approval,
    approvalResolution: new ApprovalResolutionService({ eventStore, authority, identity: deps.identity }),
    authority,
    // Surface flags mirror the branch table; the advertising guarantee
    // (ask-judged tools hidden without a surface) rides on them.
    permissionSurfaces: { approvalSurface: bubbling || guardianChild, interactionSurface: childAskUser !== undefined },
    agentProfiles: deps.agentProfiles,
    eventStore,
    identity: deps.identity,
    ...createInProcessPolicySerialPoint(eventStore),
    bashSecurity: deps.bashSecurity,
    workspacePolicyFactory: deps.workspacePolicyFactory,
    ...(deps.workspaceScopeDigest === undefined ? {} : { workspaceScopeDigest: deps.workspaceScopeDigest }),
    ...(deps.environment === undefined ? {} : { environment: deps.environment }),
    ...(guardianChild ? { guardian: deps.guardian!, guardianWaits: childGuardianWaits! } : {}),
    ...(deps.observability === undefined ? {} : { observability: deps.observability }),
    traceSink,
    ...(bridge === undefined ? {} : { onTransientEvent: bridge }),
    ...(request.onOutput === undefined
      ? {}
      : {
          onEventsAppended: (events: readonly AgentEvent[]) => {
            for (const event of events) {
              if (event.type !== "ModelResponseCommitted") continue
              request.onOutput!({ stream: "stdout", text: `turn ${event.payload.turn} completed\n` })
            }
          },
        }),
  })
  const model = request.model ?? profile?.model
  const maxTurns = effectiveMaxTurns(deps, request)
  let result: RunResult
  try {
    result = await runtime.execute({
      sessionId: childSessionId,
      commandId: `agent-child-${childSessionId}`,
      goal: request.prompt,
      ...(model === undefined ? {} : { model }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      trace: request.trace,
      signal,
      modelCallPurpose: "execution",
    })
  } catch (error) {
    // The live terminal for a surface-less ask: run-agent lands the durable
    // RunFailed (code approval_required) and rethrows so callers map the code.
    // A surfaces miswire would converge user_denied instead — the code is the
    // pinned discrimination.
    if (error instanceof ApprovalRequiredError) {
      return {
        status: "failed",
        turns: 0,
        error: `${error.code}: ${error.toolName}`,
        childSessionId,
      }
    }
    throw error
  }
  const finalText = boundFinalText(result.finalText)
  return {
    status: result.status,
    turns: result.turns,
    ...(finalText === undefined ? {} : { finalText }),
    ...(result.error === undefined ? {} : { error: result.error }),
    childSessionId,
    childRunId: result.runId,
  }
}

/**
 * Effective child tool names: the host pool minus `agent`, intersected with
 * every non-empty scope in enclosing order (parent profile, subagent
 * profile, spawn request). An undefined or empty scope inherits the
 * enclosing pool unchanged, matching `AgentProfile.tools` semantics; scopes
 * can only remove names, never widen them.
 */
export function effectiveChildToolNames(input: {
  readonly hostNames: readonly string[]
  readonly parentTools?: readonly string[]
  readonly profileTools?: readonly string[]
  readonly requested?: readonly string[]
}): string[] {
  let names = input.hostNames.filter((name) => name !== "agent")
  for (const scope of [input.parentTools, input.profileTools, input.requested]) {
    if (scope === undefined || scope.length === 0) continue
    names = names.filter((name) => scope.includes(name))
  }
  return names
}

/**
 * The child pool is the host pool minus `agent` narrowed by the enclosing
 * scopes: no nested spawn in this release, clamped by construction, and a
 * profile's declared `tools` actually bind the child. `restrictTools`
 * preserves the bash authority membership through the wrapper, so child bash
 * keeps the canonical security path.
 */
function childToolPool(
  host: ToolExecutor,
  scopes: {
    readonly parentTools?: readonly string[]
    readonly profileTools?: readonly string[]
    readonly requested?: readonly string[]
  },
): ToolExecutor {
  const names = effectiveChildToolNames({
    hostNames: host.listTools().map((tool) => tool.name),
    ...scopes,
  })
  if (names.length === 0) {
    return {
      listTools: () => [],
      execute: (input) =>
        Promise.resolve({
          content: `tool ${input.name} denied (unknown_tool_or_input: empty child tool pool)`,
          isError: true,
          denial: { code: "unknown_tool_or_input" },
        }),
    }
  }
  return restrictTools(host, names)
}

/**
 * Pins one child-owned ask callback onto the execution context of every
 * pool call, so a nested session's ask_user questions reach the bridge
 * instead of the enclosing host's ask surface. Model bash authority
 * membership survives the wrapper, matching `restrictTools`.
 */
export function withChildAskUser(host: ToolExecutor, askUser: AskUser): ToolExecutor {
  const withAsk = (input: {
    readonly name: string
    readonly input: unknown
    readonly signal?: AbortSignal
    readonly context?: ToolExecutionContext
  }): typeof input => (input.context === undefined ? input : { ...input, context: { ...input.context, askUser } })
  const wrapped: ToolExecutor = {
    listTools: () => host.listTools(),
    ...(host.describeTool === undefined ? {} : { describeTool: (name, input) => host.describeTool!(name, input) }),
    ...(host.prepare === undefined ? {} : { prepare: (input) => host.prepare!(withAsk(input)) }),
    execute: (input) => host.execute(withAsk(input)),
  }
  return hasModelBashAuthority(host) ? registerModelBashAuthority(wrapped) : wrapped
}

function effectiveMaxTurns(deps: ChildAgentRunnerDependencies, request: ChildAgentRunRequest): number | undefined {
  const cap = deps.maxTurnsDefault
  if (request.maxTurns === undefined) return cap
  if (cap === undefined) return request.maxTurns
  return Math.min(request.maxTurns, cap)
}

function boundFinalText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  if (text.length <= CHILD_AGENT_FINAL_TEXT_MAX_CHARS) return text
  return text.slice(0, CHILD_AGENT_FINAL_TEXT_MAX_CHARS) + CHILD_AGENT_FINAL_TEXT_TRUNCATION_MARKER
}
