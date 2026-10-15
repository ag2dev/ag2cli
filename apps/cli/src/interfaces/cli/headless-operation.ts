export type HeadlessAbortKind = "timeout" | "signal"

export interface HeadlessOperation {
  readonly signal: AbortSignal
  readonly abortKind: HeadlessAbortKind | undefined
  close(): void
}

interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown
}

/**
 * Owns the lifetime of one headless request. The signal is shared with model,
 * tool and context operations; closing it removes process listeners and
 * the deadline timer so one invocation cannot leak state into the next one.
 */
export function createHeadlessOperation(timeoutMs: number | undefined, signalSource: SignalSource = process): HeadlessOperation {
  const controller = new AbortController()
  let abortKind: HeadlessAbortKind | undefined
  const abort = (kind: HeadlessAbortKind, message: string, name: string): void => {
    if (controller.signal.aborted) return
    abortKind = kind
    controller.abort(new DOMException(message, name))
  }
  const onSignal = (): void => abort("signal", "headless operation interrupted", "AbortError")
  signalSource.on("SIGINT", onSignal)
  signalSource.on("SIGTERM", onSignal)
  const timer =
    timeoutMs === undefined ? undefined : setTimeout(() => abort("timeout", "headless request timeout", "TimeoutError"), timeoutMs)
  let closed = false
  return {
    signal: controller.signal,
    get abortKind() {
      return abortKind
    },
    close() {
      if (closed) return
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      signalSource.off("SIGINT", onSignal)
      signalSource.off("SIGTERM", onSignal)
    },
  }
}
