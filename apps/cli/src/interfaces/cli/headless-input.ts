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
  readonly promptFromStdin?: boolean
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
 * A lone `-` means stdin is the complete prompt. When a positional goal is
 * present and stdin is piped, the goal remains the instruction and stdin is
 * attached as context. TTY stdin is never read implicitly.
 */
export async function readHeadlessPrompt(input: HeadlessPromptInput, maxBytes: number): Promise<HeadlessPrompt> {
  const shouldReadStdin = input.promptFromStdin === true || input.stdinIsTTY === false
  if (!shouldReadStdin) {
    const goal = input.goal.trim()
    if (!goal) throw new Error("A non-empty prompt is required")
    return { goal }
  }

  const stdin = await readTextStream(input.stdin, maxBytes, input.signal)
  const trimmed = stdin.trim()
  if (input.promptFromStdin === true) {
    if (!trimmed) throw new Error("stdin did not contain a non-empty prompt")
    return { goal: trimmed }
  }

  const goal = input.goal.trim()
  if (!goal) throw new Error("A non-empty prompt is required")
  return trimmed.length > 0 ? { goal, context: [stdin] } : { goal }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  throw new DOMException("headless input cancelled", "AbortError")
}
