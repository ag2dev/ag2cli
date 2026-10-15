/**
 * Composer view: a full-width rule in the border token, then the
 * editor kernel's rows through the token bridge — kernel runs carry
 * the prompt prefixes and the completion accent; Ink's native cursor
 * is positioned over the logical caret. Pure function of the kernel's
 * render output, the terminal width, the clamped body budget
 * (the kernel's caret-follow window scrolls inside it), the
 * scrolled-off indicator riding the rule, and the
 * theme; the draft itself is mutated only through the store's
 * composer-intent input. The rule row is a fixed +1 the state
 * layer's row budget already reserves — the indicator renders on it,
 * right-aligned, so anchoring never adds or removes a frame row.
 */
import { memo, type ReactElement } from "react"
import { Box, Text, useCursor } from "ink"
import type { ComposerRenderRun, TuiEditorState } from "../state/index.js"
import { clipText, inkStyle, textWidth, type TextOverlay, type ThemeId } from "../text/index.js"

function runStyle(run: ComposerRenderRun, theme: ThemeId) {
  return inkStyle(run.token === "accent" ? "accent" : "text", (run.overlays ?? []) as readonly TextOverlay[], theme)
}

/**
 * The composer's rule row: a full-width divider, or — while the
 * reader is anchored — the same divider with the scrolled-off
 * indicator right-aligned on it. The row is exactly one line in both
 * shapes; a width too narrow to seat the indicator beside any rule
 * degrades to the clipped indicator alone.
 */
function ruleRow(indicator: string | null, columns: number, theme: ThemeId): ReactElement {
  const width = Math.max(1, columns)
  if (indicator === null) return <Text {...inkStyle("border", [], theme)}>{"─".repeat(width)}</Text>
  const fill = width - 1 - textWidth(indicator)
  if (fill < 2) return <Text {...inkStyle("muted", [], theme)}>{clipText(indicator, width).text}</Text>
  return (
    <Text>
      <Text {...inkStyle("border", [], theme)}>{"─".repeat(fill)}</Text>
      <Text {...inkStyle("muted", [], theme)}>{` ${indicator}`}</Text>
    </Text>
  )
}

/**
 * Display rows trim trailing blanks — an empty draft shows the bare
 * prompt, not the kernel's caret padding. A row that would trim to
 * nothing (a prefix-only continuation row) keeps its text verbatim:
 * an empty Ink Text paints zero rows, the frame below slides up into
 * the slot the row budget and cursor row still count, and the native
 * caret lands below the composer. At least one non-empty run per row
 * is what keeps every budgeted row painted.
 */
function trimTrailingRuns(runs: readonly ComposerRenderRun[]): readonly ComposerRenderRun[] {
  let end = runs.length
  while (end > 1 && runs[end - 1]!.text.trim() === "") end -= 1
  const last = runs[end - 1]!
  const trimmed = last.text.replace(/\s+$/, "")
  if (trimmed === "") return runs
  if (end === runs.length && trimmed === last.text) return runs
  return [...runs.slice(0, end - 1), { ...last, text: trimmed }]
}

/**
 * Memo boundary: the editor state keeps its reference while the draft
 * revision holds, and every other prop is a snapshot primitive, so
 * unrelated commits skip this subtree.
 */
export const Composer = memo(function Composer({
  editor,
  columns,
  rows: terminalRows,
  prefixRows,
  bodyRows,
  theme,
  completionVisible = false,
  cursorVisible = true,
  indicator = null,
}: {
  readonly editor: TuiEditorState
  readonly columns: number
  readonly rows: number
  /** Number of terminal rows painted before the composer's rule. */
  readonly prefixRows: number
  /** Clamped body-row budget at this width; the kernel windows the draft inside it. */
  readonly bodyRows: number
  readonly theme: ThemeId
  /** The completion token is accented exactly while the picker shows. */
  readonly completionVisible?: boolean
  /** Modal surfaces hide the editor cursor while they own keyboard focus. */
  readonly cursorVisible?: boolean
  /** The scrolled-off position letter while the reader is anchored; rides the rule. */
  readonly indicator?: string | null
}): ReactElement {
  const { setCursorPosition } = useCursor()
  const kernel = editor.kernel
  const geometry = kernel.renderLines(columns, bodyRows)
  const rows = kernel.renderRuns(columns, bodyRows, completionVisible)
  setCursorPosition(
    cursorVisible
      ? {
          x: Math.max(0, Math.min(columns - 1, geometry.caretColumn)),
          y: Math.max(0, Math.min(terminalRows - 1, prefixRows + 1 + geometry.caretRow)),
        }
      : undefined,
  )
  return (
    <Box flexDirection="column">
      {ruleRow(indicator, columns, theme)}
      {rows.map((rowRuns, index) => (
        <Text key={index}>
          {trimTrailingRuns(rowRuns).map((run, runIndex) => (
            <Text key={runIndex} {...runStyle(run, theme)}>
              {run.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
})
