/**
 * Grapheme-safe text measurement, clipping, and wrapping. All widths are in
 * terminal cells; segmentation is extended-grapheme based so combining marks
 * and joined emoji never split.
 */
/** The one grapheme segmenter the kernel's modules share. */
export const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" })

/**
 * Zero-width code point ranges (joiners, selectors, combining marks).
 * The sweep test pins the safety direction: a bare code point that
 * string-width paints cells for must not sit here (skin-tone modifiers
 * are the case in point — bare they paint two cells, so they stay in
 * the wide table and only lose their width once joined into a cluster).
 */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  // The 0x1ab0 block interleaves both widths: combining rows at
  // 0x1ab0–0x1add and 0x1ae0–0x1aeb, width-1 assigned rows at
  // 0x1ade–0x1adf and 0x1aec–0x1aff.
  [0x1ab0, 0x1add],
  [0x1ae0, 0x1aeb],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x20d0, 0x20f0],
  [0x302a, 0x302d],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xe0100, 0xe01ef],
]

/**
 * Two-cell code point ranges: the East-Asian Wide/Fullwidth set plus the
 * emoji-presentation code points, transcribed from the width table ink
 * wraps with (string-width 8.3). The sweep test pins the safety
 * direction against that oracle: no code point may measure narrower
 * here — under-counting a grapheme (✅, ⏰, ⚽ …) makes ink wrap a line
 * we budgeted as fitting, and rows spill past the frame bottom.
 * Over-counting is the safe direction and is tolerated (a wider budget
 * only wraps early); the known families are combining-mark blocks
 * string-width zeroes but this table lacks, which reserve one extra
 * cell per mark.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115e], // Hangul jamo leading consonants
  // Sparse emoji in the misc-symbols block: every range boundary below
  // is a code point string-width counts as 2 — the gaps are width 1.
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2630, 0x2637],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x268a, 0x268f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5],
  [0x2ff0, 0x3029],
  [0x302e, 0x303e],
  [0x3041, 0x3096],
  [0x309b, 0x30ff],
  [0x3105, 0x312f],
  [0x3131, 0x3163],
  [0x3165, 0x318e],
  [0x3190, 0x31e5],
  [0x31ef, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0xa48c],
  [0xa490, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  // Historic wide scripts (Tangut, Nüshu, Egyptian, …).
  [0x16fe0, 0x16fe3],
  [0x16ff0, 0x16ff6],
  [0x17000, 0x18cda],
  [0x18cff, 0x18d20],
  [0x18d80, 0x18df2],
  [0x18e00, 0x19191],
  [0x191a0, 0x191d2],
  [0x1aff0, 0x1aff3],
  [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe],
  [0x1b000, 0x1b128],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b168],
  [0x1b170, 0x1b2fb],
  [0x1d300, 0x1d356],
  [0x1d360, 0x1d376],
  // Emoji and their extensions; the gaps inside are width-1 text forms.
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f1ae, 0x1f1ae],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d9],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7da, 0x1f7da],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c],
  [0x1fa80, 0x1fac6],
  [0x1fac8, 0x1fac8],
  [0x1facc, 0x1fadd],
  [0x1fadf, 0x1faeb],
  [0x1faef, 0x1fafa],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]

function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  let low = 0
  let high = ranges.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const [from, to] = ranges[middle]!
    if (codePoint < from) high = middle
    else if (codePoint > to) low = middle + 1
    else return true
  }
  return false
}

/** Split text into extended grapheme clusters. */
export function graphemes(text: string): readonly string[] {
  if (text.length === 0) return []
  return [...graphemeSegmenter.segment(text)].map((cluster) => cluster.segment)
}

/** Terminal cell width of one grapheme cluster; zero for pure combining marks. */
export function graphemeWidth(grapheme: string): number {
  let width = 0
  let emojiPresentation = false
  let regionalIndicators = 0
  for (const codePoint of grapheme) {
    const value = codePoint.codePointAt(0)!
    if (value >= 0x1f1e6 && value <= 0x1f1ff) regionalIndicators += 1
    // Only VS16 requests emoji presentation; VS15 requests the narrow
    // text presentation, so widening on it pads one cell past the ink.
    if (value === 0xfe0f) emojiPresentation = true
    if (inRanges(value, ZERO_WIDTH_RANGES)) continue
    width = Math.max(width, inRanges(value, WIDE_RANGES) ? 2 : 1)
  }
  // Regional indicators pair into flag graphemes painted two cells each;
  // a ZWJ-joined cluster can carry several pairs plus at most one lone
  // indicator, and every pair keeps its two cells. A lone indicator
  // stays one cell, matching the width oracle.
  if (regionalIndicators >= 2) return 2 * (regionalIndicators >> 1) + (regionalIndicators & 1)
  if (width === 1 && emojiPresentation) return 2
  return width
}

/**
 * Width of a string whose every code unit the range table classifies
 * outright, or null when any unit must fall back to grapheme
 * segmentation. The ranges admit only code points whose standalone
 * table width equals their cluster width: BMP Han/fullwidth scripts
 * and punctuation with no combining, joining, or presentation
 * behavior — the tone-mark seam (302A–302F) and the halfwidth
 * ideographic space (303F) stay excluded so a cluster that would
 * re-shape them never reads a table answer.
 */
function tableWidth(text: string): number | null {
  let width = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0x20 && unit !== 0x09 && unit !== 0x0a) return null
    if (unit < 0x80) {
      if (unit === 0x7f) return null
      width += 1
    } else if (unit >= 0xd800) return null
    else if (unit >= 0x2010 && unit <= 0x2027) width += 1
    else if (unit >= 0x3000 && unit <= 0x3029) width += 2
    else if (unit >= 0x3030 && unit <= 0x303e) width += 2
    else if ((unit >= 0x3400 && unit <= 0x4dbf) || (unit >= 0x4e00 && unit <= 0x9fff) || (unit >= 0xf900 && unit <= 0xfaff)) width += 2
    else if (unit >= 0xff01 && unit <= 0xff60) width += 2
    else return null
  }
  return width
}

/** Total terminal cell width of a string. */
export function textWidth(text: string): number {
  if (/^[\x00-\x7f]*$/u.test(text)) return text.length
  const simple = tableWidth(text)
  if (simple !== null) return simple
  let total = 0
  for (const cluster of graphemeSegmenter.segment(text)) total += graphemeWidth(cluster.segment)
  return total
}

export interface ClipResult {
  readonly text: string
  readonly clipped: boolean
}

/** Truncate to a cell budget, cutting only on grapheme boundaries. */
export function clipText(text: string, maxCells: number): ClipResult {
  if (maxCells < 1) return { text: "", clipped: text.length > 0 }
  let used = 0
  let cut = -1
  let index = 0
  for (const cluster of graphemes(text)) {
    const width = graphemeWidth(cluster)
    if (used + width > maxCells) {
      cut = index
      break
    }
    used += width
    index += cluster.length
  }
  if (cut === -1) return { text, clipped: false }
  return { text: text.slice(0, cut), clipped: true }
}

/** Terminal tab-stop width plain rows expand tabs against. */
const TAB_STOP = 8

/**
 * Expand tabs to spaces at fixed tab stops. Plain rows are measured and
 * wrapped as cells, but a raw tab would count one cell while the terminal
 * advances the cursor to the next stop — so every plain-row ingress
 * expands tabs first, and column alignment in tool output survives
 * because the stops match the terminal's.
 */
export function expandTabs(text: string, tabStop: number = TAB_STOP): string {
  if (!text.includes("\t")) return text
  let out = ""
  let column = 0
  for (const cluster of graphemes(text)) {
    if (cluster === "\n") {
      out += cluster
      column = 0
      continue
    }
    if (cluster === "\t") {
      const width = tabStop - (column % tabStop)
      out += " ".repeat(width)
      column += width
      continue
    }
    out += cluster
    column += graphemeWidth(cluster)
  }
  return out
}

/**
 * Wrap without reflow: space runs and leading indent keep their cells
 * wherever a line does not break, breaks still prefer word boundaries,
 * and only a word wider than the budget hard-splits on grapheme
 * boundaries. Plain rows (user echo, shell output, errors) carry
 * meaning in their spacing, so they wrap verbatim instead of
 * reflowing like prose. Derived from the canonical span walk: a row's
 * span ends past its trailing spaces, so the slice is the trimmed row.
 */
export function wrapVerbatim(text: string, maxCells: number): readonly string[] {
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    const spans = verbatimRowSpans(paragraph, maxCells)
    for (let index = 0; index < spans.length; index += 2) lines.push(paragraph.slice(spans[index]!, spans[index + 1]!))
  }
  return lines
}

/**
 * Row spans of one paragraph wrapped verbatim: (start, end) offset
 * pairs into the paragraph, end past the row's trailing spaces — a
 * row is therefore blank exactly when its two offsets are equal. The
 * walk is canonical: the wrapper, window, and count derivations all
 * slice these spans, and corpus tests pin them to identical rows so a
 * cached layout can re-materialize any window without re-walking the
 * body. The paragraph must arrive tab-expanded: a raw tab counts as
 * one cell here, so the caller expands tabs first.
 */
export function verbatimRowSpans(paragraph: string, maxCells: number): Uint32Array {
  const width = Math.max(1, Math.floor(maxCells))
  const spans: number[] = []
  let rowStart = 0
  let rowEnd = 0
  let cursor = 0
  let used = 0
  let pendingRun: number | null = null
  let atStart = true
  let emitted = 0
  const pattern = /[^ ]+| +/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(paragraph)) !== null) {
    const token = match[0]
    const tokenStart = match.index
    if (token[0] === " ") {
      if (atStart) {
        cursor += token.length
        used += token.length
      } else pendingRun = token.length
      continue
    }
    atStart = false
    const separatorCells = cursor === rowStart ? 0 : (pendingRun ?? 0)
    const tokenWidth = textWidth(token)
    if (used + separatorCells + tokenWidth <= width) {
      // A row opened while current sat empty begins at this token: the
      // separator run the earlier break consumed never joins a row.
      if (cursor === rowStart) rowStart = tokenStart
      cursor = tokenStart + token.length
      rowEnd = cursor
      used += separatorCells + tokenWidth
      pendingRun = null
      continue
    }
    if (cursor !== rowStart) {
      spans.push(rowStart, rowEnd)
      emitted += 1
    }
    rowStart = tokenStart
    rowEnd = tokenStart
    cursor = tokenStart
    used = 0
    pendingRun = null
    // One pass over an overlong token: rows emit as their last
    // grapheme lands, so a megabyte token stays linear instead of
    // rescanning the remainder per row. Rows pack greedily to the
    // budget; a single grapheme wider than the budget (a wide char at
    // width one) emits alone so wrapping always terminates.
    let restOffset = 0
    let restCells = tokenWidth
    if (/^[\x00-\x7f]+$/u.test(token)) {
      const fullRows = Math.floor((token.length - 1) / width)
      for (let index = 0; index < fullRows; index += 1) {
        spans.push(tokenStart + index * width, tokenStart + (index + 1) * width)
        emitted += 1
      }
      restOffset = fullRows * width
      restCells = token.length - restOffset
    } else {
      let chunkStart = 0
      let chunkWidth = 0
      for (const cluster of graphemeSegmenter.segment(token)) {
        const value = cluster.segment
        const cellWidth = graphemeWidth(value)
        if (chunkWidth > 0 && chunkWidth + cellWidth > width) {
          spans.push(tokenStart + chunkStart, tokenStart + cluster.index)
          emitted += 1
          chunkStart = cluster.index
          chunkWidth = 0
        }
        if (cellWidth > width) {
          if (chunkStart < cluster.index) {
            spans.push(tokenStart + chunkStart, tokenStart + cluster.index)
            emitted += 1
          }
          spans.push(tokenStart + cluster.index, tokenStart + cluster.index + value.length)
          emitted += 1
          chunkStart = cluster.index + value.length
          chunkWidth = 0
          continue
        }
        chunkWidth += cellWidth
      }
      restOffset = chunkStart
      restCells = chunkWidth
    }
    rowStart = tokenStart + restOffset
    cursor = rowStart + token.length - restOffset
    rowEnd = cursor
    used = restCells
  }
  if (cursor !== rowStart || emitted === 0) spans.push(rowStart, rowEnd)
  return new Uint32Array(spans)
}

/** Wrap verbatim while retaining only one requested window of rows. */
export function wrapVerbatimRange(text: string, maxCells: number, start: number, count: number): readonly string[] {
  const from = Math.max(0, Math.floor(start))
  const to = from + Math.max(0, Math.floor(count))
  const lines: string[] = []
  if (to <= from) return lines
  let lineIndex = 0
  for (const paragraph of text.split("\n")) {
    if (lineIndex >= to) break
    const spans = verbatimRowSpans(paragraph, maxCells)
    for (let index = 0; index < spans.length && lineIndex < to; index += 2) {
      if (lineIndex >= from) lines.push(paragraph.slice(spans[index]!, spans[index + 1]!))
      lineIndex += 1
    }
  }
  return lines
}

/**
 * The same verbatim wrap count without retaining the wrapped row
 * strings. A row is blank exactly when its span offsets are equal;
 * trailing blank rows aggregate per paragraph — an all-blank
 * paragraph extends the run behind it, anything else ends it.
 */
export function measureVerbatim(text: string, maxCells: number): { readonly lineCount: number; readonly trailingBlankLines: number } {
  let lineCount = 0
  let trailingBlankLines = 0
  for (const paragraph of text.split("\n")) {
    const spans = verbatimRowSpans(paragraph, maxCells)
    const paragraphLines = spans.length >> 1
    let paragraphTrailing = 0
    for (let index = spans.length - 2; index >= 0 && spans[index] === spans[index + 1]; index -= 2) paragraphTrailing += 1
    lineCount += paragraphLines
    trailingBlankLines = paragraphTrailing === paragraphLines ? trailingBlankLines + paragraphLines : paragraphTrailing
  }
  return { lineCount, trailingBlankLines }
}
