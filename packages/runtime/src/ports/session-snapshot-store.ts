import type { SessionId } from "@ag2cli/core/ids.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"

/** A derived cursor that identifies the event prefix represented by a snapshot. */
export interface StoredSessionSnapshot {
  readonly snapshot: SessionSnapshot
  readonly lastEventId: string
}

/**
 * Persistence for the server's derived session read model.
 *
 * The event store remains authoritative. Implementations may discard a
 * snapshot at any time; callers must be able to rebuild it from events.
 */
export interface SessionSnapshotStore {
  read(sessionId: SessionId): Promise<StoredSessionSnapshot | undefined>
  write(value: StoredSessionSnapshot): Promise<void>
  /** Compare the currently persisted derived revision before replacing it. */
  writeIfRevision?(value: StoredSessionSnapshot, expectedRevision: number): Promise<boolean>
  delete(sessionId: SessionId): Promise<void>
}
