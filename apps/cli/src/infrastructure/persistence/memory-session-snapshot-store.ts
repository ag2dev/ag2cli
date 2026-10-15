import type { SessionId } from "@ag2cli/core/ids.js"
import type { SessionSnapshotStore, StoredSessionSnapshot } from "@ag2cli/runtime/ports/session-snapshot-store.js"

/** Deterministic derived snapshot store for application tests. */
export class MemorySessionSnapshotStore implements SessionSnapshotStore {
  private readonly values = new Map<string, StoredSessionSnapshot>()

  async read(sessionId: SessionId): Promise<StoredSessionSnapshot | undefined> {
    const value = this.values.get(sessionId)
    return value === undefined ? undefined : structuredClone(value)
  }

  async write(value: StoredSessionSnapshot): Promise<void> {
    this.values.set(value.snapshot.sessionId, structuredClone(value))
  }

  async writeIfRevision(value: StoredSessionSnapshot, expectedRevision: number): Promise<boolean> {
    const current = this.values.get(value.snapshot.sessionId)
    if (current !== undefined && current.snapshot.lastRevision !== expectedRevision) return false
    this.values.set(value.snapshot.sessionId, structuredClone(value))
    return true
  }

  async delete(sessionId: SessionId): Promise<void> {
    this.values.delete(sessionId)
  }
}
