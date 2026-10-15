/**
 * AskUserQuestionTool — the model asks the user structured questions.
 *
 * When execution hits an ambiguity, preference or decision point, the model
 * calls this tool to collect a structured multiple-choice answer before it
 * continues.
 *
 * Key design:
 *  - tool.call() never reads stdin (that belongs to the CLI host); it
 *    resolves through the context.askUser callback, so the agent loop just
 *    executes the tool and sees a ToolResult without knowing a human was
 *    asked.
 *  - A host without the interaction surface never reaches call(): the
 *    permission judgment denies ask_user terminally (approval_required) in
 *    every mode. The missing-callback degrade below is defense in depth
 *    only — an is_error result, never a silent default or a hang.
 *  - isConcurrencySafe=false: interaction must stay serial and never run in
 *    parallel with other tools.
 *
 * schema constrains questions, question, header, options and multiSelect.
 */

import { z } from "zod/v4"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import type { Tool } from "@ag2cli/runtime/ports/tool/contract.js"
import {
  ASK_USER_OUTCOME_METADATA_KEY,
  ASK_USER_QUESTION_DESCRIPTION,
  ASK_USER_QUESTION_PROMPT,
  ASK_USER_REJECTION_MESSAGE,
  formatAskUserAnswerResult,
  formatAskUserClarificationFeedback,
  type AskUserQuestion,
  type AskUserAnswer,
  type AskUserOutcome,
} from "@ag2cli/runtime/ports/ask-user.js"

const optionSchema = z.object({
  label: z.string().describe("Short display text for the option (1–5 words)"),
  description: z.string().optional().describe("Explanation or trade-off for the option"),
})

const questionSchema = z.object({
  question: z.string().describe("A complete, clear question ending with a question mark"),
  header: z.string().max(12).optional().describe("Short display label (up to 12 characters)"),
  options: z.array(optionSchema).min(2).max(4).describe("2–4 mutually exclusive options"),
  multiSelect: z.boolean().optional().describe("When true, allow multiple selections (single selection by default)"),
})

const inputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(4).describe("1–4 questions to ask the user"),
})

export class AskUserQuestionTool implements Tool<typeof inputSchema> {
  readonly name = "ask_user"
  readonly interaction = "question" as const
  readonly description = `${ASK_USER_QUESTION_DESCRIPTION}\n\n${ASK_USER_QUESTION_PROMPT}`
  readonly inputSchema = inputSchema

  isReadOnly(): boolean {
    return true
  }

  async call(
    args: z.infer<typeof inputSchema>,
    context?: import("@ag2cli/runtime/ports/tool/contract.js").ToolContext,
  ): Promise<ToolResult> {
    const askUser = context?.askUser
    if (!askUser) {
      return {
        content:
          "No interaction channel is available (askUser was not injected). Continue with reasonable default assumptions or run in an interactive environment.",
        isError: true,
      }
    }
    const questions: AskUserQuestion[] = args.questions
    let answers: AskUserAnswer[]
    try {
      answers = await askUser(questions)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Failed to ask the user: ${msg}`, isError: true }
    }
    const hasChat = answers.some((answer) => answer.action === "chat")
    // Decline is explicit only (an empty answer array or cancel actions).
    // An "answered" row with no selection means the user submitted a
    // multi-select without toggling anything — "none of these" is an
    // answer, not a hard rejection.
    const hasDeclined = answers.length === 0 || answers.some((answer) => answer.action === "cancel")
    const outcome: AskUserOutcome = hasChat ? "rejected" : hasDeclined ? "declined" : "answered"
    if (outcome === "rejected") {
      return {
        content: formatAskUserClarificationFeedback(questions, answers),
        isError: true,
        metadata: { [ASK_USER_OUTCOME_METADATA_KEY]: outcome },
      }
    }
    if (outcome === "declined") {
      return {
        content: ASK_USER_REJECTION_MESSAGE,
        isError: true,
        metadata: { [ASK_USER_OUTCOME_METADATA_KEY]: outcome },
      }
    }
    return {
      content: formatAskUserAnswerResult(questions, answers),
      metadata: { [ASK_USER_OUTCOME_METADATA_KEY]: outcome },
    }
  }

  /** Interactive tool; execute serially. */
  isConcurrencySafe(): boolean {
    return false
  }
}
