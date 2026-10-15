import type { SessionId } from "@ag2cli/core/ids.js"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import type { EventStore } from "../../ports/event-store.js"
import { PolicySerialReentryError, type PolicySerialPoint, type PolicySerialSection } from "../../ports/policy-serial-point.js"

/** Canonical security facts the dispatch/spawn fences compare against. */
export interface SessionSecurityStamp {
  readonly policyRevision?: number
  readonly scopeRevision?: number
  readonly scopeDigest?: string
}

/**
 * Runs `spawn` inside the session's serial section after re-checking the
 * bound policy. The closure must resolve once the process is STARTED —
 * awaiting process completion inside it holds the whole session queue for
 * the process lifetime and starves every permission commit behind it.
 */
export type PreSpawnGate = (spawn: () => Promise<unknown>) => Promise<unknown>

/** Denial text the bash spawn fence throws when bound policy went stale. */
export const STALE_POLICY_SPAWN_DENIAL = "stale_policy: session policy changed before process start; process not started"

/**
 * Denial cause shared by the recovery fences in the tool-turn executor and
 * shell execution: an adopted approved-without-result call must converge on
 * one stable code so callers see a resubmit hint instead of user_denied.
 * Rendered as `stale_policy: <reason>`; the constant itself stays bare so
 * `denial.reason` mirrors only the post-code text.
 */
export const STALE_POLICY_RECOVERY_DENIAL = "recovery invalidated a previously approved call; re-request approval by resubmitting"

/**
 * Denial cause shared by the binding fences in the tool-turn executor and
 * shell execution: a recorded approval never covered this exact input.
 * Rendered as `stale_policy: <reason>`.
 */
export const APPROVAL_INPUT_MISMATCH_REASON = "approval input mismatch: the approved call is bound to a different input"

/**
 * Advisory reuse miss shared by the tool-turn executor and shell execution:
 * a decision-less adopted fact stays fail-closed with a resubmit hint
 * instead of a permission code.
 */
export const PREVIOUS_RESULT_NOT_REUSABLE_NOTICE = "previous result not reusable: adjust the input and call again"

export function isStalePolicySpawnDenial(error: unknown): boolean {
  return error instanceof Error && error.message === STALE_POLICY_SPAWN_DENIAL
}

/**
 * Per-session FIFO critical section with holder-based reentry detection.
 * A token is marked while its section is running; a nested request for the
 * same running token throws instead of deadlocking behind itself, while a
 * duplicate whose earlier namesake is still queued simply serializes.
 * Release happens when the section settles (success or failure); the
 * per-session state is dropped once nothing is queued or running.
 */
export class InProcessPolicySerialPoint implements PolicySerialPoint {
  private readonly sessions = new Map<string, { queue: Promise<unknown>; held: Set<string>; pending: number }>()

  /** Sessions with queued or running sections; host observability surface. */
  get activeSessionCount(): number {
    return this.sessions.size
  }

  critical<T>(sessionId: SessionId, taskId: string, section: PolicySerialSection, fn: () => Promise<T>): Promise<T> {
    const key = sessionId.toString()
    let state = this.sessions.get(key)
    if (state === undefined) {
      state = { queue: Promise.resolve(), held: new Set(), pending: 0 }
      this.sessions.set(key, state)
    }
    if (state.held.has(taskId)) return Promise.reject(new PolicySerialReentryError(sessionId, taskId, section))
    state.pending += 1
    const run = state.queue.then(
      () => {
        state!.held.add(taskId)
        return fn()
      },
      () => {
        state!.held.add(taskId)
        return fn()
      },
    )
    // Release before the caller resumes, so re-acquiring the same token
    // after awaiting a section never trips the reentry guard.
    const release = (): void => {
      state!.held.delete(taskId)
      state!.pending -= 1
      // Nothing queued or running remains; the next section safely rebuilds
      // the state, so a long-lived host does not accumulate session entries.
      if (state!.pending === 0) this.sessions.delete(key)
    }
    run.then(release, release)
    state.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

export interface PolicySerialDeps {
  readonly serialPoint: PolicySerialPoint
  readonly readSessionSecurity: (sessionId: SessionId) => Promise<SessionSecurityStamp | undefined>
  readonly preSpawnGateFor: (sessionId: SessionId, taskId: string, bound: SessionSecurityStamp) => PreSpawnGate
}

/**
 * The composition-wide policy serialization bundle: the serial point, a fresh
 * canonical security read, and a bash spawn gate that re-checks that security
 * inside the critical section before the process starts. Unstamped fields
 * are skipped by every comparison, so direct-driven tests without a security
 * snapshot stay deterministic.
 */
export function createInProcessPolicySerialPoint(eventStore: EventStore): PolicySerialDeps {
  const serialPoint = new InProcessPolicySerialPoint()
  const readSessionSecurity = async (sessionId: SessionId): Promise<SessionSecurityStamp | undefined> => {
    const events = await eventStore.read(sessionId)
    if (events.length === 0) return undefined
    const snapshot = replaySession(events)
    return {
      policyRevision: snapshot.policyRevision,
      scopeRevision: snapshot.scopeRevision,
      ...(snapshot.scopeDigest === undefined ? {} : { scopeDigest: snapshot.scopeDigest }),
    }
  }
  const preSpawnGateFor = (sessionId: SessionId, taskId: string, bound: SessionSecurityStamp): PreSpawnGate => {
    return (spawn: () => Promise<unknown>): Promise<unknown> =>
      serialPoint.critical(sessionId, taskId, "bash-spawn", async () => {
        const fresh = await readSessionSecurity(sessionId)
        if (fresh !== undefined && sessionSecurityDrifted(bound, fresh)) {
          throw new Error(STALE_POLICY_SPAWN_DENIAL)
        }
        return await spawn()
      })
  }
  return { serialPoint, readSessionSecurity, preSpawnGateFor }
}

/** Drift is only decidable on fields both sides state; unstamped fields skip. */
export function sessionSecurityDrifted(bound: SessionSecurityStamp, fresh: SessionSecurityStamp): boolean {
  if (bound.policyRevision !== undefined && fresh.policyRevision !== undefined && fresh.policyRevision !== bound.policyRevision) return true
  if (bound.scopeRevision !== undefined && fresh.scopeRevision !== undefined && fresh.scopeRevision !== bound.scopeRevision) return true
  if (bound.scopeDigest !== undefined && fresh.scopeDigest !== undefined && fresh.scopeDigest !== bound.scopeDigest) return true
  return false
}

/**
 * Neutral bundle for direct-driven harnesses: sections run immediately, no
 * canonical security is ever read, and the spawn gate passes through. Tests
 * that exercise the fences inject real deps instead.
 */
export function directDrivePolicySerialDeps(): PolicySerialDeps {
  return {
    serialPoint: new InProcessPolicySerialPoint(),
    readSessionSecurity: async () => undefined,
    preSpawnGateFor: () => async (spawn: () => Promise<unknown>) => await spawn(),
  }
}
