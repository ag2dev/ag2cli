/**
 * Ask-user bridge (composition seam): adapts the runtime's AskUser
 * callback onto the TUI's ask-card channel. The bridge owns the
 * pending-request table — the ask promise parks until the card's answer
 * effect settles it, and orphaned pendings (a superseding raise, or the
 * modal sweep on session switch/exit) decline-settle so no ask hangs —
 * and maps the TUI's answer table onto the runtime answer contract
 * (header fallback, per-question alignment, cancel on decline, chat
 * actions on the discuss-instead-of-answer escape). The
 * entrypoint only wires raise/settle/cancelAll to the TUI; every mapping
 * decision lives here, testable without a terminal.
 */
import type { AskUserAnswer, AskUserQuestion } from "@ag2cli/runtime/ports/ask-user.js"
import type { AskUser } from "@ag2cli/runtime/ports/tool/contract.js"
import { askTabLabel, type AskRequest } from "../ui/tui/state/index.js"

/** The answer-table shape the card's answer effect carries. */
export interface AskCardSettlement {
  readonly requestId: string
  readonly outcome: "answered" | "declined" | "chat"
  readonly selected: readonly (readonly string[])[]
}

interface PendingAsk {
  readonly questions: readonly AskUserQuestion[]
  readonly resolve: (answers: AskUserAnswer[] | PromiseLike<AskUserAnswer[]>) => void
}

export interface AskUserBridge {
  /** Runtime-facing ask callback (inject into the host build). */
  readonly askUser: AskUser
  /**
   * Settle a raised card: true when the requestId was pending (the ask
   * promise resolves with it), false for stale or unknown requests.
   */
  readonly settle: (settlement: AskCardSettlement) => boolean
  /**
   * Decline-settle every parked ask (the modal sweep orphaned the card:
   * session switch/adoption, or process exit). Each deferred resolves
   * with per-question cancel answers; returns how many were settled.
   */
  readonly cancelAll: () => number
}

/** Per-question cancel answers (decline and modal-sweep settlements). */
const declineAnswers = (questions: readonly AskUserQuestion[]): AskUserAnswer[] =>
  questions.map((question) => ({
    header: question.header ?? askTabLabel(question.question),
    selected: [],
    action: "cancel" as const,
  }))

/** The chat escape: discuss-instead-of-answer maps onto per-question
 * chat actions, which the tool turns into clarification feedback. */
const chatAnswers = (questions: readonly AskUserQuestion[]): AskUserAnswer[] =>
  questions.map((question) => ({
    header: question.header ?? askTabLabel(question.question),
    selected: [],
    action: "chat" as const,
  }))

/** Map runtime questions onto the ask-card question table (pure). */
export function askCardQuestions(questions: readonly AskUserQuestion[]): AskRequest["questions"] {
  return questions.map((question) => ({
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
    options: question.options.map((option) => ({
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
  }))
}

/** Map a card settlement onto the runtime answer table (pure). */
export function askSettlementAnswers(questions: readonly AskUserQuestion[], settlement: AskCardSettlement): AskUserAnswer[] {
  return settlement.outcome === "answered"
    ? questions.map((question, index) => ({
        header: question.header ?? askTabLabel(question.question),
        selected: [...(settlement.selected[index] ?? [])],
      }))
    : settlement.outcome === "chat"
      ? chatAnswers(questions)
      : declineAnswers(questions)
}

export function createAskUserBridge(raise: (request: AskRequest) => void): AskUserBridge {
  const pending = new Map<string, PendingAsk>()
  let sequence = 0
  const declineSettleAll = (): number => {
    let settled = 0
    for (const [requestId, entry] of pending) {
      pending.delete(requestId)
      entry.resolve(declineAnswers(entry.questions))
      settled += 1
    }
    return settled
  }
  return {
    askUser: (runtimeQuestions) => {
      const questions = [...runtimeQuestions]
      if (questions.length === 0) return Promise.resolve([])
      // A new raise supersedes any parked ask: the card carries exactly
      // one request, so an unanswered prior would otherwise park forever
      // (its requestId left the card and can never settle).
      declineSettleAll()
      sequence += 1
      const requestId = `ask-${sequence}`
      return new Promise((resolve) => {
        pending.set(requestId, { questions, resolve })
        raise({
          requestId,
          questions: askCardQuestions(questions),
        })
      })
    },
    settle: (settlement) => {
      const entry = pending.get(settlement.requestId)
      if (entry === undefined) return false
      pending.delete(settlement.requestId)
      entry.resolve(askSettlementAnswers(entry.questions, settlement))
      return true
    },
    cancelAll: declineSettleAll,
  }
}
