/**
 * Keyed FIFO execution lanes.
 *
 * One instance manages one lane per key: `run(key, body)` enqueues the body
 * on that key's lane and returns its result, and different keys never block
 * each other. A body is admitted only after the previous body on the same
 * key has fully settled, including any promise the body itself returns
 * (thenable adoption). This is deliberately the opposite of a bypass gate:
 * admission never outruns a predecessor's pending effects.
 *
 * A body's rejection reaches only the caller of `run`; queued successors on
 * the key still run. The per-key cleanup rides a `.finally` whose callback
 * returns `Map.delete`'s boolean — never a thenable — so cleanup can neither
 * reject nor adopt further work.
 */
export class OrderedLane<K = string> {
  private readonly tailByKey = new Map<K, Promise<void>>()

  run<T>(key: K, body: () => Promise<T>): Promise<T> {
    const previous = this.tailByKey.get(key) ?? Promise.resolve()
    const operation = previous.then(() => body())
    // The stored tail always settles with undefined: successors and drain
    // consumers must never observe this body's rejection.
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    )
    this.tailByKey.set(key, tracked)
    // Identity guard: a settled tail may unlink only its own registration,
    // never a successor that was queued behind it.
    void tracked.finally(() => {
      if (this.tailByKey.get(key) === tracked) return this.tailByKey.delete(key)
    })
    return operation
  }

  /**
   * Snapshot of the current drained tails; settles when every in-flight body
   * has settled. Drain facet for host close paths only — never control flow.
   */
  tails(): readonly Promise<void>[] {
    return [...this.tailByKey.values()]
  }
}
