import type { RunId, SessionId } from "@ag2cli/core/ids.js"
import type { GuardianDenialReasonCode, ModelToolEffect } from "@ag2cli/core/tool-facts.js"

/**
 * Machine-stable denial cause; the closure is owned by core
 * (`GUARDIAN_DENIAL_REASON_CODES`) and runtime only aliases it so verdicts
 * and canonical events cannot drift apart.
 */
export type { GuardianDenialReasonCode }

/** Effect classification shared with permission judgment; owned by core. */
export type { ModelToolEffect }

/**
 * One prepared action submitted for review. The guardian sees the exact
 * canonical facts the executor would dispatch: it cannot rewrite input, call
 * tools, or modify permission scope, and it never decides step 1/2 denials —
 * only post-rule asks reach a review.
 */
export interface GuardianReviewRequest {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly turn: number
  readonly toolUseId: string
  readonly name: string
  readonly preparedInput: unknown
  /** Binds the review to the exact canonical input; verdicts must echo it. */
  readonly inputFingerprint: string
  readonly cwd?: string
  /**
   * Carries the classified effect instead of full tool metadata: the closed
   * first-release tool set makes the effect the review-relevant fact, so no
   * adapter can be talked into richer introspection by a crafted request.
   */
  readonly effect: ModelToolEffect
  readonly policyRevision: number
  readonly scopeRevision?: number
  readonly approvalFingerprint?: string
  /** The user's own submitted run text; required review context, never agent-authored. */
  readonly goal: string
  /** Runtime-owned review deadline; adapters bound provider/transport calls by it. */
  readonly deadlineMs: number
  /** Run cancellation; implementations reject with AbortError when it fires. */
  readonly signal?: AbortSignal
}

/**
 * A guardian verdict. `guardianId` is stamped by the adapter from local
 * configuration or an authenticated connection — never self-reported by the
 * remote side. The verdict echoes the request bindings (`toolUseId` names the
 * request instance, `inputFingerprint` the action content); the executor
 * verifies both before recording and discards mismatches.
 */
export type GuardianVerdict =
  | {
      readonly decision: "approve"
      readonly guardianId: string
      readonly toolUseId: string
      readonly inputFingerprint: string
      readonly reason?: string
    }
  | {
      readonly decision: "deny"
      readonly guardianId: string
      readonly toolUseId: string
      readonly inputFingerprint: string
      readonly reasonCode: GuardianDenialReasonCode
      /** Bounded display text for humans; machines judge on reasonCode. */
      readonly reason?: string
    }

/**
 * External review boundary for auto-mode asks. Implementations may be an LLM
 * API client, a rule engine, or a remote review service over any transport;
 * the runtime only submits prepared actions and receives verdicts. Execution
 * authority and permission-scope modification stay in AG2CLI.
 */
export interface Guardian {
  readonly guardianId: string
  review(request: GuardianReviewRequest): Promise<GuardianVerdict>
}

/**
 * Invalidation channel for in-flight guardian waits. A security change on a
 * session must never let a review recorded against the old policy approve an
 * action afterwards; `register` aborts immediately when its basis revision
 * already predates the latest invalidation.
 */
export interface GuardianWaitRegistry {
  register(sessionId: SessionId, basisPolicyRevision: number): { readonly aborted: Promise<"invalidated">; dispose(): void }
  /**
   * Aborts a session's in-flight waits. `policyRevision` is the session's
   * post-change revision: a wait whose basis predates it reviewed under dead
   * policy, while a wait already standing on it stays valid.
   */
  invalidate(sessionId: SessionId, policyRevision: number): void
}

/**
 * Bound on the invalidation-watermark map: the watermark is only the fast
 * abort path for stale registrations. Record-time revision CAS and the
 * dispatch-time drift re-check are the authoritative fences, so evicting the
 * oldest session's watermark cannot resurrect a review under dead policy.
 */
export const GUARDIAN_WAIT_REGISTRY_MAX_TRACKED_SESSIONS = 1_024

export function createGuardianWaitRegistry(): GuardianWaitRegistry {
  interface WaitEntry {
    readonly basisPolicyRevision: number
    readonly abort: (reason: "invalidated") => void
  }
  const waits = new Map<SessionId, Set<WaitEntry>>()
  const latestInvalidatedPolicyRevision = new Map<SessionId, number>()
  const trackInvalidation = (sessionId: SessionId, policyRevision: number): void => {
    // Re-insert so the map stays insertion-ordered by recency: the oldest
    // tracked session is always the first key.
    latestInvalidatedPolicyRevision.delete(sessionId)
    latestInvalidatedPolicyRevision.set(sessionId, policyRevision)
    if (latestInvalidatedPolicyRevision.size > GUARDIAN_WAIT_REGISTRY_MAX_TRACKED_SESSIONS) {
      const oldest = latestInvalidatedPolicyRevision.keys().next().value
      if (oldest !== undefined) latestInvalidatedPolicyRevision.delete(oldest)
    }
  }
  return {
    register(sessionId, basisPolicyRevision) {
      let abort: (reason: "invalidated") => void = () => undefined
      const aborted = new Promise<"invalidated">((resolve) => {
        abort = resolve
      })
      // A basis older than the latest recorded invalidation is already stale:
      // reviewing against dead policy must not even start.
      const latest = latestInvalidatedPolicyRevision.get(sessionId)
      if (latest !== undefined && basisPolicyRevision < latest) {
        abort("invalidated")
        return { aborted, dispose: () => undefined }
      }
      let entries = waits.get(sessionId)
      if (entries === undefined) {
        entries = new Set()
        waits.set(sessionId, entries)
      }
      const entry: WaitEntry = { basisPolicyRevision, abort }
      entries.add(entry)
      return {
        aborted,
        dispose: () => {
          entries.delete(entry)
          if (entries.size === 0) waits.delete(sessionId)
        },
      }
    },
    invalidate(sessionId, policyRevision) {
      const latest = latestInvalidatedPolicyRevision.get(sessionId)
      // An unchanged revision still refreshes recency; only an older one must
      // skip, so the watermark value never goes down.
      if (latest === undefined || policyRevision >= latest) trackInvalidation(sessionId, policyRevision)
      const entries = waits.get(sessionId)
      if (entries === undefined) return
      // Only waits that reviewed under now-dead policy abort: a wait already
      // standing on the post-change revision stays valid.
      for (const entry of entries) {
        if (entry.basisPolicyRevision < policyRevision) {
          entries.delete(entry)
          entry.abort("invalidated")
        }
      }
      if (entries.size === 0) waits.delete(sessionId)
    },
  }
}

/** Default runtime-owned review deadline; composition may override per host. */
export const DEFAULT_GUARDIAN_REVIEW_DEADLINE_MS = 15_000

/** One-shot deadline race used by the executor; injectable for tests. */
export interface GuardianDeadlineTimer {
  start(ms: number): { readonly expired: Promise<"deadline">; cancel(): void }
}

export function createGuardianDeadlineTimer(): GuardianDeadlineTimer {
  return {
    start(ms: number) {
      let cancelTimer: (() => void) | undefined
      const expired = new Promise<"deadline">((resolve) => {
        const handle = setTimeout(() => resolve("deadline"), ms)
        cancelTimer = () => clearTimeout(handle)
      })
      return {
        expired,
        cancel: () => {
          cancelTimer?.()
        },
      }
    },
  }
}
