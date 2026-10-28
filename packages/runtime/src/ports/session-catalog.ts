import type { SessionId } from "@ag2cli/core/ids.js"
import type { HistoryCursor } from "@ag2cli/core/events/event.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"

export interface SessionRecord {
  readonly sessionId: SessionId
  readonly workspaceId?: string
  readonly snapshot: SessionSnapshot
  /** Optional user-provided label derived from the canonical event stream. */
  readonly title?: string
  readonly createdAt: string
  /** Timestamp of the last applied canonical event; derived, never stored. */
  readonly updatedAt: string
  readonly archived: boolean
  readonly archivedAt?: string
}

export interface SessionCatalogOptions {
  readonly signal?: AbortSignal
  /** Optional canonical workspace filter for catalog projections. */
  readonly workspaceRoot?: string
}

export interface SessionCreateOptions extends SessionCatalogOptions {
  readonly title?: string
  readonly workspaceId?: string
}

/** A server-wide Session identity is already occupied. */
export class SessionIdConflictError extends Error {
  readonly code = "session_id_conflict"

  constructor(readonly sessionId: SessionId) {
    super(`Session ID already exists: ${sessionId}`)
    this.name = "SessionIdConflictError"
  }
}

/** Durable session lifecycle owned by the server, not by a client. */
export interface SessionCatalog {
  list(options?: SessionCatalogOptions): Promise<readonly SessionRecord[]>
  get(sessionId: SessionId, options?: SessionCatalogOptions): Promise<SessionRecord | undefined>
  create(sessionId: SessionId, workspace: string, options?: SessionCreateOptions): Promise<SessionRecord>
  /** Set the display title once; an existing title is preserved. */
  setTitleIfAbsent(sessionId: SessionId, title: string, options?: SessionCatalogOptions): Promise<SessionRecord>
  fork(sourceSessionId: SessionId, targetSessionId: SessionId, title?: string, options?: SessionCatalogOptions): Promise<SessionRecord>
  /** Materialize the source conversation at one authoritative logical cursor. */
  forkAtCursor(
    sourceSessionId: SessionId,
    targetSessionId: SessionId,
    cursor: HistoryCursor,
    title?: string,
    options?: SessionCatalogOptions,
  ): Promise<SessionRecord>
  archive(sessionId: SessionId, options?: SessionCatalogOptions): Promise<SessionRecord>
  delete(sessionId: SessionId, options?: SessionCatalogOptions): Promise<void>
}
