/**
 * Focused child panel: the store-derived replacement for the
 * transcript window while a delegated child holds focus — the header
 * naming the delegation, the read-only buffer rows already wrapped
 * and budgeted, and the one hint row carrying the cancel affordance.
 * The view holds no geometry of its own: it paints exactly the panel
 * the snapshot carries.
 */
import { memo, type ReactElement } from "react"
import { Box, Text } from "ink"
import { clipText, inkStyle, type ThemeId } from "../text/index.js"
import type { TuiChildPanelView } from "../state/index.js"

/** Memo boundary: the store mints one panel view per commit, so unrelated commits skip this subtree. */
export const ChildPanel = memo(function ChildPanel({
  panel,
  columns,
  theme,
}: {
  readonly panel: TuiChildPanelView
  readonly columns: number
  readonly theme: ThemeId
}): ReactElement {
  return (
    <Box flexDirection="column">
      <Text {...inkStyle("accent", [], theme)}>{clipText(panel.header, columns).text}</Text>
      {panel.lines.map((line, index) => (
        <Text key={index}>{line.length === 0 ? " " : line}</Text>
      ))}
      {panel.hint === null ? null : <Text {...inkStyle("muted", [], theme)}>{clipText(panel.hint, columns).text}</Text>}
    </Box>
  )
})
