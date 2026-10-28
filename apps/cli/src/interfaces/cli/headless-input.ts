/** Read a byte-bounded UTF-8 stream for scriptable CLI input. */
export async function readTextStream(stream: ReadableStream<Uint8Array>, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let text = ""
  const onAbort = (): void => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    while (true) {
      throwIfAborted(signal)
      const { done, value } = await reader.read()
      throwIfAborted(signal)
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        throw new Error(`stdin input exceeds the ${maxBytes}-byte limit`)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    signal?.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
}

export interface HeadlessPromptInput {
  readonly goal: string
  readonly stdin: ReadableStream<Uint8Array>
  readonly stdinIsTTY?: boolean
  readonly signal?: AbortSignal
}

export interface HeadlessPrompt {
  readonly goal: string
  readonly context?: readonly string[]
}

/**
 * Resolve a one-shot prompt without coupling command parsing to stdin.
 *
 * Piped stdin is attached as context next to the positional goal. TTY
 * stdin is never read implicitly; the `-` streaming dispatch reads stdin
 * line by line instead of going through here.
 */
export async function readHeadlessPrompt(input: HeadlessPromptInput, maxBytes: number): Promise<HeadlessPrompt> {
  if (input.stdinIsTTY !== false) {
    const goal = input.goal.trim()
    if (!goal) throw new Error("A non-empty prompt is required")
    return { goal }
  }

  const stdin = await readTextStream(input.stdin, maxBytes, input.signal)
  const goal = input.goal.trim()
  if (!goal) throw new Error("A non-empty prompt is required")
  const trimmed = stdin.trim()
  return trimmed.length > 0 ? { goal, context: [stdin] } : { goal }
}

/**
 * Stream stdin as discrete input lines for `-` dispatch: each non-empty
 * line is one mailbox input. The trailing chunk without a newline is still
 * a line.
 */
export async function* readStdinLines(stream: ReadableStream<Uint8Array>, maxBytes: number, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let buffer = ""
  const onAbort = (): void => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    while (true) {
      throwIfAborted(signal)
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        throw new Error(`stdin input exceeds the ${maxBytes}-byte limit`)
      }
      buffer += decoder.decode(value, { stream: true })
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() !== "") yield line
      }
    }
    throwIfAborted(signal)
    buffer += decoder.decode()
    if (buffer.trim() !== "") yield buffer
  } finally {
    signal?.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  throw new DOMException("headless input cancelled", "AbortError")
}
