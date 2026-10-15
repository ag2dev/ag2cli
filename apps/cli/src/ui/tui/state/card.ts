/**
 * Card shell machine: pure interaction state for every card the TUI
 * opens — tab and item focus, single- and multi-select, visible
 * windowing with digit shortcuts, and the outcome vocabulary business
 * cards map onto effects. Zero business knowledge: a card composes this
 * machine and owns effect minting, titles, and breadcrumbs.
 *
 * Interaction contract (glyph-facing semantics the card renderer pins):
 * - Enter accepts the current tab: single-select records the focused
 *   choice and advances (or confirms on the last tab); multi-select
 *   accepts the current toggles without changing them. Space toggles.
 *   A tab with no choosable item never traps the card — Enter advances
 *   past it (or confirms it empty on the last tab).
 * - Escape pops one level: a previous tab first, decline only on the
 *   first tab (the decline-all reading belongs to the business card).
 * - Digits address the visible window (window-relative), so the rendered
 *   gutter always matches what the keys do.
 * - An external-choice tab owns its marker outside the machine (a
 *   canonical source it re-derives from): Enter and digits move focus
 *   only, no marker is recorded or fabricated, and the focus seed at
 *   load is independent of the chosen set.
 */
import type { TuiIntent } from "../keys/index.js"
import { textRunsEqual, type CardView, type TextRun } from "../text/index.js"

/** Card chrome copy (single source for every card-layer string). */
export const CARD_STRINGS = {
  select: "↑↓ select",
  tabs: "←→ tabs",
  toggle: "space toggle",
  next: "enter next",
  submit: "enter submit",
  back: "esc back",
} as const

/** Digit-pick hint scoped to the addressable window (never overstates keys). */
export const cardPickHint = (max: number): string => `1-${Math.max(1, Math.floor(max))} pick`

/**
 * A bridged child session a card speaks for: the parent face decides,
 * the attribution line says whose work is being decided.
 */
export interface CardAttribution {
  readonly childSessionId: string
  readonly description: string
  readonly subagentType?: string
}

/** The single attribution crumb: `child (explore) · scan the docs`. */
export const cardAttributionLine = (attribution: CardAttribution): string =>
  attribution.subagentType === undefined
    ? `child · ${attribution.description}`
    : `child (${attribution.subagentType}) · ${attribution.description}`

/** One selectable item of a card tab. */
export interface CardItemModel {
  readonly key: string
  readonly label: string
  readonly description?: string
  readonly disabled?: boolean
}

/** One tab: label, optional free body lines above the items, and items. */
export interface CardTabModel {
  readonly key: string
  readonly label: string
  readonly items: readonly CardItemModel[]
  readonly multiSelect?: boolean
  /** Pre-wrapped free lines (question text and the like). */
  readonly body?: readonly (readonly TextRun[])[]
  /**
   * Prefilled selection (defaults / restored answers); keys not present as
   * enabled items are ignored. Single-select keeps the first entry.
   */
  readonly chosen?: readonly string[]
  /**
   * Focus seed at load — a stable item key, independent of the chosen
   * set. Absent, focus seeds from the chosen set, else the first
   * enabled item.
   */
  readonly focus?: string
  /**
   * The chosen marker is owned outside the machine — a canonical source
   * the card re-derives from, never the keyboard. Enter and digits move
   * focus only; nothing is recorded, and an unseeded tab shows no
   * marker rather than a fabricated one.
   */
  readonly externalChoice?: boolean
}

/** Whole-machine disposition for one intent. */
export type CardShellOutcome = "none" | "activated" | "confirmed" | "declined"

export interface CardShellResult {
  readonly changed: boolean
  readonly outcome: CardShellOutcome
}

/** One item as the renderer sees it: display state plus its window digit. */
export interface CardItemState {
  readonly label: string
  readonly description?: string
  readonly chosen: boolean
  readonly disabled: boolean
  readonly digit: number | null
}

/** The renderer view of a card minus its width; the view joins width at render time. */
export type CardViewBody = Omit<CardView, "width">

/** Render-ready interaction state of the active tab (business chrome is added by the owner). */
export interface CardSnapshotBase {
  readonly tabLabels: readonly string[]
  readonly activeTabIndex: number
  readonly body: readonly (readonly TextRun[])[]
  readonly items: readonly CardItemState[]
  readonly focusedIndex: number | null
  /**
   * Stable key of the focused item — the identity business cards act
   * on, independent of the visible window. Labels are display text and
   * legitimately change under a canonical echo; keys never do.
   */
  readonly focusedKey: string | null
  readonly multiSelect: boolean
  readonly lastTab: boolean
  readonly hints: readonly string[]
  /** Row marker family; the default is the radio pair. */
  readonly markers?: "radio" | "check" | "none"
  /** Hierarchy crumbs above the body (a detail card over its list). */
  readonly breadcrumb?: readonly string[]
  /** Frame title; the active tab's label when absent. */
  readonly title?: string
}

/** A card's interaction state plus the renderer view composed from it. */
export interface CardSnapshot extends CardSnapshotBase {
  readonly cardView: CardViewBody
}

function breadcrumbEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if ((a ?? []).length !== (b ?? []).length) return false
  return (a ?? []).every((crumb, index) => crumb === b![index])
}

function cardItemsEqual(a: readonly CardItemState[], b: readonly CardItemState[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index]!
      return (
        item.label === other.label &&
        item.description === other.description &&
        item.chosen === other.chosen &&
        item.disabled === other.disabled &&
        item.digit === other.digit
      )
    })
  )
}

/**
 * Value equality over the bounded base fields (tab labels, the active
 * tab's body rows and visible item window, focus, hints, chrome
 * options) — the gate snapshot() reuses its previous reference with, so
 * an unchanged card never mints a fresh object per commit.
 */
export function cardBaseEqual(a: CardSnapshotBase, b: CardSnapshotBase): boolean {
  return (
    a.activeTabIndex === b.activeTabIndex &&
    a.focusedIndex === b.focusedIndex &&
    a.focusedKey === b.focusedKey &&
    a.multiSelect === b.multiSelect &&
    a.lastTab === b.lastTab &&
    a.markers === b.markers &&
    a.title === b.title &&
    a.tabLabels.length === b.tabLabels.length &&
    a.tabLabels.every((label, index) => label === b.tabLabels[index]) &&
    a.hints.length === b.hints.length &&
    a.hints.every((hint, index) => hint === b.hints[index]) &&
    breadcrumbEqual(a.breadcrumb, b.breadcrumb) &&
    a.body.length === b.body.length &&
    a.body.every((row, index) => textRunsEqual(row, b.body[index]!)) &&
    cardItemsEqual(a.items, b.items)
  )
}

/** Compose the render-ready snapshot; the view adds only the width. */
export function cardSnapshot(card: CardSnapshotBase): CardSnapshot {
  return { ...card, cardView: composeCardView(card) }
}

function composeCardView(card: CardSnapshotBase): CardViewBody {
  const title = card.title ?? card.tabLabels[card.activeTabIndex]
  return {
    tabLabels: card.tabLabels,
    activeTabIndex: card.activeTabIndex,
    body: card.body,
    items: card.items,
    focusedIndex: card.focusedIndex,
    multiSelect: card.multiSelect,
    hints: card.hints,
    ...(title === undefined ? {} : { title }),
    ...(card.markers === undefined ? {} : { markers: card.markers }),
    ...(card.breadcrumb === undefined ? {} : { breadcrumb: card.breadcrumb }),
  }
}

export interface CardShellOptions {
  /** Visible item window (also the page step); default 5. */
  readonly itemWindow?: number
  /** Digit shortcuts address the visible window; default on. */
  readonly digits?: boolean
}

interface TabState {
  readonly model: CardTabModel
  focus: number
  chosen: readonly string[]
  windowStart: number
}

const NOOP: CardShellResult = { changed: false, outcome: "none" }

export class CardShellMachine {
  private readonly itemWindow: number
  private readonly digitsEnabled: boolean
  private tabs: readonly TabState[] = []
  private active = 0
  /** Last minted snapshot; returned again while the base fields hold. */
  private lastSnapshot: CardSnapshot | null = null

  constructor(options: CardShellOptions = {}) {
    this.itemWindow = Math.max(1, Math.floor(options.itemWindow ?? 5))
    this.digitsEnabled = options.digits ?? true
  }

  /**
   * Load a card (or reload the next one); every tab's state resets. Item
   * keys must be unique per tab — duplicates would corrupt toggle and
   * selection semantics, so the first occurrence wins. A tab with no
   * enabled item starts unfocused; nothing on it can be chosen.
   */
  load(tabs: readonly CardTabModel[]): void {
    this.tabs = tabs.map((model) => {
      const seen = new Set<string>()
      const items = model.items.filter((candidate) => {
        if (seen.has(candidate.key)) return false
        seen.add(candidate.key)
        return true
      })
      const multi = model.multiSelect === true
      const external = model.externalChoice === true
      const enabled = items.filter((candidate) => candidate.disabled !== true)
      const prefill = (model.chosen ?? []).filter((key) => enabled.some((candidate) => candidate.key === key))
      const chosen = multi || external ? [...prefill] : prefill.length > 0 ? [prefill[0]!] : enabled.length > 0 ? [enabled[0]!.key] : []
      const focusKey = model.focus ?? (multi || external ? prefill[0] : chosen[0]) ?? enabled[0]?.key
      const focus = focusKey === undefined ? -1 : items.findIndex((candidate) => candidate.key === focusKey)
      // Home the window onto a prefilled deep focus so the gutter and the
      // ❯ mark agree from the first frame.
      const windowStart =
        focus < 0 ? 0 : focus >= this.itemWindow ? Math.min(focus - this.itemWindow + 1, Math.max(0, items.length - this.itemWindow)) : 0
      return { model: { ...model, items }, focus, chosen, windowStart }
    })
    this.active = 0
  }

  dispatch(intent: TuiIntent): CardShellResult {
    if (intent.kind === "back") return this.back()
    if (intent.kind === "activate") return this.activate()
    if (intent.kind === "navigate") {
      if (intent.direction === "up" || intent.direction === "down") {
        return this.moveFocus(intent.direction === "up" ? -1 : 1)
      }
      if (intent.direction === "page-up" || intent.direction === "page-down") {
        return this.moveFocus(intent.direction === "page-up" ? -this.itemWindow : this.itemWindow)
      }
      if (intent.direction === "left" || intent.direction === "right") {
        return this.moveTab(intent.direction === "right" ? 1 : -1)
      }
      return NOOP
    }
    if (intent.kind === "input") {
      const event = intent.event
      if (event.type === "char") {
        if (event.value === " ") return this.toggleFocused()
        if (this.digitsEnabled && event.value >= "1" && event.value <= "9") {
          return this.pickVisible(Number(event.value) - 1)
        }
      }
    }
    return NOOP
  }

  /** Per-tab chosen keys, index-aligned with the loaded tabs. */
  selection(): readonly (readonly string[])[] {
    return this.tabs.map((tab) => [...tab.chosen])
  }

  snapshot(): CardSnapshot {
    const tab = this.tabs[this.active]
    const next =
      tab === undefined
        ? cardSnapshot({
            tabLabels: [],
            activeTabIndex: 0,
            body: [],
            items: [],
            focusedIndex: null,
            focusedKey: null,
            multiSelect: false,
            lastTab: true,
            hints: [],
          })
        : this.tabSnapshot(tab)
    if (this.lastSnapshot !== null && cardBaseEqual(this.lastSnapshot, next)) return this.lastSnapshot
    this.lastSnapshot = next
    return next
  }

  private tabSnapshot(tab: TabState): CardSnapshot {
    const multi = tab.model.multiSelect === true
    const windowEnd = Math.min(tab.model.items.length, tab.windowStart + this.itemWindow)
    const items: CardItemState[] = []
    for (let index = tab.windowStart; index < windowEnd; index += 1) {
      const model = tab.model.items[index]!
      items.push({
        label: model.label,
        ...(model.description === undefined ? {} : { description: model.description }),
        chosen: tab.chosen.includes(model.key),
        disabled: model.disabled === true,
        digit: this.digitsEnabled && index - tab.windowStart < 9 ? index - tab.windowStart + 1 : null,
      })
    }
    return cardSnapshot({
      tabLabels: this.tabs.map((entry) => entry.model.label),
      activeTabIndex: this.active,
      body: tab.model.body ?? [],
      items,
      focusedIndex: tab.focus >= tab.windowStart && tab.focus < windowEnd ? tab.focus - tab.windowStart : null,
      focusedKey: tab.focus >= 0 ? (tab.model.items[tab.focus]?.key ?? null) : null,
      multiSelect: multi,
      lastTab: this.active === this.tabs.length - 1,
      hints: this.hints(tab),
    })
  }

  private hints(tab: TabState): readonly string[] {
    const enterHint = this.active === this.tabs.length - 1 ? CARD_STRINGS.submit : CARD_STRINGS.next
    // With nothing choosable (empty or all disabled) the select/toggle/
    // pick hints would advertise dead keys; Enter still advances or
    // confirms, so it is the only honest affordance left.
    if (!tab.model.items.some((item) => item.disabled !== true)) return [enterHint]
    const hints: string[] = [CARD_STRINGS.select]
    if (this.tabs.length > 1) hints.push(CARD_STRINGS.tabs)
    if (tab.model.multiSelect === true) hints.push(CARD_STRINGS.toggle)
    if (this.digitsEnabled) hints.push(cardPickHint(Math.min(this.itemWindow, 9, tab.model.items.length)))
    if (this.active > 0) hints.push(CARD_STRINGS.back)
    hints.push(enterHint)
    return hints
  }

  private back(): CardShellResult {
    if (this.active === 0) return { changed: false, outcome: "declined" }
    this.active -= 1
    return { changed: true, outcome: "none" }
  }

  /**
   * Enter accepts the active tab. A tab with no choosable item (empty or
   * all disabled) never traps the card: activate advances past it — or
   * confirms on the last tab with an empty selection — so decline stays a
   * choice, never the only exit.
   */
  private activate(): CardShellResult {
    const tab = this.tabs[this.active]
    if (tab === undefined) return NOOP
    const focused = tab.model.items[tab.focus]
    if (focused !== undefined && focused.disabled !== true && tab.model.multiSelect !== true && tab.model.externalChoice !== true) {
      tab.chosen = [focused.key]
    }
    if (this.active === this.tabs.length - 1) return { changed: true, outcome: "confirmed" }
    this.active += 1
    return { changed: true, outcome: "activated" }
  }

  private toggleFocused(): CardShellResult {
    const tab = this.tabs[this.active]
    if (tab === undefined || tab.model.multiSelect !== true || tab.focus === -1) return NOOP
    const focused = tab.model.items[tab.focus]
    if (focused === undefined || focused.disabled === true) return NOOP
    tab.chosen = tab.chosen.includes(focused.key) ? tab.chosen.filter((key) => key !== focused.key) : [...tab.chosen, focused.key]
    return { changed: true, outcome: "none" }
  }

  private moveFocus(step: number): CardShellResult {
    const tab = this.tabs[this.active]
    if (tab === undefined || tab.model.items.length === 0) return NOOP
    // Advance |step| focusable positions (skipping disabled items) in the
    // step's direction; a clamped end keeps however far it got.
    const direction = step < 0 ? -1 : 1
    const magnitude = Math.abs(step)
    let index = tab.focus
    let advanced = 0
    while (advanced < magnitude) {
      let candidate = index + direction
      while (candidate >= 0 && candidate < tab.model.items.length && tab.model.items[candidate]!.disabled === true) {
        candidate += direction
      }
      if (candidate < 0 || candidate >= tab.model.items.length) break
      index = candidate
      advanced += 1
    }
    if (index === tab.focus) return NOOP
    tab.focus = index
    if (tab.focus < tab.windowStart) tab.windowStart = tab.focus
    if (tab.focus >= tab.windowStart + this.itemWindow) tab.windowStart = tab.focus - this.itemWindow + 1
    return { changed: true, outcome: "none" }
  }

  private moveTab(step: number): CardShellResult {
    if (this.tabs.length < 2) return NOOP
    const target = this.active + step
    if (target < 0 || target >= this.tabs.length) return NOOP
    this.active = target
    return { changed: true, outcome: "none" }
  }

  /** Pick the window-relative slot (digits); single-select chooses, multi toggles. */
  private pickVisible(slot: number): CardShellResult {
    const tab = this.tabs[this.active]
    // Digits address the visible window only: an off-screen slot must not
    // choose an item the rendered gutter never numbered.
    if (tab === undefined || slot < 0 || slot >= this.itemWindow) return NOOP
    const index = tab.windowStart + slot
    const target = tab.model.items[index]
    if (target === undefined || target.disabled === true) return NOOP
    tab.focus = index
    if (tab.model.multiSelect === true) {
      tab.chosen = tab.chosen.includes(target.key) ? tab.chosen.filter((key) => key !== target.key) : [...tab.chosen, target.key]
    } else if (tab.model.externalChoice !== true) {
      tab.chosen = [target.key]
    }
    return { changed: true, outcome: "none" }
  }
}
