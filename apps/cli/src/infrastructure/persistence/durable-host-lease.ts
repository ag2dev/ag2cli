import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rm, utimes } from "node:fs/promises"
import { join, resolve } from "node:path"

const HOST_LEASE_FILE = ".ag2cli-host-lease.json"
const HEARTBEAT_INTERVAL_MS = 5_000

interface HostLeaseRecord {
  readonly pid: number
  readonly nonce: string
  readonly startedAt: string
}

export interface DurableHostLease {
  readonly path: string
  close(): Promise<void>
}

/**
 * Acquire the single-writer lease for a durable event root.
 *
 * The JSONL stores have Session-level locks for individual appends, but that
 * is not enough to protect catalog and derived-store lifecycle decisions made
 * by two independent Hosts. The Host lease is therefore the process boundary:
 * one durable Host owns one event root until it closes.
 */
export async function acquireDurableHostLease(eventRoot: string): Promise<DurableHostLease> {
  const root = resolve(eventRoot)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, HOST_LEASE_FILE)
  const nonce = randomUUID()
  const record: HostLeaseRecord = { pid: process.pid, nonce, startedAt: new Date().toISOString() }

  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8")
        await handle.sync()
      } catch (error) {
        await handle.close().catch(() => {})
        await rm(path, { force: true }).catch(() => {})
        throw error
      }

      let closed = false
      const heartbeat = setInterval(() => {
        if (closed) return
        void touchLease(path).catch(() => {
          // A removed lease is handled by close; a failed heartbeat must not
          // create an unhandled rejection in the Host process.
        })
      }, HEARTBEAT_INTERVAL_MS)
      heartbeat.unref?.()

      return {
        path,
        close: async () => {
          if (closed) return
          closed = true
          clearInterval(heartbeat)
          await handle.close().catch(() => {})
          await removeOwnedLease(path, nonce)
        },
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const owner = await readLease(path)
      if (owner !== undefined && !isProcessAlive(owner.pid)) {
        await rm(path, { force: true })
        continue
      }
      if (owner === undefined) throw new Error(`Durable Host lease is corrupted and cannot be safely taken over: ${path}`)
      const ownerDescription = `pid=${owner.pid}, startedAt=${owner.startedAt}`
      throw new Error(`Durable event root is already in use by another Host: ${path} (${ownerDescription})`)
    }
  }
}

async function readLease(path: string): Promise<HostLeaseRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown
    if (!isHostLeaseRecord(value)) return undefined
    return value
  } catch {
    return undefined
  }
}

async function removeOwnedLease(path: string, nonce: string): Promise<void> {
  const owner = await readLease(path)
  if (owner?.nonce === nonce) await rm(path, { force: true })
}

async function touchLease(path: string): Promise<void> {
  const now = new Date()
  await utimes(path, now, now)
}

function isHostLeaseRecord(value: unknown): value is HostLeaseRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.nonce === "string" &&
    record.nonce.length > 0 &&
    typeof record.startedAt === "string"
  )
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM")
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST")
}
