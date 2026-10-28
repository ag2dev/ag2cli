import { parseEncodedMessage } from "@ag2cli/app-server-protocol/json-rpc.js"
import { type JsonRpcMessage } from "@ag2cli/app-server-protocol/types.js"
import { JsonRpcAppServerClient, type AppServerClientOptions, type AppServerTransport } from "./client.js"

type WebSocketEventType = "open" | "message" | "error" | "close"

interface WebSocketMessageEvent {
  readonly data: string | ArrayBuffer | Blob
}

export interface WebSocketLike {
  readonly readyState: number
  addEventListener(type: WebSocketEventType, listener: (event: WebSocketMessageEvent | unknown) => void): void
  removeEventListener(type: WebSocketEventType, listener: (event: WebSocketMessageEvent | unknown) => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
}

export const WEBSOCKET_CONNECTING = 0
export const WEBSOCKET_OPEN = 1

export class WebSocketAppServerTransport implements AppServerTransport {
  private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private closed = false
  private closeError?: Error

  private readonly onMessageEvent = (event: WebSocketMessageEvent | unknown): void => {
    if (!isMessageEvent(event)) return
    if (typeof event.data === "string") {
      this.dispatchText(event.data)
      return
    }
    if (event.data instanceof ArrayBuffer) {
      this.dispatchText(new TextDecoder().decode(event.data))
      return
    }
    void event.data
      .text()
      .then((text) => this.dispatchText(text))
      .catch((error: unknown) => this.dispatchClose(error instanceof Error ? error : new Error(String(error)), true))
  }

  private readonly onErrorEvent = (event: WebSocketMessageEvent | unknown): void => {
    this.dispatchClose(event instanceof Error ? event : new Error("WebSocket error"), true)
  }

  private readonly onCloseEvent = (): void => this.dispatchClose()

  constructor(private readonly socket: WebSocketLike) {
    socket.addEventListener("message", this.onMessageEvent)
    socket.addEventListener("error", this.onErrorEvent)
    socket.addEventListener("close", this.onCloseEvent)
  }

  send(message: JsonRpcMessage): void {
    if (this.closed || this.socket.readyState !== WEBSOCKET_OPEN) throw new Error("WebSocket is not connected or is closed")
    this.socket.send(JSON.stringify(message))
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    if (this.closed) return () => {}
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: (error?: Error) => void): () => void {
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

  close(code?: number, reason?: string): void {
    if (this.closed) return
    this.dispatchClose(undefined, true, code, reason)
  }

  private dispatchText(text: string): void {
    if (this.closed) return
    try {
      const message = parseEncodedMessage(text)
      for (const listener of this.messageListeners) listener(message)
    } catch (error) {
      this.dispatchClose(error instanceof Error ? error : new Error(String(error)), true)
    }
  }

  private dispatchClose(error?: Error, closeSocket = false, code?: number, reason?: string): void {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    this.socket.removeEventListener("message", this.onMessageEvent)
    this.socket.removeEventListener("error", this.onErrorEvent)
    this.socket.removeEventListener("close", this.onCloseEvent)
    if (closeSocket && (this.socket.readyState === WEBSOCKET_CONNECTING || this.socket.readyState === WEBSOCKET_OPEN)) {
      try {
        this.socket.close(code, reason)
      } catch {
        // The terminal transport error is already known; cleanup must continue.
      }
    }
    const listeners = [...this.closeListeners]
    this.closeListeners.clear()
    this.messageListeners.clear()
    for (const listener of listeners) {
      try {
        listener(error)
      } catch {
        // A lifecycle observer must not affect transport cleanup or other observers.
      }
    }
  }
}

export interface WebSocketConnectOptions extends AppServerClientOptions {
  readonly createWebSocket?: (url: string) => WebSocketLike
}

export async function connectWebSocketAppServerTransport(
  url: string,
  options: Pick<WebSocketConnectOptions, "createWebSocket"> & { readonly signal?: AbortSignal } = {},
): Promise<WebSocketAppServerTransport> {
  options.signal?.throwIfAborted()
  const socket = options.createWebSocket?.(url) ?? (new WebSocket(url) as unknown as WebSocketLike)
  if (socket.readyState === WEBSOCKET_OPEN) return new WebSocketAppServerTransport(socket)
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      socket.close(1000, "Connection aborted")
      reject(new DOMException("The operation was aborted", "AbortError"))
    }
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new Error(`Could not connect to App Server: ${url}`))
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error(`App Server closed the connection before the handshake: ${url}`))
    }
    const cleanup = (): void => {
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onClose)
      options.signal?.removeEventListener("abort", onAbort)
    }
    socket.addEventListener("open", onOpen)
    socket.addEventListener("error", onError)
    socket.addEventListener("close", onClose)
    options.signal?.addEventListener("abort", onAbort, { once: true })
  })
  return new WebSocketAppServerTransport(socket)
}

export async function connectWebSocketAppServer(url: string, options: WebSocketConnectOptions = {}): Promise<JsonRpcAppServerClient> {
  const transport = await connectWebSocketAppServerTransport(url, options)
  return new JsonRpcAppServerClient(transport, options)
}

function isMessageEvent(value: unknown): value is WebSocketMessageEvent {
  if (!value || typeof value !== "object" || !("data" in value)) return false
  const data = value.data
  return typeof data === "string" || data instanceof ArrayBuffer || (typeof Blob !== "undefined" && data instanceof Blob)
}
