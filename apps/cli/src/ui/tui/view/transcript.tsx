/**
 * Transcript window: the store-derived line slice, rendered as run
 * lines. The wrapping, markdown phases, tail dedupe and tool tokens
 * live in the text kernel behind the store; this view holds no mapping
 * of its own — it paints exactly the window the snapshot carries.
 */
import { memo, type ReactElement } from "react"
import { Box } from "ink"
import type { TranscriptLine, ThemeId } from "../text/index.js"
import { RunLine } from "./runs.js"

/** Memo boundary: the store keeps the window's references stable, so unrelated commits skip this subtree. */
export const Transcript = memo(function Transcript({
  lines,
  start,
  theme,
}: {
  readonly lines: readonly TranscriptLine[]
  /** Absolute transcript row of `lines[0]`; keys stay stable across scrolls. */
  readonly start: number
  readonly theme: ThemeId
}): ReactElement {
  return (
    <Box flexDirection="column">
      {/* Absolute-row keys: a scrolled window moves its start but each
          row keeps its key, so Ink reconciles rows instead of
          remounting the whole window. */}
      {lines.map((line, index) => (
        <RunLine key={start + index} runs={line.runs} theme={theme} />
      ))}
    </Box>
  )
})
