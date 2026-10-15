import { interactionLeaseScopeForInput } from "@ag2cli/app-server-protocol/input-intent.js"
import { asRecord } from "@ag2cli/app-server-protocol/validation.js"
import type { AppServerPresenceClient, ServerInitializeResult } from "@ag2cli/app-server-protocol/types.js"
import { AppServerRpcError } from "@ag2cli/app-server-client/client.js"
import {
  attachBrowserSession,
  connectBrowserAppServer,
  createBrowserSession,
  createBrowserSessionSubmitParams,
  deleteBrowserSession,
  detachBrowserSession,
  listBrowserSessions,
  parseNotificationEvents,
  serverWorkspaces,
  type BrowserAppServerConnection,
  type BrowserSessionRecord,
  type BrowserWorkspace,
} from "./app-server"
import {
  mergeWireEvents,
  mergeTransientEvents,
  pruneTransientEvents,
  type PendingApproval,
  type WireEvent,
  type WireTransientEvent,
} from "./conversation"
import { BrowserInteractionLeaseController } from "./interaction"

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting"
export interface BrowserClientState {
  readonly status: ConnectionStatus
  readonly endpoint: string
  readonly error?: string
  readonly initialize?: ServerInitializeResult
  readonly workspaces: readonly BrowserWorkspace[]
  readonly sessions: readonly BrowserSessionRecord[]
  readonly selectedWorkspaceId?: string
  readonly activeSessionId?: string
  readonly loadingSession: boolean
  readonly sending: boolean
  readonly events: readonly WireEvent[]
  readonly transientEvents: readonly WireTransientEvent[]
  readonly presence: readonly AppServerPresenceClient[]
  readonly pendingCommands: readonly string[]
}

export type BrowserConnector = typeof connectBrowserAppServer

export class BrowserClient {
  private state: BrowserClientState = {
    status: "disconnected",
    endpoint: "",
    workspaces: [],
    sessions: [],
    loadingSession: false,
    sending: false,
    events: [],
    transientEvents: [],
    presence: [],
    pendingCommands: [],
  }
  private readonly listeners = new Set<() => void>()
  private connection?: BrowserAppServerConnection
  private abort?: AbortController
  private removers: Array<() => void> = []
  private generation = 0
  private selection = 0
  private attachedSessionId?: string
  private queue: Promise<void> = Promise.resolve()
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryAttempt = 0
  private connectionOptions: Parameters<BrowserConnector>[2]
  private readonly leases = new BrowserInteractionLeaseController({
    isCurrent: (sessionId, connection) => this.state.activeSessionId === sessionId && this.connection?.rpc === connection.rpc,
  })

  constructor(
    private readonly clientId: string,
    private readonly connector: BrowserConnector = connectBrowserAppServer,
  ) {}

  getSnapshot = (): BrowserClientState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(patch: Partial<BrowserClientState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  dismissError(): void {
    this.update({ error: undefined })
  }

  async connect(endpoint: string, options: Parameters<BrowserConnector>[2] = {}, automatic = false): Promise<void> {
    const sameHost = endpoint === this.state.endpoint
    const selected = sameHost ? this.state.activeSessionId : undefined
    this.disconnect(false)
    const generation = this.generation
    const abort = new AbortController()
    this.abort = abort
    this.connectionOptions = options
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
            events: [],
            transientEvents: [],
            pendingCommands: [],
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
            const parsed = parseNotificationEvents(notification)
            if (!parsed) return
            const sessionId = parsed.kind === "event" || parsed.kind === "transient" ? parsed.event.sessionId : parsed.sessionId
            if (sessionId !== this.state.activeSessionId) return
            if (parsed.kind === "event") {
              const revision = this.state.events.at(-1)?.revision ?? 0
              this.mergeEvents([parsed.event])
              if (parsed.event.revision > revision + 1 && !this.state.loadingSession) void this.recover()
            } else if (parsed.kind === "transient") {
              this.update({
                transientEvents: pruneTransientEvents(this.state.events, mergeTransientEvents(this.state.transientEvents, [parsed.event])),
              })
            } else if (parsed.kind === "presence") this.update({ presence: parsed.clients })
            else if (parsed.kind === "lease") this.leases.observe(sessionId, parsed.leases)
            else if (parsed.kind === "resync") void this.recover()
            else if (parsed.kind === "operationFailed")
              this.update({ error: parsed.message, pendingCommands: this.state.pendingCommands.filter((id) => id !== parsed.commandId) })
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
      if (selected && sessions.some((session) => session.sessionId === selected)) await this.selectSession(selected)
      else this.resetSession()
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
    this.update({
      presence: [],
      transientEvents: [],
      loadingSession: false,
      sending: false,
      ...(clear ? { status: "disconnected", initialize: undefined } : {}),
    })
  }

  private resetSession(): void {
    this.leases.reset()
    this.update({ activeSessionId: undefined, events: [], transientEvents: [], presence: [], pendingCommands: [], loadingSession: false })
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
    this.leases.reset()
    this.update({
      activeSessionId: sessionId,
      selectedWorkspaceId: session?.workspaceId ?? this.state.selectedWorkspaceId,
      loadingSession: true,
      error: undefined,
      events: [],
      transientEvents: [],
      presence: [],
      pendingCommands: [],
    })
    const current = (): boolean => this.connection === connection && selection === this.selection
    // Serialize subscription changes so a late attach cannot revive an abandoned session.
    const attach = async (): Promise<void> => {
      if (!current()) return
      if (this.attachedSessionId && this.attachedSessionId !== sessionId) await detachBrowserSession(connection.rpc, this.attachedSessionId)
      if (!current()) return
      this.attachedSessionId = sessionId
      const state = await attachBrowserSession(connection.rpc, sessionId, 0)
      if (!current()) return
      this.leases.observe(sessionId, state.leases)
      this.mergeEvents(state.events)
      this.update({
        presence: state.presence,
        transientEvents: pruneTransientEvents(this.state.events, mergeTransientEvents(state.transientEvents, this.state.transientEvents)),
        loadingSession: false,
      })
    }
    this.queue = this.queue.then(attach, attach).catch((error) => {
      if (current()) this.update({ loadingSession: false, error: errorMessage(error) })
    })
    await this.queue
  }

  async recover(): Promise<void> {
    if (this.state.loadingSession) return
    const sessionId = this.state.activeSessionId
    if (sessionId) await this.selectSession(sessionId)
  }

  private mergeEvents(incoming: readonly WireEvent[]): void {
    const events = mergeWireEvents(this.state.events, incoming)
    const pending = new Set(this.state.pendingCommands)
    const runs = new Map<string, string>()
    for (const event of events) {
      const commandId = typeof event.payload.commandId === "string" ? event.payload.commandId : undefined
      const runId = typeof event.payload.runId === "string" ? event.payload.runId : undefined
      if ((event.type === "RunStarted" || event.type === "InputConsumed") && commandId && runId) {
        pending.add(commandId)
        runs.set(runId, commandId)
      }
      if (["RunCompleted", "RunFailed", "RunCancelled"].includes(event.type) && runId) {
        const command = runs.get(runId)
        if (command) pending.delete(command)
      }
    }
    const title = [...events].reverse().find((event) => event.type === "SessionTitleSet")?.payload.title
    this.update({
      events,
      transientEvents: pruneTransientEvents(events, this.state.transientEvents),
      pendingCommands: [...pending],
      sessions: this.state.sessions.map((session) =>
        session.sessionId === this.state.activeSessionId
          ? { ...session, lastRevision: events.at(-1)?.revision ?? session.lastRevision, ...(typeof title === "string" ? { title } : {}) }
          : session,
      ),
    })
  }

  async send(text: string): Promise<boolean> {
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
    this.update({ sending: true, error: undefined })
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
      const selectedSessionId = sessionId
      const scope = interactionLeaseScopeForInput(text.trim())
      if (scope === "session-control") throw new Error("Permission controls are not included in this client yet.")
      const commandId = crypto.randomUUID()
      return (
        (await this.leases.withLease(
          selectedSessionId,
          scope,
          { rpc: connection.rpc, connectionId: connection.initialize.connection.connectionId },
          {},
          async (leaseGeneration) => {
            if (generation !== this.generation || this.state.activeSessionId !== selectedSessionId) return false
            this.update({ pendingCommands: [...this.state.pendingCommands, commandId] })
            try {
              const result = asRecord(
                await connection.rpc.request(
                  "session.submit",
                  createBrowserSessionSubmitParams(selectedSessionId, commandId, text.trim(), scope, leaseGeneration),
                ),
                "session.submit.result",
              )
              if (generation !== this.generation || this.state.activeSessionId !== selectedSessionId) return false
              if (result.accepted !== true) throw new Error("App Server did not accept the message")
              if (result.intent === "slash") this.update({ pendingCommands: this.state.pendingCommands.filter((id) => id !== commandId) })
              return true
            } catch (error) {
              if (generation === this.generation && this.state.activeSessionId === selectedSessionId)
                this.update({ pendingCommands: this.state.pendingCommands.filter((id) => id !== commandId) })
              throw error
            }
          },
        )) ?? false
      )
    } catch (error) {
      if (generation === this.generation) this.update({ error: errorMessage(error) })
      return false
    } finally {
      if (generation === this.generation) this.update({ sending: false })
    }
  }

  async cancel(): Promise<void> {
    const commandId = this.state.pendingCommands.at(-1)
    if (!this.connection || !this.state.activeSessionId || !commandId) return
    try {
      await this.connection.rpc.request("session.cancel", { sessionId: this.state.activeSessionId, commandId })
    } catch (error) {
      this.update({ error: errorMessage(error) })
    }
  }

  async resolveApproval(approval: PendingApproval, decision: "approved" | "denied"): Promise<void> {
    const connection = this.connection
    const sessionId = this.state.activeSessionId
    if (!connection || !sessionId) return
    try {
      await connection.rpc.request("session.resolveApproval", {
        sessionId,
        runId: approval.runId,
        turn: approval.turn,
        toolUseId: approval.toolUseId,
        preparedEventId: approval.preparedEventId,
        expectedScopeRevision: approval.expectedScopeRevision,
        expectedPolicyRevision: approval.expectedPolicyRevision,
        decision,
      })
    } catch (error) {
      // Any connected client may resolve first; the resulting event removes the card here.
      if (error instanceof AppServerRpcError && (error.kind === "approval_already_resolved" || error.kind === "stale_approval")) return
      this.update({ error: errorMessage(error) })
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
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
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
