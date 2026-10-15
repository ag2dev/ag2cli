/**
 * Resume card: the /resume session picker as one modal card — one item
 * per resumable catalog session (titled sessions carry the raw id as
 * their description, since /resume <id> addresses it). Focus seeds onto
 * the first session; Enter maps onto the resume effect (the host
 * switches the live view), Escape closes without switching. A visible
 * card owns every key but interrupt — stray characters are absorbed,
 * never drafted.
 */
import type { TuiIntent } from "../keys/index.js"
import { CardShellMachine, type CardSnapshot } from "./card.js"

/** One resumable session as the host's catalog seam reports it. */
export interface ResumeSessionOption {
  readonly sessionId: string
  readonly title?: string
  readonly lastRevision: number
}

/** Host-executed outcome: switch the live view to this session. */
export type ResumeCardEffect = { readonly kind: "resume"; readonly sessionId: string }

/** One dispatched key while the card is visible. */
export interface ResumeCardResult {
  /** Whether the visible card changed; the store repaints only then. */
  readonly changed: boolean
  readonly effects: readonly ResumeCardEffect[]
}

const TAB_KEY = "resume"
const TAB_LABEL = "Resume"
const BODY_LINE = "Switch the live view to another session."

export class ResumeCard {
  /** Digit picks address the visible window, matching the rendered gutter. */
  private readonly machine = new CardShellMachine({ itemWindow: 8 })
  private readonly sessionIdsByKey = new Map<string, string>()
  private opened = false

  /** (Re)load from the fresh resumable list; focus re-defaults to the first. */
  open(sessions: readonly ResumeSessionOption[]): void {
    this.sessionIdsByKey.clear()
    const items = sessions.map((session) => {
      this.sessionIdsByKey.set(session.sessionId, session.sessionId)
      return {
        key: session.sessionId,
        label: session.title ?? session.sessionId,
        // A titled row still shows the raw id: /resume <id> addresses it.
        ...(session.title === undefined ? {} : { description: session.sessionId }),
      }
    })
    this.machine.load([
      {
        key: TAB_KEY,
        label: TAB_LABEL,
        body: [[{ text: BODY_LINE, token: "muted" }]],
        items,
      },
    ])
    this.opened = true
  }

  /** Claimable while open (a closed card hides and passes keys through). */
  isVisible(): boolean {
    return this.opened
  }

  /**
   * Hide without switching; false when already hidden. The card
   * surface is one card wide — another card opening closes this one,
   * and the next open reloads from the fresh catalog.
   */
  close(): boolean {
    if (!this.opened) return false
    this.opened = false
    return true
  }

  /**
   * Route one intent while visible: null only when the card is not
   * visible; a visible card claims every key (an unhandled one is
   * absorbed with changed false — the draft never moves under a modal).
   */
  dispatch(intent: TuiIntent): ResumeCardResult | null {
    if (!this.opened) return null
    if (intent.kind === "back") {
      // Escape never switches sessions; the next open re-defaults.
      this.opened = false
      return { changed: true, effects: [] }
    }
    const result = this.machine.dispatch(intent)
    if (result.outcome === "confirmed") {
      this.opened = false
      const key = this.machine.selection()[0]?.[0]
      const sessionId = key === undefined ? undefined : this.sessionIdsByKey.get(key)
      // The store never opens this card empty, so a confirmed focus
      // always maps; the undefined arm is the honest total function,
      // close-without-switch, should that mapping ever miss.
      return { changed: true, effects: sessionId === undefined ? [] : [{ kind: "resume", sessionId }] }
    }
    return { changed: result.changed, effects: [] }
  }

  /** Render-ready snapshot of the visible card; null hides it. */
  snapshot(): CardSnapshot | null {
    return this.opened ? this.machine.snapshot() : null
  }
}
