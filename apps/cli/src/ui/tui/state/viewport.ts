/**
 * Transcript viewport: follow the tail, or anchor to one source's
 * span at a line offset. Follow shows the last capacity lines; an
 * anchored window resolves through the span and clamps inside it
 * first, so appends keep the window still (the span does not move)
 * while a shrinking span pulls it back to the anchor's own last
 * line. Both windows are the same height: the scrolled-off
 * indicator never spends a transcript row (the composer's rule
 * carries it), so crossing the follow boundary cannot shift the
 * frame. Paging steps by that one window height and lands each
 * window exactly where its neighbor begins, so no page of lines is
 * ever skipped; PageDown hands control back to follow at the tail.
 */
import type { TranscriptLineModel } from "./lines.js"

export type TranscriptViewport =
  { readonly kind: "follow" } | { readonly kind: "anchored"; readonly sourceId: string; readonly lineOffset: number }

export const FOLLOW_VIEWPORT: TranscriptViewport = { kind: "follow" }

/** Half-open window over the model's line indexes. */
export interface TranscriptWindow {
  readonly start: number
  readonly end: number
}

/** An anchor the model no longer holds reads as follow. */
export function resolveViewport(view: TranscriptViewport, model: TranscriptLineModel): TranscriptViewport {
  if (view.kind === "follow") return view
  return model.spanOf(view.sourceId) === null ? FOLLOW_VIEWPORT : view
}

/** The visible window for one view at a line budget; null on an empty model. */
export function viewportWindow(view: TranscriptViewport, model: TranscriptLineModel, budget: number): TranscriptWindow | null {
  if (model.total === 0) return null
  const lastStart = Math.max(0, model.total - budget)
  if (view.kind === "follow") return { start: lastStart, end: model.total }
  const span = model.spanOf(view.sourceId)
  if (span === null) return { start: lastStart, end: model.total }
  // The offset clamps inside the span first — a shrunken body pulls
  // the window back to the anchor's last line, never past it into the
  // next source — then to the last full window.
  const lastSpanLine = Math.max(span.start, span.end - 1)
  const start = Math.max(0, Math.min(Math.min(span.start + view.lineOffset, lastSpanLine), lastStart))
  return { start, end: Math.min(start + budget, model.total) }
}

/** Anchor the window's first line's source; a dead lookup keeps the view. */
function anchorAt(model: TranscriptLineModel, lineIndex: number, view: TranscriptViewport): TranscriptViewport {
  const sourceId = model.sourceAt(lineIndex)
  const span = sourceId === null ? null : model.spanOf(sourceId)
  if (sourceId === null || span === null) return view
  return { kind: "anchored", sourceId, lineOffset: lineIndex - span.start }
}

/**
 * Page towards older lines: the next window ends exactly where the
 * current one begins, stepping by the window height. The top clamp
 * may repeat part of a page but never skips one; a no-op when
 * everything fits, the model is empty, the terminal offers no
 * transcript row, or the window already reads the top.
 */
export function viewportPageUp(view: TranscriptViewport, model: TranscriptLineModel, capacity: number): TranscriptViewport {
  if (capacity <= 0) return view
  const window = viewportWindow(view, model, capacity)
  if (window === null || window.start === 0) return view
  return anchorAt(model, Math.max(0, window.start - capacity), view)
}

/**
 * Page towards newer lines: the next window begins exactly where the
 * current one ends, stepping by the window height. Reaching the
 * follow start resumes the tail.
 */
export function viewportPageDown(view: TranscriptViewport, model: TranscriptLineModel, capacity: number): TranscriptViewport {
  if (capacity <= 0 || view.kind === "follow" || model.total <= capacity) return view
  const window = viewportWindow(view, model, capacity)
  if (window === null) return view
  if (window.start + capacity >= model.total - capacity) return FOLLOW_VIEWPORT
  return anchorAt(model, window.start + capacity, view)
}

/** Lines one wheel notch scrolls every wheel-driven surface. */
export const WHEEL_STEP_LINES = 3

/** Wheel up scrolls older transcript rows without impersonating a page key. */
export function viewportWheelUp(
  view: TranscriptViewport,
  model: TranscriptLineModel,
  capacity: number,
  lines = WHEEL_STEP_LINES,
): TranscriptViewport {
  if (capacity <= 0) return view
  const step = Number.isFinite(lines) ? Math.max(1, Math.floor(lines)) : WHEEL_STEP_LINES
  const window = viewportWindow(view, model, capacity)
  if (window === null || window.start === 0) return view
  return anchorAt(model, Math.max(0, window.start - step), view)
}

/** Wheel down returns to tail-follow once the latest window is reached. */
export function viewportWheelDown(
  view: TranscriptViewport,
  model: TranscriptLineModel,
  capacity: number,
  lines = WHEEL_STEP_LINES,
): TranscriptViewport {
  if (capacity <= 0 || view.kind === "follow" || model.total <= capacity) return view
  const step = Number.isFinite(lines) ? Math.max(1, Math.floor(lines)) : WHEEL_STEP_LINES
  const window = viewportWindow(view, model, capacity)
  if (window === null) return view
  const lastFollowStart = Math.max(0, model.total - capacity)
  if (window.start + step >= lastFollowStart) return FOLLOW_VIEWPORT
  return anchorAt(model, window.start + step, view)
}

/** Whether the scrolled-off indicator shows at all: an anchored reader holding more lines than the window fits. */
export function viewportShowsIndicator(view: TranscriptViewport, total: number, capacity: number): boolean {
  return view.kind === "anchored" && capacity > 0 && total > capacity
}

/**
 * The window's position label, or null while following, when the whole
 * model fits inside the indicator-free capacity, or when the terminal
 * offers no transcript row at all. The full indicator line composes
 * onto it; consumers that want only the position (the reader heading)
 * read it without parsing the composed line.
 */
export function viewportPosition(view: TranscriptViewport, window: TranscriptWindow, total: number, capacity: number): string | null {
  if (!viewportShowsIndicator(view, total, capacity)) return null
  return `↑ ${window.start + 1}-${window.end}/${total}`
}

/** The composer rule row's scrolled-off line: the position label plus the resume affordance. */
export function viewportIndicator(view: TranscriptViewport, window: TranscriptWindow, total: number, capacity: number): string | null {
  const position = viewportPosition(view, window, total, capacity)
  return position === null ? null : `${position} · PageDown resumes the tail`
}

/**
 * Whether a committed-content transition moves the head a reader may
 * have anchored to: trailing truncation — the new source ids are a
 * strict prefix of the old, a replace rewinding the newest blocks —
 * re-points every anchor offset at different content, so it resumes
 * following. Everything else keeps the anchor: ring-trim evictions
 * (the bounded history dropping its oldest blocks), appends and
 * mid-drop splices re-resolve spans in place, and an anchor whose
 * source vanished reads as follow anyway. A full remint is caught by
 * the source generation, not by shape.
 */
export function viewportResetByContent(oldSourceIds: readonly string[], newSourceIds: readonly string[]): boolean {
  return (
    newSourceIds.length < oldSourceIds.length && oldSourceIds.slice(0, newSourceIds.length).every((id, index) => id === newSourceIds[index])
  )
}
