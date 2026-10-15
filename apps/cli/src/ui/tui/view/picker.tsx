/**
 * Completion picker view: the non-modal companion rendered above the
 * composer. Label graphemes carry the match overlay inside the matcher's
 * ranges, the selected row carries the selected overlay end to end, detail
 * rides muted after the label, and a muted (selected/total) indicator row
 * appears when the list is longer than its window. Pure function of the
 * picker window the store snapshot carries.
 */
import { memo, type ReactElement } from "react"
import { Box, Text } from "ink"
import type { CompletionWindow } from "../state/index.js"
import { clipText, graphemes, inkStyle, textWidth, type TextOverlay, type ThemeId } from "../text/index.js"

interface Span {
  readonly text: string
  readonly token: "text" | "muted"
  readonly overlays: readonly TextOverlay[]
}

function candidateSpans(
  label: string,
  detail: string | undefined,
  matchRanges: readonly { start: number; end: number }[],
  selected: boolean,
  width: number,
): readonly Span[] {
  const rowWidth = Math.max(1, Math.floor(width))
  const clipped = clipText(label, rowWidth).text
  const spans: Span[] = []
  const append = (text: string, token: Span["token"], overlays: readonly TextOverlay[]): void => {
    if (text.length === 0) return
    const previous = spans[spans.length - 1]
    if (previous !== undefined && previous.token === token && previous.overlays.join(",") === overlays.join(",")) {
      spans[spans.length - 1] = { text: previous.text + text, token, overlays }
    } else {
      spans.push({ text, token, overlays })
    }
  }
  graphemes(clipped).forEach((cluster, index) => {
    const overlays: TextOverlay[] = []
    if (matchRanges.some((range) => index >= range.start && index < range.end)) overlays.push("match")
    if (selected) overlays.push("selected")
    append(cluster, "text", overlays)
  })
  if (detail !== undefined && detail.length > 0) {
    const used = textWidth(clipped)
    if (used < rowWidth) append(clipText(` · ${detail}`, rowWidth - used).text, "muted", selected ? ["selected"] : [])
  }
  return spans
}

/** Memo boundary: a value-equal picker window keeps its reference, so unrelated commits skip this subtree. */
export const CompletionPickerView = memo(function CompletionPickerView({
  window,
  columns,
  theme,
}: {
  readonly window: CompletionWindow
  readonly columns: number
  readonly theme: ThemeId
}): ReactElement {
  return (
    <Box flexDirection="column">
      {window.items.map((candidate) => (
        <Text key={candidate.key}>
          {candidateSpans(
            candidate.label,
            candidate.detail,
            candidate.matchRanges ?? [],
            candidate.key === window.selectedKey,
            columns,
          ).map((span, index) => (
            <Text key={index} {...inkStyle(span.token, span.overlays, theme)}>
              {span.text}
            </Text>
          ))}
        </Text>
      ))}
      {window.total > window.items.length ? (
        <Text {...inkStyle("muted", [], theme)}>{`  (${window.selectedIndex + 1}/${window.total})`}</Text>
      ) : null}
    </Box>
  )
})
