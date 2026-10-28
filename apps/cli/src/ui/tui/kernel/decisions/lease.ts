/**
 * The decision lease state machine: one lease per disclosed request,
 * presentation separated from authority. Collapse never resolves, a
 * settle is accepted at most once, retract closes from any live
 * state, and a rejected resolve reconciles by the request's own
 * identity — still pending re-shows the entry, a retraction closes,
 * an undecidable read parks as unknown (never terminal, never
 * misreported as failure). Leases are independent: no event on one
 * request touches another.
 */
import type { DecisionFact } from "./facts.js"

export interface DecisionLease {
  readonly state: "hidden-pending" | "presenting" | "resolving" | "resolved" | "retracted" | "unknown"
  /** Disclosure version the user has reviewed; behind the current one, settling is disarmed. */
  readonly reviewedDisclosure: number
  readonly disclosure: number
  /** Working selections per questionId; they survive collapse, repeat raise, and disclosure change alike. */
  readonly answers: Readonly<Record<string, readonly string[]>>
  /**
   * True once this lease has held the stage. A collapsed lease never
   * auto-reopens — a repeat raise stays collapsed and only the pending
   * chooser brings it back. A rejected resolve resets it: the
   * re-presentation after a still-pending reconcile is a fresh birth.
   */
  readonly everPresented: boolean
}

export type LeaseEvent =
  | { readonly kind: "raise"; readonly disclosure: number }
  | { readonly kind: "open" }
  | { readonly kind: "collapse" }
  | { readonly kind: "settle" }
  | { readonly kind: "review" }
  | { readonly kind: "authority-confirmed" }
  | { readonly kind: "authority-retracted" }
  | { readonly kind: "reconcile"; readonly read: "still-pending" | "retracted" | "undecidable" }
  | { readonly kind: "late-confirmed" }

/** A lease appears only through disclosure; nothing pre-exists its first raise. */
export function initialLease(disclosure: number): DecisionLease {
  return { state: "hidden-pending", reviewedDisclosure: disclosure, disclosure, answers: {}, everPresented: false }
}

/** True while the disclosure moved ahead of what the user reviewed; settle refuses under it. */
export function needsReview(lease: DecisionLease): boolean {
  return lease.reviewedDisclosure !== lease.disclosure
}

const HIDDEN: ReadonlySet<DecisionLease["state"]> = new Set(["hidden-pending"])

/**
 * One transition. `settled` is true exactly when this event moved a
 * presenting lease into resolving — the single-winner signal: every
 * other settle attempt, from any state, settles nothing.
 */
export function reduceLease(lease: DecisionLease, event: LeaseEvent): { readonly lease: DecisionLease; readonly settled: boolean } {
  switch (event.kind) {
    case "raise": {
      // Terminal leases never reopen; a re-raised request needs a new identity.
      if (lease.state === "resolved" || lease.state === "retracted") return { lease, settled: false }
      // Repeat raise of the same disclosure changes nothing — not the
      // collapse state, not the working answers.
      if (event.disclosure === lease.disclosure) return { lease, settled: false }
      return { lease: { ...lease, disclosure: event.disclosure }, settled: false }
    }
    case "open": {
      if (lease.state !== "hidden-pending") return { lease, settled: false }
      return { lease: { ...lease, state: "presenting", reviewedDisclosure: lease.disclosure, everPresented: true }, settled: false }
    }
    case "collapse": {
      // Back hides the presentation; resolving stays visible and never hides.
      if (lease.state !== "presenting") return { lease, settled: false }
      return { lease: { ...lease, state: "hidden-pending" }, settled: false }
    }
    case "review": {
      if (lease.state !== "presenting" && !HIDDEN.has(lease.state)) return { lease, settled: false }
      return { lease: { ...lease, reviewedDisclosure: lease.disclosure }, settled: false }
    }
    case "settle": {
      if (lease.state !== "presenting" || needsReview(lease)) return { lease, settled: false }
      return { lease: { ...lease, state: "resolving" }, settled: true }
    }
    case "authority-confirmed": {
      if (lease.state !== "resolving") return { lease, settled: false }
      return { lease: { ...lease, state: "resolved" }, settled: false }
    }
    case "authority-retracted": {
      if (lease.state === "resolved" || lease.state === "retracted") return { lease, settled: false }
      return { lease: { ...lease, state: "retracted" }, settled: false }
    }
    case "reconcile": {
      if (lease.state !== "resolving") return { lease, settled: false }
      if (event.read === "still-pending") return { lease: { ...lease, state: "hidden-pending", everPresented: false }, settled: false }
      if (event.read === "retracted") return { lease: { ...lease, state: "retracted" }, settled: false }
      return { lease: { ...lease, state: "unknown" }, settled: false }
    }
    case "late-confirmed": {
      if (lease.state !== "unknown") return { lease, settled: false }
      return { lease: { ...lease, state: "resolved" }, settled: false }
    }
  }
}

/** Selection edits ride alongside the lease; they re-review nothing and settle nothing. */
export function withAnswer(lease: DecisionLease, questionId: string, selectedOptionIds: readonly string[]): DecisionLease {
  return { ...lease, answers: { ...lease.answers, [questionId]: selectedOptionIds } }
}

/**
 * The per-request registry. Events always name one request; the map
 * makes the independence structural — there is no ordering between
 * requests and no shared queue.
 */
export class DecisionLeases {
  private readonly leases = new Map<string, DecisionLease>()

  raise(fact: DecisionFact): void {
    const id = fact.fact.request.id
    const existing = this.leases.get(id)
    if (existing === undefined) {
      this.leases.set(id, initialLease(fact.disclosure))
      return
    }
    this.leases.set(id, reduceLease(existing, { kind: "raise", disclosure: fact.disclosure }).lease)
  }

  /** Routes one event to one request; unknown ids settle nothing. */
  dispatch(id: string, event: LeaseEvent): boolean {
    const lease = this.leases.get(id)
    if (lease === undefined) return false
    const outcome = reduceLease(lease, event)
    this.leases.set(id, outcome.lease)
    return outcome.settled
  }

  lease(id: string): DecisionLease | undefined {
    return this.leases.get(id)
  }

  /** Working-selection edit on one lease; unknown ids change nothing. Not a state transition. */
  answer(id: string, questionId: string, selectedOptionIds: readonly string[]): void {
    const lease = this.leases.get(id)
    if (lease === undefined) return
    this.leases.set(id, withAnswer(lease, questionId, selectedOptionIds))
  }

  /** The binding the requests belonged to ended; every lease goes with it. */
  reset(): void {
    this.leases.clear()
  }
}
