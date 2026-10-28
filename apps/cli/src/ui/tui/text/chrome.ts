/**
 * Card chrome geometry over the text kernel: rounded frames, tab rows,
 * hint rows, and breadcrumbs rendered as styled run rows. Pure geometry —
 * this module never knows what a card is for.
 *
 * Contracts:
 * - Frames CLIP body rows to the inner width (never wrap — wrapping is
 *   the caller's job) and pad every row so all frame lines have exactly
 *   the granted width. Frames degrade to the unpadded body below
 *   FRAME_FLOOR_COLUMNS, matching the view's terminal support floor.
 * - Rows (tab/hint/breadcrumb) are unindented and never exceed the
 *   granted width; margins belong to the composing card layer.
 * - Breadcrumbs drop oldest parts first when over-wide (the current
 *   location, the last part, always survives).
 */
import type { TextRun } from "./theme.js"
import { clipText, textWidth } from "./measure.js"
import { horizontalTabWindow } from "./horizontal-navigation.js"

type RunLine = readonly TextRun[]

/** Below this width frames degrade to bare body lines. */
export const FRAME_FLOOR_COLUMNS = 20

/** Smallest terminal the frame supports; below it the view collapses to one diagnostic line. */
export const SUPPORT_FLOOR = { columns: 20, rows: 6 } as const

/** Brand and workspace rows used only when the empty transcript is visible. */
export function workspaceIntroRows(displayPath: string, width: number): readonly RunLine[] {
  const path = clipText(displayPath, Math.max(1, width - 5)).text
  return [[{ text: "", token: "text" }], [{ text: "  >_ AG2CLI", token: "brand" }], [{ text: `     ${path}`, token: "muted" }]]
}

const CORNER_TOP_LEFT = "╭"
const CORNER_TOP_RIGHT = "╮"
const CORNER_BOTTOM_LEFT = "╰"
const CORNER_BOTTOM_RIGHT = "╯"
const DASH = "─"
const VERTICAL = "│"

const border = (text: string): TextRun => ({ text, token: "border" })

/**
 * Clip styled runs to a cell budget in run order. Empty runs pass
 * through positionally (later runs survive); the walk stops at the first
 * run whose lead grapheme cannot fit.
 */
export function clipTextRuns(runs: readonly TextRun[], width: number): readonly TextRun[] {
  const clipped: TextRun[] = []
  let budget = Math.max(0, Math.floor(width))
  for (const run of runs) {
    if (budget < 1) break
    if (run.text.length === 0) continue
    const chunk = clipText(run.text, budget)
    if (chunk.text.length === 0) break
    clipped.push({ ...run, text: chunk.text })
    budget -= textWidth(chunk.text)
    if (chunk.clipped) break
  }
  return clipped
}

export interface FrameBoxOptions {
  readonly width: number
  /** Left-aligned top-border title. */
  readonly title?: string
  /** Right-aligned top-border label, e.g. "+3 -1" (muted token). */
  readonly rightTitle?: string
  readonly body: readonly RunLine[]
}

/**
 * One label segment of the top border: wrapper spaces ride the border
 * token; an empty (over-clipped) label drops its wrappers entirely.
 */
function titleSegment(label: string | undefined, textBudget: number): readonly TextRun[] {
  if (label === undefined) return []
  const clipped = clipText(label, textBudget).text
  if (clipped.length === 0) return []
  return [border(" "), { text: clipped, token: "title" }, border(" ")]
}

function rightTitleSegment(label: string | undefined, textBudget: number): readonly TextRun[] {
  if (label === undefined) return []
  const clipped = clipText(label, textBudget).text
  if (clipped.length === 0) return []
  return [border(" "), { text: clipped, token: "muted" }, border(" ")]
}

/** Top border: `╭─ title ──…── right ─╮`; labels clip (right first) so at least one fill dash survives. */
function topBorder(width: number, title: string | undefined, rightTitle: string | undefined): RunLine {
  const segmentBudget = width - 4 // corners plus their adjacent dashes
  let left = titleSegment(title, segmentBudget)
  let right = rightTitleSegment(rightTitle, segmentBudget)
  const used = () => left.reduce((sum, run) => sum + textWidth(run.text), 0) + right.reduce((sum, run) => sum + textWidth(run.text), 0)
  if (used() > segmentBudget - 1) {
    // Over-wide: clip the right label to the slack the title leaves…
    const leftWidth = left.reduce((sum, run) => sum + textWidth(run.text), 0)
    right = rightTitleSegment(rightTitle, Math.max(0, segmentBudget - 1 - leftWidth - 2))
    if (used() > segmentBudget - 1) {
      // …then the title to the slack the (possibly emptied) right leaves.
      const rightWidth = right.reduce((sum, run) => sum + textWidth(run.text), 0)
      left = titleSegment(title, Math.max(0, segmentBudget - 1 - rightWidth - 2))
    }
  }
  const fill = Math.max(1, segmentBudget - used())
  return [border(`${CORNER_TOP_LEFT}${DASH}`), ...left, border(DASH.repeat(fill)), ...right, border(`${DASH}${CORNER_TOP_RIGHT}`)]
}

/** Usable body width inside a frame of `width` cells (`"│ "` + `" │"` rails). */
export function frameInnerWidth(width: number): number {
  return width - 4
}

/** Frame-render a styled body: clip to the inner width, pad, close the rails. */
function frameBodyRow(runs: readonly TextRun[], width: number): RunLine {
  const inner = frameInnerWidth(width)
  const clipped = clipTextRuns(runs, inner)
  const used = clipped.reduce((sum, run) => sum + textWidth(run.text), 0)
  const pad = Math.max(0, inner - used)
  return [
    border(`${VERTICAL} `),
    ...clipped,
    ...(pad === 0 ? [] : [{ text: " ".repeat(pad), token: "text" as const }]),
    border(` ${VERTICAL}`),
  ]
}

/**
 * Rounded frame around pre-styled body lines. Every returned line has
 * exactly `width` cells; body rows clip (never wrap); below
 * FRAME_FLOOR_COLUMNS the body returns unchanged (degradation contract).
 */
export function frameBox(options: FrameBoxOptions): readonly RunLine[] {
  const width = Math.max(1, Math.floor(options.width))
  if (width < FRAME_FLOOR_COLUMNS) return options.body
  return [
    topBorder(width, options.title, options.rightTitle),
    ...options.body.map((line) => frameBodyRow(line, width)),
    [border(`${CORNER_BOTTOM_LEFT}${DASH.repeat(width - 2)}${CORNER_BOTTOM_RIGHT}`)],
  ]
}

export interface TabRowOptions {
  readonly tabs: readonly string[]
  readonly activeIndex: number
  readonly width: number
  readonly focused?: boolean
}

/**
 * Horizontal tab strip: all labels when they fit, otherwise the active
 * label, nearby labels, explicit overflow, and its position in the set.
 */
export function tabRow(options: TabRowOptions): RunLine {
  const tabs = options.tabs
  const activeIndex = Math.max(0, Math.min(tabs.length - 1, Math.floor(options.activeIndex)))
  if (tabs.length === 0) return []
  const window = horizontalTabWindow(tabs, activeIndex, options.width)
  const runs: TextRun[] = []
  let segments = 0
  const separator = (): void => {
    if (segments > 0) runs.push({ text: " · ", token: "muted" })
    segments += 1
  }
  if (window.start > 0) {
    separator()
    runs.push({ text: "‹", token: "muted" })
  }
  for (let index = window.start; index < window.end; index += 1) {
    separator()
    if (index === activeIndex) {
      runs.push({ text: "❮ ", token: "muted" })
      runs.push({ text: tabs[index]!, token: "suggestion", ...(options.focused ? { overlays: ["selected"] as const } : {}) })
      runs.push({ text: " ❯", token: "muted" })
    } else runs.push({ text: tabs[index]!, token: "muted" })
  }
  if (window.end < tabs.length) {
    separator()
    runs.push({ text: "›", token: "muted" })
  }
  if (tabs.length > 1) {
    separator()
    runs.push({ text: `${activeIndex + 1}/${tabs.length}`, token: "muted" })
  }
  return clipTextRuns(runs, Math.max(1, Math.floor(options.width)))
}

/** Muted key-hint row, clipped to width. */
export function hintRow(text: string, width: number): RunLine {
  const runs: TextRun[] = [{ text, token: "muted" }]
  return clipTextRuns(runs, Math.max(1, Math.floor(width)))
}

/**
 * Breadcrumb row: `‹ a · b · current` with the last part styled as a title and the
 * rest muted. Over-wide rows drop the oldest parts (a leading `…` marks
 * the elision) so the current location always survives; a still-over-wide
 * single part clips.
 */
export function breadcrumbRow(parts: readonly string[], width: number): RunLine {
  const budget = Math.max(1, Math.floor(width))
  const kept = parts.filter((part) => part.length > 0)
  if (kept.length === 0) return []
  const widthOf = (runs: readonly TextRun[]): number => runs.reduce((sum, run) => sum + textWidth(run.text), 0)
  const render = (ellipsis: boolean, list: readonly string[]): readonly TextRun[] => {
    const runs: TextRun[] = [{ text: "‹ ", token: "muted" }]
    if (ellipsis) runs.push({ text: "…", token: "muted" })
    list.forEach((part, index) => {
      if (index > 0 || ellipsis) runs.push({ text: " · ", token: "muted" })
      runs.push({ text: part, token: index === list.length - 1 ? "title" : "muted" })
    })
    return runs
  }
  let ellipsis = false
  let visible = kept
  let runs = render(ellipsis, visible)
  while (widthOf(runs) > budget && visible.length > 1) {
    visible = visible.slice(1)
    ellipsis = true
    runs = render(ellipsis, visible)
  }
  return clipTextRuns(runs, budget)
}
