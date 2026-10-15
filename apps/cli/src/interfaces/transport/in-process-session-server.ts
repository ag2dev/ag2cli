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
import { CompactSessionUseCase } from "@ag2cli/runtime/application/session/compact-session.js"
import { UpdateSessionContextWindowUseCase } from "@ag2cli/runtime/application/session/context-window.js"
import { UpdateSessionGoalUseCase } from "@ag2cli/runtime/application/session/update-goal.js"
import { UpdateSessionAgentUseCase } from "@ag2cli/runtime/application/session/update-agent.js"
import { AddAdditionalDirectoryUseCase, type AdditionalDirectoryResolver } from "@ag2cli/runtime/application/session/workspace-roots.js"
import { UpdateSessionPermissionUseCase } from "@ag2cli/runtime/application/session/permission-state.js"
import { RewindSessionUseCase } from "@ag2cli/runtime/application/session/rewind-session.js"
import { BackgroundTaskRegistry } from "@ag2cli/runtime/application/task/task-registry.js"
import { BackgroundTaskManager } from "@ag2cli/runtime/application/task/background-task-manager.js"
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
import type { SessionCommand, SessionCommandResult } from "@ag2cli/protocol/session-command.js"
import type {
  SessionClient,
  SessionEventListener,
  SessionTransientEventListener,
  SessionExecuteOptions,
  SessionServer,
  SessionSubscriptionOptions,
} from "@ag2cli/client/session-client.js"
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
  /** The one per-host policy serial point; composition shares it for child tasks. */
  readonly policySerialPoint: PolicySerialPoint
  private readonly subscriptionHub = new SessionSubscriptionHub()
  private readonly commandCoordinator = new SessionCommandCoordinator()
  /** Composition may share this writer authority with its Session catalog. */
  readonly authority: SessionAuthority
  private readonly transientSequences = new Map<string, number>()
  private readonly transientSnapshots = new Map<string, TransientStreamEvent[]>()
  private readonly snapshots = new Map<string, StoredSessionSnapshot>()
  private readonly snapshotPending = new Map<string, Promise<void>>()
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
      onEventsAppended: (events) => this.publishEvents(events),
    })
    this.notificationUseCase = new EnqueueSessionNotificationUseCase({
      eventStore: deps.eventStore,
      authority: this.authority,
      identity: deps.identity,
      onEventsAppended: (events) => this.publishEvents(events),
    })
    this.taskManager = new BackgroundTaskManager(this.taskRegistry, deps.backgroundTaskExecutor, undefined, {
      ...(deps.execution?.executionReservation === undefined ? {} : { executionReservation: deps.execution.executionReservation }),
      ...(deps.execution?.reservationOwnerId === undefined ? {} : { reservationOwnerId: deps.execution.reservationOwnerId }),
    })
    this.useCase = new CreatePlanUseCase({
      ...deps,
      observability: this.observability,
      authority: this.authority,
      ...(deps.executionReservation === undefined ? {} : { executionReservation: deps.executionReservation }),
      ...(deps.reservationOwnerId === undefined ? {} : { reservationOwnerId: deps.reservationOwnerId }),
      onEventsAppended: (events) => this.publishEvents(events),
    })
    this.contextWindowUseCase = new UpdateSessionContextWindowUseCase({
      eventStore: deps.eventStore,
      authority: this.authority,
      identity: deps.identity,
      onEventsAppended: (events) => this.publishEvents(events),
    })
    this.goalUseCase = new UpdateSessionGoalUseCase({
      eventStore: deps.eventStore,
      authority: this.authority,
      identity: deps.identity,
      onEventsAppended: (events) => this.publishEvents(events),
    })
    this.agentUseCase = new UpdateSessionAgentUseCase({
      eventStore: deps.eventStore,
      authority: this.authority,
      agents: deps.agentProfiles,
      workspaceRoot: deps.workspaceRoot,
      identity: deps.identity,
      onEventsAppended: (events) => this.publishEvents(events),
    })
    // The canonical tool-turn judgment owns permission policy; the approval
    // broker below is only the interactive surface, passed through unwrapped.
    const approvalResolution = deps.execution
      ? new ApprovalResolutionService({
          eventStore: deps.eventStore,
          authority: this.authority,
          identity: deps.execution.identity,
          broker: deps.execution.approval,
          onEventsAppended: (events) => this.publishEvents(events),
        })
      : undefined
    const onSecurityEventsAppended = (events: readonly AgentEvent[]): void => {
      this.publishEvents(events)
      const securityChange = events.find(
        (event) =>
          event.type === "SessionPermissionModeSet" ||
          event.type === "SessionPermissionRulesSet" ||
          event.type === "SessionAdditionalDirectoryAdded",
      )
      if (securityChange !== undefined) {
        // Invalidate first so a pending ask can never resolve under the old
        // policy, then abort model attempts bound to the old revision; tool
        // processes keep running and commit their results normally.
        const broker = deps.execution?.approval
        if (broker !== undefined && isInvalidatingApprovalBroker(broker)) broker.invalidatePending(securityChange.sessionId)
        const guardianWaits = deps.execution?.guardianWaits
        if (guardianWaits !== undefined) guardianWaits.invalidate(securityChange.sessionId, securityChange.payload.policyRevision)
        this.runUseCase?.abortModelAttemptsForPolicyChange(securityChange.sessionId)
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
      onEventsAppended: (events) => this.publishEvents(events),
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
        onEventsAppended: (events) => this.publishEvents(events),
      })
    }
    if (deps.execution) {
      this.runUseCase = new RunAgentUseCase({
        ...deps.execution,
        ...policySerial,
        approval: deps.execution.approval,
        permissionSurfaces: deps.execution.permissionSurfaces,
        approvalResolution: approvalResolution!,
        eventStore: deps.eventStore,
        authority: this.authority,
        traceSink: this.traceSink,
        observability: this.observability,
        ...(deps.execution.executionReservation === undefined ? {} : { executionReservation: deps.execution.executionReservation }),
        ...(deps.execution.reservationOwnerId === undefined ? {} : { reservationOwnerId: deps.execution.reservationOwnerId }),
        onEventsAppended: (events) => this.publishEvents(events),
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
        onEventsAppended: (events) => this.publishEvents(events),
        onTransientEvent: (event) => this.publishTransientEvent(event),
      })
    }
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
    return this.commandCoordinator.execute(id, command, options, (nextId, nextCommand, nextOptions) =>
      this.commandRouter.execute(nextId, nextCommand, nextOptions),
    )
  }

  async close(): Promise<void> {
    this.commandCoordinator.clear()
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

  async recoverUnfinishedRuns(): Promise<void> {
    await this.runUseCase?.recoverUnfinishedRuns()
  }

  /**
   * Host-side notification seam (E1): appends one completion notification
   * as a pending canonical input the session's next run consumes. This is
   * a composition-only injection point for child-settle projections — not
   * a public protocol command, and it never starts a run by itself.
   */
  async enqueueHostNotification(sessionId: SessionId, text: string): Promise<EnqueueSessionNotificationResult> {
    return await this.notificationUseCase.execute({ sessionId, text })
  }

  subscribe(id: SessionId, afterRevision: number, listener: SessionEventListener, options?: SessionSubscriptionOptions): () => void {
    return this.subscriptionHub.subscribe(id, afterRevision, listener, options)
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

  private async publishEvents(events: readonly AgentEvent[]): Promise<void> {
    const id = events[0]?.sessionId
    if (!id) return
    await this.advanceSnapshot(events)
    emitEventsToTelemetry(this.deps.telemetry, this.observability, events)
    this.clearCompletedTransient(events)
    this.subscriptionHub.publishDurable(events)
  }

  /** Advance the in-memory and durable read model without affecting the write outcome. */
  private async advanceSnapshot(events: readonly AgentEvent[]): Promise<void> {
    const first = events[0]
    if (!first) return
    const key = first.sessionId.toString()
    const previous = this.snapshotPending.get(key) ?? Promise.resolve()
    const operation = previous.then(() => this.advanceSnapshotNow(events))
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    )
    this.snapshotPending.set(key, tracked)
    try {
      await operation
    } finally {
      if (this.snapshotPending.get(key) === tracked) this.snapshotPending.delete(key)
    }
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
    return this.server.subscribe(this.id, afterRevision, listener, options)
  }

  subscribeTransient(listener: SessionTransientEventListener): () => void {
    return this.server.subscribeTransient(this.id, listener)
  }
}
