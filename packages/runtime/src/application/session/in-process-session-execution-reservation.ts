import type { SessionId } from "@ag2cli/core/ids.js"
import type { SessionExecutionReservation, SessionExecutionReservationLease } from "../../ports/session-execution-reservation.js"

interface ReservationWaiter {
  readonly reservationId: string
  readonly signal?: AbortSignal
  settled: boolean
  deliver(): void
  fail(error: Error): void
}

/**
 * Single-process FIFO reservation for one authoritative Host. The durable
 * Host lease already guarantees a single owning process, so a contending
 * command always shares the process with the active holder and waiting is
 * safe; the cross-process file reservation instead conflicts immediately.
 */
export class InProcessSessionExecutionReservation implements SessionExecutionReservation {
  private readonly holders = new Map<string, string>()
  private readonly waiters = new Map<string, ReservationWaiter[]>()
  private sequence = 0

  async acquire(input: {
    readonly sessionId: SessionId
    readonly commandId: string
    readonly ownerId: string
    readonly baseRevision: number
    readonly signal?: AbortSignal
  }): Promise<SessionExecutionReservationLease> {
    throwIfAborted(input.signal)
    const key = String(input.sessionId)
    const reservationId = `in-process-reservation-${++this.sequence}`
    if (this.holders.get(key) === undefined) {
      this.holders.set(key, reservationId)
      return this.leaseFor(key, reservationId)
    }
    return await new Promise<SessionExecutionReservationLease>((resolve, reject) => {
      const waiter: ReservationWaiter = {
        reservationId,
        signal: input.signal,
        settled: false,
        deliver: () => resolve(this.leaseFor(key, reservationId)),
        fail: reject,
      }
      const queue = this.waiters.get(key) ?? []
      queue.push(waiter)
      this.waiters.set(key, queue)
      input.signal?.addEventListener(
        "abort",
        () => {
          if (waiter.settled) return
          waiter.settled = true
          this.removeFromQueue(key, waiter)
          reject(abortError(input.signal))
        },
        { once: true },
      )
    })
  }

  private leaseFor(key: string, reservationId: string): SessionExecutionReservationLease {
    return {
      reservationId,
      // Ownership cannot expire within one live process.
      renew: async () => undefined,
      release: async () => {
        if (this.holders.get(key) !== reservationId) return
        const queue = this.waiters.get(key)
        const next = queue?.shift()
        if (next === undefined) {
          this.waiters.delete(key)
          this.holders.delete(key)
          return
        }
        // Hand the slot to the next waiter atomically: it becomes the holder
        // before its acquire settles, so no third acquire can jump the queue.
        this.holders.set(key, next.reservationId)
        next.settled = true
        next.deliver()
      },
    }
  }

  private removeFromQueue(key: string, waiter: ReservationWaiter): void {
    const queue = this.waiters.get(key)
    if (queue === undefined) return
    const index = queue.indexOf(waiter)
    if (index === -1) return
    queue.splice(index, 1)
    if (queue.length === 0) this.waiters.delete(key)
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("reservation cancelled", "AbortError")
}
