/**
 * The operation ledger: every world-changing command carries an id
 * minted here, and every operation-result is adjudicated here before
 * it may touch kernel state. Arrival order is never trusted — a
 * result converges only while its origin still matches the origin the
 * id was minted under, graded by scope: client results always
 * converge, workspace results die with their workspace, session
 * results die with a binding mismatch. Settlement is exactly-once per
 * id, so a duplicated executor echo converges nothing the second
 * time.
 */
import type { OperationId, OperationOrigin } from "./contract.js"

export type SettlementReason = "accepted" | "unknown-id" | "already-settled" | "origin-mismatch"

export interface OperationSettlement {
  readonly accepted: boolean
  readonly reason: SettlementReason
}

export class OperationLedger {
  private readonly minted = new Map<OperationId, OperationOrigin>()
  private readonly settled = new Set<OperationId>()
  private nextIndex = 1

  mint(origin: OperationOrigin): OperationId {
    const id = `op:${this.nextIndex}`
    this.nextIndex += 1
    this.minted.set(id, origin)
    return id
  }

  origin(id: OperationId): OperationOrigin | undefined {
    return this.minted.get(id)
  }

  pending(): readonly OperationId[] {
    return [...this.minted.keys()].filter((id) => !this.settled.has(id))
  }

  /** Adjudicate one result against the origin its id was minted under. */
  settle(id: OperationId, origin: OperationOrigin): OperationSettlement {
    const mintOrigin = this.minted.get(id)
    if (mintOrigin === undefined) return { accepted: false, reason: "unknown-id" }
    if (this.settled.has(id)) return { accepted: false, reason: "already-settled" }
    if (!converges(mintOrigin, origin)) return { accepted: false, reason: "origin-mismatch" }
    this.settled.add(id)
    return { accepted: true, reason: "accepted" }
  }
}

/** The scope-graded convergence rule the facade documents; pure so tests can reach it directly. */
export function converges(mint: OperationOrigin, result: OperationOrigin): boolean {
  if (result.scope === "client") return true
  if (mint.scope === "workspace" && result.scope === "workspace") return mint.workspaceId === result.workspaceId
  if (mint.scope === "session" && result.scope === "session")
    return mint.sessionId === result.sessionId && mint.generation === result.generation
  return false
}
