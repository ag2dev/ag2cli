/**
 * Input owner: the declarative adjudication table and the arm/binding/
 * epoch bookkeeping that decides which owner a key-intent belongs to.
 * The host-event channel below is contract — the fact vocabulary of
 * the host itself, distinct from keys.
 */
export type { BindingIdentity, ClaimClass, InputWorld, OwnerClaim, OwnerId, Resolution } from "./adjudication.js"
export { OWNER_ORDER, allClaims, resolveIntent } from "./adjudication.js"
export type { ExecutionFacts, ExecutionRefusal, ExecutionVerdict } from "./arms.js"
export { ArmLedger, WriteBarrier, bindingKey, executionGate, sameBinding } from "./arms.js"

export type HostEvent =
  | { readonly type: "resize"; readonly columns: number; readonly rows: number }
  /** Bidirectional: true enters the degraded read-only mode, false leaves it. */
  | { readonly type: "degraded"; readonly value: boolean }
  | { readonly type: "permission-mode"; readonly value: string }
  /**
   * A failed switch abandoned the previous live binding; the kernel
   * holds a sessionless state until a later resume adopts one. The
   * payload names the binding that just died, not the rejected target.
   */
  | { readonly type: "session-detached"; readonly sessionId: string; readonly generation: number }
