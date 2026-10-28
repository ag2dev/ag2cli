/**
 * Execution-side bookkeeping for business bindings. The write barrier
 * records which binding identities a rendered frame carried and which
 * frames the host reported written; the arm ledger records explicit
 * preparation; the execution gate folds the contract conditions into
 * one verdict computed at input arrival. Verdicts are never buffered —
 * an Enter refused today does not replay after a drain.
 */
import type { BindingIdentity } from "./adjudication.js"

/** Stable slot identity; the epoch rides inside BindingIdentity and moves with semantic change. */
export function bindingKey(binding: BindingIdentity): string {
  return `${binding.owner}/${binding.action}/${binding.target}`
}

export function sameBinding(a: BindingIdentity, b: BindingIdentity): boolean {
  return a.owner === b.owner && a.action === b.action && a.target === b.target && a.epoch === b.epoch
}

/** One slot's collapse: certified is sticky within the slot's current epoch; pending holds the in-flight revisions. */
interface BarrierSlotState {
  certified: boolean
  readonly pending: Set<number>
}

/**
 * The write barrier: a binding may execute only through a frame that
 * carried its exact identity and was reported written. Publication
 * records what the rendered snapshot carried — never "the latest
 * state" — so a frame that was superseded before writing certifies
 * nothing it happened to carry.
 *
 * State is collapsed per slot (owner/action/target) at its current
 * epoch: pending revisions grow only while the slot stays offered and
 * are cleared by the written report or by the next publication the
 * slot is absent from — certified survives that absence (the same
 * draft re-typed in the same session needs no re-write), but nothing
 * survives an epoch move. The drop happens inside publish() alone, so
 * a written() report racing after the host stopped offering still
 * certifies; the wired kernel never delivers a report later than the
 * next publish, which keeps the member semantics exact.
 */
export class WriteBarrier {
  private readonly slots = new Map<string, { epoch: number; state: BarrierSlotState }>()
  private writtenRevision = -1

  publish(frameRevision: number, bindings: readonly BindingIdentity[]): void {
    const offered = new Set<string>()
    for (const binding of bindings) {
      const key = bindingKey(binding)
      offered.add(key)
      const entry = this.slots.get(key)
      if (entry !== undefined && entry.epoch === binding.epoch) {
        entry.state.pending.add(frameRevision)
      } else {
        // A superseded epoch drops the whole entry; certified never
        // leaks across an epoch move.
        this.slots.set(key, { epoch: binding.epoch, state: { certified: false, pending: new Set([frameRevision]) } })
      }
    }
    for (const [key, entry] of this.slots) {
      if (!offered.has(key)) entry.state.pending.clear()
    }
  }

  /** The host reports a frame revision truly written; reports arrive in frame order. */
  written(frameRevision: number): void {
    if (frameRevision > this.writtenRevision) this.writtenRevision = frameRevision
    for (const entry of this.slots.values()) {
      if (entry.state.pending.delete(frameRevision)) {
        entry.state.certified = true
        entry.state.pending.clear()
      }
    }
  }

  get maxWrittenRevision(): number {
    return this.writtenRevision
  }

  eligible(binding: BindingIdentity): boolean {
    const entry = this.slots.get(bindingKey(binding))
    return entry !== undefined && entry.epoch === binding.epoch && entry.state.certified
  }

  /** Bounded-state readout for the contract tests: tracked slots and parked pending revisions. */
  trackedState(): { readonly slots: number; readonly pendingRevisions: number } {
    let pendingRevisions = 0
    for (const entry of this.slots.values()) pendingRevisions += entry.state.pending.size
    return { slots: this.slots.size, pendingRevisions }
  }
}

/**
 * Explicit preparation. Arming attaches only to a binding the barrier
 * already certified: a selection made before its frame was written
 * stays a working selection, never a pending arm that a later flush
 * promotes. An armed binding survives completion and task round-trips
 * until execution consumes it or it is disarmed explicitly (submit
 * sent, draft cleared); a semantic change needs no teardown because
 * the moved epoch fails the identity check.
 */
export class ArmLedger {
  private readonly armed = new Map<string, BindingIdentity>()

  /** False when the binding has not passed the barrier; the caller keeps only its working selection. */
  arm(binding: BindingIdentity, barrier: WriteBarrier): boolean {
    if (!barrier.eligible(binding)) return false
    this.armed.set(bindingKey(binding), binding)
    return true
  }

  isArmed(binding: BindingIdentity): boolean {
    const current = this.armed.get(bindingKey(binding))
    return current !== undefined && current.epoch === binding.epoch
  }

  /** Execution consumed the preparation; a repeat press must prepare again. */
  consume(binding: BindingIdentity): void {
    this.armed.delete(bindingKey(binding))
  }

  disarm(binding: BindingIdentity): void {
    this.armed.delete(bindingKey(binding))
  }
}

export type ExecutionRefusal = "identity-changed" | "disabled" | "not-written" | "unarmed"

export type ExecutionVerdict = { readonly execute: true } | { readonly execute: false; readonly reason: ExecutionRefusal }

export interface ExecutionFacts {
  /** The binding this input captured at arrival. */
  readonly binding: BindingIdentity
  /** What the surface currently publishes for the same slot. */
  readonly current: BindingIdentity
  readonly enabled: boolean
  readonly armed: boolean
  readonly written: boolean
}

/**
 * The four contract conditions in refusal order: the identity must
 * still be the live one, the action enabled, the binding's frame
 * written, and the preparation explicit. Each condition fails alone —
 * a verdict never speculates about conditions it did not check.
 */
export function executionGate(facts: ExecutionFacts): ExecutionVerdict {
  if (!sameBinding(facts.binding, facts.current)) return { execute: false, reason: "identity-changed" }
  if (!facts.enabled) return { execute: false, reason: "disabled" }
  if (!facts.written) return { execute: false, reason: "not-written" }
  if (!facts.armed) return { execute: false, reason: "unarmed" }
  return { execute: true }
}
