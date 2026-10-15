/**
 * Status footer: a full-width rule in the border token plus the status
 * line. The store prebuilds the segment runs — telemetry when the host
 * mirrors it, the minimal pending line otherwise — and this view only
 * wraps them at the live width through the text kernel and bridges the
 * lines to Ink.
 */
import { memo, type ReactElement } from "react"
import { Box, Text } from "ink"
import { inkStyle, wrapFooterSegments, type TextRun, type ThemeId } from "../text/index.js"
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
      <Text {...inkStyle("border", [], theme)}>{"─".repeat(width)}</Text>
      {wrapFooterSegments(footer, width).map((line, index) => (
        <RunLine key={index} runs={line} theme={theme} />
      ))}
    </Box>
  )
})
