/**
 * Footer wrap: lay one row of status segments out as terminal lines.
 * Segments join with " · " and never split across lines; an over-wide
 * segment clips to the width, and a lone segment always renders. Pure
 * run layout over the text kernel — the state layer owns what the
 * segments say, this owns only where they break.
 */
import { clipText, graphemes, textWidth } from "./measure.js"
import type { TextRun } from "./theme.js"

const separator = (): TextRun => ({ text: " · ", token: "text" })

export function wrapFooterSegments(segments: readonly TextRun[], width: number): readonly (readonly TextRun[])[] {
  if (width <= 0) return []
  const lines: TextRun[][] = []
  let current: TextRun[] = []
  let currentWidth = 0
  for (const segment of segments) {
    const text = segment.text.trim()
    if (text.length === 0) continue
    const clipped = clipText(text, width).text
    // An empty clip means one grapheme alone exceeds the width (a wide
    // glyph at width 1): keep the glyph so a lone segment still renders,
    // exactly like the wrapper's over-budget fallback.
    const run: TextRun = { ...segment, text: clipped.length === 0 ? graphemes(text)[0]! : clipped }
    const runWidth = textWidth(run.text)
    const candidateWidth = currentWidth === 0 ? runWidth : currentWidth + 3 + runWidth
    if (currentWidth > 0 && candidateWidth > width) {
      lines.push(current)
      current = [run]
      currentWidth = runWidth
    } else {
      if (currentWidth > 0) {
        current.push(separator())
        currentWidth += 3
      }
      current.push(run)
      currentWidth += runWidth
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}
