/**
 * Card surface: the framed card claiming modal keys (the theme panel
 * first), rendered between transcript and composer. The snapshot
 * carries the composed card view; the store's granted rows bound its
 * height together with the cap, and the renderer's degradation ladder
 * does the rest. Every run line lands through the shared Ink bridge.
 */
import { memo, type ReactElement } from "react"
import { Box } from "ink"
import type { TextRun, ThemeId } from "../text/index.js"
import { RunLine } from "./runs.js"

/** Memo boundary: equal painted rows keep their array reference, so unrelated commits skip this subtree. */
export const CardSurface = memo(function CardSurface({
  lines,
  theme,
}: {
  readonly lines: readonly (readonly TextRun[])[]
  readonly theme: ThemeId
}): ReactElement {
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <RunLine key={index} runs={line} theme={theme} />
      ))}
    </Box>
  )
})
