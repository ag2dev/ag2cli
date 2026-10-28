import type { SessionId } from "@ag2cli/core/ids.js"
import type { Message } from "@ag2cli/core/message.js"

/** The persisted notes file plus the coverage cursor carried in its frontmatter. */
export interface StoredSessionNotes {
  readonly content: string
  readonly coveredUpTo: string
}

/**
 * Side-car persistence for session notes. The canonical event stream remains
 * the session's authority; notes are a derived, rebuildable read model keyed
 * by session id, stored outside the event stream.
 */
export interface SessionNotesStore {
  /**
   * Pure path arithmetic: whether this session id can map to a storable
   * notes file at all. Callers short-circuit before any billing when false.
   */
  isAvailable(sessionId: SessionId): boolean
  /** Missing files resolve to undefined; parse failures are the adapter's absent. */
  read(sessionId: SessionId): Promise<StoredSessionNotes | undefined>
  /**
   * Atomically replace the file only while the on-disk frontmatter cursor
   * still equals `expected.coveredUpTo` (a missing or unparseable frontmatter
   * compares equal to the empty string). Returns false on mismatch without
   * writing; never throws for a lost race.
   */
  replace(sessionId: SessionId, content: string, expected: { readonly coveredUpTo: string }): Promise<boolean>
  delete(sessionId: SessionId): Promise<void>
}

export interface SessionNotesUpdaterInput {
  readonly sessionId: SessionId
  /** The contract prompt (which embeds the current file) followed by delta rows. */
  readonly messages: readonly Message[]
  readonly signal?: AbortSignal
}

/** A side model call that rewrites the notes file body; returns body text only. */
export type SessionNotesUpdater = (input: SessionNotesUpdaterInput) => Promise<string>
