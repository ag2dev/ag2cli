import { type JsonRpcMessage, type JsonRpcResponse } from "@ag2cli/app-server-protocol/types.js"
import type { AppServerTransport } from "@ag2cli/app-server-client/client.js"

/**
 * An in-process transport has the same message boundary as a socket transport.
 * It is used by embedded clients and tests; it must not expose SessionServer
 * or any composition-owned object to the client.
 */
export class InProcessAppServerTransport implements AppServerTransport {
  private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private closed = false

  constructor(
    private readonly handler: {
      handle(message: JsonRpcMessage): Promise<JsonRpcResponse | undefined>
      close(): void
    },
  ) {}

  send(message: JsonRpcMessage): void {
    if (this.closed) throw new Error("in-process App Server transport is closed")
    void this.handler
      .handle(message)
      .then((response) => {
        if (response !== undefined) this.dispatch(response)
      })
      .catch((error: unknown) => {
        this.handler.close()
        this.dispatchClose(asError(error))
      })
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): void {
    if (this.closed) return
    this.handler.close()
    this.dispatchClose()
  }

  /** Deliver a server notification to the client side of this transport. */
  emit(message: JsonRpcMessage): void {
    this.dispatch(message)
  }

  private dispatch(message: JsonRpcMessage): void {
    if (this.closed) return
    for (const listener of this.messageListeners) listener(message)
  }

  private dispatchClose(error?: Error): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener(error)
    this.messageListeners.clear()
    this.closeListeners.clear()
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
