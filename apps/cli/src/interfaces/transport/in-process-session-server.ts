import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import { emitEventsToTelemetry } from "../../infrastructure/observability/telemetry/event-telemetry.js"
import { sessionId, type SessionId } from "@ag2cli/core/ids.js"
import type { PlanProvider } from "@ag2cli/runtime/ports/model-provider.js"
import type { EventStore } from "@ag2cli/runtime/ports/event-store.js"
import { safeTraceStore, type TraceStore } from "@ag2cli/runtime/ports/trace-sink.js"
import { loadObservabilityPolicy, type ObservabilityPolicy } from "@ag2cli/runtime/ports/observability.js"
import type { TelemetrySink } from "@ag2cli/runtime/ports/telemetry.js"
import type { PlanEventIdentity } from "@ag2cli/runtime/application/plan/create-plan.js"
import { CreatePlanUseCase } from "@ag2cli/runtime/application/plan/create-plan.js"
import { RunAgentUseCase } from "@ag2cli/runtime/application/execution/run-agent.js"
import { createInProcessPolicySerialPoint } from "@ag2cli/runtime/application/execution/policy-serial-point.js"
import type { PolicySerialPoint } from "@ag2cli/runtime/ports/policy-serial-point.js"
import type { PermissionSurfaces } from "@ag2cli/runtime/application/execution/permission-judgment.js"
import { ExecuteShellUseCase } from "@ag2cli/runtime/application/execution/execute-shell.js"
import { ApprovalResolutionService } from "@ag2cli/runtime/application/session/approval-resolution.js"
import { AskResolutionService } from "@ag2cli/runtime/application/session/ask-resolution.js"
import { AskExpirySweepUseCase } from "@ag2cli/runtime/application/session/ask-expiry-sweep.js"
import { CompactSessionUseCase } from "@ag2cli/runtime/application/session/compact-session.js"
import { UpdateSessionContextWindowUseCase } from "@ag2cli/runtime/application/session/context-window.js"
import { UpdateSessionGoalUseCase } from "@ag2cli/runtime/application/session/update-goal.js"
import { UpdateSessionAgentUseCase } from "@ag2cli/runtime/application/session/update-agent.js"
import { AddAdditionalDirectoryUseCase, type AdditionalDirectoryResolver } from "@ag2cli/runtime/application/session/workspace-roots.js"
import { UpdateSessionPermissionUseCase } from "@ag2cli/runtime/application/session/permission-state.js"
import { RewindSessionUseCase } from "@ag2cli/runtime/application/session/rewind-session.js"
import { BackgroundTaskRegistry } from "@ag2cli/runtime/application/task/task-registry.js"
import { BackgroundTaskManager } from "@ag2cli/runtime/application/task/background-task-manager.js"
import { ShellBackgroundTaskExecutor } from "@ag2cli/runtime/application/task/shell-task-executor.js"
import { cancelOrphanedAgentTasks } from "@ag2cli/runtime/application/task/orphaned-task-recovery.js"
import { OrderedLane } from "@ag2cli/runtime/concurrency/ordered-lane.js"
import { SingleFlight } from "@ag2cli/runtime/concurrency/single-flight.js"
import {
  EnqueueSessionNotificationUseCase,
  type EnqueueSessionNotificationResult,
} from "@ag2cli/runtime/application/session/enqueue-notification.js"
import type { ExecutionIdentity } from "@ag2cli/runtime/application/execution/run-agent.js"
import type { ExecutionModelProvider } from "@ag2cli/runtime/ports/execution-model-provider.js"
import type { BackgroundTaskExecutor } from "@ag2cli/runtime/ports/background-task-executor.js"
import type { AgentProfileResolver } from "@ag2cli/runtime/ports/agent-profile.js"
import type { ToolExecutor } from "@ag2cli/runtime/ports/tool-executor.js"
import type { ApprovalBroker } from "@ag2cli/runtime/ports/approval-broker.js"
import type { AskBroker } from "@ag2cli/runtime/ports/ask-broker.js"
import { isInvalidatingApprovalBroker } from "@ag2cli/runtime/ports/approval-broker.js"
import type { Guardian, GuardianWaitRegistry } from "@ag2cli/runtime/ports/guardian.js"
import type { SessionCatalog } from "@ag2cli/runtime/ports/session-catalog.js"
import type { ContextBuilder } from "@ag2cli/runtime/ports/context-builder.js"
import type { ContextCompactor } from "@ag2cli/runtime/ports/context-compactor.js"
import type { SessionExecutionReservation } from "@ag2cli/runtime/ports/session-execution-reservation.js"
import type { BashSecurityPort } from "@ag2cli/runtime/ports/security.js"
import type { RuntimeEnvironment } from "@ag2cli/runtime/ports/environment.js"
import type { WorkspacePolicyFactory, WorkspaceScopeDigest } from "@ag2cli/runtime/ports/workspace.js"
import { applySessionEvent, emptySessionSnapshot, replaySession, type SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import type { SessionSnapshotStore, StoredSessionSnapshot } from "@ag2cli/runtime/ports/session-snapshot-store.js"
import type { SessionCommand, SessionCommandResult } from "@ag2cli/session-protocol/session-command.js"
import type {
  SessionClient,
  SessionEventListener,
  SessionTransientEventListener,
  SessionExecuteOptions,
  SessionServer,
  SessionSubscriptionHandle,
  SessionSubscriptionOptions,
} from "@ag2cli/session-client/session-client.js"
import { SessionCommandRouter } from "./session-command-router.js"
import { SessionSubscriptionHub } from "@ag2cli/runtime/application/session/session-subscription.js"
import { SessionCommandCoordinator } from "@ag2cli/runtime/application/session/session-coordinator.js"
import { SessionAuthority } from "@ag2cli/runtime/application/session/session-authority.js"

export interface SessionServerDependencies {
  readonly provider: PlanProvider
  readonly eventStore: EventStore
  readonly workspaceRootCanonicalizer?: (root: string) => string
  readonly workspaceScopeDigest?: WorkspaceScopeDigest
  readonly workspacePolicyFactory?: WorkspacePolicyFactory
  readonly environment?: RuntimeEnvironment
  readonly bashSecurity?: BashSecurityPort
  /** Optional derived read model; the event store remains authoritative. */
  readonly snapshotStore?: SessionSnapshotStore
  readonly identity: PlanEventIdentity
  readonly traceSink?: TraceStore
  readonly observability?: ObservabilityPolicy
  /** Default agentic turn cap resolved by the composition boundary. */
  readonly defaultMaxTurns?: number
  readonly telemetry?: TelemetrySink
  readonly backgroundTaskExecutor?: BackgroundTaskExecutor
  readonly agentProfiles?: AgentProfileResolver
  /** Canonical workspace used for pre-run Session state creation. */
  readonly workspaceRoot?: string
  /** Cross-process guard for local durable plan execution. */
  readonly executionReservation?: SessionExecutionReservation
  readonly reservationOwnerId?: string
  readonly execution?: {
    readonly model: ExecutionModelProvider
    readonly tools: ToolExecutor
    readonly shellTools?: ToolExecutor
    readonly approval: ApprovalBroker
    /**
     * Durable ask_user surface. Present only on hosts whose clients answer
     * remotely (serve); a host with a local interactive surface keeps its
     * askUser callback and must not inject a broker.
     */
    readonly ask?: AskBroker
    readonly contextBuilder?: ContextBuilder
    readonly agentProfiles?: AgentProfileResolver
    readonly compactor?: ContextCompactor
    readonly fileContextLoader?: import("@ag2cli/runtime/ports/context-builder.js").ContextAttachmentLoader
    readonly workspaceRootCanonicalizer?: (root: string) => string
    readonly workspaceScopeDigest?: WorkspaceScopeDigest
    readonly workspacePolicyFactory?: WorkspacePolicyFactory
    readonly environment?: RuntimeEnvironment
    readonly bashSecurity?: BashSecurityPort
    readonly identity: ExecutionIdentity
    readonly executionReservation?: SessionExecutionReservation
    readonly reservationOwnerId?: string
    /** Interactive surfaces for permission judgment; every direct composition states them. */
    readonly permissionSurfaces: PermissionSurfaces
    /** Answers auto-mode permission asks; absent keeps every auto ask terminal. */
    readonly guardian?: Guardian
    /** Whole-review deadline override for auto-mode asks; absent keeps the runtime default. */
    readonly guardianDeadlineMs?: number
    /** Aborts in-flight guardian reviews when session security changes. */
    readonly guardianWaits?: GuardianWaitRegistry
  }
  readonly catalog?: SessionCatalog
  /** Shared authority for catalog and runtime writes in one storage scope. */
  readonly authority?: SessionAuthority
  /** Optional server-side workspace scope adapter used by `/add-dir`. */
  readonly additionalDirectoryResolver?: AdditionalDirectoryResolver
  /**
   * Security-change fan-out for composition-owned listeners: called with the
   * session and post-change policy revision after the server's own
   * invalidations, so derived registries (live child agents) settle stale.
   */
  readonly onSecurityChange?: (sessionId: SessionId, policyRevision: number) => void
  readonly close?: () => Promise<void>
}

const MAX_SNAPSHOT_CACHE_ENTRIES = 128
const MAX_TRANSIENT_SNAPSHOT_EVENTS = 512

/**
 * Server-authoritative in-process transport. All session writes go through
 * this object; clients only send commands and receive snapshots/events.
 */
export class InProcessSessionServer implements SessionServer {
  readonly catalog?: SessionCatalog
  private readonly useCase: CreatePlanUseCase
  private readonly runUseCase?: RunAgentUseCase
  private readonly shellUseCase?: ExecuteShellUseCase
  private readonly compactUseCase?: CompactSessionUseCase
  private readonly contextWindowUseCase: UpdateSessionContextWindowUseCase
  private readonly goalUseCase: UpdateSessionGoalUseCase
  private readonly agentUseCase: UpdateSessionAgentUseCase
  private readonly addAdditionalDirectoryUseCase?: AddAdditionalDirectoryUseCase
  private readonly permissionUseCase: UpdateSessionPermissionUseCase
  private readonly rewindUseCase?: RewindSessionUseCase
  /** Durable task transitions; composition reads it for child-settle records. */
  readonly taskRegistry: BackgroundTaskRegistry
  private readonly taskManager: BackgroundTaskManager
  /** Host-side notification seam; appends pending canonical inputs. */
  private readonly notificationUseCase: EnqueueSessionNotificationUseCase
  /** First-serve convergence for asks left dangling by an ended run. */
  private readonly askExpirySweep?: AskExpirySweepUseCase
  /** Single-flight per session: the first touch converges, later touches join it. */
  private readonly convergences = new SingleFlight<string>()
  /** The one per-host policy serial point; composition shares it for child tasks. */
  readonly policySerialPoint: PolicySerialPoint
  private readonly subscriptionHub = new SessionSubscriptionHub()
  private readonly commandCoordinator = new SessionCommandCoordinator()
  /** Composition may share this writer authority with its Session catalog. */
  readonly authority: SessionAuthority
  private readonly transientSequences = new Map<string, number>()
  private readonly transientSnapshots = new Map<string, TransientStreamEvent[]>()
  private readonly snapshots = new Map<string, StoredSessionSnapshot>()
  private readonly snapshotPending = new OrderedLane<string>()
  private readonly observability: ObservabilityPolicy
  private readonly traceSink?: TraceStore
  private readonly commandRouter: SessionCommandRouter

  constructor(private readonly deps: SessionServerDependencies) {
    this.catalog = deps.catalog
    this.authority = deps.authority ?? new SessionAuthority(deps.eventStore)
    this.observability = deps.observability ?? loadObservabilityPolicy()
    this.traceSink = safeTraceStore(deps.traceSink)
    this.taskRegistry = new BackgroundTaskRegistry({
      eventStore: deps.eventStore,
      authority: this.authority,
      identity: deps.identity,
      onEventsAppended: (events, replayed) => this.publishEvents(events, replayed),
    })
    this.notificationUseCase = new EnqueueSessionNotificationUseCase({
      eventStore: deps.eventStore,
      authority: this.authority,
      identity: deps.identity,
      onEventsAppended: (events, replayed) => this.publishEvents(events, replayed),
    })
    this.useCase = new CreatePlanUseCase({
      ...deps,
      observability: this.observability,
      authority: this.authority,
      ...(deps.executionReservation === undefined ? {} : { executionReservation: deps.executionReservation }),
      ...(deps.reservationOwnerId === undefined ? {} : { reservationOwnerId: deps.reservationOwnerId }),
      onEventsAppended: (events, replayed) => this.publishEvents(events, replayed),
    })
    this.contextWindowUseCase = new UpdateSessionContextWindowUseCase({
      eventStore: deps.eventStore,
      authority: this.authority,
      identity: deps.identity,
      onEventsAppended: (events, replayed) => this.publishEvents(events, replayed),
    })
    this.goalUseCase = new UpdateSessionGoalUseCase({
      eventStore: deps.eventStore,
      authority: this.authority,
      identity: deps.identity,
      onEventsAppended: (events, replayed) => this.publishEvents(events, replayed),
    })
    this.agentUseCase = new UpdateSessionAgentUseCase({
      eventStore: deps.eventStore,
      authority: this.authority,
      agents: deps.agentProfiles,
      workspaceRoot: deps.workspaceRoot,
      identity: deps.identity,
      onEventsAppended: (events, replayed) => this.publishEvents(events, replayed),
    })
    // The canonical tool-turn judgment owns permission policy; the approval
    // broker below is only the interactive surface, passed through unwrapped.
    const approvalResolution = deps.execution
      ? new ApprovalResolutionService({
          eventStore: deps.eventStore,
          authority: this.authority,
          identity: deps.execution.identity,
          broker: deps.execution.approval,
          onEventsAppended: (events, replayed) => this.publishEvents(events, replayed),
        })
      : undefined
    // A broker injected without an execution layer has no executor to wake,
    // so the ask surface follows the execution half; a host without one keeps
    // every ask on its local askUser callback and refuses remote resolution.
    const askResolution =
      deps.execution?.ask === undefined
        ? undefined
        : new AskResolutionService({
            eventStore: deps.eventStore,
            authority: this.authority,
            identity: deps.execution.identity,
            broker: deps.execution.ask,
            onEventsAppended: (events, replayed) => this.publishEvents(events, replayed),
          })
    if (askResolution !== undefined) {
      this.askExpirySweep = new AskExpirySweepUseCase({ eventStore: deps.eventStore, sweeper: askResolution })
    }
    const onSecurityEventsAppended = (events: readonly AgentEvent[], replayed: boolean): void => {
      this.publishEvents(events, replayed)
      const securityChange = events.find(
        (event) =>
          event.type === "SessionPermissionModeSet" ||
          event.type === "SessionPermissionRulesSet" ||
          event.type === "SessionAdditionalDirectoryAdded",
      )
      if (securityChange !== undefined) {
        // Invalidate pending interactions before they can resolve under the
        // old policy. In-flight model calls may finish, but every resulting
        // tool call is judged against the latest canonical security state.
        const broker = deps.execution?.approval
        if (broker !== undefined && isInvalidatingApprovalBroker(broker)) broker.invalidatePending(securityChange.sessionId)
        const guardianWaits = deps.execution?.guardianWaits
        if (guardianWaits !== undefined) guardianWaits.invalidate(securityChange.sessionId, securityChange.payload.policyRevision)
        deps.onSecurityChange?.(securityChange.sessionId, securityChange.payload.policyRevision)
      }
    }
    // One policy serial point per host: permission commits, tool dispatch,
    // and bash spawns serialize on it for every session this server owns.
    const policySerial = createInProcessPolicySerialPoint(deps.eventStore)
    this.policySerialPoint = policySerial.serialPoint
    this.permissionUseCase = new UpdateSessionPermissionUseCase({
      eventStore: deps.eventStore,
      authority: this.authority,
      identity: deps.identity,
      serialPoint: policySerial.serialPoint,
      onEventsAppended: onSecurityEventsAppended,
    })
    if (deps.additionalDirectoryResolver) {
      this.addAdditionalDirectoryUseCase = new AddAdditionalDirectoryUseCase({
        eventStore: deps.eventStore,
        authority: this.authority,
        identity: deps.identity,
        resolver: deps.additionalDirectoryResolver,
        workspaceScopeDigest: deps.workspaceScopeDigest ?? (() => ""),
        serialPoint: policySerial.serialPoint,
        onEventsAppended: onSecurityEventsAppended,
      })
    }
    this.rewindUseCase = new RewindSessionUseCase({
      eventStore: deps.eventStore,
      authority: this.authority,
      identity: deps.identity,
      ...(deps.execution?.executionReservation === undefined ? {} : { executionReservation: deps.execution.executionReservation }),
      ...(deps.execution?.reservationOwnerId === undefined ? {} : { reservationOwnerId: deps.execution.reservationOwnerId }),
      onEventsAppended: (events, replayed) => this.publishEvents(events, replayed),
    })
    if (deps.execution?.compactor) {
      this.compactUseCase = new CompactSessionUseCase({
        eventStore: deps.eventStore,
        authority: this.authority,
        compactor: deps.execution.compactor,
        identity: deps.execution.identity,
        observability: this.observability,
        ...(deps.execution?.executionReservation === undefined ? {} : { executionReservation: deps.execution.executionReservation }),
        ...(deps.execution?.reservationOwnerId === undefined ? {} : { reservationOwnerId: deps.execution.reservationOwnerId }),
        onEventsAppended: (events, replayed) => this.publishEvents(events, replayed),
      })
    }
    if (deps.execution) {
      this.runUseCase = new RunAgentUseCase({
        ...deps.execution,
        ...policySerial,
        approval: deps.execution.approval,
        permissionSurfaces: deps.execution.permissionSurfaces,
        approvalResolution: approvalResolution!,
        ...(askResolution === undefined ? {} : { askResolution }),
        eventStore: deps.eventStore,
        authority: this.authority,
        traceSink: this.traceSink,
        observability: this.observability,
        ...(deps.execution.executionReservation === undefined ? {} : { executionReservation: deps.execution.executionReservation }),
        ...(deps.execution.reservationOwnerId === undefined ? {} : { reservationOwnerId: deps.execution.reservationOwnerId }),
        onEventsAppended: (events, replayed) => this.publishEvents(events, replayed),
        onTransientEvent: (event) => this.publishTransientEvent(event),
      })
      this.shellUseCase = new ExecuteShellUseCase({
        ...deps.execution,
        preSpawnGateFor: policySerial.preSpawnGateFor,
        approval: deps.execution.approval,
        approvalResolution: approvalResolution!,
        eventStore: deps.eventStore,
        authority: this.authority,
        traceSink: this.traceSink,
        onEventsAppended: (events, replayed) => this.publishEvents(events, replayed),
        onTransientEvent: (event) => this.publishTransientEvent(event),
      })
    }
    // The shell use case already serializes per session and fences its own
    // execution reservation; wrapping it in the manager's coordination
    // reservation would self-conflict the session's single writer, so the
    // shell fallback executor runs uncoordinated. An assembly-injected
    // executor keeps full coordination.
    this.taskManager = new BackgroundTaskManager(
      this.taskRegistry,
      deps.backgroundTaskExecutor ?? (this.shellUseCase === undefined ? undefined : new ShellBackgroundTaskExecutor(this.shellUseCase)),
      undefined,
      deps.backgroundTaskExecutor === undefined
        ? undefined
        : {
            ...(deps.execution?.executionReservation === undefined ? {} : { executionReservation: deps.execution.executionReservation }),
            ...(deps.execution?.reservationOwnerId === undefined ? {} : { reservationOwnerId: deps.execution.reservationOwnerId }),
          },
    )
    this.commandRouter = new SessionCommandRouter({
      eventStore: deps.eventStore,
      catalog: deps.catalog,
      createPlan: this.useCase,
      addAdditionalDirectory: this.addAdditionalDirectoryUseCase,
      permission: this.permissionUseCase,
      rewind: this.rewindUseCase,
      run: this.runUseCase,
      shell: this.shellUseCase,
      compact: this.compactUseCase,
      contextWindow: this.contextWindowUseCase,
      goal: this.goalUseCase,
      agent: this.agentUseCase,
      taskManager: this.taskManager,
      approvalResolution,
      ...(askResolution === undefined ? {} : { askResolution }),
      traceSink: this.traceSink,
      observability: this.observability,
      defaultMaxTurns: deps.defaultMaxTurns,
      snapshotFor: (id) => this.snapshotFor(id),
    })
  }

  connect(value: string): SessionClient {
    const id = sessionId(value)
    return new InProcessSessionClient(this, id)
  }

  async execute(id: SessionId, command: SessionCommand, options?: SessionExecuteOptions): Promise<SessionCommandResult> {
    // Convergence sits ahead of dispatch so a read never observes the
    // pre-convergence stream and a write never races the recovered loop.
    await this.convergenceFor(id)
    return this.commandCoordinator.execute(id, command, options, (nextId, nextCommand, nextOptions) =>
      this.commandRouter.execute(nextId, nextCommand, nextOptions),
    )
  }

  async close(): Promise<void> {
    await this.authority.close()
    this.subscriptionHub.close()
    this.transientSnapshots.clear()
    this.taskManager.close()
    // Host/process shutdown is not a Session terminal transition. In
    // particular, two local Hosts may observe the same Session and close at
    // different times; firing SessionEnd here would duplicate the terminal
    // event emitted by the run/session state machine itself.
    try {
      await this.deps.telemetry?.flush?.()
      await this.deps.telemetry?.shutdown?.()
    } catch {
      // Exporter shutdown is best effort and must not mask the server close.
    }
    await this.deps.close?.()
  }

  /**
   * Single-flight convergence for one session's restart residue. The first
   * touch creates the body; concurrent touches join the in-flight promise.
   * A resolved body stays so convergence runs once per session per server;
   * a rejected body deletes its entry so the next touch retries.
   */
  private convergenceFor(id: SessionId): Promise<void> {
    return this.convergences.join(id.toString(), () => this.convergeSession(id))
  }

  /**
   * Settle what a dead process left on the canonical stream: cancel
   * orphaned agent tasks, expire asks whose runs already ended, then
   * schedule the interrupted run's resume. Cancels run first so the scan
   * cannot reap tasks the recovered run spawns live; the resume itself is
   * fire-and-forget and the stream stays the only user-visible state.
   * Read-only hosts (no execution layer) never converge.
   */
  private async convergeSession(id: SessionId): Promise<void> {
    if (this.runUseCase === undefined) return
    await cancelOrphanedAgentTasks({ registry: this.taskRegistry, sessionId: id, serialPoint: this.policySerialPoint })
    await this.askExpirySweep?.execute(id)
    await this.runUseCase.recoverSessionRuns(id)
  }

  /**
   * Host-side notification seam (E1): appends one completion notification
   * as a pending canonical input the session's next run consumes. This is
   * a composition-only injection point for child-settle projections — not
   * a public protocol command, and it never starts a run by itself.
   */
  async enqueueHostNotification(id: SessionId, text: string): Promise<EnqueueSessionNotificationResult> {
    return await this.notificationUseCase.execute({ sessionId: id, text })
  }

  subscribe(
    id: SessionId,
    afterRevision: number,
    listener: SessionEventListener,
    options?: SessionSubscriptionOptions,
  ): SessionSubscriptionHandle {
    // The listener is installed before the kick so it observes the
    // convergence events; the kick is never awaited and its failure is
    // retried by the next command touch.
    const unsubscribe = this.subscriptionHub.subscribe(id, afterRevision, listener, options)
    void this.convergenceFor(id).catch(() => {})
    return { unsubscribe, installed: Promise.resolve() }
  }

  subscribeTransient(id: SessionId, listener: SessionTransientEventListener): () => void {
    return this.subscriptionHub.subscribeTransient(id, listener)
  }

  /** Return the bounded live projection retained while this Host is alive. */
  readTransient(id: SessionId): readonly TransientStreamEvent[] {
    return [...(this.transientSnapshots.get(id.toString()) ?? [])]
  }

  private async snapshotFor(id: SessionId) {
    const cached = this.snapshots.get(id.toString())
    if (cached) {
      this.touchSnapshot(id.toString())
      return cached.snapshot
    }

    const events = await this.deps.eventStore.read(id)
    if (events.length === 0) return emptySessionSnapshot(id)

    let persisted: StoredSessionSnapshot | undefined
    try {
      persisted = await this.deps.snapshotStore?.read(id)
    } catch {
      // A derived snapshot read failure must fall back to canonical events.
      persisted = undefined
    }
    let snapshot: SessionSnapshot
    if (
      persisted !== undefined &&
      persisted.snapshot.sessionId === id &&
      persisted.snapshot.lastRevision <= events.length &&
      events[persisted.snapshot.lastRevision - 1]?.eventId === persisted.lastEventId
    ) {
      snapshot = events.slice(persisted.snapshot.lastRevision).reduce(applySessionEvent, persisted.snapshot)
    } else {
      snapshot = replaySession(events)
    }
    const current = { snapshot, lastEventId: events.at(-1)!.eventId }
    this.cacheSnapshot(id.toString(), current)
    if (
      persisted === undefined ||
      persisted.lastEventId !== current.lastEventId ||
      persisted.snapshot.lastRevision !== current.snapshot.lastRevision
    ) {
      await this.persistSnapshot(current, persisted?.snapshot.lastRevision ?? 0)
    }
    return snapshot
  }

  private async publishEvents(events: readonly AgentEvent[], replayed = false): Promise<void> {
    const id = events[0]?.sessionId
    if (!id) return
    await this.advanceSnapshot(events)
    // Replay delivery is at-least-once; only telemetry counting must skip it.
    if (!replayed) emitEventsToTelemetry(this.deps.telemetry, this.observability, events)
    this.clearCompletedTransient(events)
    this.subscriptionHub.publishDurable(events)
  }

  /** Advance the in-memory and durable read model without affecting the write outcome. */
  private advanceSnapshot(events: readonly AgentEvent[]): Promise<void> {
    const first = events[0]
    if (!first) return Promise.resolve()
    return this.snapshotPending.run(first.sessionId.toString(), () => this.advanceSnapshotNow(events))
  }

  private async advanceSnapshotNow(events: readonly AgentEvent[]): Promise<void> {
    const first = events[0]
    if (!first) return
    const key = first.sessionId.toString()
    try {
      const cached = this.snapshots.get(key)
      let snapshot: SessionSnapshot
      const invalidatesProjection = events.some((event) => event.type === "HeadMoved")
      if (!invalidatesProjection && cached && first.revision === cached.snapshot.lastRevision + 1) {
        snapshot = events.reduce(applySessionEvent, cached.snapshot)
      } else {
        const all = await this.deps.eventStore.read(first.sessionId)
        if (all.length === 0) return
        snapshot = replaySession(all)
      }
      let lastEventId = events.at(-1)?.eventId
      if (!lastEventId) {
        const all = await this.deps.eventStore.read(first.sessionId)
        const lastEvent = all.at(-1)
        if (!lastEvent) return
        lastEventId = lastEvent.eventId
      }
      const current = { snapshot, lastEventId }
      this.cacheSnapshot(key, current)
      await this.persistSnapshot(current, cached?.snapshot.lastRevision ?? 0)
    } catch {
      // The durable event append has already succeeded. A derived snapshot can
      // be rebuilt on the next read and must never fail the command.
      this.snapshots.delete(key)
    }
  }

  private async persistSnapshot(value: StoredSessionSnapshot, expectedRevision = 0): Promise<void> {
    try {
      const store = this.deps.snapshotStore
      if (store?.writeIfRevision !== undefined) {
        await store.writeIfRevision(value, expectedRevision)
      } else {
        await store?.write(value)
      }
    } catch {
      // Snapshot persistence is an optimization; event durability is not.
    }
  }

  private cacheSnapshot(key: string, value: StoredSessionSnapshot): void {
    this.snapshots.delete(key)
    this.snapshots.set(key, value)
    while (this.snapshots.size > MAX_SNAPSHOT_CACHE_ENTRIES) {
      const oldest = this.snapshots.keys().next().value
      if (oldest === undefined) break
      this.snapshots.delete(oldest)
    }
  }

  private touchSnapshot(key: string): void {
    const value = this.snapshots.get(key)
    if (value) this.cacheSnapshot(key, value)
  }

  /**
   * Composition-internal transient seam: publishes onto the session's live
   * stream (sequence normalization, bounded snapshot, fan-out). Used by
   * use-case wiring and by the child-agent bridge for attributed events.
   */
  publishTransientEvent(event: TransientStreamEvent): void {
    const sessionKey = event.sessionId.toString()
    const sequence = (this.transientSequences.get(sessionKey) ?? 0) + 1
    this.transientSequences.set(sessionKey, sequence)
    const normalized = sequence === event.sequence ? event : { ...event, sequence }
    const snapshot = this.transientSnapshots.get(sessionKey) ?? []
    this.transientSnapshots.set(sessionKey, [...snapshot, normalized].slice(-MAX_TRANSIENT_SNAPSHOT_EVENTS))
    this.subscriptionHub.publishTransient(normalized)
  }

  private clearCompletedTransient(events: readonly AgentEvent[]): void {
    const terminalRuns = new Set(
      events.flatMap((event) =>
        event.type === "RunCompleted" || event.type === "RunFailed" || event.type === "RunCancelled"
          ? [event.payload.runId.toString()]
          : [],
      ),
    )
    if (terminalRuns.size === 0) return
    const sessionKey = events[0]?.sessionId.toString()
    if (sessionKey === undefined) return
    const current = this.transientSnapshots.get(sessionKey)
    if (current === undefined) return
    // Run-scoped kinds clear with their run.
    const remaining = current.filter((event) => !("runId" in event.payload && terminalRuns.has(event.payload.runId.toString())))
    if (remaining.length === 0) this.transientSnapshots.delete(sessionKey)
    else this.transientSnapshots.set(sessionKey, remaining)
  }
}

class InProcessSessionClient implements SessionClient {
  readonly sessionId: string

  constructor(
    private readonly server: InProcessSessionServer,
    private readonly id: SessionId,
  ) {
    this.sessionId = id
  }

  execute(command: SessionCommand, options?: SessionExecuteOptions): Promise<SessionCommandResult> {
    return this.server.execute(this.id, command, options)
  }

  subscribe(afterRevision: number, listener: SessionEventListener, options?: SessionSubscriptionOptions): () => void {
    const handle = this.server.subscribe(this.id, afterRevision, listener, options)
    return () => handle.unsubscribe()
  }

  subscribeTransient(listener: SessionTransientEventListener): () => void {
    return this.server.subscribeTransient(this.id, listener)
  }
}
