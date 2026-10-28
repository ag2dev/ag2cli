import { encodeMessage, parseEncodedMessage } from "@ag2cli/app-server-protocol/json-rpc.js"
import { type JsonRpcMessage } from "@ag2cli/app-server-protocol/types.js"
import type { AppServerTransport } from "./client.js"

export interface NdjsonAppServerTransportOptions {
  readonly input: ReadableStream<Uint8Array>
  readonly output: WritableStream<Uint8Array>
}

interface ByteStreamReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>
  cancel(reason?: unknown): Promise<unknown>
  releaseLock(): void
}

/** Newline-delimited JSON transport for App Server stdio connections. */
export class NdjsonAppServerTransport implements AppServerTransport {
  private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()
  private readonly reader: ByteStreamReader
  // Deliberately hand-rolled: this public client toolkit depends only on
  // the protocol package, and remote browser clients consume it
  // dependency-free — the shared concurrency primitive would drag the
  // runtime package transitively into every remote consumer.
  private writeChain = Promise.resolve()
  private closed = false
  private buffer = ""

  constructor(options: NdjsonAppServerTransportOptions) {
    this.writer = options.output.getWriter()
    this.reader = options.input.getReader()
    void this.consume()
  }

  send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("stdio App Server transport is closed")
    const data = this.encoder.encode(`${encodeMessage(message)}\n`)
    const write = this.writeChain.then(() => this.writer.write(data))
    this.writeChain = write.then(
      () => undefined,
      () => undefined,
    )
    return write
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
    this.closed = true
    void this.reader.cancel().catch(() => undefined)
    void this.writeChain.then(() => this.writer.close()).catch(() => undefined)
    this.messageListeners.clear()
    this.closeListeners.clear()
  }

  private async consume(): Promise<void> {
    try {
      while (!this.closed) {
        const result = await this.reader.read()
        if (result.done) {
          this.buffer += this.decoder.decode()
          this.dispatchLines(true)
          this.dispatchClose()
          return
        }
        this.buffer += this.decoder.decode(result.value, { stream: true })
        this.dispatchLines(false)
      }
    } catch (error) {
      this.dispatchClose(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.reader.releaseLock()
    }
  }

  private dispatchLines(final: boolean): void {
    let newline = this.buffer.indexOf("\n")
    while (newline >= 0) {
      this.dispatchLine(this.buffer.slice(0, newline))
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf("\n")
    }
    if (final && this.buffer.trim().length > 0) {
      this.dispatchLine(this.buffer)
      this.buffer = ""
    }
  }

  private dispatchLine(line: string): void {
    if (line.trim().length === 0) return
    const message = parseEncodedMessage(line)
    for (const listener of [...this.messageListeners]) listener(message)
  }

  private dispatchClose(error?: Error): void {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.closeListeners]) listener(error)
    this.messageListeners.clear()
    this.closeListeners.clear()
  }
}
