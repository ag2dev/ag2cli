/**
 * Child approval bridge (composition seam): one FIFO for every question a
 * child session surfaces onto the parent's human approval face — tool asks
 * (bubbled through the child's broker) and ask_user questions share the
 * queue, kind-distinguished, and only the head is ever raised on the card
 * surface. Settles are single-winner by token: a card answer settles the
 * head, an abort dequeues its own entry, a parent policy change settles
 * that parent's waiting approvals terminally stale (the child would
 * otherwise re-ask under a dead security snapshot), and the modal sweep
 * (session switch/exit) settles everything non-terminally. The bridge holds
 * no approval authority of its own: an "approved" verdict exists only
 * through a card-side settle.
 */
import type { SessionId } from "@ag2cli/core/ids.js"
import type { ApprovalBroker, ApprovalDecision, ApprovalOutcome } from "@ag2cli/runtime/ports/approval-broker.js"
import type { AskUserAnswer, AskUserQuestion } from "@ag2cli/runtime/ports/ask-user.js"
import type { AskUser } from "@ag2cli/runtime/ports/tool/contract.js"
import type { ChildAskAttribution, ChildApprovalRunnerSurface } from "../capabilities/execution/child-agent-runner.js"
import { askCardQuestions, askSettlementAnswers } from "./ask-user-bridge.js"

/** Which parent/child a bridged question belongs to (defined by the runner). */
export type { ChildAskAttribution }

/** A bridged tool ask raised on the parent approval surface. */
export interface ChildApprovalAskCard {
  readonly token: string
  readonly version: number
  readonly kind: "approval"
  readonly attribution: ChildAskAttribution
  readonly toolName: string
  readonly toolInput: unknown
}

/** A bridged ask_user raise on the parent ask surface. */
export interface ChildUserAskCard {
  readonly token: string
  readonly version: number
  readonly kind: "ask"
  readonly attribution: ChildAskAttribution
  readonly questions: ReturnType<typeof askCardQuestions>
}

export type ChildApprovalCard = ChildApprovalAskCard | ChildUserAskCard

/** The parent card surface the bridge raises onto (wired by the TUI host). */
export interface ChildApprovalSurface {
  /** Present the queue head; `version` is the bridge-local monotonic card version. */
  raise(card: ChildApprovalCard): void
  /** A raised card left the queue without a card-side settle (abort, invalidation, sweep). */
  retract(token: string): void
}

export interface ParkChildApprovalInput {
  readonly attribution: ChildAskAttribution
  readonly toolName: string
  readonly toolInput: unknown
  readonly signal?: AbortSignal
}

export interface ParkChildAskInput {
  readonly attribution: ChildAskAttribution
  readonly questions: readonly AskUserQuestion[]
  readonly signal?: AbortSignal
}

export interface ChildAskSettlement {
  readonly outcome: "answered" | "declined" | "chat"
  readonly selected: readonly (readonly string[])[]
}

interface BridgeEntry {
  readonly token: string
  readonly kind: "approval" | "ask"
  readonly attribution: ChildAskAttribution
  readonly toolName?: string
  readonly toolInput?: unknown
  readonly questions?: readonly AskUserQuestion[]
  readonly signal?: AbortSignal
  onAbort?: () => void
  resolveApproval?: (outcome: ApprovalOutcome) => void
  resolveAsk?: (answers: AskUserAnswer[]) => void
  reject?: (error: unknown) => void
}

export interface ChildApprovalBridge {
  parkApproval(input: ParkChildApprovalInput): Promise<ApprovalOutcome>
  parkAsk(input: ParkChildAskInput): Promise<AskUserAnswer[]>
  /** Card-side approval settle; false for stale or unknown tokens. */
  settleApproval(token: string, decision: ApprovalDecision): boolean
  /** Card-side ask settle; false for stale or unknown tokens. */
  settleAsk(token: string, settlement: ChildAskSettlement): boolean
  /** Parent policy changed: settle that parent's waiting approvals terminal
   * stale (the child maps invalidated to stale_policy and ends), decline its asks. */
  invalidateChildren(parentSessionId: SessionId): number
  /** Modal sweep: settle every entry non-terminally and close the raised card. */
  cancelAll(): number
  /** A displacing card closed; re-raise the parked head once per call. */
  notifySurfaceAvailable(): boolean
}

export function createChildApprovalBridge(surface: ChildApprovalSurface): ChildApprovalBridge {
  const queue: BridgeEntry[] = []
  let tokenSequence = 0
  let versionSequence = 0

  const raiseHead = (): void => {
    const head = queue[0]
    if (head === undefined) return
    versionSequence += 1
    surface.raise(
      head.kind === "approval"
        ? {
            token: head.token,
            version: versionSequence,
            kind: "approval",
            attribution: head.attribution,
            toolName: head.toolName!,
            toolInput: head.toolInput,
          }
        : {
            token: head.token,
            version: versionSequence,
            kind: "ask",
            attribution: head.attribution,
            questions: askCardQuestions(head.questions ?? []),
          },
    )
  }

  const detachSignal = (entry: BridgeEntry): void => {
    if (entry.onAbort !== undefined) {
      entry.signal?.removeEventListener("abort", entry.onAbort)
      entry.onAbort = undefined
    }
  }

  const declineOf = (entry: BridgeEntry): AskUserAnswer[] =>
    askSettlementAnswers(entry.questions ?? [], { requestId: entry.token, outcome: "declined", selected: [] })

  /**
   * Splice one entry out, settle its parked promise, and advance the head.
   * The entry is dequeued before settling so a re-entrant settle is a no-op
   * (single-winner). `closeCard` distinguishes the leave paths: a card
   * settle closes its own card, so only abort/invalidate/sweep dequeues
   * retract it here. Tail entries settle before the head when a batch sweeps
   * the queue, so no intermediate head is ever raised just to be retracted.
   */
  const dequeue = (entry: BridgeEntry, settle: (entry: BridgeEntry) => void, closeCard: boolean): boolean => {
    const index = queue.indexOf(entry)
    if (index === -1) return false
    queue.splice(index, 1)
    detachSignal(entry)
    const wasHead = index === 0
    if (wasHead && closeCard) surface.retract(entry.token)
    settle(entry)
    if (wasHead) raiseHead()
    return true
  }

  const abortError = () => new DOMException("Approval request cancelled", "AbortError")

  const park = (entry: BridgeEntry): void => {
    if (entry.signal?.aborted) {
      if (entry.kind === "ask") entry.resolveAsk!(declineOf(entry))
      else entry.reject!(abortError())
      return
    }
    queue.push(entry)
    if (entry.signal !== undefined) {
      const onAbort = () => {
        if (entry.kind === "ask") dequeue(entry, (e) => e.resolveAsk!(declineOf(e)), true)
        else dequeue(entry, (e) => e.reject!(abortError()), true)
      }
      entry.onAbort = onAbort
      entry.signal.addEventListener("abort", onAbort, { once: true })
    }
    if (queue.length === 1) raiseHead()
  }

  const sweep = (settle: (entry: BridgeEntry) => void, parentSessionId?: SessionId): number => {
    let settled = 0
    for (const entry of [...queue].reverse()) {
      if (parentSessionId !== undefined && entry.attribution.parentSessionId !== parentSessionId) continue
      if (dequeue(entry, settle, true)) settled += 1
    }
    return settled
  }

  return {
    parkApproval: (input) =>
      new Promise<ApprovalOutcome>((resolve, reject) => {
        tokenSequence += 1
        park({
          token: `child-approval-${tokenSequence}`,
          kind: "approval",
          attribution: input.attribution,
          toolName: input.toolName,
          toolInput: input.toolInput,
          signal: input.signal,
          resolveApproval: resolve,
          reject,
        })
      }),
    parkAsk: (input) => {
      if (input.questions.length === 0) return Promise.resolve([])
      return new Promise<AskUserAnswer[]>((resolve) => {
        tokenSequence += 1
        park({
          token: `child-ask-${tokenSequence}`,
          kind: "ask",
          attribution: input.attribution,
          questions: input.questions,
          signal: input.signal,
          resolveAsk: resolve,
        })
      })
    },
    settleApproval: (token, decision) => {
      const entry = queue.find((candidate) => candidate.token === token)
      if (entry === undefined || entry.kind !== "approval") return false
      return dequeue(entry, (e) => e.resolveApproval!(decision), false)
    },
    settleAsk: (token, settlement) => {
      const entry = queue.find((candidate) => candidate.token === token)
      if (entry === undefined || entry.kind !== "ask") return false
      return dequeue(
        entry,
        (e) =>
          e.resolveAsk!(
            askSettlementAnswers(e.questions ?? [], {
              requestId: token,
              outcome: settlement.outcome,
              selected: settlement.selected,
            }),
          ),
        false,
      )
    },
    invalidateChildren: (parentSessionId) =>
      sweep((entry) => {
        if (entry.kind === "approval") entry.resolveApproval!({ decision: "denied", reason: "invalidated", terminal: true })
        else entry.resolveAsk!(declineOf(entry))
      }, parentSessionId),
    cancelAll: () =>
      sweep((entry) => {
        if (entry.kind === "approval") entry.resolveApproval!("denied")
        else entry.resolveAsk!(declineOf(entry))
      }),
    notifySurfaceAvailable: () => {
      if (queue.length === 0) return false
      raiseHead()
      return true
    },
  }
}

/** Bubbling broker: forwards one child's approval asks into the bridge FIFO. */
export function createChildApprovalBridgeBroker(bridge: ChildApprovalBridge, attribution: ChildAskAttribution): ApprovalBroker {
  return {
    request(input) {
      return bridge.parkApproval({
        attribution,
        toolName: input.name,
        toolInput: input.input,
        signal: input.signal,
      })
    },
  }
}

/** Child askUser callback: parks ask_user questions in the same FIFO. */
export function createChildAskUser(bridge: ChildApprovalBridge, attribution: ChildAskAttribution, signal?: AbortSignal): AskUser {
  return (questions) => bridge.parkAsk({ attribution, questions: [...questions], signal })
}

/** Runner-facing ingress adapter: one port onto the bridge primitives. */
export function createChildApprovalRunnerSurface(bridge: ChildApprovalBridge): ChildApprovalRunnerSurface {
  return {
    brokerFor: (attribution) => createChildApprovalBridgeBroker(bridge, attribution),
    askUserFor: (attribution, signal) => createChildAskUser(bridge, attribution, signal),
    invalidateChildren: (parentSessionId) => bridge.invalidateChildren(parentSessionId),
  }
}
