/** The store prebuilds the status runs; this view wraps them at the live width. */
import { memo, type ReactElement } from "react"
import { Box } from "ink"
import { wrapFooterSegments, type TextRun, type ThemeId } from "../text/index.js"
import { RunLine } from "./runs.js"

/** Memo boundary: value-equal footer runs keep their array reference, so unrelated commits skip this subtree. */
export const Footer = memo(function Footer({
  footer,
  columns,
  theme,
}: {
  readonly footer: readonly TextRun[]
  readonly columns: number
  readonly theme: ThemeId
}): ReactElement {
  const width = Math.max(columns, 1)
  return (
    <Box flexDirection="column">
      {wrapFooterSegments(footer, width).map((line, index) => (
        <RunLine key={index} runs={line} theme={theme} />
      ))}
    </Box>
  )
})
