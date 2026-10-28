/**
 * ChoiceList engine: the one list interaction model every choosing step
 * shares — focus over choosable items, a visible window with digit
 * shortcuts, focus moves that skip disabled rows, and Enter as the
 * only chooser. Single select; a task composes steps at its own level,
 * so there are no tabs here. Digits address the visible window only,
 * so the rendered gutter and the keys can never disagree.
 */
import type { TuiIntent } from "../../keys/index.js"

export interface ChoiceItem {
  readonly key: string
  readonly label: string
  readonly description?: string
  readonly disabled?: boolean
}

export interface ChoiceListOptions {
  /** Visible rows; also the page step and the digit range. Default 8. */
  readonly window?: number
  /** Digit shortcuts address the visible window; default on. */
  readonly digits?: boolean
}

export interface ChoiceListResult {
  readonly changed: boolean
  /** Enter over a choosable focused item; the task maps this to its own meaning. */
  readonly activated: boolean
}

export class ChoiceList {
  private readonly windowSize: number
  private readonly digitsEnabled: boolean
  private items: readonly ChoiceItem[] = []
  private focus = -1
  private windowStart = 0
  private chosen: string | null = null

  constructor(options: ChoiceListOptions = {}) {
    this.windowSize = Math.max(1, Math.floor(options.window ?? 8))
    this.digitsEnabled = options.digits ?? true
  }

  /**
   * Load or reload the items. Keys must be unique — duplicates would
   * corrupt focus identity, so the first occurrence wins. Focus seeds
   * onto the seed key when it is still present, else the first
   * choosable item; an all-disabled or empty list starts unfocused.
   */
  load(items: readonly ChoiceItem[], seed?: { readonly focus?: string }): void {
    const seen = new Set<string>()
    this.items = items.filter((item) => (seen.has(item.key) ? false : (seen.add(item.key), true)))
    const seedKey = seed?.focus
    const focusKey =
      seedKey !== undefined && this.items.some((item) => item.key === seedKey && item.disabled !== true) ? seedKey : this.firstChoosable()
    this.focus = focusKey === null ? -1 : this.items.findIndex((item) => item.key === focusKey)
    this.windowStart =
      this.focus < 0 ? 0 : Math.min(Math.max(0, this.focus - this.windowSize + 1), Math.max(0, this.items.length - this.windowSize))
  }

  /** Route one intent; Enter over a choosable row records the choice and reports activated. */
  dispatch(intent: TuiIntent): ChoiceListResult {
    if (intent.kind === "activate") {
      const focused = this.items[this.focus]
      if (focused === undefined || focused.disabled === true) return { changed: false, activated: false }
      this.chosen = focused.key
      return { changed: true, activated: true }
    }
    if (intent.kind === "navigate") {
      if (intent.direction === "up" || intent.direction === "down")
        return { changed: this.moveFocus(intent.direction === "up" ? -1 : 1), activated: false }
      if (intent.direction === "page-up" || intent.direction === "page-down") {
        return { changed: this.moveFocus(intent.direction === "page-up" ? -this.windowSize : this.windowSize), activated: false }
      }
      return { changed: false, activated: false }
    }
    if (
      intent.kind === "input" &&
      intent.event.type === "char" &&
      this.digitsEnabled &&
      intent.event.value >= "1" &&
      intent.event.value <= "9"
    ) {
      return { changed: this.pickVisible(Number(intent.event.value) - 1), activated: false }
    }
    return { changed: false, activated: false }
  }

  get focusKey(): string | null {
    return this.focus >= 0 ? (this.items[this.focus]?.key ?? null) : null
  }

  get focusIndex(): number | null {
    return this.focus >= 0 ? this.focus : null
  }

  /** The Enter-chosen key of this load generation; a reload clears it. */
  get chosenKey(): string | null {
    return this.chosen
  }

  get isEmpty(): boolean {
    return !this.items.some((item) => item.disabled !== true)
  }

  /** Visible slice start; the frame renders this window. */
  get visibleStart(): number {
    return this.windowStart
  }

  /** The visible window as choosable rows; focus marks the preview carrier. */
  visibleRows(): readonly { readonly label: string; readonly focused: boolean }[] {
    return this.items.slice(this.windowStart, this.windowStart + this.windowSize).map((item) => ({
      label: item.label,
      focused: this.items[this.focus] === item,
    }))
  }

  hints(extra: readonly string[] = []): readonly string[] {
    if (this.isEmpty) return ["esc back"]
    const hints: string[] = ["up down select", ...extra]
    if (this.digitsEnabled && this.items.length > 1) hints.push(`1-${Math.min(this.windowSize, 9)} pick`)
    return hints
  }

  private firstChoosable(): string | null {
    return this.items.find((item) => item.disabled !== true)?.key ?? null
  }

  private moveFocus(step: number): boolean {
    if (this.items.length === 0) return false
    const direction = step < 0 ? -1 : 1
    let index = this.focus
    let advanced = 0
    while (advanced < Math.abs(step)) {
      let candidate = index + direction
      while (candidate >= 0 && candidate < this.items.length && this.items[candidate]!.disabled === true) candidate += direction
      if (candidate < 0 || candidate >= this.items.length) break
      index = candidate
      advanced += 1
    }
    if (index === this.focus) return false
    this.focus = index
    if (this.focus < this.windowStart) this.windowStart = this.focus
    if (this.focus >= this.windowStart + this.windowSize) this.windowStart = this.focus - this.windowSize + 1
    return true
  }

  /** Digits address the visible window only; an off-window slot picks nothing. */
  private pickVisible(slot: number): boolean {
    if (slot < 0 || slot >= this.windowSize) return false
    const target = this.items[this.windowStart + slot]
    if (target === undefined || target.disabled === true) return false
    this.focus = this.windowStart + slot
    return true
  }
}
