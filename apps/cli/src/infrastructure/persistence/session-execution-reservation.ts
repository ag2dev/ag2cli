import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import type { SessionId } from "@ag2cli/core/ids.js"
import {
  SessionExecutionReservationConflictError,
  type SessionExecutionReservation,
  type SessionExecutionReservationLease,
} from "@ag2cli/runtime/ports/session-execution-reservation.js"

const HEARTBEAT_INTERVAL_MS = 5_000
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_AFTER_MS = 30_000
const PROCESS_START_NONCE = randomUUID()
const PROCESS_STARTED_AT = new Date().toISOString()

type ReservationRecord = {
  readonly sessionId: string
  readonly commandId: string
  readonly ownerId: string
  readonly pid: number
  readonly processStartNonce: string
  readonly reservationId: string
  readonly baseRevision: number
  readonly startedAt: string
  readonly heartbeatAt: string
  readonly status: "active"
}

/** File-backed Session execution reservation for local durable Hosts. */
export class JsonSessionExecutionReservation implements SessionExecutionReservation {
  constructor(private readonly root: string) {}

  async acquire(input: {
    readonly sessionId: SessionId
    readonly commandId: string
    readonly ownerId: string
    readonly baseRevision: number
    readonly signal?: AbortSignal
  }): Promise<SessionExecutionReservationLease> {
    throwIfAborted(input.signal)
    const reservationRoot = join(this.root, "reservations")
    await mkdir(reservationRoot, { recursive: true, mode: 0o700 })
    const path = join(reservationRoot, `${encodeURIComponent(input.sessionId)}.json`)
    const lock = `${path}.lock`
    const previousProcessIdentity = await publishProcessIdentity(reservationRoot)
    const reservationId = randomUUID()
    const now = new Date().toISOString()
    const record: ReservationRecord = {
      sessionId: input.sessionId,
      commandId: input.commandId,
      ownerId: input.ownerId,
      pid: process.pid,
      processStartNonce: PROCESS_START_NONCE,
      baseRevision: input.baseRevision,
      reservationId,
      startedAt: now,
      heartbeatAt: now,
      status: "active",
    }

    await withReservationLock(lock, async () => {
      throwIfAborted(input.signal)
      for (;;) {
        try {
          await writeExclusive(path, record)
          break
        } catch (error) {
          if (!isAlreadyExists(error)) throw error
          const current = await readRecord(path)
          if (current !== undefined && (await isStale(current, reservationRoot, previousProcessIdentity))) {
            await rm(path, { force: true })
            continue
          }
          throw new SessionExecutionReservationConflictError(input.sessionId, input.commandId)
        }
      }
    })

    let released = false
    const heartbeat = setInterval(() => {
      if (released) return
      void this.renewRecord(path, lock, input.sessionId, input.commandId, reservationId).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    heartbeat.unref?.()

    return {
      reservationId,
      renew: async () => {
        if (released) return
        await this.renewRecord(path, lock, input.sessionId, input.commandId, reservationId)
      },
      release: async (_status = "released") => {
        if (released) return
        released = true
        clearInterval(heartbeat)
        await withReservationLock(lock, async () => {
          const current = await readRecord(path)
          if (current?.reservationId !== reservationId) return
          await rm(path, { force: true })
        })
      },
    }
  }

  private async renewRecord(path: string, lock: string, sessionId: SessionId, commandId: string, reservationId: string): Promise<void> {
    await withReservationLock(lock, async () => {
      const current = await readRecord(path)
      if (current?.reservationId !== reservationId || current.status !== "active") {
        throw new SessionExecutionReservationConflictError(sessionId, commandId)
      }
      await writeAtomic(path, { ...current, heartbeatAt: new Date().toISOString() })
    })
  }
}

async function readRecord(path: string): Promise<ReservationRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ReservationRecord>
    if (
      typeof value.sessionId !== "string" ||
      typeof value.commandId !== "string" ||
      typeof value.ownerId !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.reservationId !== "string" ||
      typeof value.baseRevision !== "number" ||
      typeof value.heartbeatAt !== "string" ||
      typeof value.status !== "string"
    )
      return undefined
    return value as ReservationRecord
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

type ProcessIdentity = {
  readonly pid: number
  readonly processStartNonce: string
  readonly startedAt: string
}

async function publishProcessIdentity(root: string): Promise<ProcessIdentity | undefined> {
  const identityRoot = join(root, "process-identities")
  await mkdir(identityRoot, { recursive: true, mode: 0o700 })
  const path = join(identityRoot, `${process.pid}.json`)
  const previous = await readProcessIdentity(path)
  await writeAtomic(path, { pid: process.pid, processStartNonce: PROCESS_START_NONCE, startedAt: PROCESS_STARTED_AT })
  return previous
}

async function readProcessIdentity(path: string): Promise<ProcessIdentity | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ProcessIdentity>
    if (typeof value.pid !== "number" || typeof value.processStartNonce !== "string" || typeof value.startedAt !== "string")
      return undefined
    return value as ProcessIdentity
  } catch (error) {
    if (isMissing(error)) return undefined
    return undefined
  }
}

async function isStale(record: ReservationRecord, root: string, previousProcessIdentity: ProcessIdentity | undefined): Promise<boolean> {
  if (record.status !== "active") return true
  try {
    process.kill(record.pid, 0)
    // A live PID is conservatively treated as owned. This avoids taking over
    // a record when the process identity is unknown. A previously published,
    // different process-start nonce is the one safe signal for PID reuse.
    if (record.pid === process.pid && previousProcessIdentity?.processStartNonce !== undefined) {
      return previousProcessIdentity.processStartNonce !== record.processStartNonce
    }
    if (record.pid !== process.pid) {
      const identity = await readProcessIdentity(join(root, "process-identities", `${record.pid}.json`))
      if (identity === undefined) return false
      return identity.processStartNonce !== record.processStartNonce
    }
    return false
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") return false
    // A dead owner is safe to take over even when its last heartbeat is recent:
    // SIGKILL cannot publish another heartbeat, and waiting for the timeout
    // would make explicit recovery needlessly fail on the next startup.
    return true
  }
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close().catch(() => {})
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeExclusive(temporary, value)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

async function withReservationLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (handle === undefined) {
    try {
      handle = await open(path, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, processStartNonce: PROCESS_START_NONCE, createdAt: Date.now() }), "utf8")
        await handle.sync()
      } catch (error) {
        await rm(path, { force: true }).catch(() => {})
        await handle.close().catch(() => {})
        handle = undefined
        throw error
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      if (await isStaleLock(path)) {
        await rm(path, { force: true })
        continue
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for the Session reservation lock: ${path}`, { cause: error })
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  try {
    return await operation()
  } finally {
    // Remove the name while our descriptor is still open. If a stale-owner
    // recovery replaced the lock after a crash, closing first could allow a
    // late cleanup to unlink the replacement lock.
    await rm(path, { force: true }).catch(() => {})
    await handle.close().catch(() => {})
  }
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path)
    return Date.now() - metadata.mtimeMs > LOCK_STALE_AFTER_MS
  } catch (error) {
    return isMissing(error)
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException("reservation cancelled", "AbortError")
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST")
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}
