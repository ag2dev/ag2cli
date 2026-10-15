import { randomUUID } from "node:crypto"
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"

/**
 * Shared file coordination primitives for durable host state.
 *
 * Stale-recovery strategies in this module tree are deliberately three, each
 * matching its owner's risk profile:
 * - `acquireFileLock` (this file) uses pid + age: a lock whose owner process
 *   is gone (ESRCH) is reclaimed immediately, and unreadable metadata falls
 *   back to lock age (`isStaleLock`). Shared by low-risk registry mutations.
 * - `durable-host-lease.ts` is pid-only and fail-closed: a live owner or a
 *   corrupt lease is never aged out, because the durable host owns exclusive
 *   write authority and takeover must stay an explicit operator decision.
 * - `session-execution-reservation.ts` uses pid + process-start nonce plus an
 *   identity marker file, defending against PID reuse across restarts while
 *   still reclaiming a confirmed-dead owner's reservation.
 *
 * The hardlink-CAS writes elsewhere in persistence intentionally keep their
 * own compare-and-swap shape: they express cross-file atomicity guarantees a
 * plain same-directory tmp+rename replace cannot provide.
 */

const DEFAULT_LOCK_TIMEOUT_MS = 5_000
const DEFAULT_LOCK_STALE_AFTER_MS = 30_000

export interface FileLockOptions {
  readonly timeoutMs?: number
  readonly staleAfterMs?: number
  /** Treat malformed metadata as a live lock instead of reclaiming it by age. */
  readonly failClosedOnCorruptMetadata?: boolean
  /** Preserve the existing lock metadata representation of each store. */
  readonly metadataTrailingNewline?: boolean
  readonly timeoutError?: (path: string, cause: unknown) => Error
}

export interface FileLock {
  readonly path: string
  readonly ownerNonce: string
  release(): Promise<void>
}

export interface AtomicReplaceOptions {
  readonly mode?: number
}

/** The target was renamed successfully, but the directory durability step failed. */
export class AtomicReplaceUncertainError extends Error {
  readonly path: string
  override readonly cause?: unknown

  constructor(path: string, cause?: unknown) {
    super(`atomic replace durability is uncertain: ${path}`, { cause })
    this.name = "AtomicReplaceUncertainError"
    this.path = path
    this.cause = cause
  }
}

/** Acquire an owner-readable exclusive file lock and recover stale lock files. */
export async function acquireFileLock(path: string, options: FileLockOptions = {}): Promise<FileLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS
  const metadataSuffix = options.metadataTrailingNewline === false ? "" : "\n"
  const deadline = Date.now() + timeoutMs
  const guardPath = `${path}.guard`

  for (;;) {
    const guard = await acquireRawFileLock(guardPath, options)
    let acquired: FileLock | undefined
    let waitError: unknown
    try {
      try {
        const handle = await open(path, "wx", 0o600)
        const ownerNonce = randomUUID()
        try {
          await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now(), ownerNonce })}${metadataSuffix}`, "utf8")
          await handle.sync()
          let released = false
          acquired = {
            path,
            ownerNonce,
            release: async () => {
              if (released) return
              released = true
              const releaseGuard = await acquireRawFileLock(guardPath, options)
              try {
                try {
                  const metadata = await readFile(path, "utf8")
                  const parsed = JSON.parse(metadata) as { readonly ownerNonce?: unknown }
                  if (parsed.ownerNonce === ownerNonce) await rm(path, { force: true })
                } catch {
                  // The lock may already have been reclaimed after this owner died.
                }
              } finally {
                await releaseGuard.release()
                await handle.close().catch(() => {})
              }
            },
          }
        } catch (error) {
          await handle.close().catch(() => {})
          await rm(path, { force: true }).catch(() => {})
          throw error
        }
      } catch (error) {
        if (!isAlreadyExists(error)) throw error
        if (await reclaimStaleLock(path, staleAfterMs, options)) {
          waitError = undefined
        } else {
          waitError = error
        }
      }
    } finally {
      await guard.release()
    }
    if (acquired !== undefined) return acquired
    if (Date.now() >= deadline) {
      throw options.timeoutError?.(path, waitError) ?? new Error(`file lock wait timeout: ${path}`, { cause: waitError })
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function acquireRawFileLock(path: string, options: FileLockOptions): Promise<FileLock> {
  const metadataSuffix = options.metadataTrailingNewline === false ? "" : "\n"
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600)
      const ownerNonce = randomUUID()
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now(), ownerNonce })}${metadataSuffix}`, "utf8")
        await handle.sync()
        let released = false
        return {
          path,
          ownerNonce,
          release: async () => {
            if (released) return
            released = true
            try {
              const metadata = await readFile(path, "utf8")
              const parsed = JSON.parse(metadata) as { readonly ownerNonce?: unknown }
              if (parsed.ownerNonce === ownerNonce) await rm(path, { force: true })
            } catch {
              // The lock may already have been reclaimed after this owner died.
            }
            await handle.close().catch(() => {})
          },
        }
      } catch (error) {
        await handle.close().catch(() => {})
        await rm(path, { force: true }).catch(() => {})
        throw error
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      if (await reclaimStaleLock(path, staleAfterMs, options)) {
        continue
      }
      if (Date.now() >= deadline) {
        throw options.timeoutError?.(path, error) ?? new Error(`file lock wait timeout: ${path}`, { cause: error })
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

export async function withFileLock<T>(path: string, operation: () => Promise<T>, options?: FileLockOptions): Promise<T> {
  const lock = await acquireFileLock(path, options)
  try {
    return await operation()
  } finally {
    await lock.release()
  }
}

export interface FileLockMetadata {
  readonly pid?: number
  readonly createdAt?: number
  readonly ownerNonce?: string
}

export async function readFileLockMetadata(path: string): Promise<FileLockMetadata> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  return {
    ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
    ...(typeof value.createdAt === "number" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.ownerNonce === "string" ? { ownerNonce: value.ownerNonce } : {}),
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Replace a file through a same-directory, fsynced temporary file. */
export async function replaceFileAtomically(path: string, content: string | Uint8Array, options: AtomicReplaceOptions = {}): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let replaced = false
  try {
    await writeFile(temporary, content, { flag: "wx", mode: options.mode ?? 0o600 })
    const handle = await open(temporary, "r+")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    replaced = true
    try {
      await syncDirectory(dirname(path))
    } catch (error) {
      throw new AtomicReplaceUncertainError(path, error)
    }
  } catch (error) {
    if (replaced && !(error instanceof AtomicReplaceUncertainError)) throw new AtomicReplaceUncertainError(path, error)
    throw error
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return index <= 0 ? "." : path.slice(0, index)
}

async function isStaleLock(path: string, staleAfterMs: number, failClosedOnCorruptMetadata: boolean): Promise<boolean> {
  try {
    const metadata = await stat(path)
    let ownerPid: number | undefined
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as { readonly pid?: unknown }
      if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) {
        if (failClosedOnCorruptMetadata) return false
      } else {
        ownerPid = value.pid
      }
    } catch {
      if (failClosedOnCorruptMetadata) {
        return false
      }
      // Fall back to lock age for low-risk registry locks with malformed metadata.
    }
    if (ownerPid !== undefined) {
      try {
        process.kill(ownerPid, 0)
        return false
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return true
        if (error && typeof error === "object" && "code" in error && error.code === "EPERM") return false
      }
    }
    return Date.now() - metadata.mtimeMs > staleAfterMs
  } catch (error) {
    return isMissing(error)
  }
}

async function reclaimStaleLock(path: string, staleAfterMs: number, options: FileLockOptions): Promise<boolean> {
  if (!(await isStaleLock(path, staleAfterMs, options.failClosedOnCorruptMetadata === true))) return false
  const recoveryLock = await acquireAdvisoryRecoveryLock(`${path}.recovery`, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
  if (recoveryLock === undefined) return false
  try {
    if (!(await isStaleLock(path, staleAfterMs, options.failClosedOnCorruptMetadata === true))) return false
    await rm(path, { force: true })
    return true
  } finally {
    await recoveryLock.release()
  }
}

interface AdvisoryRecoveryLock {
  release(): Promise<void>
}

// Plain POSIX shell holder: process.execPath is the app itself in a compiled
// binary, not a bun interpreter, so the holder must not depend on `bun -e`.
const ADVISORY_LOCK_HOLDER_COMMAND = "echo ready; cat"

async function acquireAdvisoryRecoveryLock(path: string, timeoutMs: number): Promise<AdvisoryRecoveryLock | undefined> {
  const command = advisoryLockCommand(path)
  if (command === undefined) return undefined
  const shell = Bun.which("sh") ?? "/bin/sh"
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const child = Bun.spawn({
      cmd: [...command, shell, "-c", ADVISORY_LOCK_HOLDER_COMMAND],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    }) as unknown as Bun.PipedSubprocess
    if (await advisoryLockReady(child)) {
      let released = false
      return {
        release: async () => {
          if (released) return
          released = true
          try {
            await Promise.resolve(child.stdin.end())
          } catch {
            child.kill()
          }
          await child.exited
        },
      }
    }
    await child.exited
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function advisoryLockCommand(path: string): readonly string[] | undefined {
  if (process.platform === "darwin") {
    const lockf = Bun.which("lockf")
    return lockf === null ? undefined : [lockf, "-s", "-t", "0", "-k", path]
  }
  if (process.platform === "linux") {
    const flock = Bun.which("flock")
    return flock === null ? undefined : [flock, "-n", path]
  }
  return undefined
}

async function advisoryLockReady(child: Bun.PipedSubprocess): Promise<boolean> {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let output = ""
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) return false
      output += decoder.decode(result.value, { stream: true })
      if (output.includes("ready\n")) return true
    }
  } finally {
    reader.releaseLock()
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST")
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}
