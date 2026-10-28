import type { SessionId } from "@ag2cli/core/ids.js"
import type { SessionCatalog } from "@ag2cli/runtime/ports/session-catalog.js"
import type { TuiResumeSessionView } from "./tui-command-executor.js"

/** Catalog facts the resume mapping reads; structural so tests need no snapshot fixtures. */
interface ResumeCatalogRecord {
  readonly sessionId: string
  readonly title?: string
  readonly snapshot: { readonly lastRevision: number }
  readonly createdAt: string
  readonly archived: boolean
}

/**
 * Catalog records to resumable rows: live sessions only, never the one
 * already bound, newest revision first with recency breaking ties.
 */
export function resumeSessionRows(
  records: readonly ResumeCatalogRecord[],
  excludeSessionId: string | null,
): readonly TuiResumeSessionView[] {
  return records
    .filter((record) => !record.archived && record.sessionId !== excludeSessionId)
    .map((record): TuiResumeSessionView => ({
      sessionId: record.sessionId,
      ...(record.title === undefined ? {} : { title: record.title }),
      lastRevision: record.snapshot.lastRevision,
      createdAt: record.createdAt,
    }))
    .sort((left, right) => right.lastRevision - left.lastRevision || right.createdAt.localeCompare(left.createdAt))
}

/**
 * The entrypoint owns process lifecycle only, so the branded SessionId
 * stays behind this composition seam. The catalog arrives late-bound:
 * the entry assembles before the runtime build finishes.
 */
export function createTuiResumeSeam(catalog: () => SessionCatalog | null): {
  readonly resumeSessions: (query: {
    readonly excludeSessionId: string | null
    readonly signal?: AbortSignal
  }) => Promise<readonly TuiResumeSessionView[]>
  readonly resumeGate: (sessionId: string) => Promise<void>
  readonly setTitleIfAbsent: (sessionId: string, title: string) => Promise<void>
} {
  return {
    resumeSessions: async ({ excludeSessionId, signal }) => {
      const live = catalog()
      if (live === null) throw new Error("No session catalog is available yet")
      return resumeSessionRows(await live.list(signal === undefined ? undefined : { signal }), excludeSessionId)
    },
    resumeGate: async (sessionId) => {
      const live = catalog()
      if (live === null) throw new Error("No session catalog is available yet")
      const record = await live.get(sessionId as SessionId)
      if (record === undefined) throw new Error(`session not found: ${sessionId}`)
    },
    setTitleIfAbsent: async (sessionId, title) => {
      const live = catalog()
      if (live === null) throw new Error("No session catalog is available yet")
      await live.setTitleIfAbsent(sessionId as SessionId, title)
    },
  }
}
