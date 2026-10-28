/**
 * Kernel view root: the React face over the coordinator snapshot,
 * bound with useSyncExternalStore (safe since the kernel caches its
 * frames — snapshot() returns one reference per revision). Pure
 * rendering: no terminal access, no canonical events, and the kernel
 * itself crosses the boundary as types only. The frame has three
 * tiers — the support floor's single diagnostic line, a banded
 * layout between the floor and the kernel's full-column floor that
 * keeps the composer, the footer and one feedback row alive, and the
 * full column — mirroring the kernel's adjudication floor {40,12}
 * as plain numbers rather than facade symbols.
 */
import { useSyncExternalStore } from "react"
import type { ReactElement } from "react"
import { Box, Text } from "ink"
import type { TuiKernel, TuiPlanRow, TuiSnapshot } from "../kernel/index.js"
import {
  SUPPORT_FLOOR,
  appendToolDetailsHint,
  clipText,
  clipTextRuns,
  footerMinimalSegments,
  footerSegments,
  prioritizeFooterSegments,
  graphemes,
  inkRun,
  inkStyle,
  renderCardLines,
  taskCardView,
  taskSurfaceRowHeight,
  textWidth,
  wrapVerbatim,
  wrapFooterSegments,
  type InkTextStyle,
  type TextRun,
  type TextToken,
  type ThemeId,
} from "../text/index.js"
import { CardSurface } from "./card.js"
import { Footer } from "./footer.js"
import { RunLine } from "./runs.js"
import { paintThemeDiffPreview, promptHistoryPreviewPanel, themePreviewPanel } from "./theme-preview.js"
import { Transcript } from "./transcript.js"

const TOO_SMALL_DIAGNOSTIC = `terminal too small: need at least ${SUPPORT_FLOOR.columns}x${SUPPORT_FLOOR.rows}`
const DEGRADED_DIAGNOSTIC = "session degraded: read-only until the host recovers"
const READER_HINT = "↑↓/wheel scroll · PgUp/PgDn page · bottom follows · Esc/Ctrl+O back"
const READER_HINT_COMPACT = "PgUp/Dn · Esc/Ctrl+O back"
const GESTURE_HINTS = {
  exit: "press ctrl+c again to exit",
  "ctrl-d-exit": "press ctrl+d again to exit",
  "escape-clear": "press esc again to clear draft",
  "escape-rewind": "press esc again to rewind",
} as const

/** Resolve the caret cell style without relying on reverse video at end of line. */
export function composerCaretStyle(active: boolean, tailBlock: boolean, theme: ThemeId): InkTextStyle {
  const token: TextToken = active ? (tailBlock ? "text" : "selected") : "muted"
  return inkStyle(token, [], theme)
}

/** The kernel's adjudication floor, mirrored here as numbers so the view binds no facade symbol for it. */
const FULL_COLUMN_FLOOR = { columns: 40, rows: 12 } as const

/**
 * The kernel's decision option window, mirrored here as a plain
 * number for the same reason as the floor: the painted option rows
 * and the kernel's transcript budget must agree without the view
 * binding a facade symbol.
 */
const ASK_OPTION_PREVIEW_ROWS_COMPACT = 1
const ASK_OPTION_PREVIEW_ROWS_WIDE = 2
const APPROVAL_HINT = "↑↓ move · Enter submit · Esc back"

function previewLines(content: string, width: number, maxRows: number): readonly string[] {
  const lines = wrapVerbatim(content, width)
  if (lines.length <= maxRows) return lines
  const visible = [...lines.slice(0, maxRows)]
  const last = visible.length - 1
  visible[last] = clipText(`${visible[last]}…`, width).text
  return visible
}

function approvalSummaryRows(summary: string, columns: number): readonly string[] {
  return summary.length === 0 ? [] : wrapVerbatim(summary, Math.max(1, columns))
}

/**
 * Startup static facts injected by the bootstrap: either prebuilt
 * lines or a width-adaptive builder evaluated at render time so a
 * resize recomputes the layout instead of freezing the first width.
 */
export type TuiIntroSource = readonly (readonly TextRun[])[] | ((width: number) => readonly (readonly TextRun[])[])

export interface TuiKernelRootProps {
  readonly kernel: TuiKernel
  readonly theme: ThemeId
  readonly intro?: TuiIntroSource
}

interface FrameProps {
  readonly snapshot: TuiSnapshot
  readonly columns: number
  readonly rows: number
  readonly theme: ThemeId
}

/**
 * The footer segment row from the snapshot's own facts: telemetry when
 * the host reports it, the minimal pending line otherwise — and the
 * tool-details hint appended to whichever branch ran, mirroring the
 * kernel's own footerTelemetryRuns so the painted rows and the
 * capacity budget cannot disagree.
 */
function footerRuns(footer: TuiSnapshot["footer"], columns: number): readonly TextRun[] {
  const runs = appendToolDetailsHint(
    footer.telemetry === null
      ? footerMinimalSegments(footer.pending)
      : footerSegments({ telemetry: footer.telemetry, pending: footer.pending }),
    footer.toolDetailsHint,
  )
  return prioritizeFooterSegments(runs, columns)
}

/**
 * One-row composer face: the draft split at the caret with the caret
 * cell in reverse video (a full-width block at end of line), windowed
 * so an over-wide draft always keeps the caret visible, and muted
 * while another surface holds the input — the content stays readable
 * even when the keys route elsewhere.
 */
function ComposerInputRow({
  composer,
  runs,
  rowIndex,
  columns,
  theme,
}: {
  readonly composer: TuiSnapshot["composer"]
  readonly runs: readonly TextRun[]
  readonly rowIndex: number
  readonly columns: number
  readonly theme: ThemeId
}): ReactElement {
  const cells: {
    readonly text: string
    readonly token: TextToken
    readonly overlays?: TextRun["overlays"]
    readonly start: number
    readonly end: number
  }[] = []
  let width = 0
  for (const run of runs) {
    for (const cluster of graphemes(run.text)) {
      const clusterWidth = textWidth(cluster)
      cells.push({
        text: cluster,
        token: run.token,
        ...(run.overlays === undefined ? {} : { overlays: run.overlays }),
        start: width,
        end: width + clusterWidth,
      })
      width += clusterWidth
    }
  }

  const caretColumn = rowIndex === composer.inputCaretRow ? composer.inputCaretColumn : -1
  let caretIndex = cells.findIndex((cell) => caretColumn >= cell.start && caretColumn < cell.end)
  let tailBlock = caretColumn >= 0 && caretIndex < 0
  if (tailBlock && width >= Math.max(1, columns)) {
    caretIndex = cells.length - 1
    tailBlock = false
  }

  const group = (from: number, to: number): TextRun[] => {
    const result: TextRun[] = []
    for (let index = from; index < to; index += 1) {
      const cell = cells[index]!
      const previous = result[result.length - 1]
      const sameOverlays =
        previous?.overlays === cell.overlays ||
        (previous?.overlays !== undefined &&
          cell.overlays !== undefined &&
          previous.overlays.length === cell.overlays.length &&
          previous.overlays.every((overlay, offset) => overlay === cell.overlays![offset]))
      if (previous !== undefined && previous.token === cell.token && sameOverlays) {
        result[result.length - 1] = { ...previous, text: previous.text + cell.text }
      } else {
        result.push({ text: cell.text, token: cell.token, ...(cell.overlays === undefined ? {} : { overlays: cell.overlays }) })
      }
    }
    return result
  }
  const before = group(0, caretIndex < 0 ? cells.length : caretIndex)
  const after = group(caretIndex < 0 ? cells.length : caretIndex + 1, cells.length)
  const caretText = tailBlock ? "█" : caretIndex >= 0 ? cells[caretIndex]!.text : " "
  const caretStyle = composerCaretStyle(composer.active, tailBlock, theme)
  const padding = Math.max(0, columns - width - (tailBlock ? textWidth(caretText) : 0))
  const paint = (items: readonly TextRun[], offset: number): ReactElement[] =>
    items.flatMap((run, index) => {
      const visible = composer.active ? run : { ...run, token: "muted" as const, overlays: undefined }
      const bridged = inkRun(visible, theme)
      return bridged === null
        ? []
        : [
            <Text key={`${offset}-${index}`} {...bridged.style}>
              {bridged.text}
            </Text>,
          ]
    })

  return (
    <Text {...inkStyle("inputSurface", [], theme)}>
      {paint(before, 0)}
      {caretIndex >= 0 ? <Text {...caretStyle}>{caretText}</Text> : null}
      {tailBlock ? <Text {...caretStyle}>{caretText}</Text> : null}
      {paint(after, 1)}
      {padding > 0 ? " ".repeat(padding) : null}
    </Text>
  )
}

/**
 * The band's single feedback row: the newest notice wins; without
 * one, the newest pending receipt (mint order is append order), else
 * the newest receipt by mint order alone.
 */
function bandFeedbackRow(snapshot: TuiSnapshot): string | null {
  if (snapshot.notices.length > 0) return `notice · ${snapshot.notices[snapshot.notices.length - 1]!}`
  const receipts = snapshot.receipts
  if (receipts.length === 0) return null
  let pendingIndex = -1
  for (let index = 0; index < receipts.length; index += 1) {
    if (receipts[index]!.status === "pending") pendingIndex = index
  }
  const chosen = receipts[pendingIndex >= 0 ? pendingIndex : receipts.length - 1]!
  return `${chosen.status} · ${chosen.text}`
}

/** The band names the hidden modal owner so the user knows a surface waits above the floor; decisions outrank tasks. */
function bandOwnerRow(snapshot: TuiSnapshot): string | null {
  if (snapshot.decisions.presenting !== null) return "decision open · enlarge terminal"
  if (snapshot.taskFrame !== null) return "task open · enlarge terminal"
  return null
}

function composerVisible(snapshot: TuiSnapshot): boolean {
  return snapshot.composer.visible
}

function BandFrame({ snapshot, columns, rows, theme }: FrameProps): ReactElement {
  const runs = footerRuns(snapshot.footer, columns)
  const footerLines = wrapFooterSegments(runs, columns)
  const showComposer = composerVisible(snapshot)
  const composerRows = showComposer ? snapshot.composer.surfaceRows.length : 0
  const composer = showComposer ? (
    <ComposerSurface composer={snapshot.composer} companion={snapshot.companion} columns={columns} theme={theme} />
  ) : null
  // The footer is a fixed lifeline: it paints in every band geometry,
  // and a modal surface hides the composer stack so its rows return to
  // the ladder. The snapshot ledger is also the exact number of rows
  // the composer paints here.
  const footerRowCount = footerLines.length
  const budget = rows - composerRows - footerRowCount
  let owner = bandOwnerRow(snapshot)
  let feedback = bandFeedbackRow(snapshot)
  let transcriptRows = budget - (feedback !== null ? 1 : 0) - (owner !== null ? 1 : 0)
  if (transcriptRows < 0) {
    owner = null
    transcriptRows = budget - (feedback !== null ? 1 : 0)
  }
  if (transcriptRows < 0) {
    feedback = null
    transcriptRows = budget
  }
  if (transcriptRows < 0) transcriptRows = 0
  const mutedStyle = inkStyle("muted", [], theme)
  return (
    <Box flexDirection="column" height={rows} justifyContent="flex-end">
      {transcriptRows > 0 ? <Transcript lines={snapshot.transcript.lines.slice(-transcriptRows)} start={0} theme={theme} /> : null}
      {feedback !== null ? <Text {...mutedStyle}>{clipText(feedback, columns).text}</Text> : null}
      {owner !== null ? <Text {...mutedStyle}>{clipText(owner, columns).text}</Text> : null}
      {composer}
      <Footer footer={runs} columns={columns} theme={theme} />
    </Box>
  )
}

/**
 * The ask's choice list: the header line carries the pagination
 * marker, then the question, the windowed option rows with their
 * selection markers behind the arm marker, the elision row, and the
 * two actions. The first option is focused as soon as the card opens.
 */
function AskSurface({
  presenting,
  columns,
  theme,
}: {
  readonly presenting: NonNullable<TuiSnapshot["decisions"]["presenting"]>
  readonly columns: number
  readonly theme: ThemeId
}): ReactElement {
  const rows = presenting.surfaceRows ?? []
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => {
        if (row.kind === "other-editor") {
          const clusters = graphemes(row.text)
          const target = Math.max(0, row.caretColumn ?? 0)
          let used = 0
          let split = clusters.length
          let caretText = "█"
          for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
            const next = used + textWidth(clusters[clusterIndex]!)
            if (target < next) {
              split = clusterIndex
              caretText = clusters[clusterIndex]!
              break
            }
            used = next
          }
          return (
            <Text key={`ask-row-${index}`}>
              {split > 0 ? <Text {...inkStyle("text", [], theme)}>{clusters.slice(0, split).join("")}</Text> : null}
              <Text {...composerCaretStyle(true, caretText === "█", theme)}>{caretText}</Text>
              {split < clusters.length ? (
                <Text {...inkStyle("text", [], theme)}>{clusters.slice(split + (caretText === "█" ? 0 : 1)).join("")}</Text>
              ) : null}
            </Text>
          )
        }
        const token =
          row.kind === "question-tabs" ||
          (row.focused &&
            row.enabled !== false &&
            (row.kind === "option" || row.kind === "other" || row.kind === "submit" || row.kind === "chat"))
            ? "suggestion"
            : row.kind === "separator"
              ? "border"
              : row.kind === "question"
                ? "text"
                : row.kind === "option" && row.selected
                  ? "text"
                  : "muted"
        return (
          <Text key={`ask-row-${index}`} {...inkStyle(token, [], theme)}>
            {clipText(row.text, columns).text}
          </Text>
        )
      })}
    </Box>
  )
}

function ApprovalSurface({
  presenting,
  columns,
  theme,
  ctrlDHint,
}: {
  readonly presenting: NonNullable<TuiSnapshot["decisions"]["presenting"]>
  readonly columns: number
  readonly theme: ThemeId
  readonly ctrlDHint: boolean
}): ReactElement {
  const decision = presenting.fact
  if (decision.kind !== "approval") return <Box flexDirection="column" />
  const approval = decision.fact
  const armedIndex = presenting.cursor.armedIndex
  return (
    <Box flexDirection="column">
      <Text {...inkStyle("accent", [], theme)}>
        {clipText(`Approval · ${approval.toolName[0]?.toUpperCase() ?? ""}${approval.toolName.slice(1)}`, columns).text}
      </Text>
      {approvalSummaryRows(approval.summary, columns).map((line, index) => (
        <Text key={`summary-${index}`} {...inkStyle("text", [], theme)}>
          {line}
        </Text>
      ))}
      {approval.options.map((option, index) => {
        const prefix = `${armedIndex === index ? "›" : " "} `
        const rowLimit = columns <= 40 ? ASK_OPTION_PREVIEW_ROWS_COMPACT : ASK_OPTION_PREVIEW_ROWS_WIDE
        return previewLines(option.label, Math.max(1, columns - textWidth(prefix)), rowLimit).map((line, lineIndex) => (
          <Text key={`${option.optionId}-${lineIndex}`} {...inkStyle(armedIndex === index ? "suggestion" : "muted", [], theme)}>
            {lineIndex === 0 ? `${prefix}${line}` : `  ${line}`}
          </Text>
        ))
      })}
      <Text {...inkStyle("muted", [], theme)}>{clipText(ctrlDHint ? GESTURE_HINTS["ctrl-d-exit"] : APPROVAL_HINT, columns).text}</Text>
    </Box>
  )
}

/**
 * The focused child's read-only panel: identity header, the retained
 * ring's window of attributed lines, and a tail hint whose cancel
 * affordance exists only while the child runs on a free stage — the
 * terminal outcome takes its place.
 */
function ChildrenPanelSurface({
  panel,
  snapshot,
  columns,
  budget,
  theme,
}: {
  readonly panel: NonNullable<TuiSnapshot["children"]["panel"]>
  readonly snapshot: TuiSnapshot
  readonly columns: number
  readonly budget: number
  readonly theme: ThemeId
}): ReactElement {
  const header = panel.description === "" ? panel.childSessionId : panel.description
  const tail =
    panel.status === "running" && snapshot.decisions.presenting === null && snapshot.taskFrame === null
      ? "ctrl+c cancel"
      : `${panel.status}${panel.summary !== null ? ` · ${panel.summary}` : ""}`
  const pageMarker = panel.pageCount > 1 ? `page ${panel.page + 1}/${panel.pageCount}` : null
  const rows: ReactElement[] = [
    <Text key="header" {...inkStyle("accent", [], theme)}>
      {clipText(`❮ agent ❯ ${header}`, columns).text}
    </Text>,
  ]
  const body = panel.visibleLines.slice(Math.max(0, panel.visibleLines.length - Math.max(0, budget - 2)))
  for (const [index, line] of body.entries()) {
    rows.push(
      <Text key={`line-${index}`} {...inkStyle("text", [], theme)}>
        {clipText(line, columns).text}
      </Text>,
    )
  }
  const hint = [snapshot.gestureHint?.kind === "ctrl-d-exit" ? GESTURE_HINTS["ctrl-d-exit"] : tail, pageMarker]
    .filter((part): part is string => part !== null)
    .join(" · ")
  rows.push(
    <Text key="hint" {...inkStyle("muted", [], theme)}>
      {clipText(hint, columns).text}
    </Text>,
  )
  return <Box flexDirection="column">{rows}</Box>
}

/**
 * One companion candidate row as styled runs: the focus marker plus the
 * label and short detail, with matched grapheme ranges carrying the
 * match overlay. The ranges are label-grapheme indices, so the split
 * walks clusters, not code units.
 */
function companionRuns(
  candidate: TuiSnapshot["companion"]["candidates"][number],
  focused: boolean,
  columns: number,
  labelColumnWidth: number,
): readonly TextRun[] {
  const token: TextToken = focused ? "suggestion" : "muted"
  const marker: TextRun = { text: focused ? "› " : "  ", token }
  const detailGap = 4
  const markerWidth = textWidth(marker.text)
  const labelBudget = Math.max(1, Math.min(labelColumnWidth, columns - markerWidth - (candidate.detail === undefined ? 0 : detailGap + 1)))
  const detailBudget = Math.max(0, columns - markerWidth - labelBudget - detailGap)
  const detailWidth = candidate.detail === undefined ? 0 : Math.min(textWidth(candidate.detail), 40, detailBudget)
  const labelRuns: TextRun[] = []
  const clusters = graphemes(candidate.label)
  const ranges = candidate.matchRanges ?? []
  let cursor = 0
  for (const range of ranges) {
    const start = Math.max(range.start, cursor)
    const end = Math.min(Math.max(range.end, start), clusters.length)
    if (start >= end) continue
    if (start > cursor) labelRuns.push({ text: clusters.slice(cursor, start).join(""), token })
    labelRuns.push({ text: clusters.slice(start, end).join(""), token, overlays: ["match"] })
    cursor = end
  }
  if (cursor < clusters.length) labelRuns.push({ text: clusters.slice(cursor).join(""), token })
  const visibleLabel = clipTextRuns(labelRuns, labelBudget)
  const runs: TextRun[] = [marker, ...visibleLabel]
  const labelWidth = textWidth(visibleLabel.map((run) => run.text).join(""))
  if (detailWidth > 0) {
    runs.push({ text: " ".repeat(Math.max(detailGap, labelColumnWidth - labelWidth + detailGap)), token })
    runs.push({ text: clipText(candidate.detail!, detailWidth).text, token: "muted" })
  }
  return runs
}

function ComposerSurface({
  composer,
  companion,
  columns,
  theme,
}: {
  readonly composer: TuiSnapshot["composer"]
  readonly companion: TuiSnapshot["companion"]
  readonly columns: number
  readonly theme: ThemeId
}): ReactElement | null {
  if (!composer.visible || composer.surfaceRows.length === 0) return null
  const maxCandidateLabelWidth = companion.candidates.reduce((max, candidate) => Math.max(max, textWidth(candidate.label)), 1)
  const hasCandidateDetails = companion.candidates.some((candidate) => candidate.detail !== undefined)
  const maxLabelWidth = hasCandidateDetails ? Math.min(maxCandidateLabelWidth, Math.max(1, columns - 2 - 4 - 8)) : maxCandidateLabelWidth
  return (
    <Box flexDirection="column">
      {composer.surfaceRows.map((row, index) => {
        if (row.kind === "hint") {
          return (
            <Text key={`composer-${index}`} {...inkStyle(row.token, [], theme)}>
              {row.text}
            </Text>
          )
        }
        if (row.kind === "gap") {
          return <Text key={`composer-${index}`}> </Text>
        }
        if (row.kind === "input") {
          return (
            <ComposerInputRow
              key={`composer-${index}`}
              composer={composer}
              runs={composer.inputRows[row.index] ?? []}
              rowIndex={row.index}
              columns={columns}
              theme={theme}
            />
          )
        }
        const candidate = companion.candidates[row.index]
        if (candidate === undefined) return <Text key={`composer-${index}`}> </Text>
        return (
          <RunLine
            key={`composer-${index}`}
            runs={clipTextRuns(companionRuns(candidate, row.index === companion.focusIndex, columns, maxLabelWidth), columns)}
            theme={theme}
          />
        )
      })}
    </Box>
  )
}

function taskSurface(
  frame: NonNullable<TuiSnapshot["taskFrame"]>,
  columns: number,
  maxRows: number,
  theme: ThemeId,
  ctrlDHint: boolean,
): { node: ReactElement; rows: number } {
  const splitKind = frame.title === "Theme" ? columns >= 80 : frame.title === "Prompt history" && columns >= 100
  const rowCount = taskSurfaceRowHeight(frame, columns, maxRows)
  const taskHints = frame.hints
  const visibleFrame =
    taskHints.length > 0 && ctrlDHint ? { ...frame, hints: [...taskHints.slice(0, -1), GESTURE_HINTS["ctrl-d-exit"]] } : frame
  if (splitKind === false) {
    const lines = renderCardLines(
      taskCardView(
        {
          ...visibleFrame,
          tabs: visibleFrame.tabs,
        },
        columns,
      ),
      { maxRows: rowCount },
    )
    return {
      node: <CardSurface lines={frame.title === "Theme" ? paintThemeDiffPreview(lines, frame.body) : lines} theme={theme} />,
      rows: lines.length,
    }
  }

  const leftWidth = Math.floor((columns - 3) * 0.48)
  const rightWidth = columns - leftWidth - 3
  const listLines = renderCardLines(
    taskCardView(
      {
        ...visibleFrame,
        body: [],
        tabs: visibleFrame.tabs,
      },
      leftWidth,
    ),
    { maxRows: rowCount },
  )
  const rightLines =
    frame.title === "Theme"
      ? themePreviewPanel(frame.body, rightWidth, rowCount)
      : promptHistoryPreviewPanel(frame.body, rightWidth, rowCount)
  const separator = Array.from({ length: rowCount }, (_, index) => (
    <Text key={`separator-${index}`} {...inkStyle("border", [], theme)}>
      {" "}
      │
    </Text>
  ))
  return {
    node: (
      <Box flexDirection="row">
        <Box width={leftWidth} flexDirection="column">
          <CardSurface lines={listLines} theme={theme} />
        </Box>
        <Box width={3} flexDirection="column">
          {separator}
        </Box>
        <Box width={rightWidth} flexDirection="column">
          <CardSurface lines={rightLines} theme={theme} />
        </Box>
      </Box>
    ),
    rows: rowCount,
  }
}

function FullFrame({ snapshot, columns, rows, theme, intro }: FrameProps & { readonly intro: TuiIntroSource | null }): ReactElement {
  if (snapshot.degraded) {
    return <Text {...inkStyle("muted", [], theme)}>{DEGRADED_DIAGNOSTIC}</Text>
  }
  const transcript = snapshot.transcript
  if (transcript.readerOpen) {
    const hint = columns <= 40 ? READER_HINT_COMPACT : READER_HINT
    const pageRow =
      snapshot.gestureHint?.kind === "ctrl-d-exit"
        ? `${GESTURE_HINTS["ctrl-d-exit"]} · page ${transcript.readerPage}/${transcript.readerPages}`
        : `page ${transcript.readerPage}/${transcript.readerPages} · ${hint}`
    const window = Math.max(0, rows - 2)
    const readerRuns = transcript.readerRuns.slice(0, window)
    return (
      <Box flexDirection="column">
        <Text {...inkStyle("accent", [], theme)}>{clipText("Detailed transcript", columns).text}</Text>
        {window > 0
          ? Array.from({ length: window }, (_, index) => {
              return <RunLine key={`reader-${index}`} runs={readerRuns[index] ?? []} theme={theme} />
            })
          : null}
        <Text {...inkStyle("muted", [], theme)}>{clipText(pageRow, columns).text}</Text>
      </Box>
    )
  }
  const runs = footerRuns(snapshot.footer, columns)
  const footerLines = wrapFooterSegments(runs, columns)
  const showComposer = composerVisible(snapshot)
  const chrome: ReactElement[] = []
  const belowComposer: ReactElement[] = []
  const frame = snapshot.taskFrame
  const taskPlacement = frame === null ? null : showComposer ? belowComposer : chrome
  let taskInsertionIndex = 0
  let fixedRows = 0
  const pushRow = (node: ReactElement, count: number): void => {
    chrome.push(node)
    fixedRows += count
  }
  const mutedRow = (text: string, key: string): ReactElement => (
    <Text key={key} {...inkStyle("muted", [], theme)}>
      {clipText(text, columns).text}
    </Text>
  )
  for (const [index, task] of snapshot.pausedTasks.entries()) pushRow(mutedRow(`paused · ${task.title}`, `paused-${index}`), 1)
  for (const [index, notice] of snapshot.notices.entries()) pushRow(mutedRow(notice, `notice-${index}`), 1)
  // The gutter reports in-flight submissions only; settled receipts are
  // transcript history already, so rendering them here would duplicate rows
  // and grow the gutter without bound.
  let pendingReceipts = 0
  for (const receipt of snapshot.receipts) {
    if (receipt.status !== "pending") continue
    pushRow(mutedRow(`pending · ${receipt.text}`, `receipt-${pendingReceipts}`), 1)
    pendingReceipts += 1
  }
  if (taskPlacement === chrome) taskInsertionIndex = chrome.length
  const presenting = snapshot.decisions.presenting
  if (presenting !== null) {
    // The ask surfaces its windowed options plus the elision row and
    // terminal actions from the kernel-owned row ledger; the approval
    // surface is the two-row action pair.
    if (presenting.fact.kind === "ask") {
      const askRows = presenting.surfaceRows?.length ?? 0
      pushRow(<AskSurface key="decision" presenting={presenting} columns={columns} theme={theme} />, askRows)
    } else {
      const approvalOptionRows = presenting.fact.fact.options.reduce((count, option, index) => {
        const prefix = `${presenting.cursor.armedIndex === index ? "›" : " "} `
        const rowLimit = columns <= 40 ? ASK_OPTION_PREVIEW_ROWS_COMPACT : ASK_OPTION_PREVIEW_ROWS_WIDE
        return count + previewLines(option.label, Math.max(1, columns - textWidth(prefix)), rowLimit).length
      }, 0)
      pushRow(
        <ApprovalSurface
          key="decision"
          presenting={presenting}
          columns={columns}
          theme={theme}
          ctrlDHint={snapshot.gestureHint?.kind === "ctrl-d-exit"}
        />,
        1 + approvalSummaryRows(presenting.fact.fact.summary, columns).length + approvalOptionRows + 1,
      )
    }
  }
  if (snapshot.decisions.hiddenPending.length > 0)
    pushRow(mutedRow(`+${snapshot.decisions.hiddenPending.length} other pending requests`, "hidden-pending"), 1)
  if (snapshot.decisions.resolving.length > 0)
    pushRow(mutedRow(`${snapshot.decisions.resolving.length} resolving · awaiting confirmation`, "resolving"), 1)
  if (snapshot.decisions.unknown.length > 0)
    pushRow(mutedRow(`${snapshot.decisions.unknown.length} status unknown · outcome unconfirmed`, "unknown"), 1)
  if (snapshot.runSlot.runId !== null) {
    pushRow(
      <Text key="run" {...inkStyle("accent", [], theme)}>
        {clipText(`run · ${snapshot.runSlot.runId}`, columns).text}
      </Text>,
      1,
    )
  }
  // Plan chrome is standing state outside the queue budget: one row
  // per plan in first-appearance order, the latest fact already
  // overwrote its row in place, and the view only formats the text.
  const planRowText = (row: TuiPlanRow): string =>
    row.title === undefined
      ? `Plan: ${row.completedSteps}/${row.totalSteps} steps · ${row.status}`
      : `Plan: ${row.title} — ${row.completedSteps}/${row.totalSteps} steps · ${row.status}`
  snapshot.plans.forEach((row, index) => pushRow(mutedRow(planRowText(row), `plan-${index}`), 1))
  // The parked-input preview supersedes any raw count: the rows are the
  // queue, in acceptance order, bounded by the same derivation that
  // budgeted them.
  snapshot.queue.visible.forEach((row, index) => pushRow(mutedRow(row, `queue-${index}`), 1))
  if (snapshot.queue.elided > 0) pushRow(mutedRow(`… +${snapshot.queue.elided} more queued`, "queue-elided"), 1)
  if (snapshot.children.summaryRow !== null) pushRow(mutedRow(snapshot.children.summaryRow, "children-summary"), 1)
  // The intro replaces the transcript slot while no transcript line
  // exists. The composer surface carries its own stable hint and rails.
  const introLines = transcript.lines.length === 0 && intro !== null ? (typeof intro === "function" ? intro(columns) : intro) : null
  if (showComposer)
    pushRow(
      <ComposerSurface key="composer" composer={snapshot.composer} companion={snapshot.companion} columns={columns} theme={theme} />,
      snapshot.composer.surfaceRows.length,
    )
  const footerNode = <Footer key="footer" footer={runs} columns={columns} theme={theme} />
  const footerRowCount = footerLines.length
  // The footer is a fixed lifeline like in the band: a modal surface
  // hides the composer stack, never the footer.
  fixedRows += footerRowCount
  if (frame !== null && taskPlacement !== null) {
    const surface = taskSurface(frame, columns, Math.max(0, rows - fixedRows), theme, snapshot.gestureHint?.kind === "ctrl-d-exit")
    fixedRows += surface.rows
    taskPlacement.splice(taskInsertionIndex, 0, <Box key="task-frame">{surface.node}</Box>)
  }
  const budget = Math.max(0, rows - fixedRows)
  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="column" height={budget}>
        {snapshot.children.panel !== null ? (
          <ChildrenPanelSurface panel={snapshot.children.panel} snapshot={snapshot} columns={columns} budget={budget} theme={theme} />
        ) : introLines === null ? (
          budget > 0 ? (
            <Transcript
              lines={transcript.visible.length > 0 ? transcript.visible : transcript.lines.slice(-budget)}
              start={0}
              theme={theme}
            />
          ) : null
        ) : (
          <Box flexDirection="column">
            {introLines.slice(0, budget).map((line, index) => (
              <RunLine key={index} runs={clipTextRuns(line, columns)} theme={theme} />
            ))}
          </Box>
        )}
      </Box>
      {chrome}
      {belowComposer}
      {footerNode}
    </Box>
  )
}

export function TuiKernelRoot({ kernel, theme, intro }: TuiKernelRootProps): ReactElement {
  // The subscription stays unconditional so a resize crossing a tier
  // boundary mid-session never reorders hooks.
  const snapshot = useSyncExternalStore(kernel.subscribe, kernel.snapshot)
  const { columns, rows } = snapshot.layout
  if (columns < SUPPORT_FLOOR.columns || rows < SUPPORT_FLOOR.rows) {
    return <Text {...inkStyle("muted", [], theme)}>{TOO_SMALL_DIAGNOSTIC}</Text>
  }
  if (columns < FULL_COLUMN_FLOOR.columns || rows < FULL_COLUMN_FLOOR.rows) {
    return <BandFrame snapshot={snapshot} columns={columns} rows={rows} theme={theme} />
  }
  return <FullFrame snapshot={snapshot} columns={columns} rows={rows} theme={theme} intro={intro ?? null} />
}
