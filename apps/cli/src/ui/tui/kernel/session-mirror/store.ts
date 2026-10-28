/**
 * The mirror store: presentation-only state for the fact vocabulary.
 * Query results cache their payload keyed by request id so a surface
 * can re-open from what was already fetched — the kernel emits a
 * query command only on a true miss. Queue and plan rows are not
 * stored here: the kernel owns their upsert, ordering and lineage
 * because the cancel gesture reads the queue and the plan chrome
 * paints rows as state. Structural shapes only: the payload is typed
 * locally so this owner imports no sibling.
 */
import type { MirrorFact, MirrorFile, MirrorQueryScope, MirrorSessionRow } from "./index.js"

export class MirrorStore {
  private readonly sources = new Set<MirrorFact["source"]>()
  private readonly queryResults = new Map<string, readonly MirrorFile[]>()
  private readonly resumeRows = new Map<string, readonly MirrorSessionRow[]>()
  private readonly queryScopes = new Map<string, MirrorQueryScope>()

  /** True when the fact moved state; sources only record their arrival. */
  ingest(fact: MirrorFact): boolean {
    if (fact.source === "query-result") {
      // A repeat payloadless echo never overwrites a cached payload.
      if (fact.files !== undefined) this.queryResults.set(fact.requestId, fact.files)
      else this.queryResults.set(fact.requestId, this.queryResults.get(fact.requestId) ?? [])
      this.queryScopes.set(fact.requestId, fact.scope)
      return true
    }
    if (fact.source === "resume-sessions") {
      this.resumeRows.set(fact.requestId, fact.rows)
      this.queryScopes.set(fact.requestId, fact.scope)
      return true
    }
    this.sources.add(fact.source)
    return true
  }

  has(source: MirrorFact["source"]): boolean {
    return this.sources.has(source)
  }

  queryResult(requestId: string): readonly MirrorFile[] | undefined {
    return this.queryResults.get(requestId)
  }

  resumeSessions(requestId: string): readonly MirrorSessionRow[] | undefined {
    return this.resumeRows.get(requestId)
  }

  /**
   * Scope-graded invalidation: a session-scoped query cache entry dies
   * with its binding (mismatch, or no live binding at all); workspace
   * and client entries survive switches. Files and resume rows share
   * the grading because both ride the same request-id key space.
   */
  invalidateScopes(live: { readonly sessionId: string; readonly generation: number } | null): void {
    const dead = (scope: MirrorQueryScope): boolean =>
      scope.scope === "session" && (live === null || scope.sessionId !== live.sessionId || scope.generation !== live.generation)
    for (const [requestId, scope] of this.queryScopes) {
      if (!dead(scope)) continue
      this.queryScopes.delete(requestId)
      this.queryResults.delete(requestId)
      this.resumeRows.delete(requestId)
    }
  }
}
