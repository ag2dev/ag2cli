/**
 * Framed-card renderer: composes the chrome primitives into one card
 * from a declarative view. The interaction glyphs (focus ❯, radio ●/○,
 * checkbox [x]/[ ], digit gutter) are text, not color, so cell-level
 * test harnesses can pin selection state.
 *
 * Row-budget contract: when the granted rows cannot hold the full card
 * the renderer degrades along a fixed ladder — hints, breadcrumb, item
 * descriptions, body tail, tab row, items after the focused one, body,
 * every item but the focused one — and never truncates through the
 * frame (an open-bottomed card is a bug). The focused survivor keeps
 * its true digit, and when items were dropped a muted "…N more" row
 * rides the tail whenever one row of budget remains. Below four
 * granted rows, or below the chrome frame floor, the card renders bare
 * content lines instead — with the focused item the last thing
 * standing.
 */
import type { TextRun } from "./theme.js"
import { FRAME_FLOOR_COLUMNS, breadcrumbRow, frameBox, frameInnerWidth, hintRow, tabRow } from "./chrome.js"
import { clipText, textWidth } from "./measure.js"
import { sanitizeText } from "./sanitize.js"

type RunLine = readonly TextRun[]

export interface CardItemView {
  readonly label: string
  readonly description?: string
  readonly chosen?: boolean
  readonly disabled?: boolean
  /**
   * Visible-slot digit from the interaction owner (the card shell, which
   * knows the window); null or omitted renders no digit run. The
   * renderer never derives digits on its own — one source of truth.
   */
  readonly digit?: number | null
}

export interface CardView {
  readonly width: number
  readonly title?: string
  readonly rightTitle?: string
  readonly breadcrumb?: readonly string[]
  /** Two or more labels render the tab row; a lone tab stays implicit. */
  readonly tabLabels?: readonly string[]
  readonly activeTabIndex?: number
  readonly body?: readonly RunLine[]
  readonly items?: readonly CardItemView[]
  /**
   * Index within `items` of the focused item (receives the ❯ gutter);
   * out-of-range numbers clamp. null (or omitted while items exist)
   * renders no focus gutter — the honest rendering of a tab whose items
   * exist but none can be chosen.
   */
  readonly focusedIndex?: number | null
  readonly multiSelect?: boolean
  /** Item marker family; default radio, or checkbox under multiSelect. */
  readonly markers?: "radio" | "check" | "none"
  readonly hints?: readonly string[]
}

export interface RenderCardOptions {
  /** Granted row budget; the card degrades along the ladder to fit. */
  readonly maxRows?: number
}

/** Full height a card may take: frame + body + one item window + hint. */
export const CARD_ROW_CAP = 12

const ITEM_FOCUS = "❯ "
const ITEM_PAD = "  "
const RADIO_ON = "● "
const RADIO_OFF = "○ "
const CHECK_ON = "[x] "
const CHECK_OFF = "[ ] "

/**
 * Text bound for a frame row goes through the kernel's single sanitize
 * point, then the tab and newline it spares flatten to spaces — one
 * label, one physical row. Flattening controls without stripping escape
 * sequences first would leave their payloads ("[31m") rendering as
 * visible junk.
 */
// eslint-disable-next-line no-control-regex -- the survivors of sanitizeText are tab and newline by design
const ROW_SPLITTERS = /[\t\n]/g
const flat = (text: string): string => sanitizeText(text).replace(ROW_SPLITTERS, " ")

function markerSpec(view: CardView): { readonly on: string; readonly off: string } | null {
  const mode = view.markers ?? (view.multiSelect === true ? "check" : "radio")
  if (mode === "none") return null
  return mode === "check" ? { on: CHECK_ON, off: CHECK_OFF } : { on: RADIO_ON, off: RADIO_OFF }
}

/** One item's label line: gutter (focus/digit/marker) then the label. */
function itemLine(item: CardItemView, index: number, view: CardView): RunLine {
  const focused = view.focusedIndex === index
  const chosen = item.chosen === true
  const marker = markerSpec(view)
  const runs: TextRun[] = [{ text: focused ? ITEM_FOCUS : ITEM_PAD, token: focused ? "accent" : "text" }]
  if (typeof item.digit === "number") runs.push({ text: `${item.digit}. `, token: "muted" })
  if (marker !== null) {
    runs.push({ text: chosen ? marker.on : marker.off, token: chosen ? "accent" : "muted" })
  }
  const overlays = [...(focused ? (["focus"] as const) : []), ...(chosen ? (["selected"] as const) : [])]
  runs.push({
    text: item.label,
    token: item.disabled === true ? "disabled" : "text",
    ...(overlays.length === 0 ? {} : { overlays }),
  })
  return runs
}

/** Description line indented to the label column of its item. */
function descriptionLine(item: CardItemView, _index: number, view: CardView): RunLine | null {
  if (item.description === undefined) return null
  const marker = markerSpec(view)
  const indent = ITEM_FOCUS.length + (typeof item.digit === "number" ? 3 : 0) + (marker === null ? 0 : marker.on.length)
  return [{ text: `${" ".repeat(indent)}${item.description}`, token: "muted" }]
}

/** Bare degradation: content lines without a frame, each clipped to width. */
function bareLines(view: CardView, width: number, maxRows: number): readonly RunLine[] {
  const clip = (runs: RunLine): RunLine => {
    let budget = width
    const out: TextRun[] = []
    for (const run of runs) {
      if (budget < 1) break
      if (run.text.length === 0) continue
      const chunk = clipText(run.text, budget)
      if (chunk.text.length === 0) break
      out.push({ ...run, text: chunk.text })
      budget -= textWidth(chunk.text)
      if (chunk.clipped) break
    }
    return out
  }
  const items = view.items ?? []
  const rows: RunLine[] = [...(view.body ?? [])]
  items.forEach((item, index) => rows.push(itemLine(item, index, view)))
  let kept = rows.slice(0, maxRows)
  if (items.length > 0) {
    // Head-slicing can cut the focused item off; when it does, the focused
    // item takes the last visible row — focus survives in bare mode too.
    // (An unfocused list degrades to item 0 without painting a gutter.)
    const focus = Math.max(0, Math.min(items.length - 1, Math.floor(view.focusedIndex ?? 0)))
    const focusRow = (view.body?.length ?? 0) + focus
    if (focusRow >= maxRows && maxRows >= 1) kept = [...kept.slice(0, Math.max(0, maxRows - 1)), rows[focusRow]!]
  }
  return kept.map(clip)
}

export function renderCardLines(view: CardView, options: RenderCardOptions = {}): readonly RunLine[] {
  const width = Math.max(1, Math.floor(view.width))
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY
  if (maxRows < 1) return []
  // Normalize once: flatten control characters (a literal newline or tab
  // would split a physical frame row) and clamp focus so a stale index can
  // never drop items or misplace the ❯ gutter. null (no focus anywhere)
  // survives normalization; ladder math falls back to item 0.
  const source = view.items ?? []
  const rawFocus = view.focusedIndex ?? null
  const focusedIndex = source.length === 0 ? 0 : rawFocus === null ? null : Math.max(0, Math.min(source.length - 1, Math.floor(rawFocus)))
  const focusOrdinal = focusedIndex ?? 0
  const normItems: readonly CardItemView[] = source.map((item) => ({
    ...item,
    label: flat(item.label),
    ...(item.description === undefined ? {} : { description: flat(item.description) }),
  }))
  const norm: CardView = {
    ...view,
    focusedIndex,
    ...(view.title === undefined ? {} : { title: flat(view.title) }),
    ...(view.rightTitle === undefined ? {} : { rightTitle: flat(view.rightTitle) }),
    ...(view.breadcrumb === undefined ? {} : { breadcrumb: view.breadcrumb.map(flat) }),
    ...(view.tabLabels === undefined ? {} : { tabLabels: view.tabLabels.map(flat) }),
    ...(view.hints === undefined ? {} : { hints: view.hints.map(flat) }),
    ...(view.body === undefined
      ? {}
      : { body: view.body.map((line) => line.map((run) => (run.text.length === 0 ? run : { ...run, text: flat(run.text) }))) }),
    items: normItems,
  }
  if (width < FRAME_FLOOR_COLUMNS || maxRows < 4) return bareLines(norm, width, Math.floor(maxRows))

  const inner = frameInnerWidth(width)
  let hint: RunLine | null = norm.hints === undefined || norm.hints.length === 0 ? null : hintRow(norm.hints.join(" · "), inner)
  let crumb: RunLine | null = norm.breadcrumb === undefined || norm.breadcrumb.length === 0 ? null : breadcrumbRow(norm.breadcrumb, inner)
  // Tabs navigate between item panels; an itemless (read-only) card never
  // shows a tab row even when labels are present.
  const interactive = normItems.length > 0
  let tab: RunLine | null =
    interactive && norm.tabLabels !== undefined && norm.tabLabels.length > 1
      ? tabRow({ tabs: norm.tabLabels, activeIndex: norm.activeTabIndex ?? 0, width: inner })
      : null
  let body: readonly RunLine[] = norm.body ?? []
  let items: readonly CardItemView[] = normItems
  const totalItems = items.length
  // Item rows may be sliced (ladder steps 6 and 8); the offset preserves
  // each survivor's true index so the ❯ gutter and digit stay honest.
  let itemOffset = 0
  let descriptions = true

  const assemble = (): readonly RunLine[] => {
    const rows: RunLine[] = []
    if (crumb !== null) rows.push(crumb)
    if (tab !== null) rows.push(tab)
    rows.push(...body)
    items.forEach((item, index) => {
      rows.push(itemLine(item, itemOffset + index, norm))
      if (descriptions) {
        const line = descriptionLine(item, itemOffset + index, norm)
        if (line !== null) rows.push(line)
      }
    })
    if (hint !== null) rows.push(hint)
    return rows
  }

  const budget = Math.floor(maxRows) - 2
  // Degradation ladder: each step drops the next-cheapest section until
  // the content fits; the focused item is the last thing standing.
  const steps: readonly (() => boolean)[] = [
    () => (hint !== null ? ((hint = null), true) : false),
    () => (crumb !== null ? ((crumb = null), true) : false),
    () => (descriptions ? ((descriptions = false), true) : false),
    () => (body.length > 1 ? ((body = body.slice(0, 1)), true) : false),
    () => (tab !== null ? ((tab = null), true) : false),
    () => {
      const keep = focusOrdinal + 1
      return items.length > keep ? ((items = items.slice(0, keep)), true) : false
    },
    () => (body.length > 0 ? ((body = []), true) : false),
    () => {
      if (items.length > 1) {
        items = [items[focusOrdinal] ?? items[0]!]
        itemOffset += focusOrdinal
        return true
      }
      return false
    },
  ]
  let rows = assemble()
  for (const step of steps) {
    if (rows.length <= budget) break
    if (!step()) continue
    rows = assemble()
  }
  // A truncated list must not masquerade as a complete one: when items
  // were dropped and one row of budget remains, say so.
  const dropped = totalItems - items.length
  if (dropped > 0 && rows.length + 1 <= budget) {
    rows = [...rows, [{ text: `… ${dropped} more`, token: "muted" }]]
  }
  return frameBox({ width, title: norm.title, rightTitle: norm.rightTitle, body: rows })
}
