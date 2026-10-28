import type { AgentEvent, EventTrace } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import type { RunId, SessionId } from "@ag2cli/core/ids.js"
import { EMPTY_MODEL_RESPONSE_FALLBACK, type RunResult } from "@ag2cli/core/execution/run.js"
import type { Message, ContentBlock } from "@ag2cli/core/message.js"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import type { ApprovalBroker } from "../../ports/approval-broker.js"
import type { AskBroker } from "../../ports/ask-broker.js"
import type { Guardian, GuardianDeadlineTimer, GuardianWaitRegistry } from "../../ports/guardian.js"
import type { EventStore } from "../../ports/event-store.js"
import { OrderedLane } from "../../concurrency/ordered-lane.js"
import type { ExecutionModelProvider } from "../../ports/execution-model-provider.js"
import { restrictTools, type ToolExecutor } from "../../ports/tool-executor.js"
import type { AgentProfile, AgentProfileResolver } from "../../ports/agent-profile.js"
import type { ContextAttachment, ContextAttachmentLoader, ContextBuilder } from "../../ports/context-builder.js"
import { safeTraceSink, type TraceSink } from "../../ports/trace-sink.js"
import { messagesFromSessionEvents } from "@ag2cli/core/session/message-history.js"
import { projectSecurityState, replaySession } from "@ag2cli/core/session/session-snapshot.js"
import type { CanonicalModelRequest } from "@ag2cli/core/model/observation.js"
import type { ObservabilityPolicy } from "../../ports/observability.js"
import { TransientEventPublisher } from "./transient-events.js"
import { ToolTurnExecutor, type AgentEventFactory } from "./tool-turn-executor.js"
import { ApprovalRequiredError } from "./approval-required-error.js"
import { AskExpiredError } from "./ask-expired-error.js"
import { RunNotActiveError } from "./run-not-active.js"
import { projectModelTools, type PermissionSurfaces } from "./permission-judgment.js"
import type { ApprovalResolutionWriter } from "../session/approval-resolution.js"
import type { AskResolutionWriter } from "../session/ask-resolution.js"
import { estimateRequestUsage } from "../context/compact.js"
import { createToolFailureLoopGuardState } from "./tool-failure-loop-guard.js"
import { modelMessagesForRequest } from "../prompt/assembly.js"
import type { RuntimeEnvironment } from "../../ports/environment.js"
import type { BashSecurityPort } from "../../ports/security.js"
import type { PolicySerialPoint } from "../../ports/policy-serial-point.js"
import type { PreSpawnGate, SessionSecurityStamp } from "./policy-serial-point.js"
import type { WorkspacePolicyFactory, WorkspaceScopeDigest } from "../../ports/workspace.js"
import type { SessionPermissionMode, SessionPermissionRule } from "@ag2cli/core/session/session-security.js"
import { DEFAULT_SESSION_PERMISSION_MODE, normalizeSessionPermissionRules } from "@ag2cli/core/session/session-security.js"
import {
  commandIdempotencyConflictError,
  resolveCommandIdempotency,
  type CommandIdempotencyFamily,
} from "../session/command-idempotency.js"
import type { SessionExecutionReservation } from "../../ports/session-execution-reservation.js"
import { SessionAuthority, StaleSessionWriterError } from "../session/session-authority.js"
import { SessionRevisionConflictError } from "../session/revision-conflict.js"
import { commandReceiptKey, historyCursorForEvent, reduceCanonicalSession } from "@ag2cli/core/session/canonical-session.js"

export interface ExecutionIdentity {
  nextEventId(): string
  nextRunId(): RunId
  nextCheckpointId?(): string
  now(): string
}

export interface StartRunInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly goal: string
  /** Optional per-run model override for an isolated child agent. */
  readonly model?: string
  /** Optional role-preserving context for an isolated child agent. */
  readonly initialMessages?: readonly Message[]
  readonly context?: readonly string[]
  readonly fileReferences?: readonly string[]
  readonly workspace?: string
  readonly additionalDirectories?: readonly string[]
  readonly permissionMode?: SessionPermissionMode
  readonly permissionRules?: readonly SessionPermissionRule[]
  readonly maxTurns?: number
  readonly trace?: EventTrace
  readonly signal?: AbortSignal
  readonly modelCallPurpose?: import("@ag2cli/core/model/observation.js").ModelCallPurpose
}

export interface SteerInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly runId: RunId
  readonly text: string
}

export interface CancelInputInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly inputId: string
  readonly reason?: string
}

export type InputCancellationStatus = "cancelled" | "cancelled-before-acceptance" | "already-delivered"

export interface CancelInputResult {
  readonly inputId: string
  readonly status: InputCancellationStatus
}

export interface CancelRunInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly runId: RunId
  readonly reason?: string
}

export type RunCancellationStatus = "requested" | "already_terminal" | "not_found"

export interface CancelRunResult {
  readonly runId: RunId
  readonly status: RunCancellationStatus
}

export interface QueueRunInputResult {
  readonly inputId: string
}

export interface RunAdmission extends QueueRunInputResult {
  /** The run this admission is bound to: the run a prompt started, or the run
   * a queued prompt was accepted behind. A session-level fifo prompt carries
   * none until a run consumes it. */
  readonly runId?: RunId
  readonly queued: boolean
}

interface StartRunFingerprint {
  readonly [key: string]: unknown
  readonly goal: string
  readonly model: string | null
  readonly initialMessages: readonly Message[]
  readonly context: readonly string[]
  readonly fileReferences: readonly string[]
  readonly workspace: string
  readonly additionalDirectories: readonly string[]
  /** null = the start_run input did not specify a mode; enforcement then
   * reads the session's canonical mode, so retries stay mode-era agnostic. */
  readonly permissionMode: SessionPermissionMode | null
  readonly permissionRules: readonly SessionPermissionRule[]
  readonly maxTurns: number | null
  readonly modelCallPurpose: import("@ag2cli/core/model/observation.js").ModelCallPurpose | null
}

interface ActiveModelAttempt {
  readonly attemptId: string
  readonly runId: RunId
  readonly turn: number
  readonly executionGeneration: number
  readonly branchId: string
  readonly inputCursor: import("@ag2cli/core/events/event.js").HistoryCursor
  readonly requestFingerprint: string
}

export const START_RUN_FAMILY: CommandIdempotencyFamily<StartRunFingerprint> = {
  family: "start_run",
  findAnchor: (events, commandId) => {
    const command = events.find(
      (event): event is Extract<AgentEvent, { type: "CommandAccepted" }> =>
        event.type === "CommandAccepted" && event.payload.family === "start_run" && event.payload.commandId === commandId,
    )
    if (command !== undefined) {
      return {
        event: command,
        inputFingerprint: command.payload.inputFingerprint as unknown as StartRunFingerprint,
      }
    }
    const anchor = events.find(
      (event): event is Extract<AgentEvent, { type: "InputAccepted" }> =>
        event.type === "InputAccepted" &&
        event.payload.commandId === commandId &&
        (event.payload.kind === "message" || event.payload.kind === "notification"),
    )
    return anchor === undefined
      ? undefined
      : {
          event: anchor,
          inputFingerprint: legacyStartRunFingerprint(events, anchor),
        }
  },
  findTerminal: (events, anchor) => {
    const commandId = anchor.type === "CommandAccepted" || anchor.type === "InputAccepted" ? anchor.payload.commandId : undefined
    if (commandId === undefined) return undefined
    const accepted =
      anchor.type === "InputAccepted"
        ? anchor
        : events.find(
            (event): event is Extract<AgentEvent, { type: "InputAccepted" }> =>
              event.type === "InputAccepted" &&
              event.payload.commandId === commandId &&
              (event.payload.kind === "message" || event.payload.kind === "notification"),
          )
    if (accepted === undefined) return undefined
    const runStarted = events.find(
      (event): event is Extract<AgentEvent, { type: "RunStarted" }> =>
        event.type === "RunStarted" && event.payload.commandId === accepted.payload.commandId,
    )
    if (runStarted === undefined) return undefined
    return events.find(
      (event) =>
        (event.type === "RunCompleted" || event.type === "RunFailed" || event.type === "RunCancelled") &&
        event.payload.runId === runStarted.payload.runId,
    )
  },
  fingerprintsEqual: (recorded, attempted) => {
    const recordedComparable = { ...recorded }
    const attemptedComparable = { ...attempted }
    // Pre-permission-era CommandAccepted fingerprints carry no permissionMode
    // key. Treat the missing key as "unspecified" (null) so an old-era retry
    // without the flag replays instead of conflicting on a field the original
    // input never specified; an explicit mode on retry still has to match.
    if (recordedComparable.permissionMode === undefined) recordedComparable.permissionMode = null
    if (recorded.legacy === true && attempted.maxTurns === null) {
      // Older streams persisted RunStarted.maxTurns but not the original
      // command fingerprint. An omitted retry value resumes that stream;
      // an explicit value still has to match the recorded run.
      recordedComparable.maxTurns = null
    }
    delete recordedComparable.legacy
    delete attemptedComparable.legacy
    return stableFingerprintJson(recordedComparable) === stableFingerprintJson(attemptedComparable)
  },
}

export interface RunAgentDependencies {
  readonly model: ExecutionModelProvider
  readonly tools: ToolExecutor
  readonly approval: ApprovalBroker
  readonly approvalResolution: ApprovalResolutionWriter
  /**
   * Ask answerer and durable writer. When both are present the executor owns
   * the ask_user lifecycle (canonical AskUser events before execution);
   * otherwise the tool keeps asking through its host callback.
   */
  readonly ask?: AskBroker
  readonly askResolution?: AskResolutionWriter
  /** Interactive surfaces this composition offers; required so every consumer states them. */
  readonly permissionSurfaces: PermissionSurfaces
  readonly contextBuilder?: ContextBuilder
  readonly agentProfiles?: AgentProfileResolver
  readonly fileContextLoader?: ContextAttachmentLoader
  readonly eventStore: EventStore
  /** Canonical write authority. A private authority is created when omitted. */
  readonly authority?: SessionAuthority
  /** Composition-owned canonicalization for legacy relative workspace values. */
  readonly workspaceRootCanonicalizer?: (root: string) => string
  readonly identity: ExecutionIdentity
  readonly workspacePolicyFactory?: WorkspacePolicyFactory
  readonly workspaceScopeDigest?: WorkspaceScopeDigest
  readonly environment?: RuntimeEnvironment
  readonly bashSecurity?: BashSecurityPort
  /** Serializes tool dispatch against mid-run permission commits on one session. */
  readonly serialPoint: PolicySerialPoint
  /** Fresh canonical security read used inside the dispatch gate. */
  readonly readSessionSecurity: (sessionId: SessionId) => Promise<SessionSecurityStamp | undefined>
  /** Builds the spawn fence stamped into every tool execution context. */
  readonly preSpawnGateFor: (sessionId: SessionId, taskId: string, bound: SessionSecurityStamp) => PreSpawnGate
  readonly traceSink?: TraceSink
  readonly observability?: ObservabilityPolicy
  readonly onEventsAppended?: (events: readonly AgentEvent[], replayed: boolean) => Promise<void> | void
  readonly onTransientEvent?: (event: TransientStreamEvent) => void
  /** Optional cross-process guard used by local durable compositions. */
  readonly executionReservation?: SessionExecutionReservation
  readonly reservationOwnerId?: string
  /** Answers auto-mode permission asks; absent converges every auto ask. */
  readonly guardian?: Guardian
  /** Aborts in-flight guardian reviews when session security changes. */
  readonly guardianWaits?: GuardianWaitRegistry
  readonly guardianDeadlineMs?: number
  /** Injectable deadline timer; tests substitute deterministic doubles. */
  readonly guardianDeadlineTimer?: GuardianDeadlineTimer
}

/**
 * Durable agent runtime. It owns the model/tool/approval orchestration but has
 * no knowledge of CLI, React, ACP or a provider SDK.
 */
export class RunAgentUseCase {
  private readonly pending = new OrderedLane<string>()
  private readonly admissions = new OrderedLane<string>()
  private readonly mailbox = new OrderedLane<string>()
  private readonly recovering = new Set<string>()
  private readonly runAborters = new Map<string, AbortController>()
  private readonly authority: SessionAuthority
  private readonly transientPublisher: TransientEventPublisher
  private readonly traceSink: TraceSink
  private readonly toolTurnExecutor: ToolTurnExecutor

  constructor(private readonly deps: RunAgentDependencies) {
    this.authority = deps.authority ?? new SessionAuthority(deps.eventStore)
    this.transientPublisher = new TransientEventPublisher(deps.identity, deps.onTransientEvent)
    this.traceSink = safeTraceSink(deps.traceSink)
    const makeEvent: AgentEventFactory = (
      sessionId: SessionId,
      revision: number,
      type: AgentEvent["type"],
      payload: unknown,
      nextTrace: (eventId: string) => EventTrace,
    ) => this.makeEvent(sessionId, revision, type as never, payload as never, nextTrace)
    this.toolTurnExecutor = new ToolTurnExecutor({
      approval: deps.approval,
      approvalResolution: deps.approvalResolution,
      ask: deps.ask,
      askResolution: deps.askResolution,
      permissionSurfaces: deps.permissionSurfaces,
      guardian: deps.guardian,
      guardianWaits: deps.guardianWaits,
      guardianDeadlineMs: deps.guardianDeadlineMs,
      guardianDeadlineTimer: deps.guardianDeadlineTimer,
      readEvents: (sessionId) => deps.eventStore.read(sessionId),
      identity: deps.identity,
      workspacePolicyFactory: deps.workspacePolicyFactory,
      workspaceScopeDigest: deps.workspaceScopeDigest,
      environment: deps.environment,
      bashSecurity: deps.bashSecurity,
      serialPoint: deps.serialPoint,
      readSessionSecurity: deps.readSessionSecurity,
      preSpawnGateFor: deps.preSpawnGateFor,
      traceSink: this.traceSink,
      transientPublisher: this.transientPublisher,
      makeEvent,
      append: (events) => this.append(events),
    })
  }

  /**
   * Re-enter the named session's unfinished canonical runs when this host
   * first serves it. The call only schedules the resumed loops; recovery is
   * intentionally silent and never exposes an intermediate "unknown" state
   * to a client. A second host may inspect the same history, but the
   * execution reservation and command idempotency fence decide which host
   * is allowed to continue it.
   */
  async recoverSessionRuns(sessionId: SessionId): Promise<void> {
    const key = sessionId.toString()
    if (this.recovering.has(key)) return
    const events = await this.deps.eventStore.read(sessionId)
    const state = reduceCanonicalSession(events)
    const running = [...state.runs.values()].filter((run) => run.status === "running")
    for (const run of running) {
      const started = events.find(
        (event): event is Extract<AgentEvent, { type: "RunStarted" }> => event.type === "RunStarted" && event.payload.runId === run.runId,
      )
      if (started === undefined) continue
      const accepted = events.find(
        (event): event is Extract<AgentEvent, { type: "InputAccepted" }> =>
          event.type === "InputAccepted" &&
          event.payload.commandId === started.payload.commandId &&
          (event.payload.kind === "message" || event.payload.kind === "notification"),
      )
      if (accepted === undefined) continue
      const commandAccepted = events.find(
        (event): event is Extract<AgentEvent, { type: "CommandAccepted" }> =>
          event.type === "CommandAccepted" && event.payload.family === "start_run" && event.payload.commandId === started.payload.commandId,
      )
      const fingerprint = commandAccepted?.payload.inputFingerprint as StartRunFingerprint | undefined
      const created = events.find((event): event is Extract<AgentEvent, { type: "SessionCreated" }> => event.type === "SessionCreated")
      this.recovering.add(key)
      void this.execute({
        sessionId,
        commandId: accepted.payload.commandId,
        goal: accepted.payload.text,
        ...(fingerprint?.model === undefined || fingerprint.model === null ? {} : { model: fingerprint.model }),
        ...(fingerprint?.initialMessages === undefined || fingerprint.initialMessages.length === 0
          ? {}
          : { initialMessages: fingerprint.initialMessages }),
        ...(fingerprint?.context === undefined
          ? accepted.payload.context === undefined
            ? {}
            : { context: accepted.payload.context }
          : { context: fingerprint.context }),
        ...(fingerprint?.fileReferences === undefined
          ? accepted.payload.fileReferences === undefined
            ? {}
            : { fileReferences: accepted.payload.fileReferences }
          : { fileReferences: fingerprint.fileReferences }),
        ...(fingerprint?.workspace === undefined
          ? created?.payload.workspaceRoot === undefined
            ? {}
            : { workspace: created.payload.workspaceRoot }
          : { workspace: fingerprint.workspace }),
        ...(fingerprint?.additionalDirectories === undefined
          ? created?.payload.additionalDirectories === undefined
            ? {}
            : { additionalDirectories: created.payload.additionalDirectories }
          : { additionalDirectories: fingerprint.additionalDirectories }),
        // The fingerprint records what the INPUT specified, not the seeded
        // session mode: an unspecified (null) mode stays unspecified on
        // retry, and enforcement reads the canonical session mode. Injecting
        // the SessionCreated seed here would make the retried fingerprint
        // explicit and conflict with the recorded null, so an interrupted
        // run would silently never recover.
        ...(fingerprint?.permissionMode == null ? {} : { permissionMode: fingerprint.permissionMode }),
        ...(fingerprint?.permissionRules === undefined
          ? created?.payload.permissionRules === undefined
            ? {}
            : { permissionRules: created.payload.permissionRules }
          : { permissionRules: fingerprint.permissionRules }),
        ...(started.payload.maxTurns === undefined ? {} : { maxTurns: started.payload.maxTurns }),
        ...(fingerprint?.modelCallPurpose === undefined || fingerprint.modelCallPurpose === null
          ? {}
          : { modelCallPurpose: fingerprint.modelCallPurpose }),
      })
        .catch(() => {
          // A competing writer, an unavailable provider, or a transient
          // startup failure is retried by the next serve. The canonical
          // stream remains the only user-visible state.
        })
        .finally(() => this.recovering.delete(key))
    }
  }

  execute(input: StartRunInput): Promise<RunResult> {
    return this.pending.run(input.sessionId, async () => {
      if (this.deps.executionReservation === undefined) return this.executeNow(input)
      validateInput(input)
      const existing = await this.deps.eventStore.read(input.sessionId)
      const idempotency = resolveCommandIdempotency(START_RUN_FAMILY, existing, {
        family: START_RUN_FAMILY.family,
        commandId: input.commandId,
        inputFingerprint: startRunFingerprint(input, this.deps.workspaceRootCanonicalizer),
      })
      if (idempotency.status === "replay" || idempotency.status === "conflict") return this.executeNow(input)
      const lease = await this.deps.executionReservation.acquire({
        sessionId: input.sessionId,
        commandId: input.commandId,
        ownerId: this.deps.reservationOwnerId ?? `pid-${process.pid}`,
        baseRevision: existing.length,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      try {
        return await this.executeNow(input)
      } finally {
        await lease.release(input.signal?.aborted ? "aborted" : "released").catch(() => {})
      }
    })
  }

  async steer(input: SteerInput): Promise<{ readonly inputId: string }> {
    return this.withMailbox(input.sessionId, () => this.steerSerialized(input))
  }

  private async steerSerialized(input: SteerInput): Promise<{ readonly inputId: string }> {
    if (input.commandId.trim().length === 0) throw new Error("commandId must not be empty")
    if (input.text.trim().length === 0) throw new Error("steer text must not be empty")
    const events = await this.deps.eventStore.read(input.sessionId)
    const existing = events.find((event) => event.type === "InputAccepted" && event.payload.commandId === input.commandId)
    if (existing?.type === "InputAccepted") {
      if (
        existing.payload.kind !== "steer" ||
        existing.payload.text !== input.text ||
        String(existing.payload.targetRunId) !== String(input.runId)
      ) {
        throw commandIdempotencyConflictError({
          commandId: input.commandId,
          family: "steer",
          inputFingerprint: {
            runId: existing.payload.targetRunId === undefined ? null : String(existing.payload.targetRunId),
            text: existing.payload.text,
          },
          eventRange: events.filter((event) => event.type === "InputAccepted" && event.payload.commandId === input.commandId),
        })
      }
      return { inputId: existing.payload.inputId }
    }
    const state = reduceCanonicalSession(events)
    const run = state.runs.get(String(input.runId))
    if (run?.status !== "running") throw new RunNotActiveError(String(input.runId))
    const inputId = inputIdFor(input.commandId)
    const event = this.makeEvent(
      input.sessionId,
      events.length + 1,
      "InputAccepted",
      {
        inputId,
        commandId: input.commandId,
        kind: "steer",
        text: input.text,
        delivery: "safe-boundary",
        targetRunId: input.runId,
      },
      (eventId) => ({
        traceId: `input:${input.commandId}`,
        operationId: `input:${input.commandId}`,
        causationId: eventId === input.commandId ? undefined : events.at(-1)?.eventId,
      }),
    )
    await this.append([event])
    return { inputId }
  }

  /** Commit the mailbox acceptance and run ownership before a transport returns. */
  async admit(input: StartRunInput): Promise<RunAdmission> {
    return this.withMailbox(input.sessionId, () => this.admitSerialized(input))
  }

  private admitSerialized(input: StartRunInput): Promise<RunAdmission> {
    validateInput(input)
    return this.admissions.run(input.sessionId.toString(), async () => {
      const events = await this.deps.eventStore.read(input.sessionId)
      const idempotency = resolveCommandIdempotency(START_RUN_FAMILY, events, {
        family: START_RUN_FAMILY.family,
        commandId: input.commandId,
        inputFingerprint: startRunFingerprint(input, this.deps.workspaceRootCanonicalizer),
      })
      if (idempotency.status === "conflict") throw commandIdempotencyConflictError(idempotency.record)
      const state = reduceCanonicalSession(events)
      const inputId = inputIdFor(input.commandId)
      const existing = state.inputs.get(inputId)
      if (existing !== undefined) {
        if (existing.kind !== "message" || existing.text !== input.goal) {
          throw new Error(`commandId was already used for a different start_run: ${input.commandId}`)
        }
        if (existing.status === "cancelled" || existing.status === "cancelled-before-acceptance") {
          throw commandIdempotencyConflictError({
            commandId: input.commandId,
            family: START_RUN_FAMILY.family,
            inputFingerprint: startRunFingerprint(input, this.deps.workspaceRootCanonicalizer),
            eventRange: events.filter((event) => event.type === "InputAccepted" && event.payload.inputId === existing.inputId),
          })
        }
        // The mailbox is session-level: a pending fifo prompt is queued for
        // whichever run consumes next, so replay reports the queue fact
        // instead of accepting the same input twice.
        if (existing.status === "pending") return { inputId, queued: true }
        const startedRun = [...state.runs.values()].find((run) =>
          events.some(
            (event) => event.type === "RunStarted" && event.payload.runId === run.runId && event.payload.commandId === input.commandId,
          ),
        )
        return { inputId, ...(startedRun !== undefined ? { runId: startedRun.runId } : {}), queued: false }
      }
      const running = [...state.runs.values()].find((candidate) => candidate.status === "running")
      if (running !== undefined) {
        const acceptedEvents: AgentEvent[] = []
        let revision = events.length + 1
        let causationId = events.at(-1)?.eventId
        const nextTrace = (eventId: string): EventTrace => {
          const trace = {
            traceId: `input:${input.commandId}`,
            operationId: `input:${input.commandId}`,
            ...(causationId === undefined ? {} : { causationId }),
          }
          causationId = eventId
          return trace
        }
        if (!hasStartCommandAccepted(events, input.commandId)) {
          acceptedEvents.push(
            this.makeEvent(
              input.sessionId,
              revision++,
              "CommandAccepted",
              {
                commandId: input.commandId,
                family: "start_run",
                inputFingerprint: startRunFingerprint(input, this.deps.workspaceRootCanonicalizer),
              },
              nextTrace,
            ),
          )
        }
        acceptedEvents.push(
          this.makeEvent(
            input.sessionId,
            revision,
            "InputAccepted",
            {
              inputId,
              commandId: input.commandId,
              kind: "message",
              text: input.goal,
              delivery: "fifo",
              ...(input.context && input.context.length > 0 ? { context: [...input.context] } : {}),
              ...(input.fileReferences && input.fileReferences.length > 0 ? { fileReferences: [...input.fileReferences] } : {}),
            },
            nextTrace,
          ),
        )
        await this.append(acceptedEvents)
        return { inputId, runId: running.runId, queued: true }
      }
      const runId = this.deps.identity.nextRunId()
      const traceId = input.trace?.traceId ?? this.deps.identity.nextEventId()
      const operationId = input.trace?.operationId ?? this.deps.identity.nextEventId()
      let causationId = input.trace?.causationId ?? input.commandId
      const nextTrace = (eventId: string): EventTrace => {
        const trace = {
          traceId,
          operationId,
          ...(causationId ? { causationId } : {}),
        }
        causationId = eventId
        return trace
      }
      const admission: AgentEvent[] = []
      let revision = events.length + 1
      if (events.length === 0) {
        admission.push(
          this.makeEvent(
            input.sessionId,
            revision++,
            "SessionCreated",
            {
              workspaceRoot: input.workspace ?? ".",
              additionalDirectories: input.additionalDirectories ?? [],
              permissionMode: input.permissionMode ?? DEFAULT_SESSION_PERMISSION_MODE,
              permissionRules: normalizeSessionPermissionRules(input.permissionRules ?? []),
              policyRevision: 0,
              scopeRevision: 0,
            },
            nextTrace,
          ),
        )
      }
      if (!hasStartCommandAccepted(events, input.commandId)) {
        admission.push(
          this.makeEvent(
            input.sessionId,
            revision++,
            "CommandAccepted",
            {
              commandId: input.commandId,
              family: "start_run",
              inputFingerprint: startRunFingerprint(input, this.deps.workspaceRootCanonicalizer),
            },
            nextTrace,
          ),
        )
      }
      admission.push(
        this.makeEvent(
          input.sessionId,
          revision++,
          "InputAccepted",
          {
            inputId,
            commandId: input.commandId,
            kind: "message",
            text: input.goal,
            delivery: "fifo",
            ...(input.context && input.context.length > 0 ? { context: [...input.context] } : {}),
            ...(input.fileReferences && input.fileReferences.length > 0 ? { fileReferences: [...input.fileReferences] } : {}),
          },
          nextTrace,
        ),
      )
      admission.push(
        this.makeEvent(
          input.sessionId,
          revision,
          "RunStarted",
          {
            runId,
            commandId: input.commandId,
            goal: input.goal,
            maxTurns: input.maxTurns,
          },
          nextTrace,
        ),
      )
      await this.append(admission)
      return { inputId, runId, queued: false }
    })
  }

  /** Durably admit a prompt into an already-running loop without waiting for its current turn. */
  async queueIfRunning(input: StartRunInput): Promise<QueueRunInputResult | undefined> {
    return this.withMailbox(input.sessionId, () => this.queueIfRunningSerialized(input))
  }

  private async queueIfRunningSerialized(input: StartRunInput): Promise<QueueRunInputResult | undefined> {
    validateInput(input)
    const events = await this.deps.eventStore.read(input.sessionId)
    const idempotency = resolveCommandIdempotency(START_RUN_FAMILY, events, {
      family: START_RUN_FAMILY.family,
      commandId: input.commandId,
      inputFingerprint: startRunFingerprint(input, this.deps.workspaceRootCanonicalizer),
    })
    if (idempotency.status === "conflict") throw commandIdempotencyConflictError(idempotency.record)
    const state = reduceCanonicalSession(events)
    const existing = state.inputs.get(inputIdFor(input.commandId))
    if (existing?.kind === "message") {
      if (existing.text !== input.goal)
        throw commandIdempotencyConflictError({
          commandId: input.commandId,
          family: START_RUN_FAMILY.family,
          inputFingerprint: startRunFingerprint({ ...input, goal: existing.text ?? "" }, this.deps.workspaceRootCanonicalizer),
          eventRange: events.filter((event) => event.type === "InputAccepted" && event.payload.inputId === existing.inputId),
        })
      if (existing.status === "cancelled" || existing.status === "cancelled-before-acceptance") {
        throw commandIdempotencyConflictError({
          commandId: input.commandId,
          family: START_RUN_FAMILY.family,
          inputFingerprint: startRunFingerprint(input, this.deps.workspaceRootCanonicalizer),
          eventRange: events.filter((event) => event.type === "InputAccepted" && event.payload.inputId === existing.inputId),
        })
      }
      // The mailbox is session-level: a pending fifo prompt is already
      // queued for whichever run consumes next, so re-admission is
      // idempotent rather than a duplicate acceptance.
      if (existing.status === "pending") return { inputId: existing.inputId }
      if (events.some((event) => event.type === "RunStarted" && event.payload.commandId === input.commandId)) return undefined
    }
    const running = [...state.runs.values()].find((candidate) => candidate.status === "running")
    if (running === undefined) return undefined
    const inputId = inputIdFor(input.commandId)
    const acceptedEvents: AgentEvent[] = []
    let revision = events.length + 1
    let causationId = events.at(-1)?.eventId
    const nextTrace = (eventId: string): EventTrace => {
      const trace = {
        traceId: `input:${input.commandId}`,
        operationId: `input:${input.commandId}`,
        ...(causationId === undefined ? {} : { causationId }),
      }
      causationId = eventId
      return trace
    }
    if (!hasStartCommandAccepted(events, input.commandId)) {
      acceptedEvents.push(
        this.makeEvent(
          input.sessionId,
          revision++,
          "CommandAccepted",
          {
            commandId: input.commandId,
            family: "start_run",
            inputFingerprint: startRunFingerprint(input, this.deps.workspaceRootCanonicalizer),
          },
          nextTrace,
        ),
      )
    }
    acceptedEvents.push(
      this.makeEvent(
        input.sessionId,
        revision,
        "InputAccepted",
        {
          inputId,
          commandId: input.commandId,
          kind: "message",
          text: input.goal,
          delivery: "fifo",
          ...(input.context && input.context.length > 0 ? { context: [...input.context] } : {}),
          ...(input.fileReferences && input.fileReferences.length > 0 ? { fileReferences: [...input.fileReferences] } : {}),
        },
        nextTrace,
      ),
    )
    await this.append(acceptedEvents)
    return { inputId }
  }

  async cancelInput(input: CancelInputInput): Promise<CancelInputResult> {
    return this.withMailbox(input.sessionId, () => this.cancelInputSerialized(input))
  }

  private async cancelInputSerialized(input: CancelInputInput): Promise<CancelInputResult> {
    if (input.commandId.trim().length === 0) throw new Error("commandId must not be empty")
    const events = await this.deps.eventStore.read(input.sessionId)
    const existing = events.find((event) => event.type === "InputCancellationRequested" && event.payload.commandId === input.commandId)
    if (existing?.type === "InputCancellationRequested") {
      if (existing.payload.inputId !== input.inputId || (existing.payload.reason ?? null) !== (input.reason ?? null)) {
        throw commandIdempotencyConflictError({
          commandId: input.commandId,
          family: "cancel_input",
          inputFingerprint: {
            inputId: existing.payload.inputId,
            reason: existing.payload.reason ?? null,
          },
          eventRange: events.filter((event) => event.type === "InputCancellationRequested" && event.payload.commandId === input.commandId),
        })
      }
      return {
        inputId: existing.payload.inputId,
        status: cancellationStatus(reduceCanonicalSession(events), input.commandId),
      }
    }
    if (events.length === 0) {
      const trace = (eventId: string): EventTrace => ({
        traceId: `input-cancel:${input.commandId}`,
        operationId: `input-cancel:${input.commandId}`,
        ...(eventId === input.commandId ? {} : { causationId: eventId }),
      })
      const created = this.makeEvent(
        input.sessionId,
        1,
        "SessionCreated",
        {
          workspaceRoot: ".",
          additionalDirectories: [],
          permissionMode: DEFAULT_SESSION_PERMISSION_MODE,
          permissionRules: [],
          policyRevision: 0,
          scopeRevision: 0,
        },
        trace,
      )
      const cancellation = this.makeEvent(
        input.sessionId,
        2,
        "InputCancellationRequested",
        {
          inputId: input.inputId,
          commandId: input.commandId,
          reason: input.reason,
        },
        trace,
      )
      await this.append([created, cancellation])
      return { inputId: input.inputId, status: "cancelled-before-acceptance" }
    }
    const state = reduceCanonicalSession(events)
    const consumed = [...events]
      .reverse()
      .find(
        (event): event is Extract<AgentEvent, { type: "InputConsumed" }> =>
          event.type === "InputConsumed" && event.payload.inputId === input.inputId,
      )
    const consumedRun = consumed === undefined ? undefined : state.runs.get(String(consumed.payload.runId))
    const transitionId = `command:cancel_input:${input.commandId}`
    const trace = (eventId: string): EventTrace => ({
      traceId: `input-cancel:${input.commandId}`,
      operationId: `input-cancel:${input.commandId}`,
      causationId: eventId === input.commandId ? undefined : events.at(-1)?.eventId,
    })
    const cancellationEvents: AgentEvent[] = []
    if (consumedRun?.status === "running" && !consumedRun.stopRequested) {
      cancellationEvents.push({
        ...this.makeEvent(
          input.sessionId,
          events.length + 1,
          "RunStopRequested",
          {
            runId: consumed!.payload.runId,
            commandId: input.commandId,
            reason: input.reason ?? "input cancelled",
          },
          trace,
        ),
        transitionId,
      })
    }
    cancellationEvents.push({
      ...this.makeEvent(
        input.sessionId,
        events.length + cancellationEvents.length + 1,
        "InputCancellationRequested",
        {
          inputId: input.inputId,
          commandId: input.commandId,
          reason: input.reason,
        },
        trace,
      ),
      transitionId,
    })
    await this.append(cancellationEvents)
    if (consumedRun?.status === "running") this.runAborters.get(String(consumedRun.runId))?.abort()
    const committed = reduceCanonicalSession(await this.deps.eventStore.read(input.sessionId))
    return {
      inputId: input.inputId,
      status: cancellationStatus(committed, input.commandId),
    }
  }

  /**
   * Stop request for one run. Like cancelInput this reports a request state,
   * never a completion: the durable RunStopRequested fact plus the in-process
   * abort make the loop converge on its own terminal event.
   */
  async cancelRun(input: CancelRunInput): Promise<CancelRunResult> {
    return this.withMailbox(input.sessionId, () => this.cancelRunSerialized(input))
  }

  private async cancelRunSerialized(input: CancelRunInput): Promise<CancelRunResult> {
    if (input.commandId.trim().length === 0) throw new Error("commandId must not be empty")
    const events = await this.deps.eventStore.read(input.sessionId)
    const existing = events.find((event) => event.type === "RunStopRequested" && event.payload.commandId === input.commandId)
    if (existing?.type === "RunStopRequested") {
      if (String(existing.payload.runId) !== String(input.runId)) {
        throw commandIdempotencyConflictError({
          commandId: input.commandId,
          family: "cancel_run",
          inputFingerprint: { runId: String(existing.payload.runId) },
          eventRange: events.filter((event) => event.type === "RunStopRequested" && event.payload.commandId === input.commandId),
        })
      }
      // A recorded stop request replays as its own outcome: the run's later
      // terminal state belongs to run.updated, not to this command's receipt.
      return { runId: input.runId, status: "requested" }
    }
    const state = reduceCanonicalSession(events)
    const run = state.runs.get(String(input.runId))
    if (run === undefined) return { runId: input.runId, status: "not_found" }
    if (run.status !== "running") return { runId: input.runId, status: "already_terminal" }
    if (run.stopRequested) return { runId: input.runId, status: "requested" }
    const trace = (eventId: string): EventTrace => ({
      traceId: `run-cancel:${input.commandId}`,
      operationId: `run-cancel:${input.commandId}`,
      ...(eventId === input.commandId ? {} : { causationId: eventId }),
    })
    await this.append([
      {
        ...this.makeEvent(
          input.sessionId,
          events.length + 1,
          "RunStopRequested",
          {
            runId: input.runId,
            commandId: input.commandId,
            reason: input.reason ?? "run cancelled",
          },
          trace,
        ),
        transitionId: `command:cancel_run:${input.commandId}`,
      },
    ])
    this.runAborters.get(String(input.runId))?.abort()
    return { runId: input.runId, status: "requested" }
  }

  private async executeNow(input: StartRunInput): Promise<RunResult> {
    validateInput(input)
    const previous = await this.deps.eventStore.read(input.sessionId)
    const idempotency = resolveCommandIdempotency(START_RUN_FAMILY, previous, {
      family: START_RUN_FAMILY.family,
      commandId: input.commandId,
      inputFingerprint: startRunFingerprint(input, this.deps.workspaceRootCanonicalizer),
    })
    if (idempotency.status === "conflict") throw commandIdempotencyConflictError(idempotency.record)
    if (idempotency.status === "replay") return replayRunTerminal(idempotency.terminal)
    const contextWindowOverride = previous.length === 0 ? undefined : replaySession(previous).contextWindowOverride
    if (previous.length > 0) {
      const existingInput = reduceCanonicalSession(previous).inputs.get(inputIdFor(input.commandId))
      if (existingInput?.status === "cancelled-before-acceptance")
        return {
          runId: this.deps.identity.nextRunId(),
          status: "cancelled",
          turns: 0,
        }
    }
    const existingMessage = previous.find(
      (event) =>
        event.type === "InputAccepted" &&
        event.payload.commandId === input.commandId &&
        (event.payload.kind === "message" || event.payload.kind === "notification"),
    )
    if (existingMessage?.type === "InputAccepted") {
      const existingRun = previous.find((event) => event.type === "RunStarted" && event.payload.commandId === input.commandId)
      if (existingRun?.type === "RunStarted") {
        const existingState = reduceCanonicalSession(previous)
        const existingInputState = existingState.inputs.get(inputIdFor(input.commandId))
        if (
          existingInputState?.status === "cancelled" ||
          existingState.runs.get(String(existingRun.payload.runId))?.stopRequested === true
        ) {
          return this.finishCancelledResume(input, existingRun, abortError("input cancelled"))
        }
        return this.resumeRun(input, previous, existingMessage, existingRun).catch((error: unknown) => {
          if (!input.signal?.aborted && !isAbortError(error)) throw error
          return this.finishCancelledResume(input, existingRun, error)
        })
      }
    }

    const maxTurns = input.maxTurns
    const run = this.deps.identity.nextRunId()
    const traceId = existingMessage?.trace.traceId ?? input.trace?.traceId ?? this.deps.identity.nextEventId()
    const operationId = existingMessage?.trace.operationId ?? input.trace?.operationId ?? this.deps.identity.nextEventId()
    let causationId = existingMessage?.eventId ?? input.trace?.causationId ?? input.commandId
    const nextTrace = (eventId: string): EventTrace => {
      const trace: EventTrace = {
        traceId,
        operationId,
        ...(causationId ? { causationId } : {}),
      }
      causationId = eventId
      return trace
    }
    let revision = previous.length + 1
    const setup: AgentEvent[] = []
    if (previous.length === 0) {
      setup.push(
        this.makeEvent(
          input.sessionId,
          revision++,
          "SessionCreated",
          {
            workspaceRoot: input.workspace ?? ".",
            additionalDirectories: input.additionalDirectories ?? [],
            ...(input.additionalDirectories && input.additionalDirectories.length > 0
              ? this.deps.workspaceScopeDigest === undefined
                ? {}
                : {
                    scopeDigest: this.deps.workspaceScopeDigest(input.workspace ?? ".", input.additionalDirectories),
                  }
              : {}),
            permissionMode: input.permissionMode ?? DEFAULT_SESSION_PERMISSION_MODE,
            permissionRules: normalizeSessionPermissionRules(input.permissionRules ?? []),
            policyRevision: 0,
            scopeRevision: 0,
          },
          nextTrace,
        ),
      )
    }
    if (!hasStartCommandAccepted(previous, input.commandId)) {
      setup.push(
        this.makeEvent(
          input.sessionId,
          revision++,
          "CommandAccepted",
          {
            commandId: input.commandId,
            family: "start_run",
            inputFingerprint: startRunFingerprint(input, this.deps.workspaceRootCanonicalizer),
          },
          nextTrace,
        ),
      )
    }
    const checkpoint = await this.createPromptCheckpoint()
    if (checkpoint) {
      const checkpointState = reduceCanonicalSession(previous.length === 0 ? setup : previous)
      const checkpointHead = checkpointState.activeHead
      if (checkpointHead === undefined) throw new Error("Cannot create a checkpoint without an active history head")
      setup.push(
        this.makeEvent(
          input.sessionId,
          revision++,
          "SessionCheckpointCreated",
          {
            checkpointId: checkpoint.checkpointId,
            kind: "prompt",
            headRevision: checkpointHead.physicalRevision,
            generation: checkpointState.executionGeneration,
            head: checkpointHead,
          },
          nextTrace,
        ),
      )
    }
    if (!existingMessage) {
      setup.push(
        this.makeEvent(
          input.sessionId,
          revision++,
          "InputAccepted",
          {
            inputId: inputIdFor(input.commandId),
            commandId: input.commandId,
            kind: "message",
            text: input.goal,
            delivery: "fifo",
            ...(input.context && input.context.length > 0 ? { context: [...input.context] } : {}),
            ...(input.fileReferences && input.fileReferences.length > 0 ? { fileReferences: [...input.fileReferences] } : {}),
          },
          nextTrace,
        ),
      )
    }
    setup.push(
      this.makeEvent(
        input.sessionId,
        revision++,
        "RunStarted",
        {
          runId: run,
          commandId: input.commandId,
          goal: input.goal,
          maxTurns,
        },
        nextTrace,
      ),
    )
    await this.append(setup)

    const attachments = await this.loadAttachments(input, previous)

    const activeAgentName = previous.length === 0 ? undefined : replaySession(previous).activeAgent
    return this.runLoop({
      input,
      run,
      maxTurns,
      traceId,
      operationId,
      initialCausationId: causationId,
      revision,
      messages: [...(previous.length === 0 ? (input.initialMessages ?? []) : []), ...messagesFromSessionEvents(previous)],
      startTurn: 1,
      inputId: inputIdFor(input.commandId),
      initialMessages: previous.length === 0 ? input.initialMessages : undefined,
      attachments,
      contextWindowOverride,
      ...(activeAgentName === undefined ? {} : { agentName: activeAgentName }),
    })
  }

  private async resumeRun(
    input: StartRunInput,
    previous: readonly AgentEvent[],
    existingMessage: Extract<AgentEvent, { type: "InputAccepted" }>,
    existingRun: Extract<AgentEvent, { type: "RunStarted" }>,
  ): Promise<RunResult> {
    if (input.signal?.aborted) throw abortError()
    let history = previous
    const recoveredState = reduceCanonicalSession(history)
    const pendingAttempt = [...recoveredState.attempts.values()].find(
      (attempt) => attempt.runId === existingRun.payload.runId && attempt.toolUseId === undefined && attempt.status === "started",
    )
    if (pendingAttempt !== undefined) {
      const recoveryTrace = this.createTrace(
        existingRun.trace.traceId,
        existingRun.trace.operationId,
        history.at(-1)?.eventId ?? existingRun.eventId,
      )
      await this.append([
        this.makeEvent(
          input.sessionId,
          history.length + 1,
          "ModelAttemptAbandoned",
          {
            runId: pendingAttempt.runId,
            turn: pendingAttempt.turn,
            attemptId: pendingAttempt.attemptId,
            executionGeneration: pendingAttempt.executionGeneration,
            reason: "recovered after an incomplete model attempt",
            recoveryCommandId: `recovery:abandon:${pendingAttempt.attemptId}`,
          },
          recoveryTrace.nextTrace,
        ),
      ])
      history = await this.deps.eventStore.read(input.sessionId)
    }
    const recoveredAfterRecovery = reduceCanonicalSession(history)
    if (
      recoveredAfterRecovery.runs.get(String(existingRun.payload.runId))?.stopRequested === true ||
      recoveredAfterRecovery.inputs.get(existingMessage.payload.inputId)?.status === "cancelled"
    ) {
      return this.finishCancelledResume(input, existingRun, abortError("input cancelled"))
    }
    const runEvents = history.filter(
      (event) =>
        event.revision >= existingRun.revision &&
        event.type !== "SessionCreated" &&
        (event.type === "RunStarted" || !("runId" in event.payload) || event.payload.runId === existingRun.payload.runId),
    )
    const messages = messagesFromSessionEvents(history)
    const lastCommittedResponse = [...runEvents]
      .reverse()
      .find((event): event is Extract<AgentEvent, { type: "ModelResponseCommitted" }> => event.type === "ModelResponseCommitted")
    const lastResults = [...runEvents]
      .reverse()
      .find((event): event is Extract<AgentEvent, { type: "ToolResultCommitted" }> => event.type === "ToolResultCommitted")
    const lastAttempt = [...runEvents]
      .reverse()
      .find((event): event is Extract<AgentEvent, { type: "ModelAttemptStarted" }> => event.type === "ModelAttemptStarted")
    const responseContent = lastCommittedResponse?.payload.content
    const responseTurn = lastCommittedResponse?.payload.turn
    const traceId = existingRun.trace.traceId
    const operationId = existingRun.trace.operationId
    const initialCausationId = history.at(-1)?.eventId ?? existingRun.eventId
    let revision = history.length + 1
    const trace = this.createTrace(traceId, operationId, initialCausationId)
    const maxTurns = existingRun.payload.maxTurns
    const attachments = await this.loadAttachments(input, history)
    const contextWindowOverride = history.length === 0 ? undefined : replaySession(history).contextWindowOverride
    const security = projectSecurityState(history)
    const activeAgentName = replaySession(history).activeAgent
    const activeAgent = resolveAgent(this.deps.agentProfiles, activeAgentName)
    const scopedTools = activeAgent ? restrictTools(this.deps.tools, activeAgent.tools) : this.deps.tools

    if (responseContent !== undefined && toolUsesFrom(responseContent).length > 0 && lastResults?.payload.turn !== responseTurn) {
      const executionState = reduceCanonicalSession(history)
      // The recovered tool turn runs outside runLoop, so its failures must be
      // terminalized here too — otherwise a surface-less approval ask leaves
      // the run without a durable terminal and it stays resumable forever.
      let execution: Awaited<ReturnType<ToolTurnExecutor["execute"]>>
      try {
        execution = await this.toolTurnExecutor.execute({
          input,
          run: existingRun.payload.runId,
          turn: responseTurn!,
          executionGeneration: executionState.executionGeneration,
          branchId: executionState.activeHead?.branchId ?? "main",
          toolUses: toolUsesFrom(responseContent),
          revision,
          nextTrace: trace.nextTrace,
          knownEvents: history,
          security,
          agentName: activeAgentName,
          recovered: true,
          toolResultCache: new Map(),
          repeatedToolCalls: new Map(),
          toolFailureGuard: createToolFailureLoopGuardState(),
          tools: scopedTools,
        })
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) throw error
        return await this.terminalizeRunFailure(input, existingRun.payload.runId, error, trace, undefined)
      }
      revision = execution.revision
      if (input.signal?.aborted) throw abortError()
      messages.push(toolResultMessage(execution.results))
      if (execution.interactionOutcome === "declined") throw abortError("User declined to answer questions")
      if (execution.loopGuard) {
        return this.finishFailed(
          input.sessionId,
          existingRun.payload.runId,
          responseTurn!,
          execution.loopGuard.message,
          revision,
          trace.nextTrace,
          trace.commandTrace,
        )
      }
      if (maxTurns !== undefined && responseTurn! >= maxTurns) {
        return this.finishFailed(
          input.sessionId,
          existingRun.payload.runId,
          responseTurn!,
          "Maximum execution turns reached",
          revision,
          trace.nextTrace,
          trace.commandTrace,
        )
      }
      return this.runLoop({
        input,
        run: existingRun.payload.runId,
        maxTurns,
        traceId,
        operationId,
        initialCausationId: trace.causationId,
        revision,
        messages,
        startTurn: responseTurn! + 1,
        inputId: inputIdFor(input.commandId),
        initialMessages: undefined,
        attachments,
        contextWindowOverride,
        ...(activeAgentName === undefined ? {} : { agentName: activeAgentName }),
      })
    }

    if (responseContent !== undefined && toolUsesFrom(responseContent).length === 0) {
      return this.completeRun(
        input.sessionId,
        existingRun.payload.runId,
        responseTurn!,
        textFrom(responseContent),
        revision,
        trace.nextTrace,
        trace.commandTrace,
      )
    }

    return this.runLoop({
      input,
      run: existingRun.payload.runId,
      maxTurns,
      traceId,
      operationId,
      initialCausationId: trace.causationId,
      revision,
      messages,
      startTurn: lastResults ? lastResults.payload.turn + 1 : (lastAttempt?.payload.turn ?? 1),
      inputId: inputIdFor(input.commandId),
      initialMessages: undefined,
      attachments,
      contextWindowOverride,
      ...(activeAgentName === undefined ? {} : { agentName: activeAgentName }),
    })
  }

  private async runLoop(options: {
    input: StartRunInput
    run: RunId
    maxTurns: number | undefined
    traceId: string
    operationId: string
    initialCausationId: string
    revision: number
    messages: Message[]
    startTurn: number
    inputId: string
    initialMessages?: readonly Message[]
    attachments: readonly ContextAttachment[]
    contextWindowOverride?: number
    agentName?: string
  }): Promise<RunResult> {
    const originalInput = options.input
    const runKey = String(options.run)
    const runAborter = this.runAborters.get(runKey) ?? new AbortController()
    if (!this.runAborters.has(runKey)) this.runAborters.set(runKey, runAborter)
    if (originalInput.signal !== undefined) {
      if (originalInput.signal.aborted) runAborter.abort(originalInput.signal.reason)
      else originalInput.signal.addEventListener("abort", () => runAborter.abort(originalInput.signal?.reason), { once: true })
    }
    const input: StartRunInput = {
      ...originalInput,
      signal: runAborter.signal,
    }
    const { run, maxTurns, traceId, operationId, initialCausationId } = options
    let revision = options.revision
    let messages = options.messages
    const toolResultCache = new Map<string, ToolResult>()
    const repeatedToolCalls = new Map<string, number>()
    const toolFailureGuard = createToolFailureLoopGuardState()
    let activeAttempt: ActiveModelAttempt | undefined
    const trace = this.createTrace(traceId, operationId, initialCausationId)
    const traceSink = this.traceSink
    traceSink.record({
      name: "session.command",
      phase: "started",
      sessionId: input.sessionId,
      trace: trace.commandTrace,
      timestamp: this.deps.identity.now(),
      attributes: { commandType: "run_agent" },
    })

    if (maxTurns !== undefined && options.startTurn > maxTurns) {
      return this.finishFailed(
        input.sessionId,
        run,
        maxTurns,
        "Maximum execution turns reached",
        revision,
        trace.nextTrace,
        trace.commandTrace,
      )
    }

    try {
      for (let turn = options.startTurn; maxTurns === undefined || turn <= maxTurns; turn++) {
        if (input.signal?.aborted) throw abortError()
        let currentEvents = await this.deps.eventStore.read(input.sessionId)
        let currentState = reduceCanonicalSession(currentEvents)
        if (currentState.runs.get(String(run))?.stopRequested === true) throw abortError("run stopped")
        // User inputs always outrank host notifications: consumption order is
        // the message order the model sees. Fifo prompts carry no target run:
        // the mailbox is session-level, so leftovers from earlier runs are
        // consumed by whichever run reaches the boundary first.
        const pendingInputs = [...currentState.inputs.values()]
          .filter(
            (candidate) =>
              candidate.status === "pending" &&
              (candidate.inputId === options.inputId ||
                candidate.targetRunId === run ||
                candidate.kind === "notification" ||
                (candidate.kind === "message" && candidate.targetRunId === undefined)),
          )
          .sort((left, right) => Number(left.kind === "notification") - Number(right.kind === "notification"))
        for (const pendingInput of pendingInputs) {
          let consumed = false
          for (let attempt = 0; attempt < 3 && !consumed; attempt += 1) {
            const latestEvents = await this.deps.eventStore.read(input.sessionId)
            const latestState = reduceCanonicalSession(latestEvents)
            const latestInput = latestState.inputs.get(pendingInput.inputId)
            if (latestInput?.status !== "pending") {
              if (pendingInput.inputId === options.inputId && latestInput?.status === "cancelled") {
                throw abortError("input cancelled")
              }
              break
            }
            if (latestState.runs.get(String(run))?.stopRequested === true) throw abortError("run stopped")
            const parent = latestState.activeHead
            if (parent === undefined) throw new Error("Cannot consume input without an active history head")
            const consumedEvent = this.makeEvent(
              input.sessionId,
              latestEvents.length + 1,
              "InputConsumed",
              {
                inputId: latestInput.inputId,
                commandId: latestInput.commandId,
                kind: latestInput.kind,
                text: latestInput.text ?? "",
                delivery: latestInput.delivery ?? "fifo",
                runId: run,
                executionGeneration: latestState.executionGeneration,
                boundary: latestInput.kind === "steer" ? "safe-boundary" : "model-request",
                parent,
              },
              trace.nextTrace,
            )
            try {
              await this.append([consumedEvent], latestEvents.length)
              consumed = true
            } catch (error) {
              if (!(error instanceof SessionRevisionConflictError)) throw error
            }
          }
          currentEvents = await this.deps.eventStore.read(input.sessionId)
          currentState = reduceCanonicalSession(currentEvents)
          revision = currentEvents.length + 1
        }
        if (pendingInputs.length > 0) {
          messages = [...(options.initialMessages ?? []), ...messagesFromSessionEvents(currentEvents)]
        }
        const agent = resolveAgent(this.deps.agentProfiles, options.agentName)
        const scopedTools = agent ? restrictTools(this.deps.tools, agent.tools) : this.deps.tools
        // Advertised tools are the judgment's projection of the declared list
        // on this turn's snapshot; the execution pool below stays unfiltered
        // so hallucinated calls still reach the judgment. Out-of-table names
        // deny with a stable code; an in-table name missing from this
        // composition's registry fails at the executor as before.
        const declared = scopedTools.listTools()
        const snapshot = replaySession(currentEvents)
        const visible = projectModelTools(
          declared.map((tool) => tool.name),
          snapshot,
          this.deps.permissionSurfaces,
        )
        const tools = declared.filter((tool) => visible.has(tool.name))
        const workspaceRoot = snapshot?.workspaceRoot ?? input.workspace ?? this.deps.environment?.cwd
        const additionalDirectories = snapshot?.additionalDirectories ?? input.additionalDirectories
        // An empty admitted set carries no directory fact; omit the key so
        // the environment payload stays minimal for sessions without add-dir.
        const directoriesFact =
          additionalDirectories === undefined || additionalDirectories.length === 0 ? undefined : additionalDirectories
        const contextTrace = {
          traceId,
          operationId,
          ...(trace.causationId ? { causationId: trace.causationId } : {}),
        }
        const builtContext = await this.buildContext({
          sessionId: input.sessionId,
          runId: run,
          goal: input.goal,
          context: input.context ?? [],
          attachments: options.attachments,
          messages,
          tools,
          ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
          ...(directoriesFact === undefined ? {} : { additionalDirectories: directoriesFact }),
          contextWindowOverride: options.contextWindowOverride,
          trace: contextTrace,
          signal: input.signal,
          ...(agent ? { agent: { name: agent.name, instructions: agent.instructions } } : {}),
        })
        messages = [...builtContext.messages]
        const modelMessages = modelMessagesForRequest(builtContext.contextMessages, builtContext.messages)
        const request: CanonicalModelRequest = {
          messages: modelMessages,
          tools,
          ...(builtContext.systemPrompt ? { systemPrompt: builtContext.systemPrompt } : {}),
          ...(builtContext.provenance ? { context: builtContext.provenance } : {}),
        }
        const requestUsage = estimateRequestUsage({
          messages: request.messages,
          systemPrompt: request.systemPrompt,
          tools: request.tools,
        })
        const callId = `${run}:${turn}`
        const executionGeneration = currentState.executionGeneration
        const branchId = currentState.activeHead?.branchId ?? "main"
        let inputCursor = currentState.activeHead
        if (inputCursor === undefined) throw new Error("Cannot start a model attempt without an active history head")
        const attemptId = nextModelAttemptId(currentEvents, run, turn)
        const requestFingerprint = await fingerprintModelRequest(request)
        const contextEvents: AgentEvent[] = []
        if (builtContext.compaction) {
          const compacted = this.makeEvent(
            input.sessionId,
            revision++,
            "ContextCompacted",
            {
              runId: run,
              turn,
              compactId: builtContext.compaction.compactId,
              inputMessageCount: builtContext.compaction.inputMessageCount,
              outputMessageCount: builtContext.compaction.outputMessageCount,
              messages: structuredClone(builtContext.compaction.messages),
              ...(builtContext.compaction.inputTokens === undefined ? {} : { inputTokens: builtContext.compaction.inputTokens }),
            },
            trace.nextTrace,
          )
          contextEvents.push(compacted)
          inputCursor = historyCursorForEvent(compacted, branchId)
        }
        const attemptStarted = this.makeEvent(
          input.sessionId,
          revision++,
          "ModelAttemptStarted",
          {
            runId: run,
            turn,
            attemptId,
            executionGeneration,
            branchId,
            inputCursor,
            requestFingerprint,
            // The full request snapshot rides the durable log only under a
            // payload-capturing observability mode; the provenance rides
            // every mode so default history stays low-sensitive but
            // attributable.
            ...(this.deps.observability?.captureModelPayload === true ? { request } : {}),
            ...(request.context === undefined ? {} : { context: request.context }),
            // Record the policy snapshot used to assemble this request.
            // Tool dispatch rechecks the current policy before side effects.
            boundPolicyRevision: replaySession(currentEvents).policyRevision,
          },
          trace.nextTrace,
        )
        activeAttempt = {
          attemptId,
          runId: run,
          turn,
          executionGeneration,
          branchId,
          inputCursor,
          requestFingerprint,
        }
        await this.append([...contextEvents, attemptStarted])

        const modelStartedAt = performance.now()
        traceSink.record({
          name: "execution.model",
          phase: "started",
          sessionId: input.sessionId,
          trace: { traceId, operationId, causationId: attemptStarted.eventId },
          timestamp: this.deps.identity.now(),
        })
        const assistant = await this.deps.model.generate({
          sessionId: input.sessionId,
          runId: run,
          messages: request.messages,
          tools: request.tools,
          ...((input.model ?? agent?.model) ? { model: input.model ?? agent?.model } : {}),
          ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
          signal: input.signal,
          onRetry: async (retry) => {
            const retryEvent = this.makeEvent(
              input.sessionId,
              revision++,
              "ModelRetryScheduled",
              {
                runId: run,
                turn,
                callId,
                attempt: retry.attempt,
                nextAttempt: retry.nextAttempt,
                delayMs: retry.delayMs,
                category: retry.failure.category,
              },
              trace.nextTrace,
            )
            await this.append([retryEvent])
          },
          onStreamEvent: (event) => {
            if (event.type === "thinking_delta") {
              // Reasoning is retained in the final canonical ModelResponseCommitted
              // block but is intentionally not rendered as visible assistant text.
              return
            } else if (event.type === "text_delta") {
              this.transientPublisher.emit(input.sessionId, attemptStarted.trace, "model_text_delta", {
                runId: run,
                turn,
                callId,
                delta: event.delta,
              })
            } else if (event.type === "tool_call_start") {
              this.transientPublisher.emit(input.sessionId, attemptStarted.trace, "model_tool_call_start", {
                runId: run,
                turn,
                callId,
                toolUseId: event.toolUseId,
                name: event.name,
              })
            } else if (event.type === "tool_call_delta") {
              this.transientPublisher.emit(input.sessionId, attemptStarted.trace, "model_tool_call_delta", {
                runId: run,
                turn,
                callId,
                toolUseId: event.toolUseId,
                delta: event.delta,
              })
            } else {
              this.transientPublisher.emit(input.sessionId, attemptStarted.trace, "model_tool_call_end", {
                runId: run,
                turn,
                callId,
                toolUseId: event.toolUseId,
                input: event.input,
              })
            }
          },
        })
        if (input.signal?.aborted) throw abortError()
        const afterModel = reduceCanonicalSession(await this.deps.eventStore.read(input.sessionId))
        if (afterModel.runs.get(String(run))?.stopRequested === true) throw abortError("run stopped")
        traceSink.record({
          name: "execution.model",
          phase: "succeeded",
          sessionId: input.sessionId,
          trace: { traceId, operationId, causationId: attemptStarted.eventId },
          timestamp: this.deps.identity.now(),
          durationMs: Math.round(performance.now() - modelStartedAt),
        })

        const providerUsage = assistant.modelMetadata?.usage
        // Some OpenAI-compatible proxies report only the user-message tokens
        // (or omit system/tools from prompt_tokens). Never let that make the
        // TUI under-report the actual request assembled by this runtime.
        const providerInputTokens = providerUsage?.inputTokens
        const estimatedInputTokens =
          providerInputTokens === undefined ? requestUsage.totalTokens : Math.max(providerInputTokens, requestUsage.totalTokens)
        const contextUsage = {
          inputTokens: estimatedInputTokens,
          estimated: providerInputTokens === undefined || estimatedInputTokens !== providerInputTokens,
        }
        const metadata =
          assistant.modelMetadata === undefined
            ? undefined
            : {
                ...assistant.modelMetadata,
                usage: {
                  ...(assistant.modelMetadata.usage ?? {}),
                  inputTokens: estimatedInputTokens,
                  estimated: contextUsage.estimated,
                },
              }
        // The response is fenced on the exact history base this commit read.
        // Concurrent history writes retry against a fresh parent; permission
        // changes are enforced against current policy when any tool is dispatched.
        let responseBaseEvents = await this.deps.eventStore.read(input.sessionId)
        let responseCommitted = false
        for (let commitAttempt = 0; commitAttempt < 3 && !responseCommitted; commitAttempt += 1) {
          const responseBaseState = reduceCanonicalSession(responseBaseEvents)
          const responseParent = responseBaseState.activeHead
          if (responseParent === undefined) throw new Error("Cannot commit a model response without an active history head")
          const responseCommit = this.makeEvent(
            input.sessionId,
            responseBaseEvents.length + 1,
            "ModelResponseCommitted",
            {
              runId: run,
              turn,
              attemptId,
              executionGeneration,
              branchId,
              inputCursor,
              requestFingerprint,
              parent: responseParent,
              content: assistant.message.content,
              ...(assistant.stop_reason ? { stopReason: assistant.stop_reason } : {}),
              ...(metadata ? { metadata } : {}),
              durationMs: Math.round(performance.now() - modelStartedAt),
            },
            trace.nextTrace,
          )
          try {
            const committedEvents = await this.append([responseCommit], responseBaseEvents.length)
            revision = committedEvents.at(-1)!.revision + 1
            responseCommitted = true
          } catch (error) {
            if (!(error instanceof SessionRevisionConflictError)) throw error
            responseBaseEvents = await this.deps.eventStore.read(input.sessionId)
          }
        }
        if (!responseCommitted) throw new Error("Model response could not commit: the session history kept moving")
        activeAttempt = undefined
        messages.push(assistant)

        const toolUses = toolUsesFrom(assistant.message.content)
        if (toolUses.length === 0) {
          const finalText = textFrom(assistant.message.content)
          const postResponseState = reduceCanonicalSession(await this.deps.eventStore.read(input.sessionId))
          if (postResponseState.runs.get(String(run))?.stopRequested === true) throw abortError("run stopped")
          const hasPendingInput = [...postResponseState.inputs.values()].some(
            (candidate) =>
              candidate.status === "pending" &&
              (candidate.inputId === options.inputId ||
                candidate.targetRunId === run ||
                candidate.kind === "notification" ||
                (candidate.kind === "message" && candidate.targetRunId === undefined)),
          )
          if (hasPendingInput) continue
          return this.completeRun(input.sessionId, run, turn, finalText, revision, trace.nextTrace, trace.commandTrace)
        }

        const toolEvents = await this.deps.eventStore.read(input.sessionId)
        const toolState = reduceCanonicalSession(toolEvents)
        if (toolState.runs.get(String(run))?.stopRequested === true) throw abortError("run stopped")
        const execution = await this.toolTurnExecutor.execute({
          input,
          run,
          turn,
          executionGeneration: toolState.executionGeneration,
          branchId: toolState.activeHead?.branchId ?? "main",
          toolUses,
          revision,
          nextTrace: trace.nextTrace,
          knownEvents: toolEvents,
          security: projectSecurityState(toolEvents),
          agentName: options.agentName,
          toolResultCache,
          repeatedToolCalls,
          toolFailureGuard,
          tools: scopedTools,
        })
        revision = execution.revision
        messages.push(toolResultMessage(execution.results))
        if (execution.interactionOutcome === "declined") throw abortError("User declined to answer questions")
        if (input.signal?.aborted) throw abortError()
        if (execution.loopGuard) {
          return this.finishFailed(input.sessionId, run, turn, execution.loopGuard.message, revision, trace.nextTrace, trace.commandTrace)
        }

        if (maxTurns !== undefined && turn === maxTurns) {
          return this.finishFailed(
            input.sessionId,
            run,
            turn,
            "Maximum execution turns reached",
            revision,
            trace.nextTrace,
            trace.commandTrace,
          )
        }
      }
    } catch (error) {
      return await this.terminalizeRunFailure(input, run, error, trace, activeAttempt)
    }
    throw new Error("Run did not produce a terminal state")
  }

  /**
   * Lands the durable failure terminal for a run whose execution threw: abandons
   * orphaned attempts, appends RunCancelled/RunFailed (approval failures carry
   * the stable code), and rethrows ApprovalRequiredError so live callers map it
   * through the error classifier while idempotent replays map the durable code.
   */
  private async terminalizeRunFailure(
    input: StartRunInput,
    run: RunId,
    error: unknown,
    trace: {
      readonly commandTrace: EventTrace
      readonly nextTrace: (eventId: string) => EventTrace
    },
    activeAttempt: ActiveModelAttempt | undefined,
  ): Promise<RunResult> {
    const traceSink = this.traceSink
    const current = await this.deps.eventStore.read(input.sessionId)
    let revision = current.length + 1
    const message = error instanceof Error ? error.message : String(error)
    const failureEvents: AgentEvent[] = []
    const currentState = reduceCanonicalSession(current)
    const currentRunState = currentState.runs.get(String(run))
    const cancelled = input.signal?.aborted || isAbortError(error) || currentRunState?.stopRequested === true
    if (
      currentRunState === undefined ||
      currentRunState.status !== "running" ||
      error instanceof StaleSessionWriterError ||
      (error instanceof SessionRevisionConflictError && activeAttempt !== undefined)
    ) {
      this.runAborters.delete(String(run))
      return { runId: run, status: "cancelled", turns: countTurns(current) }
    }
    const pendingAttempt = activeAttempt === undefined ? undefined : currentState.attempts.get(activeAttempt.attemptId)
    if (pendingAttempt?.status === "started" && activeAttempt !== undefined) {
      failureEvents.push(
        this.makeEvent(
          input.sessionId,
          revision++,
          "ModelAttemptAbandoned",
          {
            runId: activeAttempt.runId,
            turn: activeAttempt.turn,
            attemptId: activeAttempt.attemptId,
            executionGeneration: activeAttempt.executionGeneration,
            reason: message,
            recoveryCommandId: `recovery:abandon:${activeAttempt.attemptId}`,
          },
          trace.nextTrace,
        ),
      )
    }
    for (const pendingTool of currentState.attempts.values()) {
      if (pendingTool.status !== "started" || pendingTool.toolUseId === undefined || pendingTool.runId !== run) continue
      failureEvents.push(
        this.makeEvent(
          input.sessionId,
          revision++,
          "ToolAttemptAbandoned",
          {
            runId: pendingTool.runId,
            turn: pendingTool.turn,
            attemptId: pendingTool.attemptId,
            toolUseId: pendingTool.toolUseId,
            executionGeneration: pendingTool.executionGeneration,
            reason: message,
            recoveryCommandId: `recovery:tool-abandon:${pendingTool.attemptId}`,
          },
          trace.nextTrace,
        ),
      )
    }
    if (cancelled) {
      const terminal = this.makeEvent(
        input.sessionId,
        revision,
        "RunCancelled",
        {
          runId: run,
          turns: countTurns(current),
          reason: message,
        },
        trace.nextTrace,
      )
      failureEvents.push(terminal)
      await this.append(failureEvents)
      this.runAborters.delete(String(run))
      traceSink.record({
        name: "session.command",
        phase: "cancelled",
        sessionId: input.sessionId,
        trace: { ...trace.commandTrace, causationId: terminal.eventId },
        timestamp: this.deps.identity.now(),
        attributes: { commandType: "run_agent" },
      })
      return {
        runId: run,
        status: "cancelled",
        turns: terminal.payload.turns,
        ...(terminal.payload.reason ? { error: terminal.payload.reason } : {}),
      }
    }
    const terminal = this.makeEvent(
      input.sessionId,
      revision,
      "RunFailed",
      {
        runId: run,
        turns: countTurns(current),
        message,
        ...(error instanceof ApprovalRequiredError ? { code: "approval_required" as const } : {}),
        ...(error instanceof AskExpiredError ? { code: "interaction_expired" as const } : {}),
      },
      trace.nextTrace,
    )
    failureEvents.push(terminal)
    await this.append(failureEvents)
    this.runAborters.delete(String(run))
    traceSink.record({
      name: "session.command",
      phase: "failed",
      sessionId: input.sessionId,
      trace: { ...trace.commandTrace, causationId: terminal.eventId },
      timestamp: this.deps.identity.now(),
      attributes: { commandType: "run_agent" },
    })
    if (error instanceof ApprovalRequiredError) throw error
    if (error instanceof AskExpiredError) throw error
    return {
      runId: run,
      status: "failed",
      turns: terminal.payload.turns,
      error: terminal.payload.message,
    }
  }

  private withMailbox<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    return this.mailbox.run(sessionId.toString(), operation)
  }

  private createTrace(
    traceId: string,
    operationId: string,
    initialCausationId: string,
  ): {
    commandTrace: EventTrace
    nextTrace: (eventId: string) => EventTrace
    readonly causationId: string
  } {
    let causationId = initialCausationId
    const commandTrace: EventTrace = {
      traceId,
      operationId,
      causationId: initialCausationId,
    }
    return {
      commandTrace,
      get causationId() {
        return causationId
      },
      nextTrace: (eventId: string) => {
        const trace: EventTrace = {
          traceId,
          operationId,
          ...(causationId ? { causationId } : {}),
        }
        causationId = eventId
        return trace
      },
    }
  }

  private async completeRun(
    sessionId: SessionId,
    run: RunId,
    turns: number,
    finalText: string,
    revision: number,
    nextTrace: (eventId: string) => EventTrace,
    commandTrace: EventTrace,
  ): Promise<RunResult> {
    const visibleText = finalText.trim().length > 0 ? finalText : EMPTY_MODEL_RESPONSE_FALLBACK
    const terminal = this.makeEvent(sessionId, revision, "RunCompleted", { runId: run, turns, finalText: visibleText }, nextTrace)
    await this.append([terminal])
    this.runAborters.delete(String(run))
    const traceSink = this.traceSink
    traceSink.record({
      name: "session.command",
      phase: "succeeded",
      sessionId,
      trace: { ...commandTrace, causationId: terminal.eventId },
      timestamp: this.deps.identity.now(),
      attributes: { commandType: "run_agent" },
    })
    return { runId: run, status: "completed", turns, finalText: visibleText }
  }

  private async finishFailed(
    sessionId: SessionId,
    run: RunId,
    turns: number,
    message: string,
    revision: number,
    nextTrace: (eventId: string) => EventTrace,
    commandTrace: EventTrace,
  ): Promise<RunResult> {
    const terminal = this.makeEvent(sessionId, revision, "RunFailed", { runId: run, turns, message }, nextTrace)
    await this.append([terminal])
    this.runAborters.delete(String(run))
    const traceSink = this.traceSink
    traceSink.record({
      name: "session.command",
      phase: "failed",
      sessionId,
      trace: { ...commandTrace, causationId: terminal.eventId },
      timestamp: this.deps.identity.now(),
      attributes: { commandType: "run_agent" },
    })
    return { runId: run, status: "failed", turns, error: message }
  }

  private async finishCancelledResume(
    input: StartRunInput,
    existingRun: Extract<AgentEvent, { type: "RunStarted" }>,
    error: unknown,
  ): Promise<RunResult> {
    const current = await this.deps.eventStore.read(input.sessionId)
    const trace = this.createTrace(existingRun.trace.traceId, existingRun.trace.operationId, current.at(-1)?.eventId ?? existingRun.eventId)
    const reason = error instanceof Error ? error.message : String(error)
    const terminal = this.makeEvent(
      input.sessionId,
      current.length + 1,
      "RunCancelled",
      {
        runId: existingRun.payload.runId,
        turns: countTurns(current),
        reason,
      },
      trace.nextTrace,
    )
    await this.append([terminal])
    this.runAborters.delete(String(existingRun.payload.runId))
    const traceSink = this.traceSink
    traceSink.record({
      name: "session.command",
      phase: "cancelled",
      sessionId: input.sessionId,
      trace: { ...trace.commandTrace, causationId: terminal.eventId },
      timestamp: this.deps.identity.now(),
      attributes: { commandType: "run_agent" },
    })
    return cancelledResult(terminal.payload)
  }

  private async append(events: readonly AgentEvent[], expectedRevision?: number): Promise<readonly AgentEvent[]> {
    if (events.length === 0) return []
    const committed =
      expectedRevision === undefined ? await this.authority.append(events) : await this.authority.appendAtRevision(events, expectedRevision)
    try {
      // A replay can be the only fan-out that ever ran: the original attempt
      // may die after the durable append but before observers execute, so
      // replays must fan out too. Delivery is at-least-once.
      await this.deps.onEventsAppended?.(committed.events, committed.replayed === true)
    } catch {
      // Durable state is authoritative; observers can replay after a notification failure.
    }
    return committed.events
  }

  private async buildContext(input: Parameters<ContextBuilder["build"]>[0]): Promise<Awaited<ReturnType<ContextBuilder["build"]>>> {
    return (
      this.deps.contextBuilder?.build(input) ?? {
        messages: [...input.messages],
      }
    )
  }

  private async loadAttachments(input: StartRunInput, previous: readonly AgentEvent[]): Promise<readonly ContextAttachment[]> {
    const paths = input.fileReferences ?? []
    if (paths.length === 0) return []
    if (!this.deps.fileContextLoader) throw new Error("The current runtime does not have a file reference loader enabled")
    const snapshot = previous.length === 0 ? undefined : replaySession(previous)
    const workspace = this.deps.workspacePolicyFactory?.({
      workspaceRoot: snapshot?.workspaceRoot ?? input.workspace ?? this.deps.environment?.cwd ?? ".",
      additionalDirectories: snapshot?.additionalDirectories ?? input.additionalDirectories,
      sessionId: input.sessionId,
    })
    if (!workspace) throw new Error("Workspace policy is not injected")
    return this.deps.fileContextLoader(paths, input.signal, workspace)
  }

  private async createPromptCheckpoint(): Promise<{
    readonly checkpointId: string
  }> {
    const checkpointId = this.deps.identity.nextCheckpointId?.() ?? this.deps.identity.nextEventId()
    return { checkpointId }
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
}

function resolveAgent(resolver: AgentProfileResolver | undefined, name: string | undefined): AgentProfile | undefined {
  if (name === undefined) return undefined
  if (resolver === undefined) throw new Error("The current session agent directory is not configured; cannot switch agents")
  const agent = resolver.resolve(name)
  if (!agent) throw new Error(`Unknown session agent: ${name}`)
  return agent
}

function hasStartCommandAccepted(events: readonly AgentEvent[], commandId: string): boolean {
  return events.some(
    (event) => event.type === "CommandAccepted" && event.payload.family === "start_run" && event.payload.commandId === commandId,
  )
}

function startRunFingerprint(input: StartRunInput, canonicalizeWorkspace: ((root: string) => string) | undefined): StartRunFingerprint {
  const canonicalize = (root: string): string => canonicalizeWorkspace?.(root) ?? root
  return {
    goal: input.goal,
    model: input.model ?? null,
    initialMessages: [...(input.initialMessages ?? [])],
    context: [...(input.context ?? [])],
    fileReferences: [...(input.fileReferences ?? [])],
    workspace: canonicalize(input.workspace ?? "."),
    additionalDirectories: (input.additionalDirectories ?? []).map(canonicalize),
    // The fingerprint records what the INPUT specified, not the effective
    // session mode: unspecified (null) retries stay mode-era agnostic and
    // enforcement reads the canonical session mode. Retrying a commandId whose
    // CommandAccepted record carries an explicit mode with a different
    // explicit mode still fails loudly as an idempotency conflict.
    permissionMode: input.permissionMode ?? null,
    permissionRules: normalizeSessionPermissionRules(input.permissionRules ?? []),
    maxTurns: input.maxTurns ?? null,
    modelCallPurpose: input.modelCallPurpose ?? null,
  }
}

function legacyStartRunFingerprint(
  events: readonly AgentEvent[],
  anchor: Extract<AgentEvent, { type: "InputAccepted" }>,
): StartRunFingerprint {
  const created = events.find((event): event is Extract<AgentEvent, { type: "SessionCreated" }> => event.type === "SessionCreated")
  const started = events.find(
    (event): event is Extract<AgentEvent, { type: "RunStarted" }> =>
      event.type === "RunStarted" && event.payload.commandId === anchor.payload.commandId,
  )
  return {
    goal: anchor.payload.text,
    model: null,
    initialMessages: [],
    context: [...(anchor.payload.context ?? [])],
    fileReferences: [...(anchor.payload.fileReferences ?? [])],
    workspace: created?.payload.workspaceRoot ?? ".",
    additionalDirectories: [...(created?.payload.additionalDirectories ?? [])],
    // A legacy InputAccepted anchor cannot recover what the input specified;
    // reconstruct "unspecified" so internal wake runs and old-era retries
    // resume under the session's canonical mode instead of conflicting.
    permissionMode: null,
    permissionRules: [],
    maxTurns: started?.payload.maxTurns ?? null,
    modelCallPurpose: null,
    legacy: true,
  }
}

function stableFingerprintJson(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return candidate
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
      sorted[key] = (candidate as Record<string, unknown>)[key]
    }
    return sorted
  })
}

function validateInput(input: StartRunInput): void {
  if (input.commandId.trim().length === 0) throw new Error("commandId must not be empty")
  if (input.goal.trim().length === 0) throw new Error("goal must not be empty")
  if (input.maxTurns !== undefined && (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1)) {
    throw new Error("maxTurns must be a positive integer")
  }
  if (input.fileReferences?.some((path) => path.trim().length === 0)) {
    throw new Error("fileReferences must not contain empty paths")
  }
}

function countTurns(events: readonly AgentEvent[]): number {
  return events.reduce((max, event) => (event.type === "ModelAttemptStarted" ? Math.max(max, event.payload.turn) : max), 0)
}

function inputIdFor(commandId: string): string {
  return `input:${commandId}`
}

function cancellationStatus(state: ReturnType<typeof reduceCanonicalSession>, commandId: string): InputCancellationStatus {
  const status = state.commandReceipts.get(commandReceiptKey("cancel", commandId))?.status
  if (status === "already-delivered") return "already-delivered"
  if (status === "cancelled-before-acceptance") return "cancelled-before-acceptance"
  return "cancelled"
}

function nextModelAttemptId(events: readonly AgentEvent[], runId: RunId, turn: number): string {
  const used = new Set(
    events
      .filter((event): event is Extract<AgentEvent, { type: "ModelAttemptStarted" }> => event.type === "ModelAttemptStarted")
      .filter((event) => event.payload.runId === runId && event.payload.turn === turn)
      .map((event) => event.payload.attemptId),
  )
  let sequence = 1
  while (used.has(`${runId}:${turn}:attempt:${sequence}`)) sequence += 1
  return `${runId}:${turn}:attempt:${sequence}`
}

async function fingerprintModelRequest(request: CanonicalModelRequest): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(request))
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return nested
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(nested as Record<string, unknown>).sort()) sorted[key] = (nested as Record<string, unknown>)[key]
    return sorted
  })
}

function toolUsesFrom(content: readonly ContentBlock[]): Extract<ContentBlock, { type: "tool_use" }>[] {
  return content.filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use")
}

function toolResultMessage(
  results: readonly {
    tool_use_id: string
    content: string
    is_error?: boolean
  }[],
): Message {
  return {
    type: "user",
    message: {
      role: "user",
      content: results.map((result) => ({ type: "tool_result", ...result })),
    },
  }
}

function textFrom(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
}

function abortError(message = "Agent run was cancelled"): DOMException {
  return new DOMException(message, "AbortError")
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function replayRunTerminal(terminal: AgentEvent): RunResult {
  if (terminal.type === "RunCompleted") return completedResult(terminal.payload)
  if (terminal.type === "RunFailed") return failedResult(terminal.payload)
  if (terminal.type === "RunCancelled") return cancelledResult(terminal.payload)
  throw new Error(`start_run terminal event has an invalid type: ${terminal.type}`)
}

function completedResult(payload: Extract<AgentEvent, { type: "RunCompleted" }>["payload"]): RunResult {
  return {
    runId: payload.runId,
    status: "completed",
    turns: payload.turns,
    finalText: payload.finalText.trim().length > 0 ? payload.finalText : EMPTY_MODEL_RESPONSE_FALLBACK,
  }
}

function failedResult(payload: Extract<AgentEvent, { type: "RunFailed" }>["payload"]): RunResult {
  return {
    runId: payload.runId,
    status: "failed",
    turns: payload.turns,
    error: payload.message,
    ...(payload.code !== undefined ? { failureCode: payload.code } : {}),
  }
}

function cancelledResult(payload: Extract<AgentEvent, { type: "RunCancelled" }>["payload"]): RunResult {
  return {
    runId: payload.runId,
    status: "cancelled",
    turns: payload.turns,
    ...(payload.reason ? { error: payload.reason } : {}),
  }
}
