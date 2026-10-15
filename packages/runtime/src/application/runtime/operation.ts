/**
 * OperationController — cancellation, timeout, and deadline control for a single agent run (runtime reliability layer).
 *
 * Goal: wrap one agent run in a cancellable operation with a deadline. Model
 * requests and Bash share the same signal; calling cancel() from an entry point
 * (CLI Ctrl+C or the TUI cancel key) stops the entire chain without leaving a
 * child process running.
 *
 * Design:
 *  - Reuse AbortController for the signal (built in, dependency-free, and well understood).
 *  - Use setTimeout for the deadline and abort automatically on expiry, distinguishing
 *    timeout from manual cancellation.
 *  - cancel and close are idempotent; close clears the timer to prevent it from lingering.
 *  - Do not depend on Date.now(); the caller provides the deadline in milliseconds,
 *    and the implementation uses setTimeout without reading the clock itself.
 */

/** Cancellation reason: manual means user initiated; timeout means the deadline elapsed. */
export type CancelReason = "manual" | "timeout"

/** Observable operation state for entry-point display and auditing. */
export interface OperationState {
  /** Unique ID, incremented and unique within this process. */
  id: number
  /** Whether the operation has been cancelled. */
  cancelled: boolean
  /** Cancellation reason, or undefined if not cancelled. */
  reason?: CancelReason
  /** Optional deadline in milliseconds. */
  deadlineMs?: number
}

/** Process-wide incrementing ID, starting at 1. */
let nextId = 1

export class OperationController {
  readonly id: number
  private ac: AbortController
  private timer: ReturnType<typeof setTimeout> | undefined
  private _cancelled = false
  private _reason?: CancelReason

  constructor(opts: { deadlineMs?: number } = {}) {
    this.id = nextId++
    this.ac = new AbortController()
    if (opts.deadlineMs && opts.deadlineMs > 0) {
      this.timer = setTimeout(() => this.cancel("timeout"), opts.deadlineMs)
    }
  }

  /** Cancellation signal passed to downstream model and Bash calls. */
  get signal(): AbortSignal {
    return this.ac.signal
  }

  /** Whether the operation has been cancelled. */
  get cancelled(): boolean {
    return this._cancelled
  }

  /** Cancellation reason. */
  get reason(): CancelReason | undefined {
    return this._reason
  }

  /** Trigger cancellation. Idempotent: subsequent calls have no effect. Returns whether this call triggered it. */
  cancel(reason: CancelReason = "manual"): boolean {
    if (this._cancelled) return false
    this._cancelled = true
    this._reason = reason
    this.ac.abort(new OperationCancelledError(this.id, reason))
    this.clearTimer()
    return true
  }

  /** Clear the timer. Idempotent. Does not abort; call on normal completion to prevent a lingering timer or accidental cancellation. */
  close(): void {
    this.clearTimer()
  }

  /** Snapshot state for display and auditing. */
  snapshot(): OperationState {
    return { id: this.id, cancelled: this._cancelled, reason: this._reason }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}

/** Error thrown when an operation is cancelled. Downstream catches can inspect signal.aborted to decide whether to suppress it. */
export class OperationCancelledError extends Error {
  readonly operationId: number
  readonly cancelReason: CancelReason
  constructor(operationId: number, reason: CancelReason) {
    super(`operation ${operationId} cancelled (${reason})`)
    this.name = "OperationCancelledError"
    this.operationId = operationId
    this.cancelReason = reason
  }
}

/** Convenience helper for identifying cancellation errors to suppress rather than report. */
export function isCancelled(err: unknown): boolean {
  return err instanceof OperationCancelledError || (err instanceof Error && err.name === "AbortError")
}

/**
 * Check whether the signal is cancelled and throw OperationCancelledError if so.
 * Downstream code calls this at cooperative checkpoints. Native abort interrupts
 * model and Bash awaits; long loops should call checkSignal explicitly as a fallback.
 */
export function checkSignal(signal: AbortSignal, operationId: number): void {
  if (signal.aborted) {
    throw new OperationCancelledError(operationId, "manual")
  }
}
