import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { parseSessionSnapshot } from "@ag2cli/session-protocol/session-codec.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { SessionSnapshotStore, StoredSessionSnapshot } from "@ag2cli/runtime/ports/session-snapshot-store.js"
import { replaceFileAtomically, withFileLock } from "./file-coordination.js"

const SNAPSHOT_SCHEMA_VERSION = 1 as const
const SNAPSHOT_LOCK_OPTIONS = {
  timeoutError: (path: string, cause: unknown) => new Error(`Timed out waiting for the session snapshot lock: ${path}`, { cause }),
} as const

type StoredSnapshotEnvelope = {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  readonly sessionId: string
  readonly lastRevision: number
  readonly lastEventId: string
  readonly snapshot: unknown
}

/** Atomic, credential-private JSON persistence for a derived session snapshot. */
export class JsonSessionSnapshotStore implements SessionSnapshotStore {
  constructor(private readonly root: string) {}

  async read(id: SessionId): Promise<StoredSessionSnapshot | undefined> {
    let raw: string
    try {
      raw = await readFile(snapshotPath(this.root, id), "utf8")
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }

    try {
      const value = JSON.parse(raw) as unknown
      if (!isEnvelope(value) || value.sessionId !== id) return undefined
      const snapshot = parseSessionSnapshot(value.snapshot, id)
      if (snapshot.lastRevision !== value.lastRevision || snapshot.lastRevision < 1) return undefined
      return { snapshot, lastEventId: value.lastEventId }
    } catch {
      // A derived snapshot is never allowed to prevent event replay recovery.
      return undefined
    }
  }

  async write(value: StoredSessionSnapshot): Promise<void> {
    if (value.snapshot.lastRevision < 1 || !Number.isSafeInteger(value.snapshot.lastRevision)) {
      throw new Error("session snapshot must correspond to at least one durable event")
    }
    if (value.lastEventId.trim().length === 0) throw new Error("session snapshot lastEventId must not be empty")

    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const target = snapshotPath(this.root, value.snapshot.sessionId)
    await withFileLock(`${target}.lock`, () => this.writeUnlocked(value, target), SNAPSHOT_LOCK_OPTIONS)
  }

  async writeIfRevision(value: StoredSessionSnapshot, expectedRevision: number): Promise<boolean> {
    if (value.snapshot.lastRevision < 1 || !Number.isSafeInteger(value.snapshot.lastRevision)) {
      throw new Error("session snapshot must correspond to at least one durable event")
    }
    if (value.lastEventId.trim().length === 0) throw new Error("session snapshot lastEventId must not be empty")
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const target = snapshotPath(this.root, value.snapshot.sessionId)
    return withFileLock(
      `${target}.lock`,
      async () => {
        const current = await this.read(value.snapshot.sessionId)
        if (current !== undefined && current.snapshot.lastRevision !== expectedRevision) return false
        if (current === undefined && expectedRevision !== 0) return false
        await this.writeUnlocked(value, target)
        return true
      },
      SNAPSHOT_LOCK_OPTIONS,
    )
  }

  async delete(id: SessionId): Promise<void> {
    await rm(snapshotPath(this.root, id), { force: true })
  }

  private async writeUnlocked(value: StoredSessionSnapshot, target: string): Promise<void> {
    const envelope: StoredSnapshotEnvelope = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      sessionId: value.snapshot.sessionId,
      lastRevision: value.snapshot.lastRevision,
      lastEventId: value.lastEventId,
      snapshot: value.snapshot,
    }
    await replaceFileAtomically(target, `${JSON.stringify(envelope)}\n`)
  }
}

function snapshotPath(root: string, id: SessionId): string {
  return join(root, `${encodeURIComponent(id)}.snapshot.json`)
}

function isEnvelope(value: unknown): value is StoredSnapshotEnvelope {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.schemaVersion === SNAPSHOT_SCHEMA_VERSION &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.lastRevision === "number" &&
    Number.isSafeInteger(candidate.lastRevision) &&
    candidate.lastRevision > 0 &&
    typeof candidate.lastEventId === "string" &&
    candidate.lastEventId.trim().length > 0 &&
    "snapshot" in candidate
  )
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}
