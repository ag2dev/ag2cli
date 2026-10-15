/**
 * Full-access confirmation card: the one-time local disclosure that
 * guards a session's first entry into full access. The card is a fixed
 * Enter/Esc decision over a host-risk statement — no list to walk, no
 * machine state — built like the approval card (the host resolves the
 * consequences; the card only surfaces the reach and records the
 * answer as an effect). The facts it needs are captured at open:
 * whether the entry implies a canonical mode change (the mirror is not
 * full access yet) and the session the confirmation speaks about.
 *
 * Enter confirms once per press: it emits the confirmation fact
 * (process-local, session-keyed — the host records it) and, only when
 * the entry implies a mode change, the canonical mode commit it
 * covers. A mode-change confirmation keeps the card open awaiting the
 * echo of its own mode commit — a mode permission-applied closes it, a
 * mode permission-stale lands its error line and re-arms the keys; a
 * rules echo of either outcome never touches it — so the surface never
 * claims a mode the session has not adopted; a confirmation over an
 * already-full-access session requested nothing canonical and closes
 * itself. While a commit is in flight the card absorbs every key but
 * interrupt and paints the waiting hint: Escape cannot cancel a
 * canonical request already made, and the stale error line re-arms it
 * (a failed commit can be cancelled). Escape before any Enter cancels
 * to the composer with nothing emitted.
 */
import type { TuiIntent } from "../keys/index.js"
import { cardSnapshot, type CardSnapshot } from "./card.js"

/** Host-executed outcomes; the card keeps no local authority. */
export type FullAccessConfirmCardEffect =
  | { readonly kind: "full-access-confirm"; readonly sessionId: string | null }
  | { readonly kind: "permission-mode"; readonly mode: "full-access" }

/** One dispatched key while the card is visible. */
export interface FullAccessConfirmCardResult {
  /** Whether the visible card changed; the store repaints only then. */
  readonly changed: boolean
  readonly effects: readonly FullAccessConfirmCardEffect[]
}

/** Fixed disclosure: the reach full access grants on this host. */
const DISCLOSURE_LINES: readonly (readonly { readonly text: string; readonly token: "text" }[])[] = [
  [{ text: "Tools may read and write files, use the network, and reach credentials and processes on this host.", token: "text" }],
  [{ text: "They run with the current OS user's host privileges.", token: "text" }],
]

const HINTS: readonly string[] = ["enter confirm", "esc cancel"]

/** Painted while the card's own commit is in flight — both answer keys are absorbed. */
const AWAITING_HINTS: readonly string[] = ["waiting for the mode change"]

/** Frozen: one shared answer for every absorbed key, never mutated. */
const ABSORBED: FullAccessConfirmCardResult = Object.freeze({ changed: false, effects: Object.freeze([]) })

export class FullAccessConfirmCard {
  private opened = false
  /** Whether confirming also implies a canonical mode commit. */
  private modeChange = false
  /** A submitted commit is in flight; only its echo resolves this. */
  private awaiting = false
  private sessionId: string | null = null
  private error: string | null = null

  /**
   * Open over the captured facts: a mode change is an entry from
   * another mode (the mirror is not full access yet) and keeps the
   * card awaiting the canonical echo after Enter; the session id is
   * the identity the emitted confirmation speaks about. Reopening
   * resets the error line and any in-flight wait.
   */
  open(modeChange: boolean, sessionId: string | null): void {
    this.opened = true
    this.modeChange = modeChange
    this.awaiting = false
    this.sessionId = sessionId
    this.error = null
  }

  /** Close the visible card; false when it was already hidden. */
  close(): boolean {
    if (!this.opened) return false
    this.opened = false
    this.awaiting = false
    this.error = null
    return true
  }

  isVisible(): boolean {
    return this.opened
  }

  /** Whether the card's own mode commit is in flight, awaiting its echo. */
  isAwaiting(): boolean {
    return this.awaiting
  }

  /** Reset the stale error line — a retried confirm starts clean. */
  clearError(): void {
    this.error = null
  }

  /** Stale-commit feedback: keep the card open with the inline error. */
  reportStale(message: string): void {
    this.error = message
    // The in-flight commit resolved as failed: the answer keys re-arm.
    this.awaiting = false
  }

  /**
   * Route one intent while visible: null only when the card is hidden;
   * a visible card claims every key — Enter confirms, Escape cancels,
   * everything else is absorbed without change. One exception: a
   * submitted mode change is in flight, and until its echo resolves
   * every key is absorbed — cancelling after the fact would claim a
   * request was never made.
   */
  dispatch(intent: TuiIntent): FullAccessConfirmCardResult | null {
    if (!this.opened) return null
    if (this.awaiting) return ABSORBED
    if (intent.kind === "back") {
      // Cancel emits nothing: no confirmation fact, no mode commit.
      this.opened = false
      return { changed: true, effects: [] }
    }
    if (intent.kind === "activate") {
      // Every activate repaints: opening the wait swaps the hint line,
      // closing hides the card; a retry starts clean of the old error.
      this.clearError()
      const effects: FullAccessConfirmCardEffect[] = [{ kind: "full-access-confirm", sessionId: this.sessionId }]
      if (this.modeChange) {
        effects.push({ kind: "permission-mode", mode: "full-access" })
        this.awaiting = true
      } else this.opened = false
      return { changed: true, effects }
    }
    return ABSORBED
  }

  /**
   * Render-ready snapshot of the visible card; null hides it. The
   * disclosure is fixed copy; the only variable line is the stale
   * error under it.
   */
  snapshot(): CardSnapshot | null {
    if (!this.opened) return null
    const body = this.error === null ? [...DISCLOSURE_LINES] : [...DISCLOSURE_LINES, [{ text: this.error, token: "error" as const }]]
    return cardSnapshot({
      tabLabels: ["Confirm"],
      activeTabIndex: 0,
      body,
      items: [],
      focusedIndex: null,
      focusedKey: null,
      multiSelect: false,
      lastTab: true,
      hints: this.awaiting ? AWAITING_HINTS : HINTS,
      markers: "none",
      title: "Full access",
    })
  }
}
