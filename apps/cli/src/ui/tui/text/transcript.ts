/**
 * Transcript line kernel: map the committed transcript plus the live
 * tail to wrapped, styled lines at one fixed width. A source also
 * present in the live tail renders from the tail only — the committed
 * copy is a stale snapshot of the same block, and both together would
 * double-render a still-streaming source — and a sourceId the input
 * repeats (a reconcile window, a re-read tail) renders once, so every
 * source owns one contiguous span downstream. Assistant and user
 * entries render under a marker gutter (body width reduced by the
 * marker, continuation rows indented; user rows paint as one
 * full-width quoted band with a gray padding row above and below),
 * assistant bodies through the bounded markdown renderer with
 * the phase taken from the streaming flag, user rows always final;
 * shell/status/error rows render sanitized plain text wrapped verbatim
 * (tabs expanded to terminal stops, spacing kept); the compact renderer
 * gives tool blocks one status-first row, while the detailed renderer
 * expands retained fields in the same source slot. Every entry closes with one blank
 * separator row. The input shapes are structural: the kernel reads the
 * projection's block vocabulary by shape, never by import.
 */
import { renderMarkdownRuns, renderMarkdownRunsRange, type MarkdownRenderPhase } from "./markdown.js"
import { clipText, expandTabs, measureVerbatim, textWidth, wrapVerbatim, wrapVerbatimRange } from "./measure.js"
import { sanitizeText } from "./sanitize.js"
import type { TextRun } from "./theme.js"

/** One text-bearing committed block: body plus its row kind. */
export interface TranscriptTextInput {
  readonly sourceId: string
  readonly kind: "user" | "assistant" | "status" | "shell" | "error"
  readonly body: string
  readonly streaming?: boolean
}

/** One tool block: compact identity plus retained fields for the detailed reader. */
export interface TranscriptToolInput {
  readonly sourceId: string
  readonly kind: "tool"
  readonly body: string
  readonly runId?: string
  readonly turn?: number
  readonly toolUseId?: string
  readonly name?: string
  readonly input?: unknown
  /** Display title derived from a string `description` input at merge time. */
  readonly title?: string
  readonly status: "streaming" | "running" | "waiting" | "approved" | "denied" | "done" | "error"
  readonly result?: string
  readonly partialInput?: string
  readonly durationMs?: number
  readonly questionOutcome?: "answered" | "declined" | "rejected"
  readonly diff?: unknown
}

/** Committed blocks the kernel maps; only the transcript is read. */
export type TranscriptSourceInput = TranscriptTextInput | TranscriptToolInput

/** The committed session content; only its transcript feeds the kernel. */
export interface TranscriptSessionInput {
  readonly transcript: readonly TranscriptSourceInput[]
}

/** One still-streaming source the committed transcript may lag behind. */
export type TranscriptTailInput =
  | {
      readonly sourceId: string
      /** Block kind carried so an assistant tail renders under its entry gutter. */
      readonly kind: "user" | "assistant" | "status" | "shell" | "error"
      readonly body: string
      readonly streaming?: boolean
    }
  | TranscriptToolInput

/** One wrapped transcript line and the source it belongs to. */
export interface TranscriptLine {
  readonly sourceId: string
  readonly runs: readonly TextRun[]
}

/** One deduplicated source with the renderer needed for its current phase. */
export type TranscriptRenderSource =
  { readonly kind: "block"; readonly block: TranscriptSourceInput } | { readonly kind: "tail"; readonly tail: TranscriptTailInput }

function plainLines(body: string, token: TextRun["token"], columns: number): readonly (readonly TextRun[])[] {
  const lines: (readonly TextRun[])[] = []
  for (const paragraph of sanitizeText(body).split("\n")) {
    // Plain rows carry meaning in their spacing (shell output columns,
    // stack-trace indent), so they expand tabs to terminal stops and
    // wrap verbatim instead of reflowing like prose: the measured
    // width and the rendered width stay identical. A blank paragraph
    // wraps to one empty-text run, never to an empty row.
    for (const text of wrapVerbatim(expandTabs(paragraph), columns)) lines.push([{ text, token }])
  }
  return lines
}

function toolToken(status: TranscriptToolInput["status"]): TextRun["token"] {
  switch (status) {
    case "error":
      return "error"
    case "denied":
      return "warning"
    case "done":
      return "success"
    default:
      return "accent"
  }
}

function toolStatusLabel(status: TranscriptToolInput["status"]): string {
  switch (status) {
    case "waiting":
      return "waiting"
    case "error":
      return "failed"
    default:
      return status
  }
}

/**
 * The name both renderers label a tool with: the canonical `name`
 * when the projection carries it, otherwise the body with a trailing
 * status word stripped.
 */
function toolDisplayName(block: TranscriptToolInput): string {
  return block.name ?? (block.body.endsWith(` ${block.status}`) ? block.body.slice(0, -block.status.length - 1) : block.body)
}

function toolLines(block: TranscriptToolInput, columns: number): readonly (readonly TextRun[])[] {
  const token = toolToken(block.status)
  const name = toolDisplayName(block)
  const action = typeof block.title === "string" && block.title.length > 0 ? ` · ${block.title}` : ""
  const summary = sanitizeText(`[${toolStatusLabel(block.status)}] ${name}${action}`)
    .replace(/\s+/gu, " ")
    .trim()
  const width = Math.max(1, columns)
  const clipped = clipText(summary, width)
  const text = clipped.clipped ? `${clipText(summary, Math.max(0, width - textWidth("…"))).text}…` : clipped.text
  return [[{ text, token }]]
}

// The live tail re-mints its wrapper every tick but carries the same
// input reference, so keying the serialization on object identity
// keeps the O(payload) stringify to once per input; the cache dies
// with the object itself.
const jsonTextCache = new WeakMap<object, string>()

function jsonText(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    try {
      return JSON.stringify(value, null, 2) ?? "undefined"
    } catch {
      return "[unserializable tool input]"
    }
  }
  const cached = jsonTextCache.get(value)
  if (cached !== undefined) return cached
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? "undefined"
  } catch {
    text = "[unserializable tool input]"
  }
  jsonTextCache.set(value, text)
  return text
}

interface DetailedToolSection {
  readonly body: string
  readonly token: TextRun["token"]
}

export function detailedToolSections(block: TranscriptToolInput): readonly DetailedToolSection[] {
  const sections: DetailedToolSection[] = [
    { body: `[${toolStatusLabel(block.status)}] ${toolDisplayName(block)}`, token: toolToken(block.status) },
  ]
  // The title gate matches the compact row: an empty title carries no
  // action, and a muted "Action:" line with nothing after it reads as
  // a stray.
  if (typeof block.title === "string" && block.title.length > 0) sections.push({ body: `Action: ${block.title}`, token: "muted" })
  const metadata = [
    block.turn === undefined ? null : `Turn ${block.turn}`,
    block.durationMs === undefined ? null : `${block.durationMs} ms`,
  ].filter((part): part is string => part !== null)
  if (metadata.length > 0) sections.push({ body: metadata.join(" · "), token: "muted" })
  // A block without recorded input shows no section at all — an
  // "undefined" placeholder row would read as tool output.
  if (block.input !== undefined) sections.push({ body: "Input:", token: "muted" }, { body: jsonText(block.input), token: "text" })
  if (block.partialInput !== undefined)
    sections.push({ body: "Partial input:", token: "muted" }, { body: block.partialInput, token: "text" })
  if (block.result !== undefined) sections.push({ body: "Result:", token: "muted" }, { body: block.result, token: "text" })
  if (block.diff !== undefined && typeof block.diff === "object" && block.diff !== null) {
    const diff = block.diff as {
      readonly addedLines?: unknown
      readonly removedLines?: unknown
      readonly sites?: unknown
      readonly truncated?: unknown
    }
    if (typeof diff.addedLines === "number" && typeof diff.removedLines === "number" && typeof diff.sites === "number") {
      const marker = diff.truncated === true ? " · truncated" : ""
      sections.push({ body: `Diff: +${diff.addedLines} −${diff.removedLines} across ${diff.sites} change sites${marker}`, token: "muted" })
    }
  }
  if (block.questionOutcome !== undefined) sections.push({ body: `Question: ${block.questionOutcome}`, token: "muted" })
  return sections
}

function detailedToolLines(block: TranscriptToolInput, columns: number): readonly (readonly TextRun[])[] {
  return detailedToolSections(block).flatMap(({ body, token }) => plainLines(body, token, columns))
}

function measurePlainText(body: string, columns: number): { readonly lineCount: number; readonly trailingBlankLines: number } {
  let lineCount = 0
  let trailingBlankLines = 0
  for (const paragraph of sanitizeText(body).split("\n")) {
    const measured = measureVerbatim(expandTabs(paragraph), columns)
    lineCount += measured.lineCount
    trailingBlankLines =
      measured.trailingBlankLines === measured.lineCount ? trailingBlankLines + measured.lineCount : measured.trailingBlankLines
  }
  return { lineCount, trailingBlankLines }
}

/** Exact detailed row count for tool sources without retaining their rendered rows. */
export function measureDetailedTranscriptSource(source: TranscriptRenderSource, columns: number): number | null {
  const block = source.kind === "block" ? source.block : source.tail
  if (block.kind !== "tool") return null
  let rows = 0
  let trailingBlankRows = 0
  for (const section of detailedToolSections(block)) {
    const measured = measurePlainText(section.body, columns)
    rows += measured.lineCount
    trailingBlankRows =
      measured.trailingBlankLines === measured.lineCount ? trailingBlankRows + measured.lineCount : measured.trailingBlankLines
  }
  // Each rendered source ends with one blank separator. The normalizer
  // removes only blank body rows immediately before that separator.
  return rows - trailingBlankRows + 1
}

function plainLinesRange(
  body: string,
  token: TextRun["token"],
  columns: number,
  start: number,
  count: number,
): readonly (readonly TextRun[])[] {
  const rows: (readonly TextRun[])[] = []
  const end = start + count
  let offset = 0
  for (const paragraph of sanitizeText(body).split("\n")) {
    const expanded = expandTabs(paragraph)
    const measured = measureVerbatim(expanded, columns)
    const localStart = Math.max(0, start - offset)
    const localEnd = Math.min(measured.lineCount, end - offset)
    if (localEnd > localStart) {
      for (const text of wrapVerbatimRange(expanded, columns, localStart, localEnd - localStart)) rows.push([{ text, token }])
    }
    offset += measured.lineCount
    if (offset >= end) break
  }
  return rows
}

function entryGutterRow(marker: string, row: readonly TextRun[], index: number): readonly TextRun[] {
  if (row.length === 0) return index === 0 ? [{ text: marker, token: "accent" }] : row
  return [{ text: index === 0 ? marker : " ".repeat(textWidth(marker)), token: index === 0 ? "accent" : "text" }, ...row]
}

function renderTextSourceRange(
  sourceId: string,
  block: Exclude<TranscriptSourceInput | TranscriptTailInput, TranscriptToolInput>,
  columns: number,
  start: number,
  count: number,
): readonly TranscriptLine[] {
  const from = Math.max(0, Math.floor(start))
  const end = from + Math.max(0, Math.floor(count))
  if (end <= from) return []
  if (block.kind === "assistant" || block.kind === "user") {
    const marker = block.kind === "assistant" ? "⏺ " : "❯ "
    const phase: MarkdownRenderPhase = block.kind === "assistant" && block.streaming === true ? "streaming" : "final"
    const body = block.kind === "assistant" ? block.body.replace(/^(?:[ \t]*\r?\n)+/u, "") : block.body
    const bodyStart = block.kind === "user" ? Math.max(0, from - 1) : from
    const bodyEnd = block.kind === "user" ? Math.max(0, end - 1) : end
    const rendered = renderMarkdownRunsRange(
      body,
      { width: columns - textWidth(marker), phase },
      bodyStart,
      Math.max(0, bodyEnd - bodyStart),
    )
    // The full render's cut is overlay-aware — bold whitespace rides the
    // focus overlay and counts as content — so the assistant window
    // derives from the walk's overlay-aware trailing-blank metric; the
    // user band pops its trailing rows on text alone, so it keeps the
    // text-only last-text index.
    const bodyCount =
      block.kind === "assistant" ? Math.max(1, rendered.lineCount - rendered.trailingBlankLines) : Math.max(1, rendered.lastTextLine + 1)
    const total = block.kind === "user" ? bodyCount + 3 : bodyCount + 1
    const lines: TranscriptLine[] = []
    if (block.kind === "assistant") {
      for (let sourceLine = from; sourceLine < Math.min(end, total); sourceLine += 1) {
        if (sourceLine === bodyCount) {
          lines.push({ sourceId, runs: [] })
          continue
        }
        const row = rendered.lines[sourceLine - bodyStart]
        if (row !== undefined) lines.push({ sourceId, runs: entryGutterRow(marker, row, sourceLine) })
      }
      return lines
    }

    const padding: readonly TextRun[] = [{ text: " ".repeat(columns), token: "text", overlays: ["quoted"] }]
    for (let sourceLine = from; sourceLine < Math.min(end, total); sourceLine += 1) {
      if (sourceLine === 0 || sourceLine === bodyCount + 1) {
        lines.push({ sourceId, runs: padding })
        continue
      }
      if (sourceLine === bodyCount + 2) {
        lines.push({ sourceId, runs: [] })
        continue
      }
      const bodyLine = sourceLine - 1
      const row = rendered.lines[bodyLine - bodyStart]
      if (row === undefined) continue
      const guttered = entryGutterRow(marker, row, bodyLine)
      const banded = guttered.map((run): TextRun => ({ ...run, overlays: [...(run.overlays ?? []), "quoted"] }))
      const used = banded.reduce((width, run) => width + textWidth(run.text), 0)
      const pad = Math.max(0, columns - used)
      lines.push({
        sourceId,
        runs: pad > 0 ? [...banded, { text: " ".repeat(pad), token: "text", overlays: ["quoted"] }] : banded,
      })
    }
    return lines
  }

  const token: TextRun["token"] = block.kind === "error" ? "error" : block.kind === "status" ? "muted" : "text"
  const measured = measurePlainText(block.body, columns)
  const bodyCount = Math.max(0, measured.lineCount - measured.trailingBlankLines)
  const bodyStart = Math.min(from, bodyCount)
  const bodyEnd = Math.min(end, bodyCount)
  const rows = plainLinesRange(block.body, token, columns, bodyStart, Math.max(0, bodyEnd - bodyStart))
  const lines = rows.map((runs) => ({ sourceId, runs }))
  if (from <= bodyCount && end > bodyCount) lines.push({ sourceId, runs: [] })
  return lines
}

/** Render only a visible line range from a detailed tool source. */
export function renderDetailedTranscriptSourceRange(
  source: TranscriptRenderSource,
  columns: number,
  start: number,
  count: number,
): readonly TranscriptLine[] {
  const sourceId = source.kind === "block" ? source.block.sourceId : source.tail.sourceId
  const block = source.kind === "block" ? source.block : source.tail
  const from = Math.max(0, Math.floor(start))
  const boundedCount = Math.max(0, Math.floor(count))
  if (boundedCount === 0) return []
  if (block.kind !== "tool") return renderTextSourceRange(sourceId, block, columns, from, boundedCount)

  const sections = detailedToolSections(block)
  const measured = sections.map((section) => measurePlainText(section.body, columns))
  let rawCount = 0
  let trailingBlankRows = 0
  for (const section of measured) {
    rawCount += section.lineCount
    trailingBlankRows =
      section.trailingBlankLines === section.lineCount ? trailingBlankRows + section.lineCount : section.trailingBlankLines
  }
  const bodyLineCount = rawCount - trailingBlankRows
  const end = from + boundedCount
  const lines: TranscriptLine[] = []
  let sourceOffset = 0
  for (let index = 0; index < sections.length && sourceOffset < bodyLineCount; index += 1) {
    const section = sections[index]!
    const lineCount = measured[index]!.lineCount
    const sectionEnd = sourceOffset + lineCount
    const visibleStart = Math.max(from, sourceOffset)
    const visibleEnd = Math.min(end, bodyLineCount, sectionEnd)
    if (visibleEnd > visibleStart) {
      const rows = plainLinesRange(section.body, section.token, columns, visibleStart - sourceOffset, visibleEnd - visibleStart)
      for (const runs of rows) lines.push({ sourceId, runs })
    }
    sourceOffset = sectionEnd
  }
  if (from <= bodyLineCount && end > bodyLineCount) lines.push({ sourceId, runs: [] })
  return lines
}

function blockLines(block: TranscriptSourceInput, columns: number, detailed: boolean): readonly (readonly TextRun[])[] {
  if (block.kind === "tool") {
    return detailed ? detailedToolLines(block, columns) : toolLines(block, columns)
  }
  const phase: MarkdownRenderPhase = block.streaming === true ? "streaming" : "final"
  if (block.kind === "assistant") {
    return assistantLines(block.body, phase, columns)
  }
  if (block.kind === "error") {
    return plainLines(block.body, "error", columns)
  }
  if (block.kind === "status") {
    return plainLines(block.body, "muted", columns)
  }
  if (block.kind === "user") {
    return userLines(block.body, columns)
  }
  return plainLines(block.body, "text", columns)
}

/**
 * Seat one entry's rows under a marker gutter: the body renders at the
 * width the gutter leaves, row 0 carries the marker, and every
 * continuation row carries an equal-width indent so wrapped rows stay
 * aligned. Blank continuation rows stay empty — the gutter paints
 * where content sits.
 */
function withEntryGutter(marker: string, rows: readonly (readonly TextRun[])[]): readonly (readonly TextRun[])[] {
  const head: TextRun = { text: marker, token: "accent" }
  const indent: TextRun = { text: " ".repeat(textWidth(marker)), token: "text" }
  return rows.map((row, index) => {
    if (row.length === 0) return index === 0 ? [head] : row
    return [...(index === 0 ? [head] : [indent]), ...row]
  })
}

/**
 * Assistant entry rows: leading blank lines strip before the render so
 * streaming and committed bodies of the same text can never differ in
 * row count on this account — the shared shape of the committed block
 * and the live tail.
 */
function assistantLines(body: string, phase: MarkdownRenderPhase, columns: number): readonly (readonly TextRun[])[] {
  const marker = "⏺ "
  const stripped = body.replace(/^(?:[ \t]*\r?\n)+/u, "")
  return withEntryGutter(marker, renderMarkdownRuns(stripped, { width: columns - textWidth(marker), phase }))
}

/**
 * User entry rows: the body shares the assistant's markdown kernel,
 * always final — user input has no streaming phase — and the whole
 * entry paints as one full-width quoted band: a gray padding row above
 * and below the body, every body row carrying the quoted overlay and
 * padded to the terminal width so short rows still close the band.
 * The foreground stays the theme's normal color; inline styles keep
 * their own tokens.
 */
function userLines(body: string, columns: number): readonly (readonly TextRun[])[] {
  const marker = "❯ "
  const rows = withEntryGutter(marker, renderMarkdownRuns(body, { width: columns - textWidth(marker), phase: "final" })).slice()
  // The body's own trailing blank rows fold into the band's bottom
  // padding instead of stacking extra gray blanks above it.
  while (rows.length > 0 && rows[rows.length - 1]!.every((run) => run.text.trim().length === 0)) rows.pop()
  const bandRow = (row: readonly TextRun[]): readonly TextRun[] => {
    const banded = row.map((run): TextRun => ({ ...run, overlays: [...(run.overlays ?? []), "quoted"] }))
    // Body rows render at the width the two-cell marker leaves, so the
    // pad closes exactly at the terminal width; the degenerate floor
    // can overshoot it, and there the band simply runs ragged.
    const pad = Math.max(0, columns - banded.reduce((width, run) => width + textWidth(run.text), 0))
    return pad > 0 ? [...banded, { text: " ".repeat(pad), token: "text", overlays: ["quoted"] }] : banded
  }
  const padding: readonly TextRun[] = [{ text: " ".repeat(columns), token: "text", overlays: ["quoted"] }]
  return [padding, ...rows.map(bandRow), padding]
}

/**
 * Tail rows mirror the committed shape of their kind — the tail is the
 * same block at a fresher revision, so the commit swap must not move a
 * row. Tool tails carry the same lifecycle and detail fields as their
 * committed block, so both renderers keep the source's row shape aligned.
 */
function tailLines(block: TranscriptTailInput, columns: number, detailed: boolean): readonly (readonly TextRun[])[] {
  if (block.kind === "tool") return detailed ? detailedToolLines(block, columns) : toolLines(block, columns)
  switch (block.kind) {
    case "assistant":
      return assistantLines(block.body, block.streaming === true ? "streaming" : "final", columns)
    case "user":
      return userLines(block.body, columns)
    case "error":
      return plainLines(block.body, "error", columns)
    case "status":
      return plainLines(block.body, "muted", columns)
    case "shell":
      return plainLines(block.body, "text", columns)
  }
}

/** Committed sources followed by tail-only sources, preserving live block positions. */
export function transcriptRenderSources(
  session: TranscriptSessionInput,
  liveTail: readonly TranscriptTailInput[],
): readonly TranscriptRenderSource[] {
  const seen = new Set<string>()
  const tailSources = new Map<string, TranscriptTailInput>()
  for (const block of liveTail) if (!tailSources.has(block.sourceId)) tailSources.set(block.sourceId, block)
  const sources: TranscriptRenderSource[] = []
  for (const block of session.transcript) {
    if (seen.has(block.sourceId)) continue
    seen.add(block.sourceId)
    const tail = tailSources.get(block.sourceId)
    sources.push(tail === undefined ? { kind: "block", block } : { kind: "tail", tail })
  }
  for (const block of tailSources.values()) {
    if (seen.has(block.sourceId)) continue
    seen.add(block.sourceId)
    sources.push({ kind: "tail", tail: block })
  }
  return sources
}

/**
 * Render one deduplicated source without touching any other transcript
 * block. Every entry closes with exactly one blank separator row.
 */
export function renderTranscriptSource(source: TranscriptRenderSource, columns: number): readonly TranscriptLine[] {
  return renderSource(source, columns, false)
}

/** Render one source for the full-screen reader, expanding tool facts in place. */
export function renderDetailedTranscriptSource(source: TranscriptRenderSource, columns: number): readonly TranscriptLine[] {
  return renderSource(source, columns, true)
}

function renderSource(source: TranscriptRenderSource, columns: number, detailed: boolean): readonly TranscriptLine[] {
  const sourceId = source.kind === "block" ? source.block.sourceId : source.tail.sourceId
  const rendered = source.kind === "block" ? blockLines(source.block, columns, detailed) : tailLines(source.tail, columns, detailed)
  // A blank row is any row without visible text and without an
  // overlay: the markdown kernel mints [], the plain paths an
  // empty-text run, and an excerpt cut can strand either at the end —
  // while the quoted band's pad rows carry their color in the overlay
  // alone, so they count as content. All blank rows coalesce into the
  // one separator.
  const blankRow = (row: readonly TextRun[]): boolean =>
    row.every((run) => run.text.trim().length === 0 && (run.overlays ?? []).length === 0)
  let cut = rendered.length
  while (cut > 0 && blankRow(rendered[cut - 1]!)) cut -= 1
  return [...rendered.slice(0, cut), [] as readonly TextRun[]].map((runs) => ({ sourceId, runs }))
}
