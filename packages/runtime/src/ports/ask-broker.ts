import type { RunId, SessionId } from "@ag2cli/core/ids.js"
import type { AskUserAnswer, AskUserQuestion } from "./ask-user.js"

/** Canonical ask outcomes. Expiry is written only by the restart sweep, never by an answerer. */
export type AskOutcome = "answered" | "chat" | "declined" | "expired"

/** What an answerer returns: a user-reachable outcome plus its answer rows. */
export type AskBrokerOutcome =
  | { readonly outcome: "answered"; readonly answers: readonly AskUserAnswer[] }
  | { readonly outcome: "chat"; readonly answers?: readonly AskUserAnswer[] }
  | { readonly outcome: "declined" }

export interface AskResolution {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly turn: number
  readonly toolUseId: string
  readonly outcome: Exclude<AskOutcome, "expired">
  readonly answers?: readonly AskUserAnswer[]
  readonly contextAnswers?: readonly AskUserAnswer[]
}

/** User-question boundary. The runtime never knows how questions are presented. */
export interface AskBroker {
  request(input: {
    readonly sessionId: SessionId
    readonly runId: RunId
    readonly turn: number
    readonly toolUseId: string
    readonly name: string
    readonly questions: readonly AskUserQuestion[]
    readonly signal?: AbortSignal
  }): Promise<AskBrokerOutcome>
}

/** Optional command-side half of a broker used by remote clients. */
export interface AskResolver {
  resolve(input: AskResolution): boolean
}

export type ResolvableAskBroker = AskBroker & AskResolver

export function isResolvableAskBroker(value: AskBroker): value is ResolvableAskBroker {
  return typeof (value as Partial<AskResolver>).resolve === "function"
}

/** In-memory wait/resolve broker for one server process. Pending asks are durable through events. */
export function createPendingAskBroker(): ResolvableAskBroker {
  interface BrokerEntry {
    readonly sessionId: SessionId
    readonly resolve: (outcome: AskBrokerOutcome) => void
    readonly reject: (error: unknown) => void
  }
  const pending = new Map<string, BrokerEntry>()
  const resolved = new Map<string, { readonly sessionId: SessionId; readonly outcome: AskBrokerOutcome }>()
  // Composite ids are opaque branded strings, so the key is a JSON array and
  // each entry repeats its sessionId for exact-session matching.
  const keyOf = (input: Pick<AskResolution, "sessionId" | "runId" | "turn" | "toolUseId">) =>
    JSON.stringify([input.sessionId, input.runId, input.turn, input.toolUseId])

  return {
    request(input) {
      const key = keyOf(input)
      const earlyOutcome = resolved.get(key)
      if (earlyOutcome) {
        resolved.delete(key)
        return Promise.resolve(earlyOutcome.outcome)
      }
      const existing = pending.get(key)
      if (existing) {
        return new Promise<AskBrokerOutcome>((resolve, reject) => {
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
      return new Promise<AskBrokerOutcome>((resolve, reject) => {
        const onAbort = () => {
          pending.delete(key)
          reject(new DOMException("Ask request cancelled", "AbortError"))
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
        resolved.set(key, {
          sessionId: input.sessionId,
          outcome:
            input.outcome === "answered"
              ? { outcome: "answered", answers: input.answers ?? [] }
              : input.outcome === "chat"
                ? { outcome: "chat", ...(input.answers === undefined ? {} : { answers: input.answers }) }
                : { outcome: "declined" },
        })
        return true
      }
      request.resolve(
        input.outcome === "answered"
          ? { outcome: "answered", answers: input.answers ?? [] }
          : input.outcome === "chat"
            ? { outcome: "chat", ...(input.answers === undefined ? {} : { answers: input.answers }) }
            : { outcome: "declined" },
      )
      return true
    },
  }
}
