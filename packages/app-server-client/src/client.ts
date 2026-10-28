import { createNotification, createRequest, isResponse, parseEncodedMessage } from "@ag2cli/app-server-protocol/json-rpc.js"
import { type AppServerErrorCode, isAppServerErrorCode } from "@ag2cli/app-server-protocol/error-codes.js"
import {
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type JsonValue,
  type ServerInitializeParams,
  type ServerInitializeResult,
} from "@ag2cli/app-server-protocol/types.js"
import { assertJsonValue, parseServerInitializeResult } from "@ag2cli/app-server-protocol/validation.js"
import {
  callProtocol,
  type ProtocolCallOptions,
  type ProtocolMethod,
  type ProtocolMethodParams,
  type ProtocolMethodResults,
} from "./protocol-methods.js"

export interface AppServerTransport {
  send(message: JsonRpcMessage): void | Promise<void>
  onMessage(listener: (message: JsonRpcMessage) => void): () => void
  onClose(listener: (error?: Error) => void): () => void
  close(code?: number, reason?: string): void
}

export interface AppServerClientOptions {
  readonly requestTimeoutMs?: number
}

export interface AppServerRpcClient {
  request(method: string, params?: JsonValue, options?: { readonly signal?: AbortSignal }): Promise<JsonValue>
  notify(method: string, params?: JsonValue): void
  onNotification(listener: AppServerNotificationListener): () => void
  onClose(listener: AppServerCloseListener): () => void
  close(code?: number, reason?: string): void
}

export type AppServerNotificationListener = (notification: JsonRpcNotification) => void
export type AppServerCloseListener = (error?: Error) => void

export class AppServerRpcError extends Error {
  readonly code: number
  readonly kind?: AppServerErrorCode
  readonly rawKind?: string
  readonly origin: "server" | "local"
  readonly retryable: boolean
  readonly details?: JsonValue

  constructor(response: Extract<JsonRpcResponse, { error: unknown }>, origin: "server" | "local" = "server") {
    super(response.error.message)
    this.name = "AppServerRpcError"
    this.code = response.error.code
    this.origin = origin
    const rawKind = response.error.data?.code
    this.kind = isAppServerErrorCode(rawKind) ? rawKind : undefined
    if (!isAppServerErrorCode(rawKind)) this.rawKind = rawKind
    this.retryable = response.error.data?.retryable ?? false
    this.details = response.error.data?.details
  }

  /**
   * Synthesize a catalog error locally (e.g. a result that fails protocol
   * parsing). `origin: "local"` keeps it distinguishable from the same code
   * sent by a server.
   */
  static local(
    kind: AppServerErrorCode,
    message: string,
    data?: { readonly retryable?: boolean; readonly details?: JsonValue },
  ): AppServerRpcError {
    return new AppServerRpcError(
      {
        jsonrpc: "2.0",
        id: "local",
        error: {
          code: -32602,
          message,
          data: {
            code: kind,
            ...(data?.retryable === undefined ? {} : { retryable: data.retryable }),
            ...(data?.details === undefined ? {} : { details: data.details }),
          },
        },
      },
      "local",
    )
  }
}

export class AppServerClientError extends Error {
  readonly kind: "client_closed" | "request_timeout" | "transport_closed" | "invalid_response" | "not_connected"

  constructor(kind: AppServerClientError["kind"], message: string) {
    super(message)
    this.name = "AppServerClientError"
    this.kind = kind
  }
}

interface PendingRequest {
  readonly resolve: (value: JsonValue) => void
  readonly reject: (reason: unknown) => void
  readonly timer?: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly abortHandler?: () => void
}

export class JsonRpcAppServerClient implements AppServerRpcClient {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly notificationListeners = new Set<AppServerNotificationListener>()
  private readonly closeListeners = new Set<AppServerCloseListener>()
  private readonly requestTimeoutMs: number
  private readonly removeMessageListener: () => void
  private readonly removeCloseListener: () => void
  private nextRequestId = 1
  private closed = false
  private closeError?: Error

  constructor(
    private readonly transport: AppServerTransport,
    options: AppServerClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new RangeError("requestTimeoutMs must be positive")
    }
    this.removeMessageListener = transport.onMessage((message) => this.receive(message))
    this.removeCloseListener = transport.onClose((error) => this.fail(error ?? new Error("transport closed")))
  }

  request(method: string, params?: JsonValue, options: { readonly signal?: AbortSignal } = {}): Promise<JsonValue> {
    if (this.closed) return Promise.reject(new AppServerClientError("client_closed", "App Server client is closed"))
    const id = this.nextRequestId++
    const request = createRequest(method, id, params)
    const key = requestKey(id)

    return new Promise<JsonValue>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError())
        return
      }
      const timer = setTimeout(() => {
        const pending = this.pending.get(key)
        if (!pending) return
        this.pending.delete(key)
        this.removeAbortHandler(pending)
        pending.reject(new AppServerClientError("request_timeout", `Request timed out: ${method}`))
      }, this.requestTimeoutMs)
      const abortHandler = options.signal === undefined ? undefined : () => this.abortRequest(key)
      const pending: PendingRequest = {
        resolve,
        reject,
        timer,
        signal: options.signal,
        abortHandler,
      }
      this.pending.set(key, pending)
      if (options.signal !== undefined && abortHandler !== undefined) options.signal.addEventListener("abort", abortHandler, { once: true })
      try {
        const sent = this.transport.send(request)
        if (sent !== undefined) void Promise.resolve(sent).catch((error: unknown) => this.rejectRequest(key, error))
      } catch (error) {
        this.rejectRequest(key, error)
      }
    })
  }

  /** Typed, registry-validated call surface for every non-interaction protocol method. */
  callProtocol<M extends ProtocolMethod>(
    method: M,
    params: ProtocolMethodParams[M],
    options?: ProtocolCallOptions,
  ): Promise<ProtocolMethodResults[M]> {
    return callProtocol(this, method, params, options)
  }

  notify(method: string, params?: JsonValue): void {
    if (this.closed) throw new AppServerClientError("client_closed", "App Server client is closed")
    const sent = this.transport.send(createNotification(method, params))
    if (sent !== undefined) void Promise.resolve(sent).catch((error: unknown) => this.fail(asError(error)))
  }

  async initialize(params: ServerInitializeParams, options: { readonly signal?: AbortSignal } = {}): Promise<ServerInitializeResult> {
    const result = await this.request("server.initialize", assertJsonValue(params, "server.initialize.params"), options)
    const parsed = parseServerInitializeResult(result)
    if (parsed.server.hostId !== params.hostId) {
      this.close(1008, "Initialize Host mismatch")
      throw new Error("server.initialize descriptor Host ID does not match the requested Host")
    }
    return parsed
  }

  onNotification(listener: AppServerNotificationListener): () => void {
    if (this.closed) throw new AppServerClientError("client_closed", "App Server client is closed")
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  /** Observe the terminal lifecycle transition of this single RPC connection. */
  onClose(listener: AppServerCloseListener): () => void {
    if (this.closed) {
      try {
        listener(this.closeError)
      } catch {
        // A late lifecycle observer must not affect the caller registering it.
      }
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  receive(message: JsonRpcMessage): void {
    if (this.closed) return
    if (isResponse(message)) {
      if (message.id === null) return
      const key = requestKey(message.id)
      const pending = this.pending.get(key)
      if (!pending) return
      this.pending.delete(key)
      this.clearPending(pending)
      if ("error" in message) pending.reject(new AppServerRpcError(message))
      else pending.resolve(message.result)
      return
    }
    for (const listener of this.notificationListeners) {
      try {
        listener(message)
      } catch {
        // A client-side notification handler must not break the transport.
      }
    }
  }

  receiveText(text: string): void {
    try {
      this.receive(parseEncodedMessage(text))
    } catch (error) {
      this.fail(new AppServerClientError("invalid_response", error instanceof Error ? error.message : String(error)))
    }
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return
    this.fail(new AppServerClientError("client_closed", "App Server client is closed"))
    this.transport.close(code, reason)
  }

  private abortRequest(key: string): void {
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key)
    this.clearPending(pending)
    pending.reject(abortError())
  }

  private rejectRequest(key: string, error: unknown): void {
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key)
    this.clearPending(pending)
    pending.reject(error)
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeError = error instanceof AppServerClientError ? error : new AppServerClientError("transport_closed", error.message)
    this.removeMessageListener()
    this.removeCloseListener()
    this.failPending(this.closeError)
    for (const listener of [...this.closeListeners]) {
      try {
        listener(this.closeError)
      } catch {
        // A lifecycle observer must not affect request cleanup or other observers.
      }
    }
    this.closeListeners.clear()
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      this.clearPending(pending)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private clearPending(pending: PendingRequest): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    this.removeAbortHandler(pending)
  }

  private removeAbortHandler(pending: PendingRequest): void {
    if (pending.signal !== undefined && pending.abortHandler !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortHandler)
    }
  }
}

function requestKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`
}

function abortError(): DOMException {
  return new DOMException("Request was cancelled", "AbortError")
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
