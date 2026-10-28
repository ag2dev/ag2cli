/**
 * Decision facts and the ask vocabulary: request identity plus the
 * typed resolution values. The ask question shape mirrors the host
 * hook payload exactly — the kernel adds no readiness policy of its
 * own because the payload carries none.
 */

export type RequestIdentity = { readonly id: string }

/**
 * The ask resolution. The discuss detour resolves the whole card as
 * chat; the runtime maps it to one clarifying row. The declined
 * variant is the ask's one explicit refusal action.
 */
export type AskValue =
  | {
      readonly kind: "answered"
      readonly answers: readonly { readonly questionId: string; readonly selectedOptionIds: readonly string[] }[]
      readonly freeText?: readonly { readonly questionId: string; readonly text: string }[]
    }
  | {
      readonly kind: "chat"
      readonly contextAnswers?: readonly { readonly questionId: string; readonly selectedOptionIds: readonly string[] }[]
      readonly contextFreeText?: readonly { readonly questionId: string; readonly text: string }[]
    }
  | { readonly kind: "declined" }

export type ApprovalValue = { readonly optionId: string }

export interface ApprovalOptionFact {
  readonly optionId: string
  readonly label: string
  readonly outcome: "approve_once" | "deny"
}

export interface AskOptionFact {
  readonly optionId: string
  readonly label: string
  readonly description?: string
}

export interface AskQuestionFact {
  readonly questionId: string
  readonly question: string
  readonly header?: string
  readonly multiSelect: boolean
  readonly options: readonly AskOptionFact[]
}

export interface AskFact {
  readonly request: RequestIdentity
  /** Display-only origin line above the head; absent on parent asks. */
  readonly attribution?: string
  readonly questions: readonly AskQuestionFact[]
}

export interface ApprovalFact {
  readonly request: RequestIdentity
  readonly toolName: string
  readonly summary: string
  readonly options: readonly ApprovalOptionFact[]
}

/**
 * A disclosed decision request. The disclosure version moves when the
 * authority's disclosed content truly changes; a repeat raise of the
 * same version is idempotent.
 */
export type DecisionFact =
  | { readonly kind: "ask"; readonly fact: AskFact; readonly disclosure: number }
  | { readonly kind: "approval"; readonly fact: ApprovalFact; readonly disclosure: number }
