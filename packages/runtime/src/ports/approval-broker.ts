import type { RunId, SessionId } from "@ag2cli/core/ids.js"
import type { ToolExecutionMetadata } from "@ag2cli/core/tool-facts.js"

export type ApprovalDecision = "approved" | "denied"

/** Structured cause of a denial; the executor maps it to tool result text. */
export type DenialReason = "quota-exceeded" | "background-no-ask" | "no-approval-surface" | "invalidated" | "guardian-denied"

/**
 * A broker either decides or denies with a structured cause. Plain decisions
 * stay valid members of the union, so existing brokers need no change. A
 * `terminal` denial ends the run instead of settling as a retryable in-run
 * result; only an answerer that knows the ask's policy world is gone (e.g. a
 * child bridge invalidated by a parent security change) may set it.
 */
export type ApprovalOutcome = ApprovalDecision | { readonly decision: "denied"; readonly reason: DenialReason; readonly terminal?: boolean }

export function approvalDecisionOf(outcome: ApprovalOutcome): ApprovalDecision {
  return typeof outcome === "string" ? outcome : outcome.decision
}

/** User/policy approval boundary. The runtime never knows how approval is presented. */
export interface ApprovalBroker {
  request(input: {
    readonly sessionId: SessionId
    readonly runId: RunId
    readonly turn: number
    readonly toolUseId: string
    readonly name: string
    readonly input: unknown
    readonly tool?: ToolExecutionMetadata
    readonly signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

export interface ApprovalResolution {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly turn: number
  readonly toolUseId: string
  readonly decision: ApprovalDecision
}

/** Optional command-side half of a broker used by remote clients. */
export interface ApprovalResolver {
  resolve(input: ApprovalResolution): boolean
}

/** Optional server-side invalidation hook for policy/scope changes. */
export interface ApprovalInvalidator {
  invalidatePending(sessionId: SessionId): void
}

export type ResolvableApprovalBroker = ApprovalBroker & ApprovalResolver

export function isResolvableApprovalBroker(value: ApprovalBroker): value is ResolvableApprovalBroker {
  return typeof (value as Partial<ApprovalResolver>).resolve === "function"
}

export type InvalidatingApprovalBroker = ApprovalBroker & ApprovalInvalidator

export function isInvalidatingApprovalBroker(value: ApprovalBroker): value is InvalidatingApprovalBroker {
  return typeof (value as Partial<ApprovalInvalidator>).invalidatePending === "function"
}

/** In-memory wait/resolve broker for one server process. Pending requests are durable through events. */
export function createPendingApprovalBroker(): ResolvableApprovalBroker & ApprovalInvalidator {
  interface BrokerEntry {
    readonly sessionId: SessionId
    readonly resolve: (outcome: ApprovalOutcome) => void
    readonly reject: (error: unknown) => void
  }
  const pending = new Map<string, BrokerEntry>()
  const resolved = new Map<string, { readonly sessionId: SessionId; readonly decision: ApprovalDecision }>()
  // Composite ids are opaque branded strings that may contain any flat-key
  // delimiter, so the key is a JSON array and each entry repeats its
  // sessionId: invalidation matches the exact session instead of a
  // splittable prefix.
  const keyOf = (input: Pick<ApprovalResolution, "sessionId" | "runId" | "turn" | "toolUseId">) =>
    JSON.stringify([input.sessionId, input.runId, input.turn, input.toolUseId])

  return {
    request(input) {
      const key = keyOf(input)
      const earlyDecision = resolved.get(key)
      if (earlyDecision) {
        resolved.delete(key)
        return Promise.resolve(earlyDecision.decision)
      }
      const existing = pending.get(key)
      if (existing) {
        return new Promise<ApprovalOutcome>((resolve, reject) => {
          pending.set(key, {
            sessionId: input.sessionId,
            resolve: (outcome) => {
              existing.resolve(outcome)
              resolve(outcome)
            },
            reject: (error) => {
              existing.reject(error)
              reject(error)
            },
          })
        })
      }
      return new Promise<ApprovalOutcome>((resolve, reject) => {
        const onAbort = () => {
          pending.delete(key)
          reject(new DOMException("Approval request cancelled", "AbortError"))
        }
        if (input.signal?.aborted) {
          onAbort()
          return
        }
        input.signal?.addEventListener("abort", onAbort, { once: true })
        pending.set(key, {
          sessionId: input.sessionId,
          resolve: (outcome) => {
            input.signal?.removeEventListener("abort", onAbort)
            pending.delete(key)
            resolve(outcome)
          },
          reject: (error) => {
            input.signal?.removeEventListener("abort", onAbort)
            pending.delete(key)
            reject(error)
          },
        })
      })
    },
    resolve(input) {
      const key = keyOf(input)
      const request = pending.get(key)
      if (!request) {
        resolved.set(key, { sessionId: input.sessionId, decision: input.decision })
        return true
      }
      request.resolve(input.decision)
      return true
    },
    invalidatePending(sessionId) {
      // A security revision change must not leave this session's requests
      // waiting for a decision made under the old policy. They resolve as a
      // structured denial so the canonical tool lifecycle records the
      // resolution and the executor maps the cause to stale_policy. Exact
      // sessionId equality keeps other sessions' pending work and recorded
      // early decisions untouched.
      for (const [key, request] of pending) {
        if (request.sessionId !== sessionId) continue
        pending.delete(key)
        request.resolve({ decision: "denied", reason: "invalidated" })
      }
      for (const [key, entry] of [...resolved]) {
        if (entry.sessionId === sessionId) resolved.delete(key)
      }
    },
  }
}

/** Non-interactive fallback: there is no user to ask, so a request that
 * survives the session permission policy is denied fast instead of hanging.
 * The denial is recorded as an in-conversation tool result; the run completes. */
export function createDenyAllApprovalBroker(): ApprovalBroker {
  return {
    async request() {
      return "denied"
    },
  }
}
