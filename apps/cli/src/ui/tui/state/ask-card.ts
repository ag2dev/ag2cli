/**
 * Ask card: the ask tool's questions as one card — one tab per
 * question, options as items, the full question text as the tab body.
 * The shell machine owns every interaction (focus, single- and
 * multi-select, windowing); this card only loads questions, maps the
 * shell outcomes onto the answer effect, and owns the title and the
 * chat-escape hint. Enter confirms on the last tab with the per-tab
 * selection table; Escape pops one question at a time and declines the
 * whole dialog on the first; "c" answers nothing and asks the model to
 * discuss instead. The card holds no ask authority: the host resolves
 * the request through its answers port, and every outcome closes the
 * card. A visible card owns every key but interrupt — stray characters
 * are absorbed, never drafted.
 */
import type { TuiIntent } from "../keys/index.js"
import { cardAttributionLine, CardShellMachine, cardSnapshot, type CardAttribution, type CardSnapshot } from "./card.js"

/** One option of an ask question (mirror of the runtime ask contract). */
export interface AskOption {
  readonly label: string
  readonly description?: string
}

/** One question: full text, short header, options, select mode. */
export interface AskQuestion {
  readonly question: string
  readonly header?: string
  readonly multiSelect?: boolean
  readonly options: readonly AskOption[]
}

/** A raised ask: request identity plus its questions. */
export interface AskRequest {
  readonly requestId: string
  readonly questions: readonly AskQuestion[]
  /** A bridged child session the answers speak for; absent = the live session's own ask. */
  readonly attribution?: CardAttribution
}

/** How the dialog ended; the runtime maps chat to clarification feedback. */
export type AskOutcome = "answered" | "declined" | "chat"

/** Host-executed resolution; the card keeps no local authority. */
export type AskCardEffect = {
  readonly kind: "ask-answer"
  readonly requestId: string
  readonly outcome: AskOutcome
  /** Per-question chosen labels, index-aligned with the request. */
  readonly selected: readonly (readonly string[])[]
}

/** One dispatched key while the card is visible. */
export interface AskCardResult {
  /** Whether the visible card changed; the store repaints only then. */
  readonly changed: boolean
  readonly effects: readonly AskCardEffect[]
}

/**
 * Tab label / answer header fallback for a question without a header:
 * twelve code units, backed off one when the cut would split a
 * surrogate pair. Exported so tab labels and answer headers can never
 * disagree.
 */
export function askTabLabel(question: string): string {
  const raw = question.slice(0, 12)
  // A dangling HIGH surrogate at the end means the cut severed a pair
  // (the low half landed outside); back off one so the label stays valid.
  const last = raw.length === 0 ? 0 : raw.charCodeAt(raw.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? raw.slice(0, -1) : raw
}

/** Hint line for the chat escape (this card's own affordance). */
const CHAT_HINT = "c chat"

const SINGLE_TITLE = "Question"
const MULTI_TITLE = "Questions"

export class AskCard {
  private readonly machine = new CardShellMachine()
  private request: AskRequest | null = null
  private opened = false

  /** Open the dialog over a request; every tab's state resets. */
  open(request: AskRequest): void {
    this.opened = true
    this.request = {
      requestId: request.requestId,
      questions: [...request.questions],
      ...(request.attribution === undefined ? {} : { attribution: request.attribution }),
    }
    this.machine.load(
      this.request.questions.map((question) => {
        const label = question.header ?? askTabLabel(question.question)
        return {
          key: label,
          label,
          multiSelect: question.multiSelect === true,
          body: [[{ text: question.question, token: "accent" as const }]],
          items: question.options.map((option) => ({
            key: option.label,
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        }
      }),
    )
  }

  /** Close the visible card; false when it was already hidden. */
  close(): boolean {
    if (!this.opened) return false
    this.opened = false
    return true
  }

  /**
   * Close only the named visible request (a bridge retract); false when
   * another request holds the surface or the card is hidden.
   */
  closeIfRequest(requestId: string): boolean {
    if (!this.isVisible() || this.request!.requestId !== requestId) return false
    this.opened = false
    return true
  }

  /** Claimable while open with at least one question to show. */
  isVisible(): boolean {
    return this.opened && this.request !== null && this.request.questions.length > 0
  }

  /**
   * Route one intent while visible: null only when the card is not
   * visible; a visible card claims every key (an unhandled one is
   * absorbed with changed false — the draft never moves under a modal).
   * Every outcome that resolves the request closes the card; the host
   * owns delivering the answer table to the pending ask.
   */
  dispatch(intent: TuiIntent): AskCardResult | null {
    if (!this.isVisible()) return null
    const request = this.request!
    // The chat escape sits ahead of the machine (which would no-op the
    // char): "c" answers nothing and asks the model to discuss instead.
    if (intent.kind === "input" && intent.event.type === "char" && intent.event.value === "c") {
      this.opened = false
      return { changed: true, effects: [{ kind: "ask-answer", requestId: request.requestId, outcome: "chat", selected: [] }] }
    }
    const result = this.machine.dispatch(intent)
    if (result.outcome === "confirmed") {
      const selected = this.machine.selection()
      this.opened = false
      return { changed: true, effects: [{ kind: "ask-answer", requestId: request.requestId, outcome: "answered", selected }] }
    }
    if (result.outcome === "declined") {
      this.opened = false
      return { changed: true, effects: [{ kind: "ask-answer", requestId: request.requestId, outcome: "declined", selected: [] }] }
    }
    return { changed: result.changed, effects: [] }
  }

  /**
   * Render-ready snapshot of the visible card; null hides it. The frame
   * title names the dialog (one question by its header, many as
   * "Questions") while the tab row carries the per-question labels; a
   * bridged child renders its attribution crumb above the question
   * body; the chat escape rides the machine's own hints.
   */
  snapshot(): CardSnapshot | null {
    if (!this.isVisible()) return null
    const request = this.request!
    const single = request.questions.length === 1 ? request.questions[0]! : undefined
    const snapshot = this.machine.snapshot()
    return cardSnapshot({
      ...snapshot,
      title: single === undefined ? MULTI_TITLE : (single.header ?? SINGLE_TITLE),
      hints: [...snapshot.hints, CHAT_HINT],
      ...(request.attribution === undefined ? {} : { breadcrumb: [cardAttributionLine(request.attribution)] }),
    })
  }
}
