/**
 * Rewind card: the checkpoint list as one modal card — one item per
 * rewindable user message plus the "(current)" sentinel as the seeded
 * default (confirming it only closes). Every open reloads from the
 * host-injected checkpoint source and re-defaults focus onto the
 * sentinel. Escape closes without rewinding; confirming a checkpoint
 * maps onto the rewind effect (the host restores the conversation before
 * that input). A visible card owns every key but interrupt — stray
 * characters are absorbed, never drafted.
 */
import type { TuiIntent } from "../keys/index.js"
import { CardShellMachine, type CardSnapshot } from "./card.js"

/** One rewindable user message; selecting it restores the point before it. */
export interface RewindCheckpoint {
  readonly inputId: string
  readonly label: string
}

/** Host-executed outcome: restore the conversation before this input. */
export type RewindCardEffect = { readonly kind: "rewind"; readonly inputId: string }

/** One dispatched key while the card is visible. */
export interface RewindCardResult {
  /** Whether the visible card changed; the store repaints only then. */
  readonly changed: boolean
  readonly effects: readonly RewindCardEffect[]
}

const TAB_KEY = "rewind"
const TAB_LABEL = "Rewind"
const SENTINEL_KEY = "(current)"
const CHECKPOINT_PREFIX = "cp:"
const BODY_LINE = "Restore the conversation to the point before…"

export class RewindCard {
  /** Digit picks address the visible window, matching the rendered gutter. */
  private readonly machine = new CardShellMachine({ itemWindow: 8 })
  private readonly checkpointsByKey = new Map<string, string>()
  private opened = false

  /** (Re)load from fresh checkpoints; focus re-defaults to the sentinel. */
  open(checkpoints: readonly RewindCheckpoint[]): void {
    this.checkpointsByKey.clear()
    const items = checkpoints.map((point) => {
      const key = `${CHECKPOINT_PREFIX}${point.inputId}`
      this.checkpointsByKey.set(key, point.inputId)
      return { key, label: point.label }
    })
    items.push({ key: SENTINEL_KEY, label: SENTINEL_KEY })
    this.machine.load([
      {
        key: TAB_KEY,
        label: TAB_LABEL,
        chosen: [SENTINEL_KEY],
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
   * Hide without rewinding; false when already hidden. The card
   * surface is one card wide — another card opening closes this one,
   * and the next open reloads from fresh checkpoints.
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
  dispatch(intent: TuiIntent): RewindCardResult | null {
    if (!this.opened) return null
    if (intent.kind === "back") {
      // Escape never rewinds; the next open re-defaults to the sentinel.
      this.opened = false
      return { changed: true, effects: [] }
    }
    const result = this.machine.dispatch(intent)
    if (result.outcome === "confirmed") {
      this.opened = false
      const key = this.machine.selection()[0]?.[0]
      const inputId = key === undefined ? undefined : this.checkpointsByKey.get(key)
      // The sentinel (or an empty card) confirms as a plain close.
      return { changed: true, effects: inputId === undefined ? [] : [{ kind: "rewind", inputId }] }
    }
    return { changed: result.changed, effects: [] }
  }

  /** Render-ready snapshot of the visible card; null hides it. */
  snapshot(): CardSnapshot | null {
    return this.opened ? this.machine.snapshot() : null
  }
}
