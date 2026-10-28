/** Domain data shape and model-facing contract for AskUserQuestion. */

/** A single option. */
export interface AskUserOption {
  label: string
  description?: string
}

/** A question. */
export interface AskUserQuestion {
  /** Full question text. */
  question: string
  /** Short display label (at most 12 characters). */
  header?: string
  /** Two to four options. */
  options: AskUserOption[]
  /** Whether multiple selections are allowed. */
  multiSelect?: boolean
}

/** User's interactive response to a question. */
export interface AskUserAnswer {
  /** Question header, or the first 12 characters of question when absent. */
  header: string
  /** Labels of the options selected by the user; multiple for multi-select. */
  selected: string[]
  /** Optional free-text response for this question. */
  freeText?: string
  /** Internal stable position used only for partial chat context rows. */
  questionIndex?: number
  /** `chat` asks the model to continue discussing; `cancel` records no answer. */
  action?: "chat" | "cancel"
}

/** Outcome of the question interaction, kept separate from tool approval. */
export type AskUserOutcome = "answered" | "declined" | "rejected"

/** Stable metadata key used by the tool result and TUI projection. */
export const ASK_USER_OUTCOME_METADATA_KEY = "askUserOutcome"

/** OpenClaude-compatible rejection message sent to the model after cancel. */
export const ASK_USER_REJECTION_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

/** Tool-facing description for the structured question contract. */
export const ASK_USER_QUESTION_DESCRIPTION =
  "Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices."

/** Supported usage notes for the model-facing tool description. */
export const ASK_USER_QUESTION_PROMPT = [
  "Use this tool when you need to ask the user questions during execution. This allows you to:",
  "1. Gather user preferences or requirements",
  "2. Clarify ambiguous instructions",
  "3. Get decisions on implementation choices as you work",
  "4. Offer choices to the user about what direction to take.",
  "Use multiSelect: true to allow multiple answers to be selected for a question.",
  'If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.',
].join("\n")

/** Format the answer result that the next model turn receives. */
export function formatAskUserAnswerResult(questions: readonly AskUserQuestion[], answers: readonly AskUserAnswer[]): string {
  const byIndex = answers.some((answer) => answer.questionIndex !== undefined)
    ? new Map(answers.filter((answer) => answer.questionIndex !== undefined).map((answer) => [answer.questionIndex!, answer]))
    : undefined
  const values = questions
    .map((question, index) => {
      const answer = byIndex?.get(index) ?? answers[index]
      const parts = [...(answer?.selected ?? []), ...(answer?.freeText?.trim() ? [answer.freeText] : [])]
      const value = parts.join(", ")
      return `"${question.question}"="${value}"`
    })
    .join(", ")
  return `User has answered your questions: ${values}. You can now continue with the user's answers in mind.`
}

/** OpenClaude-compatible feedback for the Chat about this action. */
export function formatAskUserClarificationFeedback(questions: readonly AskUserQuestion[], answers: readonly AskUserAnswer[]): string {
  const byIndex = answers.some((answer) => answer.questionIndex !== undefined)
    ? new Map(answers.filter((answer) => answer.questionIndex !== undefined).map((answer) => [answer.questionIndex!, answer]))
    : undefined
  const questionsWithAnswers = questions
    .map((question, index) => {
      const answer = byIndex?.get(index) ?? answers[index]
      if (answer && (answer.selected.length > 0 || answer.freeText?.trim())) {
        const parts = [...answer.selected, ...(answer.freeText?.trim() ? [answer.freeText] : [])]
        return `- "${question.question}"\n  Answer: ${parts.join(", ")}`
      }
      return `- "${question.question}"\n  (No answer provided)`
    })
    .join("\n")
  return [
    "The user wants to clarify these questions.",
    "This means they may have additional information, context or questions for you.",
    "Take their response into account and then reformulate the questions if appropriate.",
    "Start by asking them what they would like to clarify.",
    "",
    `Questions asked:\n${questionsWithAnswers}`,
  ].join("\n")
}
