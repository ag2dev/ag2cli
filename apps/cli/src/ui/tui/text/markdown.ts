/**
 * Bounded terminal markdown renderer: the legacy line grammar ported into
 * the token model. Text only — no HTML, images, or hyperlinks; raw escape
 * sequences are stripped at ingress so layout measures what the terminal
 * shows, and the Ink style bridge stays the enforcement point for every
 * run reaching output. Structural styles map onto the closed token
 * vocabulary: emphasis is accent, code spans are warning, strikethrough
 * is muted, rules and quote bars are border, and bold rides the focus
 * overlay, which contributes only bold in every theme.
 */
import type { TextOverlay, TextRun, TextToken } from "./theme.js"
import { expandTabs, graphemeSegmenter, graphemeWidth, graphemes, textWidth } from "./measure.js"
import { sanitizeText } from "./sanitize.js"

/**
 * Snapshot lifecycle of the text being rendered: streaming keeps partial
 * structure raw (table layout lands with the final phase), final lays out
 * the settled document. The phase describes the current snapshot only —
 * it carries no run, event, or renderer identity.
 */
export type MarkdownRenderPhase = "streaming" | "final"

export interface MarkdownRunsOptions {
  readonly width: number
  readonly phase: MarkdownRenderPhase
  readonly codeIndent?: string
}

/** A bounded window from the markdown renderer, plus exact source metrics. */
export interface MarkdownRunsRange {
  readonly lines: readonly RunLine[]
  readonly lineCount: number
  readonly trailingBlankLines: number
  readonly lastTextLine: number
}

type RunLine = readonly TextRun[]

interface InlineStyle {
  /** Absent on attribute-only styles (strong): inherit the enclosing token. */
  readonly token?: TextToken
  readonly overlays?: readonly TextOverlay[]
}

const FOCUS: readonly TextOverlay[] = ["focus"]
const BASE: InlineStyle = { token: "text" }
const PLACEHOLDER_START = "\uE000"
const PLACEHOLDER_END = "\uE001"
// Marker machinery code points; stripped from input so literal private-use
// characters in content can never collide with generated markers.
const MARKER_CHARS = /[\uE000-\uE004]/g

function runOf(text: string, style: InlineStyle): TextRun {
  // Parse-time styles are concrete (the stack seeds from a base style and
  // merges never drop a token); the fallback only satisfies the compiler.
  return { text, token: style.token ?? "text", ...(style.overlays === undefined ? {} : { overlays: style.overlays }) }
}

/** Strong is attribute-only: bold rides the focus overlay, color inherits. */
function strongStyle(): InlineStyle {
  return { overlays: FOCUS }
}

/**
 * Overlay equality by value: inline styles mint a fresh overlays array
 * per merged span, so adjacent runs of the same span stack arrive with
 * equal-but-distinct references — the coalescing in wrapRuns must see
 * them as one style.
 */
function overlaysEqual(left: readonly TextOverlay[] | undefined, right: readonly TextOverlay[] | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return left.length === right.length && left.every((overlay, index) => overlay === right[index])
}

/**
 * Grapheme-precise hard wrap over styled runs: break only when the next
 * visible cluster exceeds the cell budget (an over-wide cluster at column
 * zero is emitted), continuation lines carry their own tokens, and an
 * exact fit never emits a trailing empty line.
 */
function wrapRuns(runs: readonly TextRun[], width: number): readonly RunLine[] {
  const bounded = Math.max(1, Math.floor(width))
  const lines: TextRun[][] = []
  let current: TextRun[] = []
  let used = 0
  let hasText = false
  for (const run of runs) {
    for (const cluster of graphemes(run.text)) {
      const clusterWidth = graphemeWidth(cluster)
      if (used > 0 && clusterWidth > 0 && used + clusterWidth > bounded) {
        lines.push(current)
        current = []
        used = 0
        hasText = false
      }
      const last = current[current.length - 1]
      if (last !== undefined && last.token === run.token && overlaysEqual(last.overlays, run.overlays)) {
        current[current.length - 1] = { ...last, text: `${last.text}${cluster}` }
      } else {
        current.push({ text: cluster, token: run.token, ...(run.overlays === undefined ? {} : { overlays: run.overlays }) })
      }
      used += clusterWidth
      hasText = true
    }
  }
  if (lines.length === 0 || hasText) lines.push(current)
  return lines
}

function isBlankRunLine(line: RunLine): boolean {
  return line.every((run) => run.text.trim().length === 0 && (run.overlays ?? []).length === 0)
}

function hasVisibleText(line: RunLine): boolean {
  return line.some((run) => run.text.trim().length > 0)
}

/** Wrap styled text in one grapheme pass, retaining only the requested rows. */
function wrapRunsWindow(runs: readonly TextRun[], width: number, start: number, count: number): MarkdownRunsRange {
  const bounded = Math.max(1, Math.floor(width))
  const from = Math.max(0, Math.floor(start))
  const end = from + Math.max(0, Math.floor(count))
  const lines: RunLine[] = []
  let lineCount = 0
  let trailingBlankLines = 0
  let lastTextLine = -1
  let current: TextRun[] = []
  let used = 0
  let hasText = false
  const emit = (): void => {
    if (lineCount >= from && lineCount < end) lines.push(current)
    if (isBlankRunLine(current)) trailingBlankLines += 1
    else trailingBlankLines = 0
    if (hasVisibleText(current)) lastTextLine = lineCount
    lineCount += 1
    current = []
    used = 0
    hasText = false
  }
  for (const run of runs) {
    for (const cluster of graphemeSegmenter.segment(run.text)) {
      const value = cluster.segment
      const clusterWidth = graphemeWidth(value)
      if (used > 0 && clusterWidth > 0 && used + clusterWidth > bounded) emit()
      const last = current[current.length - 1]
      if (last !== undefined && last.token === run.token && overlaysEqual(last.overlays, run.overlays)) {
        current[current.length - 1] = { ...last, text: `${last.text}${value}` }
      } else {
        current.push({ text: value, token: run.token, ...(run.overlays === undefined ? {} : { overlays: run.overlays }) })
      }
      used += clusterWidth
      hasText = true
    }
  }
  if (lineCount === 0 || hasText) emit()
  return { lines, lineCount, trailingBlankLines, lastTextLine }
}

/**
 * Inline rules in the legacy order: code spans protect first and fully (an
 * underscore inside `read_file` must not pair with a later one); the
 * remaining rules wrap their content in span markers instead of removing
 * it, so later rules still apply inside earlier matches (`**~~x~~**`
 * renders muted bold). A final stack parse turns markers into runs with
 * cleanly nested styles: attributes accumulate, an inner span's token
 * overrides, and a code span inside a span merges both.
 */
const SPAN_OPEN = "\uE002"
const SPAN_OPEN_END = "\uE003"
const SPAN_CLOSE = "\uE004"

function mergeStyles(outer: InlineStyle, inner: InlineStyle): InlineStyle {
  const overlays = [...new Set([...(outer.overlays ?? []), ...(inner.overlays ?? [])])]
  return { token: inner.token ?? outer.token, ...(overlays.length === 0 ? {} : { overlays }) }
}

/**
 * Stack parse of the marker string: span-open pushes its style merged over
 * the enclosing one, span-close pops, and code placeholders resolve with
 * both styles merged. Plain segments take the top of the stack.
 */
function parseInline(
  text: string,
  stack: readonly InlineStyle[],
  spans: readonly InlineStyle[],
  codes: readonly { readonly text: string; readonly style: InlineStyle }[],
): readonly TextRun[] {
  const frames: InlineStyle[] = [...stack]
  const runs: TextRun[] = []
  const pattern = /\uE000(\d+)\uE001|\uE002(\d+)\uE003|\uE004/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const top = frames[frames.length - 1] ?? BASE
    if (match.index > cursor) runs.push(runOf(text.slice(cursor, match.index), top))
    cursor = match.index + match[0].length
    if (match[1] !== undefined) {
      const record = codes[Number(match[1])]
      if (record !== undefined) runs.push(runOf(record.text, mergeStyles(top, record.style)))
      continue
    }
    if (match[2] !== undefined) {
      frames.push(mergeStyles(top, spans[Number(match[2])] ?? top))
      continue
    }
    if (frames.length > 1) frames.pop()
  }
  const top = frames[frames.length - 1] ?? BASE
  if (cursor < text.length) runs.push(runOf(text.slice(cursor), top))
  return runs
}

function renderInline(value: string, base: InlineStyle): readonly TextRun[] {
  const codes: { readonly text: string; readonly style: InlineStyle }[] = []
  const code = (content: string): string => {
    const index = codes.length
    codes.push({ text: content, style: { token: "warning" } })
    return `${PLACEHOLDER_START}${index}${PLACEHOLDER_END}`
  }
  const spans: InlineStyle[] = []
  const span = (content: string, style: InlineStyle): string => {
    const index = spans.length
    spans.push(style)
    return `${SPAN_OPEN}${index}${SPAN_OPEN_END}${content}${SPAN_CLOSE}`
  }
  let result = value
  result = result.replace(/`([^`\n]+)`/g, (_match: string, content: string) => code(content))
  result = result.replace(/\*\*([^*\n]+)\*\*/g, (_match: string, content: string) => span(content, strongStyle()))
  result = result.replace(/(?<![\p{L}\p{N}_])__([^_\n]+)__(?![\p{L}\p{N}_])/gu, (_match: string, content: string) =>
    span(content, strongStyle()),
  )
  result = result.replace(/~~([^~\n]+)~~/g, (_match: string, content: string) => span(content, { token: "muted" }))
  result = result.replace(/\*([^*\n]+)\*/g, (_match: string, content: string) => span(content, { token: "accent" }))
  result = result.replace(/(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, (_match: string, content: string) =>
    span(content, { token: "accent" }),
  )
  result = result.replace(/\[([^\]\n]+)\]\([^\s)]+\)/g, "$1")
  return parseInline(result, [base], spans, codes)
}

/** Column alignment declared by the delimiter row. */
type TableAlignment = "left" | "center" | "right"

interface TableScan {
  readonly alignments: readonly TableAlignment[]
  readonly header: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

interface TableSourceScan {
  readonly alignments: readonly TableAlignment[]
  readonly header: readonly string[]
  readonly dataStart: number
  readonly end: number
  readonly rowCount: number
}

interface SourceLine {
  readonly text: string
  readonly next: number
}

function sourceLineAt(source: string, start: number): SourceLine | null {
  if (start > source.length) return null
  const newline = source.indexOf("\n", start)
  return newline === -1 ? { text: source.slice(start), next: source.length + 1 } : { text: source.slice(start, newline), next: newline + 1 }
}

/**
 * Split one source line on pipe delimiters. Only unescaped pipes outside
 * code spans split; escaped `\|` stays a literal pipe in the cell text.
 * Optional outer pipes drop their empty edge cells. Returns null when the
 * line carries no unescaped pipe at all.
 */
function splitPipeCells(rawLine: string): readonly string[] | null {
  // CRLF tails must not forge a phantom trailing cell; interior content is
  // untouched so non-table semantics never shift.
  const line = rawLine.replace(/\r+$/u, "")
  const cells: string[] = []
  let current = ""
  let inCode = false
  let hasPipe = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (character === "`") {
      inCode = !inCode
      current += character
      continue
    }
    // Inside a code span everything is literal: `\|` keeps its backslash
    // (GFM keeps backslashes in code) and pipes never split.
    if (inCode) {
      current += character
      continue
    }
    if (character === "\\" && line[index + 1] === "|") {
      current += "|"
      index += 1
      continue
    }
    if (character === "|") {
      hasPipe = true
      cells.push(current)
      current = ""
      continue
    }
    current += character
  }
  cells.push(current)
  if (!hasPipe) return null
  // An outer pipe is one preceded (or followed) by whitespace only; blank
  // edge cells from outer pipes drop, blank edge cells from content do not.
  if (cells[0]!.trim() === "" && line.slice(0, line.indexOf("|")).trim() === "") cells.shift()
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === "" && line.lastIndexOf("|") === line.length - 1) cells.pop()
  return cells.map((cell) => cell.trim())
}

/** Delimiter cells `:-:`, `:-`, `-:`, `-` map to alignments; else null. */
function parseDelimiterRow(cells: readonly string[]): readonly TableAlignment[] | null {
  const alignments: TableAlignment[] = []
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")
    if (left && right) alignments.push("center")
    else if (right) alignments.push("right")
    else alignments.push("left")
  }
  return alignments
}

/**
 * Detect a table starting at startIndex: a header row of cells followed by
 * a delimiter row with a matching column count. Data rows continue while
 * lines are non-blank and pipe-bearing; a row with more cells than the
 * header voids the whole table (raw fallback) rather than losing cells.
 */
function scanTable(sourceLines: readonly string[], startIndex: number): TableScan | null {
  const header = splitPipeCells(sourceLines[startIndex]!)
  if (header === null || header.length === 0 || startIndex + 1 >= sourceLines.length) return null
  const delimiter = splitPipeCells(sourceLines[startIndex + 1]!)
  if (delimiter === null) return null
  const alignments = parseDelimiterRow(delimiter)
  if (alignments === null || alignments.length !== header.length) return null
  const rows: string[][] = []
  for (let index = startIndex + 2; index < sourceLines.length; index += 1) {
    const line = sourceLines[index]!
    if (line.trim().length === 0) break
    const cells = splitPipeCells(line)
    if (cells === null) break
    if (cells.length > header.length) return null
    const padded = [...cells]
    while (padded.length < header.length) padded.push("")
    rows.push(padded)
  }
  return { alignments, header, rows }
}

/** Validate a table by scanning source line offsets without retaining every split cell. */
function scanTableSource(source: string, start: number): TableSourceScan | null {
  const headerLine = sourceLineAt(source, start)
  if (headerLine === null) return null
  const header = splitPipeCells(headerLine.text)
  if (header === null || header.length === 0) return null
  const delimiterLine = sourceLineAt(source, headerLine.next)
  if (delimiterLine === null) return null
  const delimiter = splitPipeCells(delimiterLine.text)
  if (delimiter === null) return null
  const alignments = parseDelimiterRow(delimiter)
  if (alignments === null || alignments.length !== header.length) return null
  const dataStart = delimiterLine.next
  let cursor = dataStart
  let rowCount = 0
  for (;;) {
    const line = sourceLineAt(source, cursor)
    if (line === null || line.text.trim().length === 0) break
    const cells = splitPipeCells(line.text)
    if (cells === null) break
    if (cells.length > header.length) return null
    rowCount += 1
    cursor = line.next
  }
  return { alignments, header, dataStart, end: cursor, rowCount }
}

/**
 * Deterministic allocation: shrink the widest shrinkable column by one
 * until the row fits. A column never shrinks below its widest single
 * grapheme — wrapRuns must emit an over-wide grapheme rather than drop
 * it, so a narrower column would push the box past the cell budget.
 */
function allocateColumnWidths(ideal: readonly number[], minimums: readonly number[], budget: number): readonly number[] | null {
  const widths = ideal.map((value, index) => Math.max(value, minimums[index] ?? 1))
  let deficit = widths.reduce((sum, value) => sum + value, 0) - budget
  while (deficit > 0) {
    let target = -1
    for (let index = 0; index < widths.length; index += 1) {
      const width = widths[index] ?? 0
      if (width > (minimums[index] ?? 1) && width > target) target = width
    }
    if (target <= 0) return null
    for (let index = 0; index < widths.length; index += 1) {
      const width = widths[index] ?? 0
      if (width === target && width > (minimums[index] ?? 1)) {
        widths[index] = target - 1
        deficit -= 1
        break
      }
    }
  }
  return widths
}

/** Widest single grapheme in rendered text: the wrap floor for a column. */
function widestGrapheme(runs: readonly TextRun[]): number {
  let widest = 1
  for (const run of runs) {
    for (const cluster of graphemeSegmenter.segment(run.text)) {
      const width = graphemeWidth(cluster.segment)
      if (width > widest) widest = width
    }
  }
  return widest
}

/** Render a scanned table as box rows; null when the width cannot host it. */
function renderTable(scan: TableScan, width: number): readonly RunLine[] | null {
  const columns = scan.alignments.length
  const budget = width - (columns + 1 + 2 * columns)
  if (budget < columns) return null
  const headerBase: InlineStyle = { token: "text", overlays: FOCUS }
  // Measure rendered cell text (emphasis markers drop) once per cell; the
  // totals seed ideal widths and the widest grapheme sets the shrink floor.
  const rendered = [scan.header, ...scan.rows].map((row) => row.map((cell) => renderInline(cell, row === scan.header ? headerBase : BASE)))
  const widthOf = (runs: readonly TextRun[]): number => runs.reduce((sum, run) => sum + textWidth(run.text), 0)
  const ideal = Array.from({ length: columns }, (_unused, column) => Math.max(1, ...rendered.map((row) => widthOf(row[column] ?? []))))
  const minimums = Array.from({ length: columns }, (_unused, column) =>
    Math.max(1, ...rendered.map((row) => widestGrapheme(row[column] ?? []))),
  )
  const columnWidths = allocateColumnWidths(ideal, minimums, budget)
  if (columnWidths === null) return null
  const cellLines = rendered.map((row) => row.map((runs, column) => wrapRuns(runs, Math.max(1, columnWidths[column] ?? 1))))
  const align = (column: number, runs: readonly TextRun[]): readonly TextRun[] => {
    const used = runs.reduce((sum, run) => sum + textWidth(run.text), 0)
    const slack = columnWidths[column]! - used
    if (slack <= 0) return runs
    const alignment = scan.alignments[column]!
    const left = alignment === "right" ? slack : alignment === "center" ? Math.floor(slack / 2) : 0
    const right = slack - left
    const padded: TextRun[] = []
    if (left > 0) padded.push({ text: " ".repeat(left), token: "text" })
    padded.push(...runs)
    if (right > 0) padded.push({ text: " ".repeat(right), token: "text" })
    return padded
  }
  const borderRow = (left: string, middle: string, right: string): RunLine => [
    {
      text:
        columnWidths
          .map((columnWidth) => "─".repeat(columnWidth + 2))
          .reduce((joined, segment, index) => joined + (index === 0 ? left : middle) + segment, "") + right,
      token: "border",
    },
  ]
  const bodyRow = (rowIndex: number, line: number): RunLine => {
    const parts: TextRun[] = []
    for (let column = 0; column < columns; column += 1) {
      parts.push({ text: column === 0 ? "│ " : " │ ", token: "border" })
      parts.push(...align(column, cellLines[rowIndex]![column]![line] ?? []))
    }
    parts.push({ text: " │", token: "border" })
    return parts
  }
  const rows: RunLine[] = [borderRow("┌", "┬", "┐")]
  const headerHeight = Math.max(1, ...cellLines[0]!.map((cell) => cell.length))
  for (let line = 0; line < headerHeight; line += 1) rows.push(bodyRow(0, line))
  if (scan.rows.length > 0) rows.push(borderRow("├", "┼", "┤"))
  for (let rowIndex = 1; rowIndex < cellLines.length; rowIndex += 1) {
    const rowHeight = Math.max(1, ...cellLines[rowIndex]!.map((cell) => cell.length))
    for (let line = 0; line < rowHeight; line += 1) rows.push(bodyRow(rowIndex, line))
  }
  rows.push(borderRow("└", "┴", "┘"))
  return rows
}

/** Render a table window without retaining all of its wrapped output rows. */
function* sourceTableRows(source: string, scan: TableSourceScan): Iterable<readonly string[]> {
  yield scan.header
  let cursor = scan.dataStart
  for (let rowIndex = 0; rowIndex < scan.rowCount; rowIndex += 1) {
    const line = sourceLineAt(source, cursor)
    if (line === null) return
    const cells = [...(splitPipeCells(line.text) ?? [])]
    while (cells.length < scan.header.length) cells.push("")
    yield cells
    cursor = line.next
  }
}

/** Render a source table window without retaining split cells for hidden rows. */
function renderTableSourceWindow(
  source: string,
  scan: TableSourceScan,
  width: number,
  start: number,
  count: number,
): MarkdownRunsRange | null {
  const columns = scan.alignments.length
  const budget = width - (columns + 1 + 2 * columns)
  if (budget < columns) return null
  const headerBase: InlineStyle = { token: "text", overlays: FOCUS }
  const ideal = Array.from({ length: columns }, () => 1)
  const minimums = Array.from({ length: columns }, () => 1)
  let measuredRowIndex = 0
  for (const raw of sourceTableRows(source, scan)) {
    const base = measuredRowIndex === 0 ? headerBase : BASE
    for (let column = 0; column < columns; column += 1) {
      const rendered = renderInline(raw[column] ?? "", base)
      const measuredWidth = rendered.reduce((sum, run) => sum + textWidth(run.text), 0)
      ideal[column] = Math.max(ideal[column] ?? 1, measuredWidth)
      minimums[column] = Math.max(minimums[column] ?? 1, widestGrapheme(rendered))
    }
    measuredRowIndex += 1
  }
  const columnWidths = allocateColumnWidths(ideal, minimums, budget)
  if (columnWidths === null) return null

  const from = Math.max(0, Math.floor(start))
  const end = from + Math.max(0, Math.floor(count))
  const lines: RunLine[] = []
  let lineCount = 0
  const emit = (row: RunLine): void => {
    if (lineCount >= from && lineCount < end) lines.push(row)
    if (isBlankRunLine(row)) trailingBlankLines += 1
    else trailingBlankLines = 0
    if (hasVisibleText(row)) lastTextLine = lineCount
    lineCount += 1
  }
  let trailingBlankLines = 0
  let lastTextLine = -1
  const borderRow = (left: string, middle: string, right: string): RunLine => [
    {
      text:
        columnWidths
          .map((columnWidth) => "─".repeat(columnWidth + 2))
          .reduce((joined, segment, index) => joined + (index === 0 ? left : middle) + segment, "") + right,
      token: "border",
    },
  ]
  const align = (column: number, runs: readonly TextRun[]): readonly TextRun[] => {
    const used = runs.reduce((sum, run) => sum + textWidth(run.text), 0)
    const slack = columnWidths[column]! - used
    if (slack <= 0) return runs
    const alignment = scan.alignments[column]!
    const left = alignment === "right" ? slack : alignment === "center" ? Math.floor(slack / 2) : 0
    const right = slack - left
    const padded: TextRun[] = []
    if (left > 0) padded.push({ text: " ".repeat(left), token: "text" })
    padded.push(...runs)
    if (right > 0) padded.push({ text: " ".repeat(right), token: "text" })
    return padded
  }
  const appendTableRow = (raw: readonly string[], rowIndex: number): void => {
    const base = rowIndex === 0 ? headerBase : BASE
    const cells = raw.map((cell) => renderInline(cell, base))
    const cellHeights = cells.map((cell, column) => wrapRunsWindow(cell, Math.max(1, columnWidths[column] ?? 1), 0, 0).lineCount)
    const height = Math.max(1, ...cellHeights)
    const rowStart = lineCount
    const localStart = Math.min(height, Math.max(0, from - rowStart))
    const localEnd = Math.max(localStart, Math.min(height, end - rowStart))
    const visibleCount = Math.max(0, localEnd - localStart)
    lineCount += localStart
    if (localEnd > localStart) {
      const visibleCells = cells.map(
        (cell, column) => wrapRunsWindow(cell, Math.max(1, columnWidths[column] ?? 1), localStart, visibleCount).lines,
      )
      for (let line = localStart; line < localEnd; line += 1) {
        const parts: TextRun[] = []
        for (let column = 0; column < columns; column += 1) {
          parts.push({ text: column === 0 ? "│ " : " │ ", token: "border" })
          parts.push(...align(column, visibleCells[column]![line - localStart] ?? []))
        }
        parts.push({ text: " │", token: "border" })
        emit(parts)
      }
    }
    // The selected rows were counted by emit; skipped rows still advance the index.
    lineCount += height - localEnd
  }

  emit(borderRow("┌", "┬", "┐"))
  let rowIndex = 0
  for (const raw of sourceTableRows(source, scan)) {
    if (rowIndex === 1) emit(borderRow("├", "┼", "┤"))
    appendTableRow(raw, rowIndex)
    rowIndex += 1
  }
  emit(borderRow("└", "┴", "┘"))
  lastTextLine = lineCount - 1
  return { lines, lineCount, trailingBlankLines, lastTextLine }
}

/** Render markdown into styled run lines at a cell width. */
export function renderMarkdownRuns(markdown: string, options: MarkdownRunsOptions): readonly RunLine[] {
  const width = Math.max(1, Math.floor(options.width))
  const codeIndent = options.codeIndent ?? "  "
  // Content is sanitized before any measurement so widths, wrapping, and
  // table allocation see exactly the text the Ink bridge will emit.
  const sourceLines = expandTabs(sanitizeText(markdown).replace(MARKER_CHARS, "")).split("\n")
  const lines: RunLine[] = []
  let fenced = false
  let fence = ""
  for (let index = 0; index < sourceLines.length; index += 1) {
    const sourceLine = sourceLines[index]!
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(sourceLine)
    if (fenceMatch !== null) {
      if (!fenced) {
        fenced = true
        fence = fenceMatch[1]!
        lines.push([{ text: `${fence}${fenceMatch[2]!.trim()}`, token: "muted" }])
      } else if (sourceLine.trimStart().startsWith(fence[0]!)) {
        fenced = false
        lines.push([{ text: fence, token: "muted" }])
      } else {
        lines.push(...wrapRuns([{ text: `${codeIndent}${sourceLine}`, token: "muted" }], width))
      }
      continue
    }
    if (fenced) {
      lines.push(...wrapRuns([{ text: `${codeIndent}${sourceLine}`, token: "muted" }], width))
      continue
    }
    if (sourceLine.trim().length === 0) {
      lines.push([])
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(sourceLine)
    if (heading !== null) {
      const base: InlineStyle = { token: "accent", overlays: FOCUS }
      lines.push(...wrapRuns([{ text: `${heading[1]} `, token: "accent", overlays: FOCUS }, ...renderInline(heading[2]!, base)], width))
      lines.push([])
      continue
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(sourceLine)) {
      lines.push([{ text: "─".repeat(Math.min(width, 80)), token: "border" }])
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(sourceLine)
    if (quote !== null) {
      lines.push(...wrapRuns([{ text: "│ ", token: "border" }, ...renderInline(quote[1]!, BASE)], width))
      continue
    }
    const list = /^(\s*)([-*+] |\d+[.)] )(.*)$/.exec(sourceLine)
    if (list !== null) {
      lines.push(...wrapRuns([{ text: `${list[1]}${list[2]}`, token: "text" }, ...renderInline(list[3]!, BASE)], width))
      continue
    }
    // Tables lay out only in the final phase; streaming and any malformed
    // or infeasible table fall through to the ordinary line branches (the
    // raw fallback path shares every safety and wrap guarantee).
    if (options.phase === "final") {
      const scan = scanTable(sourceLines, index)
      if (scan !== null) {
        const rendered = renderTable(scan, width)
        if (rendered !== null) {
          lines.push(...rendered)
          index += scan.rows.length + 1
          continue
        }
      }
    }
    lines.push(...wrapRuns(renderInline(sourceLine, BASE), width))
  }
  return lines
}

/** Render a bounded markdown row window while still measuring the complete source. */
export function renderMarkdownRunsRange(markdown: string, options: MarkdownRunsOptions, start: number, count: number): MarkdownRunsRange {
  const width = Math.max(1, Math.floor(options.width))
  const from = Math.max(0, Math.floor(start))
  const end = from + Math.max(0, Math.floor(count))
  const codeIndent = options.codeIndent ?? "  "
  const source = expandTabs(sanitizeText(markdown).replace(MARKER_CHARS, ""))
  const lines: RunLine[] = []
  let lineCount = 0
  let trailingBlankLines = 0
  let lastTextLine = -1
  let fenced = false
  let fence = ""
  const append = (batch: MarkdownRunsRange): void => {
    const batchStart = lineCount
    lines.push(...batch.lines)
    lineCount += batch.lineCount
    trailingBlankLines = batch.trailingBlankLines === batch.lineCount ? trailingBlankLines + batch.lineCount : batch.trailingBlankLines
    if (batch.lastTextLine >= 0) lastTextLine = batchStart + batch.lastTextLine
  }
  const appendLine = (line: RunLine): void => {
    const selected = lineCount >= from && lineCount < end ? [line] : []
    append({ lines: selected, lineCount: 1, trailingBlankLines: isBlankRunLine(line) ? 1 : 0, lastTextLine: hasVisibleText(line) ? 0 : -1 })
  }
  const appendWrapped = (runs: readonly TextRun[]): void => {
    const localStart = Math.max(0, from - lineCount)
    const localCount = Math.max(0, end - Math.max(from, lineCount))
    append(wrapRunsWindow(runs, width, localStart, localCount))
  }
  let cursor = 0
  while (cursor <= source.length) {
    const line = sourceLineAt(source, cursor)
    if (line === null) break
    const sourceLine = line.text
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(sourceLine)
    if (fenceMatch !== null) {
      if (!fenced) {
        fenced = true
        fence = fenceMatch[1]!
        appendLine([{ text: `${fence}${fenceMatch[2]!.trim()}`, token: "muted" }])
      } else if (sourceLine.trimStart().startsWith(fence[0]!)) {
        fenced = false
        appendLine([{ text: fence, token: "muted" }])
      } else {
        appendWrapped([{ text: `${codeIndent}${sourceLine}`, token: "muted" }])
      }
      cursor = line.next
      continue
    }
    if (fenced) {
      appendWrapped([{ text: `${codeIndent}${sourceLine}`, token: "muted" }])
      cursor = line.next
      continue
    }
    if (sourceLine.trim().length === 0) {
      appendLine([])
      cursor = line.next
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(sourceLine)
    if (heading !== null) {
      const base: InlineStyle = { token: "accent", overlays: FOCUS }
      appendWrapped([{ text: `${heading[1]} `, token: "accent", overlays: FOCUS }, ...renderInline(heading[2]!, base)])
      appendLine([])
      cursor = line.next
      continue
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(sourceLine)) {
      appendLine([{ text: "─".repeat(Math.min(width, 80)), token: "border" }])
      cursor = line.next
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(sourceLine)
    if (quote !== null) {
      appendWrapped([{ text: "│ ", token: "border" }, ...renderInline(quote[1]!, BASE)])
      cursor = line.next
      continue
    }
    const list = /^(\s*)([-*+] |\d+[.)] )(.*)$/.exec(sourceLine)
    if (list !== null) {
      appendWrapped([{ text: `${list[1]}${list[2]}`, token: "text" }, ...renderInline(list[3]!, BASE)])
      cursor = line.next
      continue
    }
    if (options.phase === "final") {
      const scan = scanTableSource(source, cursor)
      if (scan !== null) {
        const localStart = Math.max(0, from - lineCount)
        const localCount = Math.max(0, end - Math.max(from, lineCount))
        const table = renderTableSourceWindow(source, scan, width, localStart, localCount)
        if (table !== null) {
          append(table)
          cursor = scan.end
          continue
        }
      }
    }
    appendWrapped(renderInline(sourceLine, BASE))
    cursor = line.next
  }
  return { lines, lineCount, trailingBlankLines, lastTextLine }
}
