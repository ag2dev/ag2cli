export interface TaskSchedulerClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: TaskSchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Small injectable scheduler used only for recurring background task wakeups. */
export class BackgroundTaskScheduler {
  private readonly timers = new Map<string, unknown>()

  constructor(private readonly clock: TaskSchedulerClock = realClock) {}

  schedule(key: string, runAt: string, callback: () => void): void {
    this.cancel(key)
    const target = Date.parse(runAt)
    if (!Number.isFinite(target)) throw new Error(`Invalid task nextRunAt: ${runAt}`)
    const handle = this.clock.setTimeout(
      () => {
        this.timers.delete(key)
        callback()
      },
      Math.max(0, target - this.clock.now()),
    )
    this.timers.set(key, handle)
  }

  nextRunAt(intervalMs: number): string {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new Error("loop interval must be at least 1,000 ms")
    return new Date(this.clock.now() + intervalMs).toISOString()
  }

  cancel(key: string): void {
    const handle = this.timers.get(key)
    if (handle === undefined) return
    this.clock.clearTimeout(handle)
    this.timers.delete(key)
  }

  close(): void {
    for (const key of [...this.timers.keys()]) this.cancel(key)
  }
}
