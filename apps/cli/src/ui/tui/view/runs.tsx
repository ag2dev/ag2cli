/**
 * One rendered terminal line: text-kernel runs bridged to Ink styled
 * spans. The view owns no style logic of its own — inkRun/inkStyle are
 * the single style point — and a line with no visible spans still
 * occupies a row (a single space) so blank markdown separators keep
 * their height in the frame. Adjacent runs of one style merge into a
 * single span, and equal runs skip re-render: a scrolled window
 * re-paints only the rows whose content actually changed.
 */
import { memo, type ReactElement } from "react"
import { Text } from "ink"
import { inkRun, textRunsEqual, type TextRun, type ThemeId } from "../text/index.js"

function overlaysEqual(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || left.length === 0) return right === undefined || right.length === 0
  if (right === undefined || left.length !== right.length) return false
  return left.every((overlay, index) => overlay === right[index])
}

/** Adjacent same-style runs concatenate before the bridge; fewer Ink spans per frame. */
function mergeRuns(runs: readonly TextRun[]): readonly TextRun[] {
  const merged: TextRun[] = []
  for (const run of runs) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.token === run.token && overlaysEqual(last.overlays, run.overlays)) {
      merged[merged.length - 1] = { ...last, text: last.text + run.text }
      continue
    }
    merged.push(run)
  }
  return merged
}

export const RunLine = memo(
  function RunLine({ runs, theme }: { readonly runs: readonly TextRun[]; readonly theme: ThemeId }): ReactElement {
    const spans: ReactElement[] = []
    for (const [index, run] of mergeRuns(runs).entries()) {
      const bridged = inkRun(run, theme)
      if (bridged === null) continue
      spans.push(
        <Text key={index} {...bridged.style}>
          {bridged.text}
        </Text>,
      )
    }
    if (spans.length === 0) {
      return <Text> </Text>
    }
    return <Text>{spans}</Text>
  },
  (prev, next) => prev.theme === next.theme && textRunsEqual(prev.runs, next.runs),
)
