/** Small horizontal-navigation primitives shared by the permission and Ask headers. */
import { textWidth } from "./measure.js"

export type HorizontalDirection = "left" | "right"

export interface HorizontalTabWindow {
  readonly start: number
  readonly end: number
}

/** Resolve the normalized keys that move within a horizontal tab header. */
export function horizontalTabDirection(intent: { readonly kind: string; readonly direction?: string }): HorizontalDirection | null {
  if (intent.kind === "navigate" && (intent.direction === "left" || intent.direction === "right")) return intent.direction
  if (intent.kind === "advance") return "right"
  if (intent.kind === "permission-cycle") return "left"
  return null
}

/** Move within a finite tab strip; ends clamp instead of wrapping. */
export function moveHorizontalTab(index: number, count: number, direction: HorizontalDirection): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, Math.floor(index) + (direction === "right" ? 1 : -1)))
}

/**
 * Select the largest contiguous tab slice that fits while retaining the
 * active label, explicit overflow markers, and its position in the full set.
 * Each displayed label, marker, and counter is separated by ` · ` in both
 * the styled card header and the plain Ask header.
 */
export function horizontalTabWindow(labels: readonly string[], activeIndex: number, width: number): HorizontalTabWindow {
  if (labels.length === 0) return { start: 0, end: 0 }
  const active = Math.max(0, Math.min(labels.length - 1, Math.floor(activeIndex)))
  let start = active
  let end = active + 1
  const budget = Math.max(1, Math.floor(width))
  const cost = (from: number, to: number): number => {
    let used = 0
    let tokenCount = 0
    if (from > 0) {
      used += textWidth("‹")
      tokenCount += 1
    }
    for (let index = from; index < to; index += 1) {
      used += textWidth(labels[index]!) + (index === active ? textWidth("❮  ❯") : 0)
      tokenCount += 1
    }
    if (to < labels.length) {
      used += textWidth("›")
      tokenCount += 1
    }
    if (labels.length > 1) {
      used += textWidth(`${active + 1}/${labels.length}`)
      tokenCount += 1
    }
    used += Math.max(0, tokenCount - 1) * textWidth(" · ")
    return used
  }

  while (true) {
    const canLeft = start > 0 && cost(start - 1, end) <= budget
    const canRight = end < labels.length && cost(start, end + 1) <= budget
    if (!canLeft && !canRight) break
    // Keep the strip balanced around the selected question when both sides fit.
    if (canLeft && (!canRight || active - (start - 1) <= end + 1 - active)) start -= 1
    else end += 1
  }
  return { start, end }
}
