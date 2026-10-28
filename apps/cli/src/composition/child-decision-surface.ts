/**
 * Child decision surface (composition seam): presents the bridge's
 * child cards on the kernel's decision chain and returns card answers
 * to the bridge. Raise identity is the bridge token, so every card
 * face semantic the kernel already owns serves a child card unchanged;
 * the settle boolean is the child's only closure — no canonical echo
 * exists for a child question. A switch window suppresses raises
 * wholesale; the surviving head re-raises once the new kernel state
 * settled, because the cards belong to the child sessions, not to
 * either parent binding.
 */
import type { AskQuestionFact, AskValue, ApprovalValue, TuiInput } from "../ui/tui/kernel/index.js"
import type { ChildApprovalBridge, ChildApprovalSurface, ChildAskSettlement } from "./child-approval-bridge.js"
import { approvalSummaryLines } from "./tui-projection-pump.js"
import { askFactsFromQuestions, decisionDisclosureDigest } from "./tui-session-host.js"
import type { ChildAskAttribution } from "../capabilities/execution/child-agent-runner.js"

/** The origin row a child card carries above its content. */
const attributionRow = (attribution: ChildAskAttribution): string =>
  attribution.subagentType === undefined
    ? `child · ${attribution.description}`
    : `child (${attribution.subagentType}) · ${attribution.description}`

/** Invert a kernel answer onto the bridge's per-question label rows. */
const askSettlementOf = (questions: readonly AskQuestionFact[], value: AskValue): ChildAskSettlement =>
  value.kind !== "answered"
    ? { outcome: value.kind, selected: [] }
    : {
        outcome: "answered",
        selected: questions.map((question) => {
          const row = value.answers.find((answer) => answer.questionId === question.questionId)
          if (row === undefined) return []
          return question.options.flatMap((option) => (row.selectedOptionIds.includes(option.optionId) ? [option.label] : []))
        }),
      }

/** The executor-facing half: settle plus the post-settle head nudge. */
export interface TuiChildDecisionSeam {
  /** Retract every raised card and hold new raises until release(). */
  sweep(): void
  /** End a suppression window and re-raise the surviving head. */
  release(): void
  /** Re-raise the parked head when nothing presents; no-op inside a window. */
  notifyIfFree(): void
  /** Resolve a child token; undefined means the id is not a child card. */
  settle(id: string, value: AskValue | ApprovalValue): boolean | undefined
}

export interface TuiChildDecisionSurface extends TuiChildDecisionSeam {
  /** The raise/retract face the bridge holds. */
  readonly surface: ChildApprovalSurface
  /** Late bind: the kernel is built after the bridge, around this surface. */
  bind(kernel: { dispatch(input: TuiInput): void }): void
}

export function createChildDecisionSurface(bridge: () => ChildApprovalBridge): TuiChildDecisionSurface {
  let dispatch: ((input: TuiInput) => void) | null = null
  let suppressed = false
  // Minted question tables by token: the ask settle inverts selections
  // through them; an approval token holds an empty table. Entries drop
  // on retract and on every settle, so the map stays bounded by the
  // live queue.
  const minted = new Map<string, readonly AskQuestionFact[]>()
  const notifyIfFree = (): void => {
    if (suppressed) return
    bridge().notifySurfaceAvailable()
  }

  return {
    surface: {
      raise(card) {
        if (suppressed) return
        if (card.kind === "approval") {
          const summary = [attributionRow(card.attribution), ...approvalSummaryLines(card.toolInput, card.toolName)].join("\n")
          minted.set(card.token, [])
          dispatch?.({
            kind: "decision",
            fact: {
              kind: "approval",
              fact: {
                request: { id: card.token },
                toolName: card.toolName,
                summary,
                options: [
                  { optionId: "approve_once", label: "Approve once", outcome: "approve_once" },
                  { optionId: "deny", label: "Deny", outcome: "deny" },
                ],
              },
              disclosure: decisionDisclosureDigest([card.toolName, summary]),
            },
          })
          return
        }
        const questions = askFactsFromQuestions(card.questions)
        minted.set(card.token, questions)
        dispatch?.({
          kind: "decision",
          fact: {
            kind: "ask",
            fact: { request: { id: card.token }, attribution: attributionRow(card.attribution), questions },
            disclosure: decisionDisclosureDigest(
              questions.flatMap((question) => [
                question.questionId,
                question.question,
                question.header ?? "",
                String(question.multiSelect),
                ...question.options.flatMap((option) => [option.optionId, option.label, option.description ?? ""]),
              ]),
            ),
          },
        })
      },
      retract(token) {
        minted.delete(token)
        dispatch?.({ kind: "decision-status", request: { id: token }, event: "authority-retracted" })
      },
    },
    bind(kernel) {
      dispatch = (input) => kernel.dispatch(input)
    },
    sweep() {
      // Suppression opens before cancelAll so a raise the sweep itself
      // provokes (the head dequeues and the next head re-raises
      // synchronously inside cancelAll) is already held.
      suppressed = true
      bridge().cancelAll()
    },
    release() {
      suppressed = false
      notifyIfFree()
    },
    notifyIfFree,
    settle(id, value) {
      const questions = minted.get(id)
      if (questions === undefined) return undefined
      minted.delete(id)
      if ("optionId" in value) {
        if (value.optionId !== "approve_once" && value.optionId !== "deny") return false
        return bridge().settleApproval(id, value.optionId === "approve_once" ? "approved" : "denied")
      }
      return bridge().settleAsk(id, askSettlementOf(questions, value))
    },
  }
}
