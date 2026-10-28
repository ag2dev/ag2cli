/**
 * Per-session draft store under a byte budget. A session switch saves
 * the outgoing draft and loads the incoming one, so resuming a session
 * restores what was being typed. Clean (empty) slots are evicted
 * oldest-first when the budget overflows; a dirty draft — unsent work
 * — is never dropped silently: when nothing clean can pay, the store
 * keeps every draft and reports the overflow so the surface can say
 * so.
 */
export interface DraftSlot {
  readonly sessionId: string
  readonly text: string
}

export interface DraftOverflow {
  readonly keptSessionId: string
  readonly bytes: number
  readonly budget: number
}

export type DraftSaveOutcome = { readonly evicted: readonly string[]; readonly overflow: DraftOverflow | null }

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).length

export class SessionDrafts {
  private readonly slots = new Map<string, string>()
  private readonly budget: number

  constructor(budget: number) {
    this.budget = budget
  }

  /** Save one session's draft; eviction pays for overflow with clean slots only. */
  save(sessionId: string, text: string): DraftSaveOutcome {
    this.slots.delete(sessionId)
    this.slots.set(sessionId, text)
    const evicted: string[] = []
    for (const [candidate, candidateText] of this.slots) {
      if (this.totalBytes() <= this.budget) break
      if (candidate === sessionId || candidateText.length > 0) continue
      this.slots.delete(candidate)
      evicted.push(candidate)
    }
    const overflow = this.totalBytes() > this.budget ? { keptSessionId: sessionId, bytes: this.totalBytes(), budget: this.budget } : null
    return { evicted, overflow }
  }

  load(sessionId: string): string {
    return this.slots.get(sessionId) ?? ""
  }

  drop(sessionId: string): void {
    this.slots.delete(sessionId)
  }

  private totalBytes(): number {
    let total = 0
    for (const text of this.slots.values()) total += byteLength(text)
    return total
  }
}
