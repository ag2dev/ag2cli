import readline from "node:readline"
import type {
  PublicAskUserAnswer,
  PublicAskUserInteraction,
  PublicToolApprovalInteraction,
} from "@ag2cli/app-server-protocol/dto/interactions.js"

export type HeadlessAbortKind = "timeout" | "signal"

export interface HeadlessOperationOptions {
  readonly timeoutMs?: number
  readonly signalSource?: SignalSource
  /** Runs on the first abort trigger; resolve once active work settled, or hard-abort through the given trigger. */
  readonly onGracefulCancel?: (kind: HeadlessAbortKind, hardAbort: () => void) => Promise<void>
  /** Hard-abort fallback when a graceful cancel stalls. */
  readonly gracefulEscalationMs?: number
}

export interface HeadlessOperation {
  readonly signal: AbortSignal
  readonly abortKind: HeadlessAbortKind | undefined
  close(): void
}

interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown
}

/** A stalled graceful cancel must never hang the process longer than this. */
export const HEADLESS_GRACEFUL_ESCALATION_MS = 10_000

/**
 * Owns the lifetime of one headless request. The first SIGINT/SIGTERM or
 * deadline hit requests a graceful cancel (the caller cancels durable work
 * and lets it settle); a second trigger or an overdue escalation hard-aborts
 * the shared signal. `abortKind` is set at the first trigger so a run that
 * settles cancelled still reports TIMEOUT versus CANCELLED faithfully.
 */
export function createHeadlessOperation(options: HeadlessOperationOptions = {}): HeadlessOperation {
  const controller = new AbortController()
  const source = options.signalSource ?? process
  let abortKind: HeadlessAbortKind | undefined
  let escalation: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const hardAbort = (): void => {
    if (escalation !== undefined) {
      clearTimeout(escalation)
      escalation = undefined
    }
    if (controller.signal.aborted) return
    const timeout = abortKind === "timeout"
    controller.abort(
      new DOMException(timeout ? "headless request timeout" : "headless operation interrupted", timeout ? "TimeoutError" : "AbortError"),
    )
  }

  const trigger = (kind: HeadlessAbortKind): void => {
    if (closed) return
    if (abortKind !== undefined) {
      hardAbort()
      return
    }
    abortKind = kind
    if (options.onGracefulCancel === undefined) {
      hardAbort()
      return
    }
    escalation = setTimeout(hardAbort, options.gracefulEscalationMs ?? HEADLESS_GRACEFUL_ESCALATION_MS)
    void options.onGracefulCancel(kind, hardAbort).then(
      () => {
        if (escalation !== undefined) {
          clearTimeout(escalation)
          escalation = undefined
        }
      },
      () => hardAbort(),
    )
  }

  const onSignal = (): void => trigger("signal")
  source.on("SIGINT", onSignal)
  source.on("SIGTERM", onSignal)
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => trigger("timeout"), options.timeoutMs)

  return {
    signal: controller.signal,
    get abortKind() {
      return abortKind
    },
    close() {
      if (closed) return
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      if (escalation !== undefined) {
        clearTimeout(escalation)
        escalation = undefined
      }
      source.off("SIGINT", onSignal)
      source.off("SIGTERM", onSignal)
    },
  }
}

/** Line-oriented TTY port; injectable so tests drive prompts without a terminal. */
export interface HeadlessLineReader {
  question(prompt: string): Promise<string>
  close(): void
}

export function createTtyLineReader(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): HeadlessLineReader {
  const lines = readline.createInterface({ input, output })
  return {
    question: (prompt) => new Promise<string>((resolve) => lines.question(prompt, resolve)),
    close: () => lines.close(),
  }
}

export interface TtyInteractionSurface {
  /** Returns the optionId to resolve with; anything but an explicit yes denies. */
  resolveToolApproval(interaction: PublicToolApprovalInteraction): Promise<string>
  answerAskUser(interaction: PublicAskUserInteraction): Promise<PublicAskUserAnswer>
}

/** Interactive answers for a TTY run: y/n approvals and numbered ask_user selections. */
export function createTtyInteractionSurface(ask: HeadlessLineReader): TtyInteractionSurface {
  const approvalOption = (interaction: PublicToolApprovalInteraction, outcome: "approve_once" | "deny"): string | undefined =>
    interaction.options.find((option) => option.outcome === outcome)?.optionId

  const selectOptions = async (
    questionId: string,
    prompt: string,
    options: readonly { optionId: string; label: string }[],
  ): Promise<string[]> => {
    const answer = (await ask.question(prompt)).trim()
    const picked: string[] = []
    for (const part of answer.split(/[\s,]+/)) {
      const index = Number(part)
      const optionId =
        index >= 1 && index <= options.length ? options[index - 1]?.optionId : options.find((option) => option.label === part)?.optionId
      if (optionId !== undefined && !picked.includes(optionId)) picked.push(optionId)
    }
    if (picked.length === 0) throw new Error(`No valid selection for question ${questionId}`)
    return picked
  }

  return {
    async resolveToolApproval(interaction) {
      const subject =
        interaction.subject.type === "command"
          ? `${interaction.subject.command} (${interaction.subject.cwdRelative})`
          : `${interaction.subject.toolName}: ${interaction.subject.summary}`
      const answer = (await ask.question(`${interaction.title}\n${subject}\nAllow? [y/N] `)).trim().toLowerCase()
      const optionId = approvalOption(interaction, answer === "y" || answer === "yes" ? "approve_once" : "deny")
      if (optionId === undefined)
        throw new Error(`Tool approval offers no ${answer === "y" || answer === "yes" ? "approve" : "deny"} option`)
      return optionId
    },
    async answerAskUser(interaction) {
      const answers: { questionId: string; selectedOptionIds: string[] }[] = []
      for (const question of interaction.questions) {
        const header = question.header === undefined ? "" : `${question.header}\n`
        const list = question.options.map((option, index) => `${index + 1}. ${option.label}`).join("\n")
        const prompt = `${header}${question.question}\n${list}\n${question.multiSelect ? "choices (comma-separated): " : "choice: "}`
        answers.push({
          questionId: question.questionId,
          selectedOptionIds: await selectOptions(question.questionId, prompt, question.options),
        })
      }
      return { outcome: "answered", answers }
    },
  }
}
