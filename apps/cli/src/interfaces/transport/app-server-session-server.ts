import { interactionLeaseScopeForInput } from "@ag2cli/app-server-protocol/input-intent.js"
import {
  APP_SERVER_INTERACTION_LEASE_SCOPES,
  type AppServerInteractionLease,
  type AppServerInteractionLeases,
  type AppServerPresenceClient,
  type InteractionLeaseScope,
  type JsonRpcNotification,
  type JsonValue,
} from "@ag2cli/app-server-protocol/types.js"
import { asRecord, assertJsonValue, parseNonEmptyString, parseNonNegativeInteger } from "@ag2cli/app-server-protocol/validation.js"
import { AppServerClientError, AppServerRpcError, type AppServerRpcClient } from "@ag2cli/app-server-client/client.js"
import { SessionRecoveryToolkit, type SessionAttachOutcome } from "@ag2cli/app-server-client/session-recovery.js"
import { randomUUID } from "node:crypto"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import { EMPTY_MODEL_RESPONSE_FALLBACK, type RunResult } from "@ag2cli/core/execution/run.js"
import { runId, sessionId, type RunId, type SessionId } from "@ag2cli/core/ids.js"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import type {
  SessionClient,
  SessionEventListener,
  SessionExecuteOptions,
  SessionServer,
  SessionSubscriptionOverflow,
  SessionSubscriptionOptions,
  SessionTransientEventListener,
} from "@ag2cli/client/session-client.js"
import type { SessionCommand, SessionCommandResult } from "@ag2cli/protocol/session-command.js"
import { SESSION_PROTOCOL_VERSION } from "@ag2cli/protocol/session-command.js"
import { parseSessionCommandResult } from "@ag2cli/protocol/session-codec.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import type { InteractionLeaseBinding } from "../tui-interaction-lease.js"

export interface AppServerSessionServerAdapterOptions {
  readonly onError?: (error: unknown) => void
  /** Notify the adapter after a new physical App Server connection is ready. */
  readonly onConnectionReady?: (listener: () => void) => () => void
  /** Observe the authoritative presence and interaction state of an attached Session. */
  readonly onPresence?: (presence: AppServerSessionPresence) => void
  /** Inject an already acquired lease generation into protected wire requests. */
  readonly interactionLease?: InteractionLeaseBinding
}

export interface AppServerSessionPresence {
  readonly sessionId: SessionId
  readonly clients: readonly AppServerPresenceClient[]
  readonly leases: AppServerInteractionLeases
}

interface SessionSubscriptionState {
  readonly eventListeners: Set<SessionEventListener>
  readonly transientListeners: Set<SessionTransientEventListener>
  readonly overflowListeners: Set<(overflow: SessionSubscriptionOverflow) => void>
  readonly bufferedEvents: AgentEvent[]
  transientEvents: TransientStreamEvent[]
  transientBuffer?: TransientStreamEvent[]
  presence?: AppServerSessionPresence
  lastRevision: number
  attaching?: Promise<void>
  resyncAfterRevision?: number
  /** The raw `SessionRecoveryToolkit` attach promise `attaching` was derived from, used to tell
   * whether a later `ensureAttached` call can reuse `attaching` as-is (same underlying attach)
   * or must derive a fresh wrapper (the toolkit issued a genuinely new attach, e.g. after a
   * reconnect raced with the previous one still being in flight). */
  attachingFor?: Promise<SessionAttachOutcome<AttachedSessionData>>
}

interface AttachedSessionData {
  readonly snapshotRevision: number
  readonly events: readonly AgentEvent[]
  readonly presence: AppServerSessionPresence
  readonly transientEvents: readonly TransientStreamEvent[]
}

type TerminalRunEvent = Extract<AgentEvent, { type: "RunCompleted" | "RunFailed" | "RunCancelled" }>

interface PendingSubmit {
  readonly key: string
  readonly sessionId: SessionId
  readonly commandId: string
  readonly text: string
  readonly context?: readonly string[]
  readonly fileReferences?: readonly string[]
  readonly workspace?: string
  readonly promise: Promise<SessionCommandResult>
  intent?: "prompt" | "slash" | "mention" | "shell"
  runId?: RunId
  shellResult?: ToolResult
  terminal?: TerminalRunEvent
  completing: boolean
  settled: boolean
  readonly resolve: (result: SessionCommandResult) => void
  readonly reject: (error: unknown) => void
  attaching?: Promise<void>
  sending: boolean
  unsubscribe?: () => void
  signal?: AbortSignal
  onAccepted?: () => void
  abortHandler?: () => void
  acceptedNotified: boolean
}

/**
 * Adapts the public App Server protocol to the internal SessionClient shape.
 *
 * This is an edge adapter only: it owns no runtime, catalog, event store or
 * session state. The App Server connection remains the sole authority.
 */
export class AppServerSessionServerAdapter implements SessionServer {
  private readonly states = new Map<string, SessionSubscriptionState>()
  private readonly pendingSubmits = new Map<string, PendingSubmit>()
  private readonly removeNotification: () => void
  private readonly removeConnectionReady: () => void
  private readonly canReconnect: boolean
  private readonly recovery: SessionRecoveryToolkit<AttachedSessionData>
  private closed = false

  constructor(
    private readonly rpc: AppServerRpcClient,
    private readonly options: AppServerSessionServerAdapterOptions = {},
  ) {
    this.canReconnect = options.onConnectionReady !== undefined
    this.recovery = new SessionRecoveryToolkit((value, afterRevision) => this.performAttach(sessionId(value), afterRevision))
    this.removeNotification = rpc.onNotification((notification) => this.handleNotification(notification))
    this.removeConnectionReady =
      options.onConnectionReady?.(() => {
        this.recoverAttachedSessions()
        this.retryPendingSubmits()
      }) ?? (() => {})
  }

  connect(value: string): SessionClient {
    const id = sessionId(value)
    return {
      sessionId: id,
      execute: (command, options) => this.execute(id, command, options),
      subscribe: (afterRevision, listener, options) => this.subscribe(id, afterRevision, listener, options),
      subscribeTransient: (listener) => this.subscribeTransient(id, listener),
    }
  }

  async execute(id: SessionId, command: SessionCommand, options?: SessionExecuteOptions): Promise<SessionCommandResult> {
    if (this.closed) throw new Error("App Server session adapter is closed")
    switch (command.type) {
      case "get_snapshot":
        return this.readSnapshot(id, options)
      case "read_events":
        return this.readEvents(id, command.afterRevision ?? 0, options)
      case "create_plan":
        return this.createPlan(id, command, options)
      case "start_run":
        return this.submit(id, command.commandId, command.goal, options, {
          ...(command.context === undefined ? {} : { context: command.context }),
          ...(command.fileReferences === undefined ? {} : { fileReferences: command.fileReferences }),
          ...(command.workspace === undefined ? {} : { workspace: command.workspace }),
        })
      case "execute_user_shell":
        return this.submit(id, command.commandId, `!${command.command}`, options)
      case "read_trace":
        return this.readTrace(id, options)
      case "read_model_calls":
        return this.readModelCalls(id, command.includePayload === true, options)
      case "resolve_approval":
        return this.resolveApproval(id, command, options)
      default:
        return this.command(id, command, options)
    }
  }

  /** Create a canonical Session through the App Server catalog. */
  async createSession(value: string, workspaceId: string, title?: string, options?: SessionExecuteOptions): Promise<void> {
    const id = sessionId(value)
    await this.request(
      "session.create",
      {
        sessionId: id,
        workspaceId,
        ...(title === undefined ? {} : { title }),
      },
      options,
    )
  }

  /** End this connection's subscription and presence for one Session. */
  async detachSession(value: string, options?: SessionExecuteOptions): Promise<void> {
    const id = sessionId(value)
    const result = asRecord(await this.request("session.detach", { sessionId: id }, options), "session.detach.result")
    assertSessionResultId(result, id, "session.detach.result")
    if (typeof result.detached !== "boolean") throw new AppServerSessionAdapterError("session.detach.result.detached must be a boolean")
  }

  subscribe(id: SessionId, afterRevision: number, listener: SessionEventListener, options?: SessionSubscriptionOptions): () => void {
    const state = this.stateFor(id)
    state.lastRevision = Math.max(state.lastRevision, afterRevision)
    state.eventListeners.add(listener)
    if (options?.onOverflow) state.overflowListeners.add(options.onOverflow)
    void this.ensureAttached(id, state, afterRevision).catch(() => undefined)
    return () => {
      state.eventListeners.delete(listener)
      if (options?.onOverflow) state.overflowListeners.delete(options.onOverflow)
    }
  }

  subscribeTransient(id: SessionId, listener: SessionTransientEventListener): () => void {
    const state = this.stateFor(id)
    state.transientListeners.add(listener)
    void this.ensureAttached(id, state, state.lastRevision).catch(() => undefined)
    return () => {
      state.transientListeners.delete(listener)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.removeNotification()
    this.removeConnectionReady()
    for (const pending of [...this.pendingSubmits.values()]) {
      this.settlePendingSubmit(pending, new AppServerSessionAdapterError("App Server session adapter is closed"))
    }
    this.states.clear()
  }

  private async readSnapshot(id: SessionId, options?: SessionExecuteOptions): Promise<SessionCommandResult> {
    const result = asRecord(await this.request("session.snapshot", { sessionId: id }, options), "session.snapshot.result")
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "snapshot",
      snapshot: parseSnapshot(result.snapshot, id),
    }
  }

  private async readEvents(id: SessionId, afterRevision: number, options?: SessionExecuteOptions): Promise<SessionCommandResult> {
    const result = asRecord(await this.request("session.replay", { sessionId: id, afterRevision }, options), "session.replay.result")
    if (!Array.isArray(result.events)) throw new AppServerSessionAdapterError("session.replay.result.events must be an array")
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "events",
      events: parseEvents(result.events, id),
    }
  }

  private async createPlan(
    id: SessionId,
    command: Extract<SessionCommand, { readonly type: "create_plan" }>,
    options?: SessionExecuteOptions,
  ): Promise<SessionCommandResult> {
    const result = asRecord(
      await this.request(
        "session.plan",
        {
          sessionId: id,
          commandId: command.commandId,
          text: command.goal,
          ...(command.context === undefined ? {} : { context: command.context }),
          ...(command.workspace === undefined ? {} : { workspace: command.workspace }),
          ...leaseParams(this.currentLeaseReference(id, "composer")),
        },
        options,
      ),
      "session.plan.result",
    )
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "plan_created",
      plan: result.result as never,
      snapshot: parseSnapshot(result.snapshot, id),
    }
  }

  private async readTrace(id: SessionId, options?: SessionExecuteOptions): Promise<SessionCommandResult> {
    const result = asRecord(await this.request("session.trace", { sessionId: id }, options), "session.trace.result")
    assertSessionResultId(result, id, "session.trace.result")
    if (!Array.isArray(result.records)) throw new AppServerSessionAdapterError("session.trace.result.records must be an array")
    return parseSessionCommandResult({ protocolVersion: SESSION_PROTOCOL_VERSION, type: "trace", records: result.records }, id)
  }

  private async readModelCalls(id: SessionId, includePayload: boolean, options?: SessionExecuteOptions): Promise<SessionCommandResult> {
    const result = asRecord(
      await this.request("session.modelCalls", { sessionId: id, includePayload }, options),
      "session.modelCalls.result",
    )
    assertSessionResultId(result, id, "session.modelCalls.result")
    if (!Array.isArray(result.records)) throw new AppServerSessionAdapterError("session.modelCalls.result.records must be an array")
    return parseSessionCommandResult({ protocolVersion: SESSION_PROTOCOL_VERSION, type: "model_calls", records: result.records }, id)
  }

  private async submit(
    id: SessionId,
    commandId: string,
    text: string,
    options?: SessionExecuteOptions,
    extras?: {
      readonly context?: readonly string[]
      readonly fileReferences?: readonly string[]
      readonly workspace?: string
    },
  ): Promise<SessionCommandResult> {
    const pending = this.preparePendingSubmit(id, commandId, text, extras, options)
    try {
      await pending.attaching
    } catch (error) {
      if (this.deferSubmitForReconnect(pending, error)) return pending.promise
      this.settlePendingSubmit(pending, error)
      throw error
    }
    if (pending.settled) return pending.promise
    return this.sendPendingSubmit(pending)
  }

  private preparePendingSubmit(
    id: SessionId,
    commandId: string,
    text: string,
    extras:
      | {
          readonly context?: readonly string[]
          readonly fileReferences?: readonly string[]
          readonly workspace?: string
        }
      | undefined,
    options?: SessionExecuteOptions,
  ): PendingSubmit {
    const key = submitKey(id, commandId)
    if (this.pendingSubmits.has(key)) throw new AppServerSessionAdapterError(`commandId is already waiting to complete: ${commandId}`)

    let resolvePromise!: (result: SessionCommandResult) => void
    let rejectPromise!: (error: unknown) => void
    const promise = new Promise<SessionCommandResult>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const pending: PendingSubmit = {
      key,
      sessionId: id,
      commandId,
      text,
      ...(extras?.context === undefined ? {} : { context: extras.context }),
      ...(extras?.fileReferences === undefined ? {} : { fileReferences: extras.fileReferences }),
      ...(extras?.workspace === undefined ? {} : { workspace: extras.workspace }),
      completing: false,
      settled: false,
      resolve: resolvePromise,
      reject: rejectPromise,
      promise,
      sending: false,
      ...(options?.onAccepted === undefined ? {} : { onAccepted: options.onAccepted }),
      acceptedNotified: false,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    }
    this.pendingSubmits.set(key, pending)
    const state = this.stateFor(id)
    const listener: SessionEventListener = (events) => {
      for (const event of events) this.observePendingSubmit(pending, event)
    }
    state.eventListeners.add(listener)
    pending.unsubscribe = () => state.eventListeners.delete(listener)
    // TuiSessionController keeps a durable subscription for the lifetime of
    // the TUI. Reusing it here is important: a second session.attach would
    // detach the first server-side subscription and release this connection's
    // interaction lease just before session.submit is sent.
    if (state.eventListeners.size === 1) {
      void this.ensureAttached(id, state, state.lastRevision).catch(() => undefined)
    }
    pending.attaching = state.attaching
    if (pending.settled) pending.unsubscribe()
    if (options?.signal !== undefined) {
      pending.abortHandler = () => {
        void this.request("session.cancel", { sessionId: id, commandId }).catch(() => undefined)
        this.settlePendingSubmit(pending, abortError(options.signal))
      }
      if (options.signal.aborted) pending.abortHandler()
      else options.signal.addEventListener("abort", pending.abortHandler, { once: true })
    }
    return pending
  }

  private async sendPendingSubmit(pending: PendingSubmit): Promise<SessionCommandResult> {
    if (pending.settled) return pending.promise
    if (pending.sending) return pending.promise
    pending.sending = true
    try {
      const scope = interactionLeaseScopeForInput(pending.text)
      const result = asRecord(
        await this.request(
          "session.submit",
          {
            sessionId: pending.sessionId,
            commandId: pending.commandId,
            text: pending.text,
            ...(pending.context === undefined ? {} : { context: pending.context }),
            ...(pending.fileReferences === undefined ? {} : { fileReferences: pending.fileReferences }),
            ...(pending.workspace === undefined ? {} : { workspace: pending.workspace }),
            ...submitLeaseParams(this.currentLeaseReference(pending.sessionId, scope)),
          },
          { signal: pending.signal },
        ),
        "session.submit.result",
      )
      if (result.accepted !== true) throw new AppServerSessionAdapterError("session.submit.result.accepted must be true")
      if (!pending.acceptedNotified) {
        pending.acceptedNotified = true
        try {
          pending.onAccepted?.()
        } catch {
          // Acceptance has already happened; an observer cannot turn it into a transport failure.
        }
      }
      const intent = parseNonEmptyString(result.intent, "session.submit.result.intent")
      if (intent !== "prompt" && intent !== "slash" && intent !== "mention" && intent !== "shell") {
        throw new AppServerSessionAdapterError(`session.submit returned an unmappable intent: ${intent}`)
      }
      pending.intent = intent
      if (intent === "slash") {
        const action = parseNonEmptyString(result.action, "session.submit.result.action")
        const payload = asRecord(result.result, "session.submit.result.result")
        if (result.snapshot === undefined) throw new AppServerSessionAdapterError("session.submit.result.snapshot is missing")
        this.cancelPendingSubmit(pending)
        return parseSessionCommandResult(
          {
            protocolVersion: SESSION_PROTOCOL_VERSION,
            type: internalResultType(action),
            ...payload,
            snapshot: result.snapshot,
          },
          pending.sessionId,
        )
      }
      this.completePendingSubmitIfReady(pending)
      if (result.result === undefined || result.snapshot === undefined) return pending.promise

      this.cancelPendingSubmit(pending)
      const snapshot = parseSnapshot(result.snapshot, pending.sessionId)
      if (intent === "shell") {
        return {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          type: "shell_result",
          runId: runId(parseNonEmptyString(result.runId, "session.submit.result.runId")),
          result: result.result as never,
          snapshot,
        }
      }
      return {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "run_result",
        result: result.result as never,
        snapshot,
      }
    } catch (error) {
      if (this.deferSubmitForReconnect(pending, error)) return pending.promise
      this.cancelPendingSubmit(pending)
      throw error
    } finally {
      pending.sending = false
    }
  }

  private deferSubmitForReconnect(pending: PendingSubmit, error: unknown): boolean {
    if (pending.settled || pending.signal?.aborted || !this.canReconnect) return false
    if (isCommandInProgress(error)) {
      if (pending.intent === undefined) pending.intent = inferSubmitIntent(pending.text)
      return true
    }
    if (!isReconnectableSubmitError(error)) return false
    return true
  }

  private retryPendingSubmits(): void {
    if (this.closed) return
    for (const pending of [...this.pendingSubmits.values()]) {
      if (pending.settled || pending.sending || (pending.terminal !== undefined && pending.intent !== undefined)) continue
      void this.sendPendingSubmit(pending).catch((error: unknown) => {
        this.options.onError?.(error)
      })
    }
  }

  private observePendingSubmit(pending: PendingSubmit, event: AgentEvent): void {
    if (pending.settled) return
    if (event.type === "RunStarted" && event.payload.commandId === pending.commandId) {
      pending.runId = event.payload.runId
      return
    }
    if (pending.runId === undefined) return
    if (event.type === "ToolResultCommitted" && event.payload.runId === pending.runId) {
      pending.shellResult = event.payload.result
      return
    }
    if (
      (event.type === "RunCompleted" || event.type === "RunFailed" || event.type === "RunCancelled") &&
      event.payload.runId === pending.runId
    ) {
      pending.terminal = event
      this.completePendingSubmitIfReady(pending)
    }
  }

  private completePendingSubmitIfReady(pending: PendingSubmit): void {
    if (pending.settled || pending.completing || pending.intent === undefined || pending.terminal === undefined) return
    pending.completing = true
    void this.finishPendingSubmit(pending).catch((error: unknown) => {
      this.settlePendingSubmit(pending, error)
    })
  }

  private async finishPendingSubmit(pending: PendingSubmit): Promise<void> {
    const terminal = pending.terminal
    if (!terminal || !pending.intent) return
    const snapshotResult = await this.readSnapshot(pending.sessionId)
    if (snapshotResult.type !== "snapshot") throw new AppServerSessionAdapterError("session.snapshot did not return a snapshot")
    const snapshot = snapshotResult.snapshot
    if (pending.intent === "shell") {
      const result = pending.shellResult ?? shellResultFromTerminal(terminal)
      this.settlePendingSubmit(pending, undefined, {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        type: "shell_result",
        runId: terminal.payload.runId,
        result,
        snapshot,
      })
      return
    }
    this.settlePendingSubmit(pending, undefined, {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "run_result",
      result: runResultFromTerminal(terminal),
      snapshot,
    })
  }

  private settlePendingSubmit(pending: PendingSubmit, error?: unknown, result?: SessionCommandResult): void {
    if (pending.settled) return
    pending.settled = true
    this.pendingSubmits.delete(pending.key)
    pending.unsubscribe?.()
    if (pending.signal !== undefined && pending.abortHandler !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortHandler)
    }
    if (error !== undefined) pending.reject(error)
    else if (result !== undefined) pending.resolve(result)
    else pending.reject(new AppServerSessionAdapterError("Session submit did not return a result"))
  }

  private cancelPendingSubmit(pending: PendingSubmit): void {
    if (pending.settled) return
    pending.settled = true
    this.pendingSubmits.delete(pending.key)
    pending.unsubscribe?.()
    if (pending.signal !== undefined && pending.abortHandler !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortHandler)
    }
  }

  private async resolveApproval(
    id: SessionId,
    command: Extract<SessionCommand, { readonly type: "resolve_approval" }>,
    options?: SessionExecuteOptions,
  ): Promise<SessionCommandResult> {
    const result = asRecord(
      await this.request(
        "session.resolveApproval",
        {
          sessionId: id,
          runId: command.runId,
          turn: command.turn,
          toolUseId: command.toolUseId,
          preparedEventId: command.preparedEventId,
          expectedScopeRevision: command.expectedScopeRevision,
          expectedPolicyRevision: command.expectedPolicyRevision,
          decision: command.decision,
        },
        options,
      ),
      "session.resolveApproval.result",
    )
    return {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "snapshot",
      snapshot: parseSnapshot(result.snapshot, id),
    }
  }

  private async command(id: SessionId, command: AdapterSessionCommand, options?: SessionExecuteOptions): Promise<SessionCommandResult> {
    const commandId = "commandId" in command && typeof command.commandId === "string" ? command.commandId : `client-${randomUUID()}`
    const interactionScope = interactionScopeForCommand(command)
    const params = publicCommandParams(id, commandId, command, this.currentLeaseReference(id, interactionScope))
    const response = asRecord(await this.request("session.command", params, options), "session.command.result")
    if (response.accepted !== true) throw new AppServerSessionAdapterError("session.command.result.accepted must be true")
    if (parseNonEmptyString(response.sessionId, "session.command.result.sessionId") !== id.toString()) {
      throw new AppServerSessionAdapterError("session.command.result sessionId does not match")
    }
    if (parseNonEmptyString(response.commandId, "session.command.result.commandId") !== commandId) {
      throw new AppServerSessionAdapterError("session.command.result commandId does not match")
    }
    const action = parseNonEmptyString(response.action, "session.command.result.action")
    const payload = asRecord(response.result, "session.command.result.result")
    const snapshot = response.snapshot
    if (snapshot === undefined) throw new AppServerSessionAdapterError("session.command.result.snapshot is missing")
    const type = internalResultType(action)
    const normalized = {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type,
      ...payload,
      snapshot,
    }
    return parseSessionCommandResult(normalized, id)
  }

  private request(method: string, params: Record<string, unknown>, options?: SessionExecuteOptions): Promise<JsonValue> {
    return this.rpc.request(
      method,
      assertJsonValue(JSON.parse(JSON.stringify(params)), `${method}.params`),
      options?.signal === undefined ? undefined : { signal: options.signal },
    )
  }

  private currentLeaseReference(id: SessionId, scope: InteractionLeaseScope | "none"): InteractionLeaseReference | undefined {
    if (scope === "none" || this.options.interactionLease === undefined) return undefined
    const connection = this.options.interactionLease.connection()
    const generation = this.options.interactionLease.controller.currentGeneration(id.toString(), scope, connection.connectionId)
    return generation === undefined ? undefined : { scope, generation }
  }

  private stateFor(id: SessionId): SessionSubscriptionState {
    const key = id.toString()
    const existing = this.states.get(key)
    if (existing) return existing
    const state: SessionSubscriptionState = {
      eventListeners: new Set(),
      transientListeners: new Set(),
      overflowListeners: new Set(),
      bufferedEvents: [],
      transientEvents: [],
      lastRevision: 0,
    }
    this.states.set(key, state)
    return state
  }

  private ensureAttached(id: SessionId, state: SessionSubscriptionState, afterRevision: number): Promise<void> {
    const attachingFor = this.recovery.attach(id.toString(), afterRevision)
    if (state.attaching && state.attachingFor === attachingFor) return state.attaching
    const attaching = attachingFor
      .then((outcome) => this.applyAttachOutcome(state, outcome))
      .catch((error: unknown) => {
        this.options.onError?.(error)
        throw error
      })
    state.attaching = attaching
    state.attachingFor = attachingFor
    void attaching.then(
      () => this.clearAttachment(state, attaching),
      () => this.clearAttachment(state, attaching),
    )
    return attaching
  }

  /** Performs one Session's `session.attach` RPC and returns its parsed result; staleness
   * (a reconnect superseding this attach before it resolves) is decided by the caller via the
   * `SessionRecoveryToolkit` outcome, not here -- this only knows how to fetch and parse. */
  private async performAttach(id: SessionId, afterRevision: number): Promise<AttachedSessionData> {
    const state = this.stateFor(id)
    const transientBuffer: TransientStreamEvent[] = []
    state.transientEvents = []
    state.transientBuffer = transientBuffer
    try {
      const result = asRecord(
        await this.request("session.attach", { sessionId: id, afterRevision, includeTransient: true }),
        "session.attach.result",
      )
      const snapshot = parseSnapshot(result.snapshot, id)
      if (!Array.isArray(result.events)) throw new AppServerSessionAdapterError("session.attach.result.events must be an array")
      const attachedTransient = result.transientEvents === undefined ? [] : parseTransientEvents(result.transientEvents, id)
      return {
        snapshotRevision: snapshot.lastRevision,
        events: parseEvents(result.events, id),
        presence: parsePresence(result.presence, id),
        transientEvents: mergeTransientEvents(attachedTransient, state.transientBuffer ?? transientBuffer),
      }
    } finally {
      if (state.transientBuffer === transientBuffer) state.transientBuffer = undefined
    }
  }

  /** Publishes one attach's events/presence/transient events, unless it was superseded by a
   * newer reconnect (`outcome.current === false`) in which case it is silently discarded. */
  private applyAttachOutcome(state: SessionSubscriptionState, outcome: SessionAttachOutcome<AttachedSessionData>): void {
    if (!outcome.current || outcome.result === undefined) return
    const { snapshotRevision, events, presence, transientEvents } = outcome.result
    state.lastRevision = Math.max(state.lastRevision, snapshotRevision)
    for (const event of events) this.publishEvent(state, event, false)
    const bufferedEvents = state.bufferedEvents.splice(0)
    for (const event of [...bufferedEvents].sort((left, right) => left.revision - right.revision)) {
      this.publishEvent(state, event, false)
    }
    this.publishPresence(state, presence)
    state.transientEvents = [...transientEvents]
    for (const event of transientEvents) this.notifyTransient(state, event)
  }

  private recoverAttachedSessions(): void {
    if (this.closed) return
    this.recovery.reconnected()
    for (const [value, state] of this.states) {
      if (state.eventListeners.size === 0 && state.transientListeners.size === 0) continue
      void this.ensureAttached(sessionId(value), state, state.lastRevision).catch(() => undefined)
    }
  }

  private clearAttachment(state: SessionSubscriptionState, attaching: Promise<void>): void {
    if (state.attaching !== attaching) return
    state.attaching = undefined
    state.attachingFor = undefined
  }

  private handleNotification(notification: JsonRpcNotification): void {
    try {
      if (notification.method === "session.event") {
        const params = asRecord(notification.params, "session.event.params")
        const id = sessionId(parseNonEmptyString(params.sessionId, "sessionId"))
        const state = this.states.get(id.toString())
        if (!state) return
        this.publishEvent(state, parseEvent(params.event, id, params.revision))
        return
      }
      if (notification.method === "session.transient") {
        const params = asRecord(notification.params, "session.transient.params")
        const id = sessionId(parseNonEmptyString(params.sessionId, "sessionId"))
        const state = this.states.get(id.toString())
        if (!state) return
        const event = parseTransientEvent(params.event, id)
        this.publishTransient(state, event)
        return
      }
      if (notification.method === "session.resyncRequired") {
        const params = asRecord(notification.params, "session.resyncRequired.params")
        const id = sessionId(parseNonEmptyString(params.sessionId, "sessionId"))
        const state = this.states.get(id.toString())
        if (!state) return
        const minimumRevision = parseNonNegativeInteger(params.minimumRevision, "minimumRevision")
        const overflow: SessionSubscriptionOverflow = {
          channel: "durable",
          sessionId: id,
          cursor: Math.max(0, minimumRevision - 1),
          queued: 0,
        }
        this.signalOverflow(id, state, overflow)
        return
      }
      if (notification.method === "presence.updated") {
        const params = asRecord(notification.params, "presence.updated.params")
        const id = sessionId(parseNonEmptyString(params.sessionId, "sessionId"))
        const state = this.states.get(id.toString())
        if (!state) return
        this.publishPresence(state, {
          sessionId: id,
          clients: parsePresenceClients(params.clients, "presence.updated.clients"),
          leases: state.presence?.leases ?? defaultLeases(),
        })
        return
      }
      if (notification.method === "interaction.lease.updated") {
        const params = asRecord(notification.params, "interaction.lease.updated.params")
        const id = sessionId(parseNonEmptyString(params.sessionId, "sessionId"))
        const state = this.states.get(id.toString())
        if (!state) return
        this.publishPresence(state, {
          sessionId: id,
          clients: state.presence?.clients ?? [],
          leases: parseInteractionLeases(params.leases, "interaction.lease.updated.leases"),
        })
        return
      }
      if (notification.method === "session.operation.failed") {
        const params = asRecord(notification.params, "session.operation.failed.params")
        const id = sessionId(parseNonEmptyString(params.sessionId, "sessionId"))
        const commandId = parseNonEmptyString(params.commandId, "commandId")
        const pending = this.pendingSubmits.get(submitKey(id, commandId))
        if (!pending) return
        const message = parseNonEmptyString(params.message, "message")
        this.settlePendingSubmit(pending, new AppServerSessionAdapterError(`Session operation failed: ${message}`))
      }
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  private publishEvent(state: SessionSubscriptionState, event: AgentEvent, bufferGapsDuringAttach = true): void {
    if (event.revision <= state.lastRevision) return
    if (event.revision > state.lastRevision + 1) {
      if (bufferGapsDuringAttach && state.attaching !== undefined) {
        if (!state.bufferedEvents.some((buffered) => buffered.eventId === event.eventId)) state.bufferedEvents.push(event)
        return
      }
      this.signalOverflow(event.sessionId, state, {
        channel: "durable",
        sessionId: event.sessionId,
        cursor: state.lastRevision,
        queued: 0,
      })
      return
    }
    state.lastRevision = event.revision
    if (event.type === "RunCompleted" || event.type === "RunFailed" || event.type === "RunCancelled") {
      const terminalRunId = event.payload.runId.toString()
      // Run-scoped kinds clear with their run.
      const belongsToRun = (item: TransientStreamEvent): boolean =>
        "runId" in item.payload && item.payload.runId.toString() === terminalRunId
      state.transientEvents = state.transientEvents.filter((item) => !belongsToRun(item))
      if (state.transientBuffer) {
        state.transientBuffer = state.transientBuffer.filter((item) => !belongsToRun(item))
      }
    }
    for (const listener of [...state.eventListeners]) {
      try {
        listener([event])
      } catch (error) {
        this.options.onError?.(error)
      }
    }
  }

  private publishTransient(state: SessionSubscriptionState, event: TransientStreamEvent): void {
    if (state.transientBuffer) {
      state.transientBuffer.push(event)
      return
    }
    if (state.transientEvents.some((item) => item.eventId === event.eventId)) return
    state.transientEvents = [...mergeTransientEvents(state.transientEvents, [event])]
    this.notifyTransient(state, event)
  }

  private notifyTransient(state: SessionSubscriptionState, event: TransientStreamEvent): void {
    for (const listener of [...state.transientListeners]) {
      try {
        listener(event)
      } catch (error) {
        this.options.onError?.(error)
      }
    }
  }

  private signalOverflow(id: SessionId, state: SessionSubscriptionState, overflow: SessionSubscriptionOverflow): void {
    for (const listener of [...state.overflowListeners]) {
      try {
        listener(overflow)
      } catch (error) {
        this.options.onError?.(error)
      }
    }
    state.resyncAfterRevision = Math.min(state.resyncAfterRevision ?? overflow.cursor, overflow.cursor)
    const attach = (): void => {
      const afterRevision = state.resyncAfterRevision
      if (afterRevision === undefined) return
      state.resyncAfterRevision = undefined
      void this.ensureAttached(id, state, afterRevision).catch((error: unknown) => this.options.onError?.(error))
    }
    if (state.attaching === undefined) attach()
    else void state.attaching.then(attach, attach).catch((error: unknown) => this.options.onError?.(error))
  }

  private publishPresence(state: SessionSubscriptionState, presence: AppServerSessionPresence): void {
    state.presence = presence
    try {
      this.options.onPresence?.(presence)
    } catch (error) {
      this.options.onError?.(error)
    }
  }
}

export class AppServerSessionAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AppServerSessionAdapterError"
  }
}

function parseSnapshot(value: unknown, id: SessionId): SessionSnapshot {
  const snapshot = asRecord(value, "session.snapshot")
  if (snapshot.sessionId !== id.toString()) throw new AppServerSessionAdapterError("Session snapshot sessionId does not match")
  parseNonNegativeInteger(snapshot.lastRevision, "snapshot.lastRevision")
  return snapshot as unknown as SessionSnapshot
}

function assertSessionResultId(result: Record<string, unknown>, id: SessionId, name: string): void {
  if (parseNonEmptyString(result.sessionId, `${name}.sessionId`) !== id.toString()) {
    throw new AppServerSessionAdapterError(`${name}.sessionId does not match the target Session`)
  }
}

function parseEvents(value: readonly unknown[], id: SessionId): readonly AgentEvent[] {
  return value.map((event, index) => parseEvent(event, id, undefined, index))
}

function parseEvent(value: unknown, id: SessionId, expectedRevision?: unknown, index?: number): AgentEvent {
  const event = asRecord(value, `session.event${index === undefined ? "" : `[${index}]`}`)
  if (event.sessionId !== id.toString()) throw new AppServerSessionAdapterError("Session event sessionId does not match")
  const revision = parseNonNegativeInteger(event.revision, "event.revision")
  if (expectedRevision !== undefined && revision !== expectedRevision) {
    throw new AppServerSessionAdapterError("Session event revision does not match")
  }
  return event as unknown as AgentEvent
}

function parseTransientEvent(value: unknown, id: SessionId, index?: number): TransientStreamEvent {
  const event = asRecord(value, `session.transient.event${index === undefined ? "" : `[${index}]`}`)
  if (event.sessionId !== id.toString()) throw new AppServerSessionAdapterError("Session transient event sessionId does not match")
  parseNonEmptyString(event.eventId, "transient.eventId")
  parseNonEmptyString(event.type, "transient.type")
  return event as unknown as TransientStreamEvent
}

function parseTransientEvents(value: unknown, id: SessionId): readonly TransientStreamEvent[] {
  if (!Array.isArray(value)) throw new AppServerSessionAdapterError("session.attach.result.transientEvents must be an array")
  return value.map((event, index) => parseTransientEvent(event, id, index))
}

function parsePresence(value: unknown, id: SessionId): AppServerSessionPresence {
  const record = asRecord(value, "session.attach.result.presence")
  if (record.sessionId !== id.toString()) throw new AppServerSessionAdapterError("Session presence sessionId does not match")
  return {
    sessionId: id,
    clients: parsePresenceClients(record.clients, "session.attach.result.presence.clients"),
    leases: parseInteractionLeases(record.leases, "session.attach.result.presence.leases"),
  }
}

function parsePresenceClients(value: unknown, name: string): readonly AppServerPresenceClient[] {
  if (!Array.isArray(value)) throw new AppServerSessionAdapterError(`${name} must be an array`)
  return value.map((item, index) => {
    const record = asRecord(item, `${name}[${index}]`)
    const clientKind = parseClientKind(record.clientKind, `${name}[${index}].clientKind`)
    return {
      connectionId: parseNonEmptyString(record.connectionId, `${name}[${index}].connectionId`),
      deviceId: parseNonEmptyString(record.deviceId, `${name}[${index}].deviceId`),
      clientId: parseNonEmptyString(record.clientId, `${name}[${index}].clientId`),
      clientKind,
      name: parseNonEmptyString(record.name, `${name}[${index}].name`),
      version: parseNonEmptyString(record.version, `${name}[${index}].version`),
    }
  })
}

function parseInteractionLeases(value: unknown, name: string): AppServerInteractionLeases {
  const record = asRecord(value, name)
  return {
    composer: parseInteractionLease(record.composer, `${name}.composer`),
    "session-control": parseInteractionLease(record["session-control"], `${name}.session-control`),
  }
}

function parseInteractionLease(value: unknown, name: string): AppServerInteractionLease {
  const record = asRecord(value, name)
  if (record.status !== "available" && record.status !== "held") {
    throw new AppServerSessionAdapterError(`${name}.status is invalid`)
  }
  const generation = parseNonNegativeInteger(record.generation, `${name}.generation`)
  const holder = record.holder === undefined ? undefined : parseInteractionHolder(record.holder, `${name}.holder`)
  if (record.status === "held" && holder === undefined) throw new AppServerSessionAdapterError(`${name}.holder must be present`)
  const expiresAt = record.expiresAt === undefined ? undefined : parseNonEmptyString(record.expiresAt, `${name}.expiresAt`)
  return {
    status: record.status,
    generation,
    ...(holder === undefined ? {} : { holder }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

function parseInteractionHolder(value: unknown, name: string): AppServerInteractionLease["holder"] {
  const record = asRecord(value, name)
  const clientKind = parseClientKind(record.clientKind, `${name}.clientKind`)
  return {
    connectionId: parseNonEmptyString(record.connectionId, `${name}.connectionId`),
    deviceId: parseNonEmptyString(record.deviceId, `${name}.deviceId`),
    clientId: parseNonEmptyString(record.clientId, `${name}.clientId`),
    clientKind,
    name: parseNonEmptyString(record.name, `${name}.name`),
  }
}

function parseClientKind(value: unknown, name: string): AppServerPresenceClient["clientKind"] {
  if (
    value === "tui" ||
    value === "web" ||
    value === "mobile" ||
    value === "desktop" ||
    value === "acp" ||
    value === "script" ||
    value === "unknown"
  ) {
    return value
  }
  throw new AppServerSessionAdapterError(`${name} is invalid`)
}

function defaultLeases(): AppServerInteractionLeases {
  return Object.fromEntries(
    APP_SERVER_INTERACTION_LEASE_SCOPES.map((scope) => [scope, { status: "available" as const, generation: 0 }]),
  ) as AppServerInteractionLeases
}

type AdapterSessionCommand = Exclude<
  SessionCommand,
  {
    readonly type: "get_snapshot" | "read_events" | "read_trace" | "read_model_calls" | "create_plan" | "start_run" | "resolve_approval"
  }
>

interface InteractionLeaseReference {
  readonly scope: InteractionLeaseScope
  readonly generation: number
}

function mergeTransientEvents(
  existing: readonly TransientStreamEvent[],
  incoming: readonly TransientStreamEvent[],
): readonly TransientStreamEvent[] {
  const byId = new Map<string, TransientStreamEvent>()
  for (const event of existing) byId.set(event.eventId, event)
  for (const event of incoming) byId.set(event.eventId, event)
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence).slice(-512)
}

function publicCommandParams(
  id: SessionId,
  commandId: string,
  command: AdapterSessionCommand,
  lease?: InteractionLeaseReference,
): Record<string, unknown> {
  const base = { sessionId: id, commandId, ...leaseParams(lease) }
  switch (command.type) {
    case "add_additional_directory":
      return {
        ...base,
        action: {
          type: "addDirectory",
          directory: command.directory,
          ...(command.workspaceRoot === undefined ? {} : { workspaceRoot: command.workspaceRoot }),
          ...(command.expectedScopeRevision === undefined ? {} : { expectedScopeRevision: command.expectedScopeRevision }),
        },
      }
    case "set_permission_mode":
      return {
        ...base,
        action: {
          type: "setPermissionMode",
          mode: command.mode,
          ...(command.expectedPolicyRevision === undefined ? {} : { expectedPolicyRevision: command.expectedPolicyRevision }),
        },
      }
    case "set_permission_rules":
      return {
        ...base,
        action: {
          type: "setPermissionRules",
          rules: command.rules,
          ...(command.expectedPolicyRevision === undefined ? {} : { expectedPolicyRevision: command.expectedPolicyRevision }),
        },
      }
    case "execute_shell":
      return {
        ...base,
        action: {
          type: "executeShell",
          argv: command.argv,
          ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
          ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
        },
      }
    case "execute_user_shell":
      return {
        ...base,
        action: {
          type: "executeUserShell",
          command: command.command,
          ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
          ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
        },
      }
    case "compact":
      return { ...base, action: { type: "compact", ...(command.instructions === undefined ? {} : { instructions: command.instructions }) } }
    case "set_context_window":
      return { ...base, action: { type: "setContextWindow", contextWindow: command.contextWindow } }
    case "clear_context_window":
      return { ...base, action: { type: "clearContextWindow" } }
    case "set_agent":
      return { ...base, action: { type: "setAgent", ...(command.agentName === undefined ? {} : { agentName: command.agentName }) } }
    case "update_goal":
      return { ...base, action: { type: "updateGoal", update: command.update } }
    case "create_task":
      return {
        ...base,
        action: {
          type: "createTask",
          taskType: command.taskType,
          title: command.title,
          ...(command.prompt === undefined ? {} : { prompt: command.prompt }),
          ...(command.argv === undefined ? {} : { argv: command.argv }),
          ...(command.intervalMs === undefined ? {} : { intervalMs: command.intervalMs }),
          ...(command.maxRuns === undefined ? {} : { maxRuns: command.maxRuns }),
          ...(command.workspace === undefined ? {} : { workspace: command.workspace }),
          ...(command.parentRunId === undefined ? {} : { parentRunId: command.parentRunId }),
        },
      }
    case "list_tasks":
      return { ...base, action: { type: "listTasks" } }
    case "cancel_task":
      return {
        ...base,
        action: { type: "cancelTask", taskId: command.taskId, ...(command.reason === undefined ? {} : { reason: command.reason }) },
      }
    case "list_checkpoints":
      return { ...base, action: { type: "listCheckpoints" } }
    case "preview_rewind":
      return {
        ...base,
        ...(command.expectedRevision === undefined ? {} : { expectedRevision: command.expectedRevision }),
        action: {
          type: "previewRewind",
          checkpointId: command.checkpointId,
        },
      }
    case "rewind":
      return {
        ...base,
        ...(command.expectedRevision === undefined ? {} : { expectedRevision: command.expectedRevision }),
        action: {
          type: "rewind",
          checkpointId: command.checkpointId,
        },
      }
    case "steer":
      return {
        ...base,
        action: { type: "steer", runId: command.runId.toString(), text: command.text },
      }
    case "cancel_input":
      return {
        ...base,
        action: {
          type: "cancelInput",
          inputId: command.inputId,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        },
      }
  }
}

function interactionScopeForCommand(command: AdapterSessionCommand): InteractionLeaseScope | "none" {
  switch (command.type) {
    case "set_permission_mode":
    case "set_permission_rules":
    case "preview_rewind":
    case "rewind":
      return "session-control"
    case "list_tasks":
    case "cancel_task":
    case "list_checkpoints":
      return "none"
    default:
      return "composer"
  }
}

function leaseParams(reference: InteractionLeaseReference | undefined): Record<string, unknown> {
  return reference === undefined ? {} : { lease: reference }
}

function submitLeaseParams(reference: InteractionLeaseReference | undefined): Record<string, unknown> {
  return reference === undefined ? {} : { lease: { [reference.scope]: reference.generation } }
}

function internalResultType(action: string): string {
  switch (action) {
    case "directoryAdded":
      return "additional_directory_added"
    case "permissionUpdated":
      return "permission_updated"
    case "compacted":
      return "compacted"
    case "contextWindowUpdated":
      return "context_window_updated"
    case "agentUpdated":
      return "agent_updated"
    case "goalUpdated":
      return "goal_updated"
    case "taskCreated":
      return "task_created"
    case "tasksListed":
      return "tasks"
    case "taskCancelled":
      return "task_cancelled"
    case "checkpointsListed":
      return "checkpoints"
    case "rewindPreviewed":
      return "rewind_preview"
    case "rewound":
      return "rewind_result"
    case "inputAccepted":
      return "input_accepted"
    case "inputCancelled":
      return "input_cancelled"
    case "shellResult":
      return "shell_result"
    default:
      throw new AppServerSessionAdapterError(`session.command returned an unmappable action: ${action}`)
  }
}

function submitKey(id: SessionId, commandId: string): string {
  return `${id}:${commandId}`
}

function isReconnectableSubmitError(error: unknown): error is AppServerClientError {
  return error instanceof AppServerClientError && (error.kind === "transport_closed" || error.kind === "not_connected")
}

function isCommandInProgress(error: unknown): error is AppServerRpcError {
  return error instanceof AppServerRpcError && error.kind === "command_in_progress"
}

function inferSubmitIntent(text: string): "prompt" | "shell" {
  return text.trimStart().startsWith("!") ? "shell" : "prompt"
}

function runResultFromTerminal(event: TerminalRunEvent): RunResult {
  switch (event.type) {
    case "RunCompleted":
      return {
        runId: event.payload.runId,
        status: "completed",
        turns: event.payload.turns,
        finalText: event.payload.finalText.trim().length > 0 ? event.payload.finalText : EMPTY_MODEL_RESPONSE_FALLBACK,
      }
    case "RunFailed":
      return {
        runId: event.payload.runId,
        status: "failed",
        turns: event.payload.turns,
        error: event.payload.message,
        ...(event.payload.code !== undefined ? { failureCode: event.payload.code } : {}),
      }
    case "RunCancelled":
      return {
        runId: event.payload.runId,
        status: "cancelled",
        turns: event.payload.turns,
        ...(event.payload.reason === undefined ? {} : { error: event.payload.reason }),
      }
  }
}

function shellResultFromTerminal(event: TerminalRunEvent): ToolResult {
  switch (event.type) {
    case "RunCompleted":
      return { content: event.payload.finalText }
    case "RunFailed":
      return { content: event.payload.message, isError: true }
    case "RunCancelled":
      return { content: event.payload.reason ?? "Shell execution cancelled", isError: true }
  }
}

function abortError(signal?: AbortSignal): DOMException {
  return signal?.reason instanceof DOMException
    ? signal.reason
    : signal?.reason instanceof Error
      ? new DOMException(signal.reason.message, "AbortError")
      : new DOMException("Request was aborted", "AbortError")
}
