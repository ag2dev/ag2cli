/**
 * Framed-card renderer: composes the chrome primitives into one card
 * from a declarative view. The interaction glyphs (focus ❯, radio ●/○,
 * checkbox [x]/[ ], digit gutter) are text, not color, so cell-level
 * test harnesses can pin selection state.
 *
 * Row-budget contract: when the granted rows cannot hold the full card
 * the renderer degrades along a fixed ladder — hints, breadcrumb, item
 * descriptions, body tail, items after the focused one, body, every
 * item but the focused one — and never truncates through the
 * frame (an open-bottomed card is a bug). The focused survivor keeps
 * its true digit, and when items were dropped a muted "…N more" row
 * rides the tail whenever one row of budget remains. Below four
 * granted rows, or below the chrome frame floor, the card renders bare
 * content lines instead — with the focused item the last thing
 * standing.
 */
import type { TextRun } from "./theme.js"
import { FRAME_FLOOR_COLUMNS, breadcrumbRow, frameBox, frameInnerWidth, hintRow, tabRow } from "./chrome.js"
import { clipText, textWidth, wrapVerbatim } from "./measure.js"
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
  readonly tabFocused?: boolean
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

/**
 * The composed task frame as the card shell reads it: structural, so
 * the text layer maps any frame that carries these fields without
 * importing the kernel's types.
 */
export interface TaskCardSource {
  readonly title: string
  /** The engine's own steps; the card renders them as the breadcrumb. */
  readonly steps: readonly string[]
  /** The task-owned horizontal header, including its focus state. */
  readonly tabs?: {
    readonly labels: readonly string[]
    readonly activeIndex: number
    readonly focused: boolean
  }
  /** The current step's choosable rows; each row is one physical line. */
  readonly rows: readonly { readonly label: string; readonly description?: string; readonly focused: boolean }[]
  /** The current step's body lines (paged documents, tab annotations). */
  readonly body: readonly string[]
  readonly hints: readonly string[]
  readonly dirty: boolean
}

/**
 * Map one task frame onto the declarative card. Each row keeps one
 * physical line — its annotation folds into the label run, so the
 * renderer's description rung stays unfed and a full row window cannot
 * double the card's height. The escape affordance leads the hint row:
 * the joined hint line clips from the right at narrow widths, so esc
 * must ride first to survive. A dirty frame confesses as a warning
 * tail on the body.
 */
export function taskCardView(source: TaskCardSource, width: number): CardView {
  const body: RunLine[] = source.body.flatMap((line): RunLine[] =>
    wrapVerbatim(line, Math.max(1, frameInnerWidth(width))).map((part) => [{ text: part, token: "text" }]),
  )
  if (source.dirty) body.push([{ text: "unsaved changes", token: "warning" }])
  const esc = source.hints.filter((hint) => hint.startsWith("esc"))
  const hints = esc.length === 0 ? source.hints : [...esc, ...source.hints.filter((hint) => !hint.startsWith("esc"))]
  const focusIndex = source.rows.findIndex((row) => row.focused)
  return {
    width,
    title: source.title,
    breadcrumb: source.steps,
    ...(source.tabs === undefined ? {} : { tabLabels: source.tabs.labels }),
    ...(source.tabs === undefined ? {} : { activeTabIndex: source.tabs.activeIndex }),
    ...(source.tabs === undefined ? {} : { tabFocused: source.tabs.focused }),
    markers: "none",
    body,
    items: source.rows.map((row) => ({
      label: row.description === undefined ? row.label : `${row.label} — ${row.description}`,
    })),
    focusedIndex: focusIndex < 0 ? null : focusIndex,
    hints,
  }
}

/** The card's own row count under a granted budget — the one height derivation every consumer shares. */
export function cardRowHeight(view: CardView, maxRows?: number): number {
  return renderCardLines(view, maxRows === undefined ? {} : { maxRows }).length
}

/**
 * The task surface's row count, shared by the coordinator's transcript
 * viewport and the view's renderer. Side previews use the list pane's
 * width and keep their sample outside the card body.
 */
export function taskSurfaceRowHeight(source: TaskCardSource, width: number, maxRows = CARD_ROW_CAP): number {
  const split = source.title === "Theme" ? width >= 80 : source.title === "Prompt history" && width >= 100
  const leftWidth = split ? Math.floor((width - 3) * 0.48) : width
  const cardWidth = leftWidth
  const cardSource = split ? { ...source, body: [] } : source
  const cardRows = cardRowHeight(taskCardView(cardSource, cardWidth), maxRows)
  if (!split) return cardRows

  const rightWidth = width - leftWidth - 3
  const previewRows =
    source.title === "Theme"
      ? 4 + source.body.length
      : 2 + source.body.flatMap((line) => wrapVerbatim(line, Math.max(1, rightWidth))).length
  return Math.min(Math.max(0, maxRows), Math.max(cardRows, previewRows))
}

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
  const runs: TextRun[] = [{ text: focused ? ITEM_FOCUS : ITEM_PAD, token: focused ? "suggestion" : "text" }]
  if (typeof item.digit === "number") runs.push({ text: `${item.digit}. `, token: "muted" })
  if (marker !== null) {
    runs.push({ text: chosen ? marker.on : marker.off, token: chosen ? "suggestion" : "muted" })
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
      ? tabRow({ tabs: norm.tabLabels, activeIndex: norm.activeTabIndex ?? 0, width: inner, focused: norm.tabFocused })
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
  // The task-owned tab header stays visible while secondary content yields.
  const steps: readonly (() => boolean)[] = [
    () => (descriptions ? ((descriptions = false), true) : false),
    () => (crumb !== null ? ((crumb = null), true) : false),
    () => {
      const overflow = rows.length - budget
      if (overflow <= 0 || body.length <= 1) return false
      const keep = Math.max(1, body.length - overflow)
      if (keep === body.length) return false
      body = body.slice(0, keep)
      return true
    },
    () => (hint !== null ? ((hint = null), true) : false),
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
