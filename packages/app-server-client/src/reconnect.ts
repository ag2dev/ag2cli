import type { JsonRpcNotification, JsonValue, ServerInitializeResult } from "@ag2cli/app-server-protocol/types.js"
import { AppServerClientError, type AppServerCloseListener, type AppServerNotificationListener, type AppServerRpcClient } from "./client.js"

export interface ConnectedAppServerClient {
  readonly client: AppServerRpcClient
  readonly initialize: ServerInitializeResult
}

export type AppServerClientConnector = () => Promise<ConnectedAppServerClient>

export type AppServerConnectionState = "disconnected" | "connecting" | "connected" | "closed"

export interface AppServerConnectionStateChange {
  readonly state: AppServerConnectionState
  readonly error?: Error
}

export interface ReconnectingAppServerClientOptions {
  /** Create and initialize a fresh physical client for every connection attempt. */
  readonly connect: AppServerClientConnector
}

/**
 * Keeps the public RPC surface stable while replacing one terminal physical
 * connection with another. It deliberately does not retry or queue requests.
 * Callers must recover subscriptions and reconcile commands from durable state.
 */
export class ReconnectingAppServerClient implements AppServerRpcClient {
  private readonly notificationListeners = new Set<AppServerNotificationListener>()
  private readonly stateListeners = new Set<(change: AppServerConnectionStateChange) => void>()
  private active?: ActiveConnection
  private state: AppServerConnectionState = "disconnected"
  private initializeResult?: ServerInitializeResult
  private connectPromise?: Promise<ServerInitializeResult>
  private generation = 0
  private closedError?: Error

  constructor(private readonly options: ReconnectingAppServerClientOptions) {}

  get connectionState(): AppServerConnectionState {
    return this.state
  }

  get connected(): boolean {
    return this.state === "connected"
  }

  get initialize(): ServerInitializeResult | undefined {
    return this.initializeResult
  }

  connect(): Promise<ServerInitializeResult> {
    if (this.state === "closed") return Promise.reject(this.closedError ?? clientClosedError())
    if (this.state === "connected" && this.initializeResult !== undefined) return Promise.resolve(this.initializeResult)
    if (this.connectPromise !== undefined) return this.connectPromise

    const generation = ++this.generation
    this.transition({ state: "connecting" })
    const attempt = this.open(generation)
    this.connectPromise = attempt
    void attempt.then(
      () => {
        if (this.connectPromise === attempt) this.connectPromise = undefined
      },
      () => {
        if (this.connectPromise === attempt) this.connectPromise = undefined
      },
    )
    return attempt
  }

  reconnect(): Promise<ServerInitializeResult> {
    if (this.state === "closed") return Promise.reject(this.closedError ?? clientClosedError())
    if (this.state === "connecting") return this.connectPromise ?? this.connect()
    if (this.active !== undefined) this.active.client.close()
    return this.connect()
  }

  request(method: string, params?: JsonValue, options?: { readonly signal?: AbortSignal }): Promise<JsonValue> {
    const active = this.active
    if (active === undefined || this.state !== "connected") {
      return Promise.reject(new AppServerClientError("not_connected", "App Server is not connected"))
    }
    return active.client.request(method, params, options)
  }

  notify(method: string, params?: JsonValue): void {
    const active = this.active
    if (active === undefined || this.state !== "connected") {
      throw new AppServerClientError("not_connected", "App Server is not connected")
    }
    active.client.notify(method, params)
  }

  onNotification(listener: AppServerNotificationListener): () => void {
    if (this.state === "closed") throw this.closedError ?? clientClosedError()
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onClose(listener: AppServerCloseListener): () => void {
    if (this.state === "closed") {
      try {
        listener(this.closedError)
      } catch {
        // A lifecycle observer must not affect a late registration.
      }
      return () => {}
    }
    return this.onConnectionStateChange((change) => {
      if (change.state === "closed") listener(change.error)
    })
  }

  onConnectionStateChange(listener: (change: AppServerConnectionStateChange) => void): () => void {
    if (this.state === "closed") {
      try {
        listener({ state: "closed", error: this.closedError })
      } catch {
        // A late lifecycle observer must not affect registration.
      }
      return () => {}
    }
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  close(): void {
    if (this.state === "closed") return
    this.generation += 1
    this.closedError = clientClosedError()
    const active = this.active
    this.active = undefined
    this.initializeResult = undefined
    this.transition({ state: "closed", error: this.closedError })
    active?.removeNotification()
    active?.removeClose()
    active?.client.close()
    this.notificationListeners.clear()
    this.stateListeners.clear()
  }

  private async open(generation: number): Promise<ServerInitializeResult> {
    let connected: ConnectedAppServerClient
    try {
      connected = await this.options.connect()
    } catch (error) {
      const normalized = asError(error)
      if (this.state !== "closed" && this.generation === generation) this.transition({ state: "disconnected", error: normalized })
      throw normalized
    }

    if (this.state === "closed" || this.generation !== generation) {
      connected.client.close()
      throw this.closedError ?? new AppServerClientError("transport_closed", "Connection attempt is no longer valid")
    }

    let removeNotification: () => void
    let removeClose: () => void
    let closedDuringSetup: Error | undefined
    try {
      removeNotification = connected.client.onNotification((notification) => this.dispatchNotification(notification))
      removeClose = connected.client.onClose((error) => {
        closedDuringSetup = error ?? new AppServerClientError("transport_closed", "App Server closed before the connection was established")
        this.handlePhysicalClose(connected.client, closedDuringSetup)
      })
    } catch (error) {
      connected.client.close()
      const normalized = asError(error)
      if (this.generation === generation) this.transition({ state: "disconnected", error: normalized })
      throw normalized
    }
    if (closedDuringSetup !== undefined || this.state !== "connecting" || this.generation !== generation) {
      removeNotification()
      removeClose()
      connected.client.close()
      const error =
        closedDuringSetup ?? this.closedError ?? new AppServerClientError("transport_closed", "Connection attempt is no longer valid")
      if (this.state === "connecting" && this.generation === generation) this.transition({ state: "disconnected", error })
      throw error
    }
    this.active = { client: connected.client, removeNotification, removeClose }
    this.initializeResult = connected.initialize
    this.transition({ state: "connected" })
    return connected.initialize
  }

  private handlePhysicalClose(client: AppServerRpcClient, error?: Error): void {
    if (this.active?.client !== client || this.state === "closed") return
    const active = this.active
    this.active = undefined
    this.initializeResult = undefined
    active.removeNotification()
    active.removeClose()
    this.transition({
      state: "disconnected",
      ...(error === undefined ? {} : { error }),
    })
  }

  private dispatchNotification(notification: JsonRpcNotification): void {
    for (const listener of [...this.notificationListeners]) {
      try {
        listener(notification)
      } catch {
        // A stable client listener must not break the physical connection.
      }
    }
  }

  private transition(change: AppServerConnectionStateChange): void {
    this.state = change.state
    for (const listener of [...this.stateListeners]) {
      try {
        listener(change)
      } catch {
        // A lifecycle observer must not affect connection state.
      }
    }
  }
}

interface ActiveConnection {
  readonly client: AppServerRpcClient
  readonly removeNotification: () => void
  readonly removeClose: () => void
}

function clientClosedError(): AppServerClientError {
  return new AppServerClientError("client_closed", "App Server client is closed")
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
