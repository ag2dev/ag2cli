/**
 * Cached detailed tool-source layout: one walk over each section's
 * prepared paragraphs records every wrapped row as a span into its
 * paragraph, so a visible window locates its rows by binary search and
 * slices them without re-walking the body. A source whose section
 * bodies are unchanged (value-compared; the large input string arrives
 * memoized from the transcript kernel) re-measures for free while the
 * live tail re-mints its wrapper every tick, and a section body that
 * grew by appending keeps its complete paragraphs and re-prepares only
 * the tail — sanitization never consumes a line break, so appended
 * text cannot change a completed line. Entries are LRU-bounded; the
 * state layer owns the cache so the kernel stays pure.
 */
import { expandTabs, verbatimRowSpans } from "./measure.js"
import { sanitizeText } from "./sanitize.js"
import type { TextRun } from "./theme.js"
import { detailedToolSections, type TranscriptLine, type TranscriptToolInput } from "./transcript.js"

/** One prepared paragraph and the row spans wrapped at the entry's width. */
interface ParagraphLayout {
  readonly text: string
  readonly spans: Uint32Array
  readonly rowCount: number
  readonly trailingBlankRows: number
}

/** One section's paragraphs plus its composed row counts. */
interface SectionLayout {
  readonly body: string
  readonly token: TextRun["token"]
  readonly paragraphs: readonly ParagraphLayout[]
  /** Cumulative row count before each paragraph; strictly increasing. */
  readonly rowStarts: readonly number[]
  readonly lineCount: number
  readonly trailingBlankLines: number
  readonly approxBytes: number
}

/** One source's full layout at one width, with its trailing separator. */
interface SourceLayout {
  readonly sourceId: string
  readonly columns: number
  readonly sections: readonly SectionLayout[]
  /** Cumulative row count before each section; strictly increasing. */
  readonly rowStarts: readonly number[]
  readonly bodyRows: number
  readonly totalRows: number
  readonly approxBytes: number
  touched: number
}

export interface ToolDetailCache {
  /** Exact row count of the detailed source, including its trailing separator row. */
  measure(block: TranscriptToolInput, columns: number): number
  /** Render one row window by slicing recorded spans. */
  range(block: TranscriptToolInput, columns: number, start: number, count: number): readonly TranscriptLine[]
  /** Monotonic count of full layout rebuilds; reuse assertions read it. */
  buildCount(): number
}

/** Bounds injection is for eviction tests; production uses the defaults. */
export interface ToolDetailCacheBounds {
  readonly maxEntries?: number
  readonly maxBytes?: number
}

const MAX_ENTRIES = 256
const MAX_BYTES = 4 * 1024 * 1024

/**
 * Fixed per-object charges the byte budget must count alongside text:
 * a layout of many tiny paragraphs retains the paragraph objects, the
 * typed-array headers (byteLength counts only elements), and the
 * cumulative row-start slots — without these, that shape overshoots
 * the budget by orders of magnitude while charging almost nothing.
 */
const PARAGRAPH_OBJECT_BYTES = 96
const SECTION_OBJECT_BYTES = 128
const ROW_START_BYTES = 8

/** One sanitized line prepared and wrapped at the entry's width. */
function buildParagraph(line: string, columns: number): ParagraphLayout {
  const text = expandTabs(line)
  const spans = verbatimRowSpans(text, columns)
  const rowCount = spans.length >> 1
  let trailingBlankRows = 0
  for (let index = spans.length - 2; index >= 0; index -= 2) {
    if (spans[index] !== spans[index + 1]!) break
    trailingBlankRows += 1
  }
  return { text, spans, rowCount, trailingBlankRows }
}

function composeParagraphs(paragraphs: readonly ParagraphLayout[]): Omit<SectionLayout, "body" | "token" | "paragraphs"> {
  const rowStarts: number[] = []
  let lineCount = 0
  let trailingBlankLines = 0
  let approxBytes = 0
  for (const paragraph of paragraphs) {
    rowStarts.push(lineCount)
    lineCount += paragraph.rowCount
    trailingBlankLines =
      paragraph.trailingBlankRows === paragraph.rowCount ? trailingBlankLines + paragraph.rowCount : paragraph.trailingBlankRows
    approxBytes += PARAGRAPH_OBJECT_BYTES + paragraph.text.length * 2 + paragraph.spans.byteLength
  }
  approxBytes += rowStarts.length * ROW_START_BYTES
  return { rowStarts, lineCount, trailingBlankLines, approxBytes }
}

function buildSection(body: string, token: TextRun["token"], columns: number): SectionLayout {
  const paragraphs = sanitizeText(body)
    .split("\n")
    .map((line) => buildParagraph(line, columns))
  return { body, token, paragraphs, ...composeParagraphs(paragraphs) }
}

/**
 * Extend one cached section to a body that grew by appending: the
 * paragraphs of every line the old body completed are byte-stable —
 * the raw prefix property pins their bytes and sanitization is
 * line-local — so only the incomplete last line and the appended lines
 * re-prepare. Equal bodies reuse the layout outright, adopting a
 * changed token for free; any other change returns null for a full
 * rebuild.
 */
function extendSection(cached: SectionLayout, body: string, token: TextRun["token"], columns: number): SectionLayout | null {
  if (body === cached.body) return cached.token === token ? cached : { ...cached, token }
  if (!body.startsWith(cached.body)) return null
  const kept = cached.paragraphs.length - 1
  const lines = sanitizeText(body).split("\n")
  if (lines.length < kept + 1) return null
  const paragraphs = [...cached.paragraphs.slice(0, kept), ...lines.slice(kept).map((line) => buildParagraph(line, columns))]
  return { body, token, paragraphs, ...composeParagraphs(paragraphs) }
}

function composeSections(sections: readonly SectionLayout[]): Omit<SourceLayout, "sourceId" | "columns" | "sections" | "touched"> {
  const rowStarts: number[] = []
  let rawRows = 0
  let trailingBlankRows = 0
  let approxBytes = 0
  for (const section of sections) {
    rowStarts.push(rawRows)
    rawRows += section.lineCount
    trailingBlankRows =
      section.trailingBlankLines === section.lineCount ? trailingBlankRows + section.lineCount : section.trailingBlankLines
    // The retained body anchors every value validation and prefix
    // extension, so it spends the byte budget alongside its paragraphs.
    approxBytes += SECTION_OBJECT_BYTES + section.approxBytes + section.body.length * 2
  }
  approxBytes += rowStarts.length * ROW_START_BYTES
  const bodyRows = rawRows - trailingBlankRows
  return { rowStarts, bodyRows, totalRows: bodyRows + 1, approxBytes }
}

function upperBound(starts: readonly number[], row: number): number {
  let low = 0
  let high = starts.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (starts[middle]! <= row) low = middle + 1
    else high = middle
  }
  return low - 1
}

export function createToolDetailCache(bounds: ToolDetailCacheBounds = {}): ToolDetailCache {
  const maxEntries = bounds.maxEntries ?? MAX_ENTRIES
  const maxBytes = bounds.maxBytes ?? MAX_BYTES
  const entries = new Map<string, SourceLayout>()
  let clock = 0
  let builds = 0
  let bytes = 0

  const evict = (): void => {
    if (entries.size <= maxEntries && bytes <= maxBytes) return
    const ordered = [...entries.values()].sort((left, right) => left.touched - right.touched)
    // The newest layout is never its own eviction target: a source past
    // the byte budget alone (two max-size tool fields) would otherwise
    // self-evict on install and re-walk its whole text on every frame
    // that shows it. It may overshoot the budget until a later source
    // outranks it.
    for (let index = 0; index < ordered.length - 1; index += 1) {
      if (entries.size <= maxEntries && bytes <= maxBytes) return
      entries.delete(ordered[index]!.sourceId)
      bytes -= ordered[index]!.approxBytes
    }
  }

  const install = (sourceId: string, sections: readonly SectionLayout[], columns: number, fullBuild: boolean): SourceLayout => {
    const cached = entries.get(sourceId)
    const layout: SourceLayout = {
      sourceId,
      columns,
      sections,
      ...composeSections(sections),
      touched: (clock += 1),
    }
    if (cached !== undefined) bytes -= cached.approxBytes
    entries.set(sourceId, layout)
    bytes += layout.approxBytes
    if (fullBuild) builds += 1
    evict()
    return layout
  }

  const layoutFor = (block: TranscriptToolInput, columns: number): SourceLayout => {
    // Sections re-derive per call — a handful of small literals plus a
    // memoized stringify — and validate the cache by value so a
    // re-minted wrapper with equal fields is a hit.
    const fresh = detailedToolSections(block)
    const cached = entries.get(block.sourceId)
    if (
      cached !== undefined &&
      cached.columns === columns &&
      cached.sections.length === fresh.length &&
      cached.sections.every((section, index) => section.body === fresh[index]!.body && section.token === fresh[index]!.token)
    ) {
      cached.touched = clock += 1
      return cached
    }
    if (cached !== undefined && cached.columns === columns && cached.sections.length === fresh.length) {
      const extended: SectionLayout[] = []
      let viable = true
      for (let index = 0; index < fresh.length; index += 1) {
        const section = extendSection(cached.sections[index]!, fresh[index]!.body, fresh[index]!.token, columns)
        if (section === null) {
          viable = false
          break
        }
        extended.push(section)
      }
      if (viable) return install(block.sourceId, extended, columns, false)
    }
    return install(
      block.sourceId,
      fresh.map((section) => buildSection(section.body, section.token, columns)),
      columns,
      true,
    )
  }

  const measure = (block: TranscriptToolInput, columns: number): number => layoutFor(block, columns).totalRows

  const range = (block: TranscriptToolInput, columns: number, start: number, count: number): readonly TranscriptLine[] => {
    const layout = layoutFor(block, columns)
    const from = Math.max(0, Math.floor(start))
    const end = Math.min(layout.totalRows, from + Math.max(0, Math.floor(count)))
    const sourceId = block.sourceId
    const lines: TranscriptLine[] = []
    for (let row = from; row < end; row += 1) {
      if (row === layout.bodyRows) {
        lines.push({ sourceId, runs: [] })
        continue
      }
      const sectionIndex = upperBound(layout.rowStarts, row)
      const section = layout.sections[sectionIndex]!
      const sectionStart = layout.rowStarts[sectionIndex]!
      const paragraphIndex = upperBound(section.rowStarts, row - sectionStart)
      const paragraph = section.paragraphs[paragraphIndex]!
      const local = row - sectionStart - section.rowStarts[paragraphIndex]!
      const spanStart = paragraph.spans[local * 2]!
      const spanEnd = paragraph.spans[local * 2 + 1]!
      lines.push({ sourceId, runs: [{ text: paragraph.text.slice(spanStart, spanEnd), token: section.token }] })
    }
    return lines
  }

  return { measure, range, buildCount: () => builds }
}
