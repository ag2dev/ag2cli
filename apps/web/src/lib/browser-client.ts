import type {
  AppServerInteractionLease,
  InteractionLeaseScope,
  ServerInitializeResult,
  SessionResolveInteractionParams,
  WorkspaceDiffChange,
  WorkspaceReadFileResult,
} from "@ag2cli/app-server-protocol/types.js"
import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type {
  PublicAskUserAnswer,
  PublicAskUserInteraction,
  PublicPendingInteraction,
  PublicToolApprovalInteraction,
} from "@ag2cli/app-server-protocol/dto/interactions.js"
import type { PublicPresenceClient } from "@ag2cli/app-server-protocol/dto/presence.js"
import type { PublicPermissionPolicy } from "@ag2cli/app-server-protocol/dto/policy.js"
import type {
  PublicInputSnapshot,
  PublicPermissionModeValue,
  PublicPlanSummary,
  PublicSessionSnapshot,
} from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type { PublicTransientEvent } from "@ag2cli/app-server-protocol/dto/transient.js"
import type { SessionResyncRequiredNotificationParams } from "@ag2cli/app-server-protocol/dto/notifications.js"
import { AppServerRpcError } from "@ag2cli/app-server-client/client.js"
import { callProtocol } from "@ag2cli/app-server-client/protocol-methods.js"
import { classifyAppServerNotification } from "@ag2cli/app-server-client/notifications.js"
import { LiveTransientStore } from "@ag2cli/app-server-client/live-transient-store.js"
import {
  attachBrowserSession,
  attachLiveBrowserSession,
  connectBrowserAppServer,
  createBrowserSession,
  deleteBrowserSession,
  detachBrowserSession,
  listBrowserSessions,
  replayBrowserSession,
  resyncBrowserSession,
  ReplayContinuationError,
  serverWorkspaces,
  type BrowserAppServerConnection,
  type BrowserSessionRecord,
  type BrowserWorkspace,
} from "./app-server"
import { mergeWireEvents } from "./conversation"
import {
  BrowserInteractionLeaseController,
  BrowserInteractionLeaseUnavailableError,
  type BrowserInteractionLeaseUpdate,
} from "./interaction"
import {
  applyInteractionEvents,
  applyPlanEvents,
  applyQueueEvents,
  applySecurityEvents,
  applyTaskEvents,
  seedPendingInteractions,
  seedPlans,
  seedQueuedInputs,
  seedSessionSecurity,
  seedShellTasks,
  type BrowserShellTask,
  type SessionSecurity,
} from "./session-mirrors"
import type { SessionGetTaskLogsResult } from "@ag2cli/app-server-protocol/dto/task-methods.js"

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting"

export interface BrowserLeaseView {
  readonly lease: AppServerInteractionLease
  readonly heldBySelf: boolean
}

/** Lease mirror for the active session; the lease controller is the single
 * source of truth — presence broadcasts and lease notifications both feed it. */
export type BrowserLeases = { readonly [scope in InteractionLeaseScope]: BrowserLeaseView }

/** Workspace change browsing (ruling G): the diff list is the file selector;
 * a snapshotToken mismatch triggers a full refetch, never a splice. */
export interface BrowserWorkspaceDiff {
  readonly loading: boolean
  readonly changes: readonly WorkspaceDiffChange[]
  readonly nextCursor?: string
  readonly error?: string
}

/** One open file viewer fed from a diff entry; line windows continue under
 * the expectedDigest guard and a changed file restarts from line one. */
export interface BrowserWorkspaceFileView {
  readonly path: string
  readonly loading: boolean
  readonly kind?: "text" | "binary"
  readonly content?: string
  readonly startLine?: number
  readonly totalLines?: number
  readonly nextStartLine?: number
  readonly sizeBytes?: number
  readonly digest?: string
  readonly error?: string
}

export interface BrowserClientState {
  readonly status: ConnectionStatus
  readonly endpoint: string
  readonly clientId: string
  readonly error?: string
  readonly initialize?: ServerInitializeResult
  readonly workspaces: readonly BrowserWorkspace[]
  readonly sessions: readonly BrowserSessionRecord[]
  readonly selectedWorkspaceId?: string
  readonly activeSessionId?: string
  readonly loadingSession: boolean
  readonly sending: boolean
  /** Barrier-aligned attach snapshot; the first frame before replay events land. */
  readonly snapshot?: PublicSessionSnapshot
  readonly events: readonly PublicSessionEvent[]
  readonly transientEvents: readonly PublicTransientEvent[]
  readonly presence: readonly PublicPresenceClient[]
  /** Per-scope lease view for the active session; holder identity is limited
   * to clientId/clientKind/name on the wire. */
  readonly leases?: BrowserLeases
  readonly pendingCommands: readonly string[]
  /** FIFO queue mirror (ruling B): seeded from snapshot.inputs, parked by
   * input.accepted, drained by input.updated/input.failed. */
  readonly queuedInputs: readonly PublicInputSnapshot[]
  /** Pending interactions of both kinds; closed by interaction.resolved. */
  readonly pendingInteractions: readonly PublicPendingInteraction[]
  /** Latest plan summary per planId (informational overlay). */
  readonly plans: readonly PublicPlanSummary[]
  /** Workspace diff mirror for the active session; undefined until first load. */
  readonly workspaceDiff?: BrowserWorkspaceDiff
  /** The single open file viewer; paths arrive verbatim from diff entries. */
  readonly workspaceFile?: BrowserWorkspaceFileView
  /** Remote shell console tasks (ruling H): task.updated mirrors plus the
   * output the paged getTaskLogs pulls have folded in; console-only, never
   * transcript entries. */
  readonly shellTasks: readonly BrowserShellTask[]
  readonly shellSending: boolean
  readonly shellError?: string
  /** Security mirror; security.updated only carries mode + policyRevision. */
  readonly security?: SessionSecurity
  /** Informational, non-error status line (e.g. steer fallback outcome). */
  readonly notice?: string
  /** The attached lineage holds events no shipped parser can project: the
   * transcript stays readable and live, every mutation port refuses with the
   * named unsupported_event, and only a clean rebuild lifts the state. */
  readonly readOnly?: boolean
  /** Live steer cancellation whose text refills the composer draft;
   * replayed history never triggers a refill. */
  readonly steerCancelled?: { readonly text: string }
}

export type BrowserConnector = typeof connectBrowserAppServer

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** The resolveInteraction body without the fields this client fills in. */
type ResolveInteractionBody = DistributiveOmit<SessionResolveInteractionParams, "sessionId" | "resolutionId">

type SessionResyncReason = SessionResyncRequiredNotificationParams["reason"]

/** Resync reasons map to distinct user-facing copy so the rebuilt view
 * explains itself; the vocabulary is the protocol's four-reason enum. */
const RESYNC_NOTICES: Readonly<Record<SessionResyncReason, string>> = {
  queue_overflow: "Live updates fell behind, so the conversation was refreshed from the server.",
  restart: "The host restarted, so the conversation was refreshed from the server.",
  rewind: "The conversation was rewound on the server, so the view was rebuilt.",
  history_unavailable: "Part of the history was unavailable, so the conversation was refreshed from the server.",
}

/** The degradation copy names the protocol error and states only the two
 * defined recovery paths; it never guesses the unknown event's semantics. */
const READ_ONLY_ERROR =
  "unsupported_event: this conversation has events this client cannot interpret. Reconnect or update the client to restore writing."

/** Bounded per-request log pages keep each pull cheap for the host while the
 * loop exercises real pagination; the poll cadence only re-checks running
 * tasks between task.updated arrivals. */
const TASK_LOG_PAGE_LIMIT = 5
const TASK_LOG_POLL_MS = 150

/** A stale in-flight page must never pull a terminal task back to a live
 * status; tasks do not un-complete. */
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"])

/** Every mutation port's refusal while the attached lineage holds events this
 * client cannot project; the rejection names the port and the protocol's
 * unsupported_event, never a bare error string. */
export class BrowserSessionReadOnlyError extends Error {
  constructor(port: string) {
    super(`${port} blocked: the conversation is read-only (unsupported_event)`)
    this.name = "BrowserSessionReadOnlyError"
  }
}

export class BrowserClient {
  private state: BrowserClientState = {
    status: "disconnected",
    endpoint: "",
    clientId: "",
    workspaces: [],
    sessions: [],
    loadingSession: false,
    sending: false,
    events: [],
    transientEvents: [],
    presence: [],
    pendingCommands: [],
    queuedInputs: [],
    pendingInteractions: [],
    plans: [],
    shellTasks: [],
    shellSending: false,
  }
  private readonly listeners = new Set<() => void>()
  private connection?: BrowserAppServerConnection
  private abort?: AbortController
  private removers: Array<() => void> = []
  private generation = 0
  private selection = 0
  private attachedSessionId?: string
  // Deliberately hand-rolled: the stored tail is the terminal catch and
  // never rejects (callers await the swallowed tail), and follow-up
  // selections append only after the awaited tail settles — appending
  // from inside a handler would deadlock the queue. The web client also
  // stays free of the runtime package owning the shared primitives.
  private queue: Promise<void> = Promise.resolve()
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryAttempt = 0
  /** Replay cursor for the attached session lineage: the highest revision this
   * client has seen, projected or safely skipped. It survives disconnects so
   * reconnect recovery replays incrementally, and resets whenever the lineage
   * is abandoned (selection change, host change, new conversation). */
  private lastProjectedRevision = 0
  /** Live session notifications captured while an attach await is in flight;
   * the flip merges them with replay instead of rendering partial state. */
  private attachBuffer?: { events: PublicSessionEvent[]; transients: PublicTransientEvent[] }
  private connectionOptions: Parameters<BrowserConnector>[2]
  private readonly leases = new BrowserInteractionLeaseController({
    isCurrent: (sessionId, connection) => this.state.activeSessionId === sessionId && this.connection?.rpc === connection.rpc,
    onLease: (update) => this.mirrorLease(update),
  })
  /** Transient storage for the active session; every projection rebuild resets it. */
  private readonly transients = new LiveTransientStore<PublicTransientEvent>()
  /** Pending periodic log pulls per shell task; cleared with the session. */
  private readonly taskPullTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly clientId: string,
    private readonly connector: BrowserConnector = connectBrowserAppServer,
  ) {
    this.state = { ...this.state, clientId }
  }

  getSnapshot = (): BrowserClientState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private silentUpdates = 0

  private update(patch: Partial<BrowserClientState>): void {
    this.state = { ...this.state, ...patch }
    if (this.silentUpdates > 0) return
    for (const listener of this.listeners) listener()
  }

  /** Applies a synchronous update group as one store notification, so the
   * attach flip reaches React as a single frame. */
  private flip(mutate: () => void): void {
    this.silentUpdates += 1
    try {
      mutate()
    } finally {
      this.silentUpdates -= 1
      if (this.silentUpdates === 0) for (const listener of this.listeners) listener()
    }
  }

  dismissError(): void {
    this.update({ error: undefined })
  }

  dismissNotice(): void {
    this.update({ notice: undefined })
  }

  clearSteerCancelled(): void {
    this.update({ steerCancelled: undefined })
  }

  async connect(endpoint: string, options: Parameters<BrowserConnector>[2] = {}, automatic = false): Promise<void> {
    const sameHost = endpoint === this.state.endpoint
    const selected = sameHost ? this.state.activeSessionId : undefined
    this.disconnect(false)
    const generation = this.generation
    const abort = new AbortController()
    this.abort = abort
    this.connectionOptions = options
    if (!sameHost) this.lastProjectedRevision = 0
    this.update({
      status: automatic ? "reconnecting" : "connecting",
      endpoint,
      error: undefined,
      ...(!sameHost
        ? {
            sessions: [],
            workspaces: [],
            activeSessionId: undefined,
            selectedWorkspaceId: undefined,
            snapshot: undefined,
            events: [],
            transientEvents: [],
            presence: [],
            leases: undefined,
            pendingCommands: [],
            queuedInputs: [],
            pendingInteractions: [],
            plans: [],
            workspaceDiff: undefined,
            workspaceFile: undefined,
            shellTasks: [],
            shellError: undefined,
            security: undefined,
            notice: undefined,
            readOnly: false,
            steerCancelled: undefined,
          }
        : {}),
    })
    try {
      const connection = await this.connector(endpoint, this.clientId, { ...options, signal: abort.signal })
      if (generation !== this.generation) {
        connection.close()
        return
      }
      this.connection = connection
      this.removers = [
        connection.rpc.onNotification((notification) => {
          if (this.connection !== connection) return
          try {
            const classified = classifyAppServerNotification(notification)
            if (classified === undefined) return
            switch (classified.kind) {
              // Unknown informational vocabulary is skipped for rendering, but
              // the preserved envelope still advances the replay cursor: a
              // reconnect must not re-fetch what this client has already seen.
              case "unknown-informational-event":
                this.advanceCursor(classified.envelope.revision)
                return
              case "session.event": {
                if (classified.event.sessionId !== this.state.activeSessionId) return
                if (this.attachBuffer) {
                  this.attachBuffer.events.push(classified.event)
                  return
                }
                this.mergeEvents([classified.event])
                return
              }
              case "session.transient": {
                if (classified.event.sessionId !== this.state.activeSessionId) return
                if (this.attachBuffer) {
                  this.attachBuffer.transients.push(classified.event)
                  return
                }
                this.transients.applyTransient(classified.event)
                this.update({ transientEvents: this.transients.transientEvents() })
                return
              }
              case "unknown-critical-event": {
                if (classified.event.envelope.sessionId !== this.state.activeSessionId) return
                // The safe response is a silent rebuild first: a non-durable
                // unknown event disappears in it, and a durable one degrades
                // the session read-only inside the resync path.
                void this.resyncSession(classified.event.envelope.sessionId, undefined)
                return
              }
              case "session.resyncRequired": {
                if (classified.params.sessionId !== this.state.activeSessionId) return
                void this.resyncSession(classified.params.sessionId, classified.params.reason)
                return
              }
              case "presence.updated": {
                if (classified.params.sessionId !== this.state.activeSessionId) return
                this.update({ presence: classified.params.clients })
                // Presence carries the same lease facts as the dedicated
                // notification; the controller stays the single lease source.
                this.leases.observe(classified.params.sessionId, classified.params.leases)
                return
              }
              case "interaction.lease.updated": {
                if (classified.params.sessionId !== this.state.activeSessionId) return
                this.leases.observe(classified.params.sessionId, classified.params.leases)
                return
              }
            }
          } catch (error) {
            this.update({ error: errorMessage(error) })
          }
        }),
        connection.onClose(() => {
          if (this.connection !== connection) return
          this.disconnect(false)
          this.update({ status: "reconnecting" })
          this.scheduleReconnect()
        }),
      ]
      const sessions = await listBrowserSessions(connection.rpc)
      if (generation !== this.generation) return
      const workspaces = serverWorkspaces(connection.initialize)
      this.update({
        initialize: connection.initialize,
        sessions,
        workspaces,
        status: "connected",
        selectedWorkspaceId:
          workspaces.find((w) => w.workspaceId === this.state.selectedWorkspaceId)?.workspaceId ?? workspaces[0]?.workspaceId,
      })
      this.retryAttempt = 0
      if (selected && sessions.some((session) => session.sessionId === selected)) {
        // Same-lineage reconnect: extend the surviving projection instead of
        // rebuilding it; a cursor that no longer extends escalates inside.
        if (this.lastProjectedRevision > 0) await this.recoverSession(selected)
        else await this.selectSession(selected)
      } else this.resetSession()
    } catch (error) {
      if (generation !== this.generation) return
      this.disconnect(false)
      this.update({ status: automatic ? "reconnecting" : "disconnected", error: errorMessage(error) })
      if (automatic) this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.retryAttempt++, 15_000)
    this.retryTimer = setTimeout(() => void this.connect(this.state.endpoint, this.connectionOptions, true), delay)
  }

  disconnect(clear = true): void {
    this.generation += 1
    this.selection += 1
    clearTimeout(this.retryTimer)
    const connection = this.connection
    this.connection = undefined
    for (const remove of this.removers) remove()
    this.removers = []
    this.abort?.abort()
    this.abort = undefined
    connection?.close()
    this.attachedSessionId = undefined
    this.leases.reset()
    this.transients.reset()
    this.clearTaskPulls()
    this.update({
      presence: [],
      transientEvents: [],
      loadingSession: false,
      sending: false,
      shellSending: false,
      ...(clear ? { status: "disconnected", initialize: undefined } : {}),
    })
  }

  private resetSession(): void {
    this.lastProjectedRevision = 0
    this.leases.reset()
    this.transients.reset()
    this.clearTaskPulls()
    this.update({
      activeSessionId: undefined,
      snapshot: undefined,
      events: [],
      transientEvents: [],
      presence: [],
      leases: undefined,
      pendingCommands: [],
      queuedInputs: [],
      pendingInteractions: [],
      plans: [],
      workspaceDiff: undefined,
      workspaceFile: undefined,
      shellTasks: [],
      shellError: undefined,
      security: undefined,
      notice: undefined,
      readOnly: false,
      steerCancelled: undefined,
      loadingSession: false,
    })
  }

  newConversation(workspaceId = this.state.selectedWorkspaceId): void {
    const connection = this.connection
    const previous = this.attachedSessionId
    this.selection += 1
    this.resetSession()
    this.update({ selectedWorkspaceId: workspaceId })
    if (connection && previous) {
      this.queue = this.queue
        .then(async () => {
          if (this.connection !== connection) return
          await detachBrowserSession(connection.rpc, previous)
          if (this.attachedSessionId === previous) this.attachedSessionId = undefined
        })
        .catch((error) => this.update({ error: errorMessage(error) }))
    }
  }

  async selectSession(sessionId: string): Promise<void> {
    const connection = this.connection
    if (!connection || this.state.status !== "connected") return
    const selection = ++this.selection
    const session = this.state.sessions.find((s) => s.sessionId === sessionId)
    this.lastProjectedRevision = 0
    this.leases.reset()
    this.transients.reset()
    this.clearTaskPulls()
    this.update({
      activeSessionId: sessionId,
      selectedWorkspaceId: session?.workspace.workspaceId ?? this.state.selectedWorkspaceId,
      loadingSession: true,
      error: undefined,
      snapshot: undefined,
      events: [],
      transientEvents: [],
      presence: [],
      leases: undefined,
      pendingCommands: [],
      queuedInputs: [],
      pendingInteractions: [],
      plans: [],
      workspaceDiff: undefined,
      workspaceFile: undefined,
      shellTasks: [],
      shellError: undefined,
      security: undefined,
      notice: undefined,
      readOnly: false,
      steerCancelled: undefined,
    })
    const current = (): boolean => this.connection === connection && selection === this.selection
    // Serialize subscription changes so a late attach cannot revive an abandoned session.
    const attach = async (): Promise<void> => {
      if (!current()) return
      if (this.attachedSessionId && this.attachedSessionId !== sessionId) await detachBrowserSession(connection.rpc, this.attachedSessionId)
      if (!current()) return
      this.attachedSessionId = sessionId
      this.attachBuffer = { events: [], transients: [] }
      const buffer = this.attachBuffer
      const state = await attachBrowserSession(connection.rpc, sessionId).finally(() => {
        this.attachBuffer = undefined
      })
      if (!current()) return
      // One flip: snapshot seeds, replay, and events buffered during the
      // attach await land in a single commit; the merge dedupes by event
      // identity, so overlap between replay and buffered events is safe.
      this.flip(() => {
        this.update({
          snapshot: state.snapshot,
          queuedInputs: seedQueuedInputs(state.snapshot.inputs),
          pendingInteractions: seedPendingInteractions(state.snapshot.pendingInteractions),
          plans: seedPlans(state.snapshot.activePlan),
          shellTasks: seedShellTasks(state.snapshot.activeTasks),
          security: seedSessionSecurity(state.snapshot.security, state.snapshot.asOfRevision),
        })
        this.mergeEvents([...state.events, ...buffer.events], true)
        for (const event of buffer.transients) this.transients.applyTransient(event)
        this.update({ transientEvents: this.transients.transientEvents() })
        this.update({ loadingSession: false })
      })
      // Seeded active tasks are mid-flight by definition; start their pulls.
      for (const task of this.state.shellTasks) this.scheduleTaskPull(task.taskId)
    }
    this.queue = this.queue.then(attach, attach).catch((error) => {
      if (!current()) return
      if (isInvalidResultError(error)) {
        // Attaching a lineage this client cannot project degrades read-only
        // — the same state the resync entry produces, never an error banner.
        this.update({ loadingSession: false, readOnly: true, error: READ_ONLY_ERROR })
        return
      }
      this.update({ loadingSession: false, error: errorMessage(error) })
    })
    await this.queue
  }

  async recover(): Promise<void> {
    if (this.state.loadingSession) return
    const sessionId = this.state.activeSessionId
    if (sessionId) await this.selectSession(sessionId)
  }

  /** Reconnect recovery: the projection survives, a fresh attach registers the
   * live subscription first, and replay(after the cursor) plus the events
   * buffered during the await merge in a single flip. The attach snapshot is
   * deliberately not applied — a wholesale replace is resync-only. */
  private async recoverSession(sessionId: string): Promise<void> {
    const connection = this.connection
    if (!connection || this.state.activeSessionId !== sessionId) return
    const selection = ++this.selection
    const cursor = this.lastProjectedRevision
    const current = (): boolean => this.connection === connection && selection === this.selection
    let escalate = false
    const recover = async (): Promise<void> => {
      if (!current()) return
      this.attachedSessionId = sessionId
      this.attachBuffer = { events: [], transients: [] }
      const buffer = this.attachBuffer
      try {
        await attachLiveBrowserSession(connection.rpc, sessionId)
        const replayed = await replayBrowserSession(connection.rpc, sessionId, cursor)
        if (!current()) return
        // One flip: replay pages and events buffered during the awaits land in
        // a single commit; the merge dedupes by event identity, so overlap
        // between replay and buffered events is safe.
        this.flip(() => {
          this.mergeEvents([...replayed.events, ...buffer.events], true)
          for (const event of buffer.transients) this.transients.applyTransient(event)
          this.update({ transientEvents: this.transients.transientEvents() })
        })
      } finally {
        if (this.attachBuffer === buffer) this.attachBuffer = undefined
      }
    }
    this.queue = this.queue.then(recover, recover).catch((error) => {
      // The held cursor no longer extends against this history; the flag
      // rebuilds the lineage wholesale after this chain settles (appending a
      // selection from inside the handler would deadlock the queue).
      if (current() && this.state.activeSessionId === sessionId && isReplayEscalation(error)) {
        escalate = true
        return
      }
      if (current()) this.update({ error: errorMessage(error) })
    })
    await this.queue
    if (escalate && current()) await this.selectSession(sessionId)
  }

  private advanceCursor(revision: number): void {
    if (revision > this.lastProjectedRevision) this.lastProjectedRevision = revision
  }

  /** Server-directed resync: the held projection stays rendered while a fresh
   * snapshot plus replay(0) rebuild it wholesale in a single flip — no blank
   * frame, no loading state. Live events buffered during the await beyond the
   * snapshot cursor join the same flip; anything at or below it is already
   * contained in the rebuild and dropped. A `reason` explains the rebuild to
   * the user; the unknown-critical intake rebuilds silently. A replay(0) that
   * still cannot project degrades the session read-only instead of falling
   * back — that is the one defined entry into the degraded state. */
  private async resyncSession(sessionId: string, reason: SessionResyncReason | undefined): Promise<void> {
    const connection = this.connection
    if (!connection || this.state.activeSessionId !== sessionId) return
    const selection = ++this.selection
    const current = (): boolean => this.connection === connection && selection === this.selection
    let fallback = false
    const resync = async (): Promise<void> => {
      if (!current()) return
      this.attachBuffer = { events: [], transients: [] }
      const buffer = this.attachBuffer
      try {
        const rebuilt = await resyncBrowserSession(connection.rpc, sessionId)
        if (!current()) return
        this.flip(() => {
          this.transients.reset()
          // The cursor restarts from the rebuild: replay(0) re-advances it to
          // the server head, and the snapshot cursor covers revisions this
          // client once skipped but that no known event re-states.
          this.lastProjectedRevision = 0
          this.update({
            notice: reason === undefined ? undefined : RESYNC_NOTICES[reason],
            readOnly: false,
            error: undefined,
            snapshot: rebuilt.snapshot,
            events: [],
            queuedInputs: seedQueuedInputs(rebuilt.snapshot.inputs),
            pendingInteractions: seedPendingInteractions(rebuilt.snapshot.pendingInteractions),
            plans: seedPlans(rebuilt.snapshot.activePlan),
            shellTasks: seedShellTasks(rebuilt.snapshot.activeTasks),
            security: seedSessionSecurity(rebuilt.snapshot.security, rebuilt.snapshot.asOfRevision),
          })
          const live = buffer.events.filter((event) => event.revision > rebuilt.snapshot.asOfRevision)
          this.mergeEvents([...rebuilt.events, ...live], true)
          this.advanceCursor(rebuilt.snapshot.asOfRevision)
          for (const event of buffer.transients) this.transients.applyTransient(event)
          this.update({ transientEvents: this.transients.transientEvents() })
          for (const task of this.state.shellTasks) this.scheduleTaskPull(task.taskId)
        })
      } finally {
        if (this.attachBuffer === buffer) this.attachBuffer = undefined
      }
    }
    this.queue = this.queue.then(resync, resync).catch((error) => {
      if (!current() || this.state.activeSessionId !== sessionId) return
      if (isInvalidResultError(error)) {
        // The lineage still holds events no shipped parser can project. The
        // held projection stays readable and live; mutations degrade instead
        // of dead-ending on an error banner or a pointless re-attach loop.
        this.update({ readOnly: true, error: READ_ONLY_ERROR })
        return
      }
      // The in-band resync failed; only a re-attach restores a consistent
      // projection. The flag defers the selection until this chain settles
      // (appending one from inside the handler would deadlock the queue).
      fallback = true
    })
    await this.queue
    if (fallback && current()) await this.selectSession(sessionId)
  }

  private mergeEvents(incoming: readonly PublicSessionEvent[], replay = false): void {
    const events = mergeWireEvents(this.state.events, incoming)
    for (const event of incoming) this.transients.applyDurable(event)
    for (const event of incoming) this.advanceCursor(event.revision)
    // A command drains when its input fails, reaches a terminal status
    // without a run, or its run terminates; one run admits many commands
    // (the prompt plus its steers), so the index is commandId -> runId with
    // terminal runs filtered at the end.
    const pendingCommands = new Set<string>()
    const runByCommand = new Map<string, string>()
    const terminalRuns = new Set<string>()
    for (const event of events) {
      if (event.type === "input.accepted" || event.type === "input.updated") {
        const { commandId, runId, status } = event.input
        if (runId !== undefined) runByCommand.set(commandId, runId)
        if (status === "queued" || runByCommand.has(commandId)) pendingCommands.add(commandId)
        else pendingCommands.delete(commandId)
      }
      if (event.type === "input.failed") pendingCommands.delete(event.commandId)
      if (
        event.type === "run.updated" &&
        (event.run.status === "completed" || event.run.status === "failed" || event.run.status === "cancelled")
      )
        terminalRuns.add(event.run.runId)
    }
    const pending = [...pendingCommands].filter((commandId) => !terminalRuns.has(runByCommand.get(commandId) ?? commandId))
    let steerCancelled: { readonly text: string } | undefined
    let expiredInteraction = false
    if (!replay)
      for (const event of incoming) {
        if (event.type !== "input.updated" || event.input.kind !== "steer" || event.input.status !== "cancelled") continue
        const text = event.input.text?.trim()
        if (text) steerCancelled = { text }
        break
      }
    if (!replay)
      for (const event of incoming) {
        if (event.type === "interaction.resolved" && event.resolution.outcome === "expired") expiredInteraction = true
      }
    const title = [...events].reverse().find((event) => event.type === "session.title.updated")?.title
    const securityBefore = this.state.security
    const securityAfter = securityBefore === undefined ? undefined : applySecurityEvents(securityBefore, incoming)
    const tasksBefore = this.state.shellTasks
    const shellTasksAfter = applyTaskEvents(tasksBefore, incoming)
    this.update({
      events,
      transientEvents: this.transients.transientEvents(),
      pendingCommands: [...pending],
      queuedInputs: applyQueueEvents(this.state.queuedInputs, incoming),
      pendingInteractions: applyInteractionEvents(this.state.pendingInteractions, incoming),
      plans: applyPlanEvents(this.state.plans, incoming),
      shellTasks: shellTasksAfter,
      security: securityAfter,
      ...(steerCancelled === undefined ? {} : { steerCancelled }),
      ...(expiredInteraction ? { error: "A pending question expired before it was answered" } : {}),
      sessions: this.state.sessions.map((session) =>
        session.sessionId === this.state.activeSessionId ? { ...session, ...(title === undefined ? {} : { title }) } : session,
      ),
    })
    // security.updated carries only mode + revision; selectableModes and
    // custom-rule state come from a policy refetch, and replayed history
    // already reflects a snapshot-consistent policy.
    const liveSessionId = this.state.activeSessionId
    if (!replay && securityAfter !== undefined && securityAfter !== securityBefore && liveSessionId !== undefined)
      void this.refetchPolicy(liveSessionId)
    // A new or moved task face is the cue to fetch its logs; replay seeding
    // is left to the attach/resync flips, which schedule after the state swap.
    if (!replay)
      for (const task of shellTasksAfter) {
        const before = tasksBefore.find((candidate) => candidate.taskId === task.taskId)
        if (before === undefined || before.status !== task.status || before.updatedAt !== task.updatedAt) this.scheduleTaskPull(task.taskId)
      }
  }

  /** Mirrors controller lease truth into renderable state. Self-ownership is
   * the controller's generation match — the wire holder shape carries no
   * connection identity to compare against. */
  private mirrorLease(update: BrowserInteractionLeaseUpdate): void {
    if (update.sessionId !== this.state.activeSessionId) return
    const connectionId = this.connection?.initialize.connection.connectionId
    const view = (scope: InteractionLeaseScope): BrowserLeaseView => ({
      lease: scope === update.scope ? update.lease : this.leases.currentLease(update.sessionId, scope),
      heldBySelf: connectionId !== undefined && this.leases.currentGeneration(update.sessionId, scope, connectionId) !== undefined,
    })
    this.update({ leases: { composer: view("composer"), "session-control": view("session-control") } })
  }

  /** Explicit user action: takes over only the session-control scope; the
   * composer lease stays submit-level. Convergence is the server's lease
   * publication, never a local optimistic flip. */
  async takeoverSessionControl(): Promise<void> {
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    if (!connection || !sessionId) return
    try {
      await this.leases.takeover(sessionId, "session-control", {
        rpc: connection.rpc,
        connectionId: connection.initialize.connection.connectionId,
      })
    } catch (error) {
      if (this.connection === connection) this.update({ error: permissionModeError(error) })
    }
  }

  private refuseIfReadOnly(port: string): boolean {
    if (this.state.readOnly !== true) return false
    this.update({ error: new BrowserSessionReadOnlyError(port).message })
    return true
  }

  /** Loads diff page one; panel open, manual refresh, and post-change reloads
   * all funnel here so stale state is always replaced, not extended. */
  async loadWorkspaceDiff(limit?: number): Promise<void> {
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    if (!connection || !sessionId) return
    const selection = this.selection
    this.update({ workspaceDiff: { loading: true, changes: [] } })
    try {
      const page = await callProtocol(connection.rpc, "workspace.diff", {
        sessionId,
        ...(limit === undefined ? {} : { limit }),
        includePatch: true,
      })
      if (this.connection !== connection || selection !== this.selection) return
      this.update({
        workspaceDiff: {
          loading: false,
          changes: page.changes,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        },
      })
    } catch (error) {
      if (this.connection === connection && selection === this.selection)
        this.update({ workspaceDiff: { loading: false, changes: [], error: workspaceErrorText(error) } })
    }
  }

  /** Continues the diff pagination; a snapshotToken mismatch triggers one full
   * refetch instead of splicing pages across snapshots (ruling G). */
  async loadMoreWorkspaceDiff(limit?: number): Promise<void> {
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    const diff = this.state.workspaceDiff
    if (!connection || !sessionId || !diff || diff.nextCursor === undefined || diff.loading) return
    const selection = this.selection
    this.update({ workspaceDiff: { ...diff, loading: true } })
    try {
      const page = await callProtocol(connection.rpc, "workspace.diff", {
        sessionId,
        cursor: diff.nextCursor,
        ...(limit === undefined ? {} : { limit }),
        includePatch: true,
      })
      if (this.connection !== connection || selection !== this.selection) return
      this.update({
        workspaceDiff: {
          loading: false,
          changes: [...diff.changes, ...page.changes],
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        },
      })
    } catch (error) {
      if (this.connection !== connection || selection !== this.selection) return
      if (error instanceof AppServerRpcError && error.kind === "workspace_changed") {
        await this.loadWorkspaceDiff(limit)
        return
      }
      this.update({ workspaceDiff: { ...diff, loading: false, error: workspaceErrorText(error) } })
    }
  }

  /** Opens the file viewer for one diff entry; the path flows to the host
   * verbatim — the client never parses or joins paths locally (ruling G). */
  async openWorkspaceFile(path: string, maxLines?: number): Promise<void> {
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    if (!connection || !sessionId) return
    const selection = this.selection
    this.update({ workspaceFile: { path, loading: true } })
    try {
      const result = await callProtocol(connection.rpc, "workspace.readFile", {
        sessionId,
        path,
        ...(maxLines === undefined ? {} : { maxLines }),
      })
      if (this.connection !== connection || selection !== this.selection) return
      this.update({ workspaceFile: { path, loading: false, ...workspaceFileFields(result) } })
    } catch (error) {
      if (this.connection === connection && selection === this.selection)
        this.update({ workspaceFile: { path, loading: false, error: workspaceErrorText(error) } })
    }
  }

  /** Reads the next line window under the digest guard; a changed file
   * restarts from line one instead of splicing windows across digests. */
  async readMoreWorkspaceFile(maxLines?: number): Promise<void> {
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    const file = this.state.workspaceFile
    if (!connection || !sessionId || !file || file.loading || file.nextStartLine === undefined || file.digest === undefined) return
    const selection = this.selection
    this.update({ workspaceFile: { ...file, loading: true } })
    try {
      const result = await callProtocol(connection.rpc, "workspace.readFile", {
        sessionId,
        path: file.path,
        startLine: file.nextStartLine,
        expectedDigest: file.digest,
        ...(maxLines === undefined ? {} : { maxLines }),
      })
      if (this.connection !== connection || selection !== this.selection) return
      this.update({
        workspaceFile: {
          ...file,
          loading: false,
          content: `${file.content ?? ""}\n${result.content ?? ""}`,
          totalLines: result.totalLines,
          ...(result.nextStartLine === undefined ? {} : { nextStartLine: result.nextStartLine }),
        },
      })
    } catch (error) {
      if (this.connection !== connection || selection !== this.selection) return
      if (error instanceof AppServerRpcError && error.kind === "workspace_changed") {
        await this.openWorkspaceFile(file.path, maxLines)
        return
      }
      this.update({ workspaceFile: { ...file, loading: false, error: workspaceErrorText(error) } })
    }
  }

  closeWorkspaceFile(): void {
    this.update({ workspaceFile: undefined })
  }

  private scheduleTaskPull(taskId: string, delay = 0): void {
    if (this.taskPullTimers.has(taskId)) return
    this.taskPullTimers.set(
      taskId,
      setTimeout(() => {
        this.taskPullTimers.delete(taskId)
        void this.pullTaskLogs(taskId)
      }, delay),
    )
  }

  private clearTaskPulls(): void {
    for (const timer of this.taskPullTimers.values()) clearTimeout(timer)
    this.taskPullTimers.clear()
  }

  private async pullTaskLogs(taskId: string): Promise<void> {
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    if (!connection || !sessionId) return
    try {
      for (;;) {
        const task = this.state.shellTasks.find((candidate) => candidate.taskId === taskId)
        if (!task || this.state.activeSessionId !== sessionId || this.connection !== connection) return
        const page = await callProtocol(connection.rpc, "session.getTaskLogs", {
          sessionId,
          taskId,
          ...(task.pulledThrough === undefined ? {} : { afterSequence: task.pulledThrough }),
          limit: TASK_LOG_PAGE_LIMIT,
        })
        if (this.connection !== connection || this.state.activeSessionId !== sessionId) return
        this.applyTaskLogs(taskId, page)
        if (page.nextAfterSequence !== undefined) continue
        if (page.status === "queued" || page.status === "running") this.scheduleTaskPull(taskId, TASK_LOG_POLL_MS)
        return
      }
    } catch (error) {
      if (this.connection === connection && this.state.activeSessionId === sessionId) this.update({ shellError: shellErrorText(error) })
    }
  }

  private applyTaskLogs(taskId: string, page: SessionGetTaskLogsResult): void {
    this.update({
      shellTasks: this.state.shellTasks.map((task) => {
        if (task.taskId !== taskId) return task
        // Concurrent pulls can race when a task.updated lands mid-pull; the
        // cursor filter keeps the fold idempotent and drops a late page that
        // a faster pull has already covered, and a page racing past a
        // terminal transition cannot regress the terminal status.
        const fresh = page.chunks.filter((chunk) => chunk.sequence > (task.pulledThrough ?? 0))
        const last = fresh[fresh.length - 1]
        const status = TERMINAL_TASK_STATUSES.has(task.status) && !TERMINAL_TASK_STATUSES.has(page.status) ? task.status : page.status
        return {
          ...task,
          status,
          output: fresh.length === 0 ? task.output : (task.output ? `${task.output}\n` : "") + fresh.map((chunk) => chunk.text).join("\n"),
          ...(last === undefined ? {} : { pulledThrough: last.sequence }),
          outputBytes: page.outputBytes,
        }
      }),
    })
  }

  /** Runs one console command; the `shell:execute` scope is the whole
   * admission and the identity is a fresh commandId. */
  async executeUserShell(command: string): Promise<boolean> {
    if (this.refuseIfReadOnly("session.executeUserShell")) return false
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    if (!connection || !sessionId || this.state.status !== "connected" || !command.trim()) return false
    const generation = this.generation
    const selection = this.selection
    this.update({ shellSending: true, shellError: undefined })
    try {
      await callProtocol(connection.rpc, "session.executeUserShell", {
        sessionId,
        commandId: crypto.randomUUID(),
        command: command.trim(),
      })
      return generation === this.generation && selection === this.selection
    } catch (error) {
      if (generation === this.generation && selection === this.selection) this.update({ shellError: shellErrorText(error) })
      return false
    } finally {
      if (generation === this.generation) this.update({ shellSending: false })
    }
  }

  async cancelShellTask(taskId: string): Promise<void> {
    if (this.refuseIfReadOnly("session.cancelTask")) return
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    if (!connection || !sessionId) return
    try {
      await callProtocol(connection.rpc, "session.cancelTask", { sessionId, taskId })
    } catch (error) {
      this.update({ shellError: shellErrorText(error) })
    }
  }

  async send(text: string): Promise<boolean> {
    if (this.refuseIfReadOnly("session.submit")) return false
    const connection = this.connection
    const workspace = this.state.workspaces.find((w) => w.workspaceId === this.state.selectedWorkspaceId)
    if (
      !connection ||
      this.state.status !== "connected" ||
      this.state.sending ||
      this.state.loadingSession ||
      !text.trim() ||
      !workspace ||
      workspace.availability !== "available"
    )
      return false
    const generation = this.generation
    const selection = this.selection
    let sessionId = this.state.activeSessionId
    this.update({ sending: true, error: undefined, notice: undefined })
    try {
      if (!sessionId) {
        const session = await createBrowserSession(connection.rpc, workspace.workspaceId, text.trim().slice(0, 64))
        if (generation !== this.generation) return false
        this.update({ sessions: [session, ...this.state.sessions] })
        if (selection !== this.selection) return false
        sessionId = session.sessionId
        await this.selectSession(sessionId)
        if (this.state.activeSessionId !== sessionId || this.state.error) return false
      }
      return (await this.submitWithComposerLease(sessionId, crypto.randomUUID(), text.trim())) !== undefined
    } catch (error) {
      if (generation === this.generation) this.update({ error: errorMessage(error) })
      return false
    } finally {
      if (generation === this.generation) this.update({ sending: false })
    }
  }

  /** Submits under the composer lease; the returned queued flag drives the
   * steer-fallback presentation. Undefined means the attempt went stale. */
  private async submitWithComposerLease(
    sessionId: string,
    commandId: string,
    text: string,
  ): Promise<{ readonly queued: boolean } | undefined> {
    const connection = this.connection
    if (!connection) return undefined
    const generation = this.generation
    return this.leases.withLease(
      sessionId,
      "composer",
      { rpc: connection.rpc, connectionId: connection.initialize.connection.connectionId },
      {},
      async (leaseGeneration) => {
        if (generation !== this.generation || this.state.activeSessionId !== sessionId) return undefined
        this.update({ pendingCommands: [...this.state.pendingCommands, commandId] })
        try {
          const admitted = await callProtocol(connection.rpc, "session.submit", {
            sessionId,
            commandId,
            text,
            lease: { scope: "composer", generation: leaseGeneration },
          })
          if (generation !== this.generation || this.state.activeSessionId !== sessionId) return undefined
          return { queued: admitted.queued }
        } catch (error) {
          if (generation === this.generation && this.state.activeSessionId === sessionId)
            this.update({ pendingCommands: this.state.pendingCommands.filter((id) => id !== commandId) })
          throw error
        }
      },
    )
  }

  /** Steers the active run. A run_not_active admission falls back to a fresh
   * submit with a new command identity — the fallback is a new logical
   * submission, not a same-payload retry, so the steer commandId is never reused. */
  async steer(text: string): Promise<boolean> {
    if (this.refuseIfReadOnly("session.steer")) return false
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    const runId = this.activeRunId()
    if (!connection || !sessionId || !runId || this.state.sending || this.state.loadingSession || !text.trim()) return false
    const generation = this.generation
    this.update({ error: undefined, notice: undefined })
    try {
      await callProtocol(connection.rpc, "session.steer", {
        sessionId,
        runId,
        commandId: crypto.randomUUID(),
        text: text.trim(),
      })
      return generation === this.generation
    } catch (error) {
      if (!(error instanceof AppServerRpcError && error.kind === "run_not_active")) {
        if (generation === this.generation) this.update({ error: errorMessage(error) })
        return false
      }
      if (generation !== this.generation || this.state.activeSessionId !== sessionId) return false
      // The target run ended between derivation and admission; the fallback
      // submit decides whether the message queued or started immediately.
      const fallback = await this.submitWithComposerLease(sessionId, crypto.randomUUID(), text.trim())
      if (fallback === undefined || generation !== this.generation) return false
      this.update({
        notice: fallback.queued
          ? "The run ended while steering; your message was queued"
          : "The run ended while steering; your message was sent",
      })
      return true
    }
  }

  /** Cancels one queued input by identity; the wire accepts exactly the two
   * identity fields, and terminal inputs are reported by the mirror's events. */
  async cancelInput(inputId: string): Promise<void> {
    if (this.refuseIfReadOnly("session.cancelInput")) return
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    if (!connection || !sessionId) return
    try {
      await callProtocol(connection.rpc, "session.cancelInput", { sessionId, inputId })
    } catch (error) {
      this.update({ error: errorMessage(error) })
    }
  }

  /** Newest status per runId; at most one run is active per session, and the
   * events are revision-ordered so the last write per run wins. */
  private activeRunId(): string | undefined {
    const statuses = new Map<string, string>()
    for (const event of this.state.events) {
      if (event.type === "run.updated") statuses.set(event.run.runId, event.run.status)
    }
    for (const [runId, status] of statuses) if (status === "running") return runId
    return undefined
  }

  /** Cancels the run behind the newest pending command; a queued input with
   * no run yet has nothing active to cancel through the run face. */
  async cancel(): Promise<void> {
    if (this.refuseIfReadOnly("session.cancelRun")) return
    const commandId = this.state.pendingCommands.at(-1)
    const sessionId = this.state.activeSessionId
    if (!this.connection || !sessionId || !commandId) return
    const runId = this.runIdForCommand(commandId)
    if (runId === undefined) return
    try {
      await callProtocol(this.connection.rpc, "session.cancelRun", { sessionId, runId })
    } catch (error) {
      this.update({ error: errorMessage(error) })
    }
  }

  private runIdForCommand(commandId: string): string | undefined {
    let runId: string | undefined
    for (const event of this.state.events) {
      if (event.type !== "input.accepted" && event.type !== "input.updated") continue
      if (event.input.commandId !== commandId) continue
      const candidate = event.input.runId
      if (candidate !== undefined) runId = candidate
    }
    return runId
  }

  async resolveToolApproval(interaction: PublicToolApprovalInteraction, decision: "approved" | "denied"): Promise<void> {
    await this.sendResolution({
      kind: "tool_approval",
      interactionId: interaction.interactionId,
      optionId: decision === "approved" ? "approve_once" : "deny",
      expectedScopeRevision: interaction.scopeRevision,
      expectedPolicyRevision: interaction.policyRevision,
    })
  }

  /** Resolves an ask_user card. A chat outcome keeps the run active, so the
   * follow-up prompt queues behind it like any submit while running. */
  async resolveAskUser(interaction: PublicAskUserInteraction, answer: PublicAskUserAnswer): Promise<void> {
    await this.sendResolution({ kind: "ask_user", interactionId: interaction.interactionId, answer })
    if (answer.outcome === "chat")
      this.update({ notice: "Answered in chat — send your follow-up below; it will queue until the response finishes." })
  }

  /** First valid resolution wins server-side; losing the race is closing the
   * card through the canonical event, never a client error. */
  private async sendResolution(params: ResolveInteractionBody): Promise<void> {
    if (this.refuseIfReadOnly("session.resolveInteraction")) return
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    if (!connection || !sessionId) return
    try {
      await callProtocol(connection.rpc, "session.resolveInteraction", { sessionId, resolutionId: crypto.randomUUID(), ...params })
    } catch (error) {
      if (error instanceof AppServerRpcError && (error.kind === "interaction_already_resolved" || error.kind === "stale_approval")) return
      this.update({ error: errorMessage(error) })
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.refuseIfReadOnly("session.deleteSession")) return
    const connection = this.connection
    if (!connection) return
    await this.selectSession(sessionId)
    if (this.connection !== connection || this.state.activeSessionId !== sessionId || this.state.error) return
    try {
      await this.leases.withLease(
        sessionId,
        "session-control",
        { rpc: connection.rpc, connectionId: connection.initialize.connection.connectionId },
        {},
        async (generation) => {
          await deleteBrowserSession(connection.rpc, sessionId, generation)
          this.update({ sessions: this.state.sessions.filter((session) => session.sessionId !== sessionId) })
          this.newConversation()
        },
      )
    } catch (error) {
      this.update({ error: errorMessage(error) })
    }
  }

  /** Switches the permission mode under an explicitly acquired session-control
   * lease; the expected revision makes the write compare-and-swap. */
  async setPermissionMode(mode: PublicPermissionModeValue): Promise<void> {
    if (this.refuseIfReadOnly("session.setPermissionMode")) return
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    const security = this.state.security
    if (!connection || !sessionId || !security) return
    this.update({ error: undefined, notice: undefined })
    try {
      await this.leases.withLease(
        sessionId,
        "session-control",
        { rpc: connection.rpc, connectionId: connection.initialize.connection.connectionId },
        {},
        async (generation) => {
          const result = await callProtocol(connection.rpc, "session.setPermissionMode", {
            sessionId,
            mode,
            expectedPolicyRevision: security.policyRevision,
            lease: { scope: "session-control", generation },
          })
          this.applyPolicy(result.policy)
        },
      )
    } catch (error) {
      this.update({ error: permissionModeError(error) })
      if (error instanceof AppServerRpcError && error.kind === "policy_revision_conflict") await this.refetchPolicy(sessionId)
    }
  }

  /** Policy refetch for live security.updated; a failure stays silent because
   * the event mirror already carries the authoritative mode and revision. */
  private async refetchPolicy(sessionId: string): Promise<void> {
    const connection = this.connection
    if (!connection || this.state.activeSessionId !== sessionId) return
    try {
      const result = await callProtocol(connection.rpc, "session.getPermissionPolicy", { sessionId })
      if (this.connection === connection && this.state.activeSessionId === sessionId) this.applyPolicy(result.policy)
    } catch {
      // The next security.updated or manual retry converges the mirror.
    }
  }

  /** Overwrites the policy fields events cannot carry; the event-based
   * revision stays untouched so the paired security.updated applies idempotently. */
  private applyPolicy(policy: PublicPermissionPolicy): void {
    const security = this.state.security
    if (security === undefined) return
    this.update({
      security: {
        ...security,
        permissionMode: policy.mode,
        policyRevision: policy.policyRevision,
        hasCustomRules: policy.rules.length > 0,
        selectableModes: [...policy.selectableModes],
      },
    })
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Replay failures that mean the held cursor cannot extend against the
 * server's history: the server's head is behind the cursor, or its
 * continuation cursor is unusable. */
function isReplayEscalation(error: unknown): boolean {
  if (error instanceof AppServerRpcError && error.kind === "revision_ahead") return true
  return error instanceof ReplayContinuationError
}

/** A result the shipped parsers cannot project: the lineage holds event
 * types this client generation does not know. */
function isInvalidResultError(error: unknown): boolean {
  return error instanceof AppServerRpcError && error.kind === "invalid_result"
}

/** Maps permission-mode write failures to actionable guidance; the raw wire
 * messages name the error but not what the user should do next. */
export function permissionModeError(error: unknown): string {
  if (error instanceof BrowserInteractionLeaseUnavailableError)
    return "Another client is controlling this session. Wait until it finishes, then try again."
  if (error instanceof AppServerRpcError) {
    switch (error.kind) {
      case "policy_revision_conflict":
        return "The permission policy changed elsewhere. The latest mode is shown — try again if you still want to switch."
      case "interaction_lease_held":
        return "Another client is controlling this session. Wait until it finishes, then try again."
      case "interaction_lease_stale":
        return "The session control lease expired. Try switching the mode again."
      case "interaction_lease_required":
      case "interaction_lease_scope_mismatch":
        return "The mode change needs the session control lease. Try again."
      case "scope_denied":
        return "This connection is not allowed to change permission modes."
    }
  }
  return errorMessage(error)
}

/** Workspace face failures keep their named readable presentation inside the
 * browsing panel; path denials quote the host's reason, which distinguishes
 * sensitive paths from files that left the working tree. */
export function workspaceErrorText(error: unknown): string {
  if (error instanceof AppServerRpcError) {
    switch (error.kind) {
      case "scope_denied":
        return "This connection is not allowed to browse workspace files."
      case "capability_unavailable":
        return "Workspace browsing is not enabled on this host."
      case "workspace_unavailable":
        return "The workspace is not available on this host."
      case "invalid_params":
        return "That workspace request was rejected by the host."
      case "workspace_path_denied":
      case "workspace_changed":
        return errorMessage(error)
    }
  }
  return errorMessage(error)
}

/** Shell face failures keep their named readable presentation inside the
 * console; admission refusals name the protocol error. */
export function shellErrorText(error: unknown): string {
  if (error instanceof AppServerRpcError) {
    switch (error.kind) {
      case "scope_denied":
        return "This connection is not allowed to run shell commands."
      case "capability_unavailable":
        return "Remote shell is not enabled on this host."
    }
  }
  return errorMessage(error)
}

function workspaceFileFields(result: WorkspaceReadFileResult): Omit<BrowserWorkspaceFileView, "path" | "loading"> {
  return {
    kind: result.kind,
    ...(result.content === undefined ? {} : { content: result.content }),
    ...(result.startLine === undefined ? {} : { startLine: result.startLine }),
    ...(result.totalLines === undefined ? {} : { totalLines: result.totalLines }),
    ...(result.nextStartLine === undefined ? {} : { nextStartLine: result.nextStartLine }),
    sizeBytes: result.sizeBytes,
    digest: result.digest,
  }
}
