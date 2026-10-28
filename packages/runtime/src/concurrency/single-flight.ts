/**
 * Run-once merge guard.
 *
 * Concurrent joiners for one key share a single start. A successful start
 * memoizes: joiners arriving after success receive the settled value without
 * a restart. A failed start evicts its entry — the rejection reaches that
 * attempt's joiners only, and the next join starts fresh.
 */
export class SingleFlight<K = string> {
  private readonly entries = new Map<K, Promise<unknown>>()

  join<T>(key: K, start: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key)
    if (existing !== undefined) return existing as Promise<T>
    // start() runs synchronously in the caller's stack: callers rely on its
    // preamble beginning before join() returns. Storing the entry only after
    // start() returns keeps a synchronous start() from observing its own
    // entry.
    const attempt = start()
    this.entries.set(key, attempt)
    void attempt.catch(() => {
      if (this.entries.get(key) === attempt) this.entries.delete(key)
    })
    return attempt
  }

  /** The current entry without starting one; undefined when absent. */
  peek(key: K): Promise<unknown> | undefined {
    return this.entries.get(key)
  }
}
