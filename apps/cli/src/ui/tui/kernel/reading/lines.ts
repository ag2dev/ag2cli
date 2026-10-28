/**
 * Transcript document model: source-owned wrapped line segments with a
 * prefix index for anchor lookup and visible-window slicing. The cache
 * folds the projection's change batches onto its cached order — a
 * streaming delta renders only the live source — and bounds its
 * rendered lines (LRU eviction with lazy re-materialization on slice),
 * so the model and cache stay rebuildable derived data, never a second
 * history. A wholesale rebuild (adoption, evicted log, gapped batch)
 * scans source order once and builds a compact index, while the view
 * materializes only its window.
 */
import type { SourceChangeBatch } from "../../sessionprojection/index.js"
import {
  renderTranscriptSource,
  transcriptRenderSources,
  type TextRun,
  type TranscriptLine,
  type TranscriptRenderSource,
  type TranscriptSessionInput,
  type TranscriptTailInput,
  type TranscriptToolInput,
} from "../../text/index.js"

/**
 * The chrome's editor face: layout asks only for the draft's body-row
 * demand, so this narrow structural type keeps the reading owner free
 * of a lateral fields dependency (kernel rule: lateral imports pass
 * through the coordinator only).
 */
interface ChromeEditorFace {
  bodyRows(width: number, ceiling: number): number
}

/** One source's contiguous line range; end is exclusive. */
export interface TranscriptLineSpan {
  readonly start: number
  readonly end: number
}

/** A source's pre-rendered wrapped rows; a rendered source owns at least one row, and the zero-line guard stays for degenerate inputs. */
export interface TranscriptLineSegment {
  readonly sourceId: string
  readonly lines: readonly TranscriptLine[]
}

/** A source whose row count is known but whose rows render on slice (cache-evicted history). */
export interface TranscriptLazySegment {
  readonly sourceId: string
  readonly lineCount: number
  materialize(start: number, count: number): readonly TranscriptLine[]
}

interface ModelSegment {
  readonly sourceId: string
  readonly lines: readonly TranscriptLine[] | null
  readonly lineCount: number
  readonly materialize: ((start: number, count: number) => readonly TranscriptLine[]) | undefined
}

export class TranscriptLineModel {
  private readonly segments: readonly ModelSegment[]
  private readonly starts: readonly number[]
  private readonly ends: readonly number[]
  private readonly spans: ReadonlyMap<string, TranscriptLineSpan>
  private readonly lineCount: number

  constructor(input: readonly (TranscriptLineSegment | TranscriptLazySegment)[]) {
    const spans = new Map<string, TranscriptLineSpan>()
    const sourceIndexes = new Map<string, number>()
    const starts: number[] = []
    const ends: number[] = []
    const normalized: ModelSegment[] = []
    let lineCount = 0
    const push = (segment: ModelSegment): void => {
      if (segment.lineCount === 0) return
      if (sourceIndexes.has(segment.sourceId)) throw new Error(`Transcript source owns non-contiguous lines: ${segment.sourceId}`)
      const index = normalized.length
      const start = lineCount
      lineCount += segment.lineCount
      normalized.push(segment)
      starts.push(start)
      ends.push(lineCount)
      sourceIndexes.set(segment.sourceId, index)
      spans.set(segment.sourceId, { start, end: lineCount })
    }
    for (const segment of input) {
      const lazy = segment as TranscriptLazySegment
      if (typeof lazy.lineCount === "number" && typeof lazy.materialize === "function") {
        push({ sourceId: lazy.sourceId, lines: null, lineCount: lazy.lineCount, materialize: lazy.materialize })
        continue
      }
      const eagerSegment = segment as TranscriptLineSegment
      push({ sourceId: eagerSegment.sourceId, lines: eagerSegment.lines, lineCount: eagerSegment.lines.length, materialize: undefined })
    }
    this.segments = normalized
    this.starts = starts
    this.ends = ends
    this.spans = spans
    this.lineCount = lineCount
  }

  get total(): number {
    return this.lineCount
  }

  /** The contiguous span one source owns, or null when it rendered no lines. */
  spanOf(sourceId: string): TranscriptLineSpan | null {
    return this.spans.get(sourceId) ?? null
  }

  /** The source owning one line index, or null outside the model. */
  sourceAt(lineIndex: number): string | null {
    const segmentIndex = this.segmentIndexAt(lineIndex)
    return segmentIndex < 0 ? null : this.segments[segmentIndex]!.sourceId
  }

  /** Up to `count` lines from `start`, clamped into the model; lazy segments render on touch. */
  slice(start: number, count: number): readonly TranscriptLine[] {
    const from = Math.max(0, Math.min(start, this.lineCount))
    const to = Math.min(this.lineCount, from + Math.max(0, count))
    const result: TranscriptLine[] = []
    let cursor = from
    let segmentIndex = this.segmentIndexAt(from)
    while (cursor < to && segmentIndex >= 0) {
      const segment = this.segments[segmentIndex]!
      const localStart = cursor - this.starts[segmentIndex]!
      const take = Math.min(segment.lineCount - localStart, to - cursor)
      if (segment.lines === null) result.push(...segment.materialize!(localStart, take))
      else result.push(...segment.lines.slice(localStart, localStart + take))
      cursor += take
      segmentIndex += 1
    }
    return result
  }

  private segmentIndexAt(lineIndex: number): number {
    if (lineIndex < 0 || lineIndex >= this.lineCount) return -1
    let low = 0
    let high = this.ends.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.ends[middle]! <= lineIndex) low = middle + 1
      else high = middle
    }
    return low < this.segments.length ? low : -1
  }
}

/** Session input the cache reads; the projection revision drives the fold. */
type CacheSession = TranscriptSessionInput & { readonly projectionRevision?: number }

/** Rendering, optional exact measurement, and bounds the cache honors. */
export interface TranscriptLineCacheOptions {
  readonly render?: (source: TranscriptRenderSource, columns: number) => readonly TranscriptLine[]
  /** Optional bounded row renderer for a measured source. */
  readonly renderRange?: (source: TranscriptRenderSource, columns: number, start: number, count: number) => readonly TranscriptLine[]
  /** Exact row count for a source that should stay unrendered until slice; null falls back to render. */
  readonly measure?: (source: TranscriptRenderSource, columns: number) => number | null
  readonly maxCachedLines?: number
  readonly maxCachedBytes?: number
}

/** Default bound for the rendered line cache: cached wrapped lines. */
export const MAX_CACHED_LINES = 10_000

/** Default bound for the rendered line cache: approximate cached characters. */
export const MAX_CACHED_BYTES = 2_000_000

/** One indexed source: its rendered rows, or an exact row count for lazy materialization. */
interface CacheEntry {
  source: TranscriptRenderSource
  columns: number
  lines: readonly TranscriptLine[] | null
  lineCount: number
  approxBytes: number
  touched: number
}

function approxBytesOf(lines: readonly TranscriptLine[]): number {
  let total = 0
  for (const line of lines) for (const run of line.runs) total += run.text.length
  return total
}

function sameValue(left: unknown, right: unknown, seen = new WeakMap<object, WeakSet<object>>()): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false
  let paired = seen.get(left)
  if (paired?.has(right)) return true
  if (paired === undefined) {
    paired = new WeakSet<object>()
    seen.set(left, paired)
  }
  paired.add(right)
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index], seen))
    )
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) && sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], seen),
    )
  )
}

export function sameToolRenderSource(left: TranscriptToolInput, right: TranscriptToolInput): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.body === right.body &&
    left.runId === right.runId &&
    left.turn === right.turn &&
    left.toolUseId === right.toolUseId &&
    left.name === right.name &&
    left.title === right.title &&
    left.status === right.status &&
    left.toolStatus === right.toolStatus &&
    sameValue(left.input, right.input) &&
    left.partialInput === right.partialInput &&
    left.result === right.result &&
    left.durationMs === right.durationMs &&
    left.questionOutcome === right.questionOutcome &&
    sameValue(left.diff, right.diff)
  )
}

/**
 * Rebuild gate and incremental fold for the model. Exact session/tail
 * identity reuses the whole index. A change batch whose window starts
 * exactly at the cached revision folds onto the cached order — a
 * streaming delta touches only the live source, with no enumeration or
 * value comparison of stable history — while any reset, a null, stale
 * or gapped batch, or a broken invariant falls back to the full
 * snapshot rebuild, which reuses source indexes or cached rows while
 * the rendered value is equal. Rendered lines stay bounded derived data:
 * LRU eviction drops the rows of least-recently-rendered sources and
 * the model re-materializes them lazily on slice.
 */
export class TranscriptLineCache {
  private readonly render: (source: TranscriptRenderSource, columns: number) => readonly TranscriptLine[]
  private readonly renderRange: TranscriptLineCacheOptions["renderRange"]
  private readonly measure: ((source: TranscriptRenderSource, columns: number) => number | null) | undefined
  private readonly maxCachedLines: number
  private readonly maxCachedBytes: number
  private entry: {
    session: CacheSession
    tail: readonly TranscriptTailInput[]
    columns: number
    model: TranscriptLineModel
    baseRevision: number | undefined
  } | null = null
  private readonly sourceLines = new Map<string, CacheEntry>()
  /** Transcript source order the fold maintains; tail overlays ride their own entries. */
  private order: string[] = []
  private readonly positions = new Map<string, number>()
  private clock = 0
  private sourceComparisons = 0

  constructor(options: TranscriptLineCacheOptions = {}) {
    this.render = options.render ?? renderTranscriptSource
    this.renderRange = options.renderRange
    this.measure = options.measure
    this.maxCachedLines = options.maxCachedLines ?? MAX_CACHED_LINES
    this.maxCachedBytes = options.maxCachedBytes ?? MAX_CACHED_BYTES
  }

  modelFor(
    session: CacheSession,
    liveTail: readonly TranscriptTailInput[],
    columns: number,
    batch?: SourceChangeBatch | null,
  ): TranscriptLineModel {
    const entry = this.entry
    if (entry !== null && entry.session === session && entry.tail === liveTail && entry.columns === columns) {
      return entry.model
    }
    const revision = session.projectionRevision
    let model: TranscriptLineModel | null = null
    if (
      entry !== null &&
      entry.columns === columns &&
      batch !== undefined &&
      batch !== null &&
      typeof revision === "number" &&
      entry.baseRevision !== undefined &&
      entry.baseRevision === batch.sinceRevision &&
      batch.upToRevision === revision &&
      this.fold(batch, session, liveTail, columns)
    ) {
      model = this.publish(liveTail)
    }
    if (model === null) model = this.rebuild(session, liveTail, columns)
    this.entry = { session, tail: liveTail, columns, model, baseRevision: revision }
    return model
  }

  /** Drop every index and row; the next modelFor rebuilds from its input alone. */
  invalidate(): void {
    this.entry = null
    this.sourceLines.clear()
    this.order = []
    this.positions.clear()
  }

  /** Wrapped lines currently cached; evicted history renders again on slice. */
  cachedLineCount(): number {
    let lines = 0
    for (const cached of this.sourceLines.values()) if (cached.lines !== null) lines += cached.lineCount
    return lines
  }

  /**
   * Exact line count for a source at one width, including a source
   * whose rows are still lazy. A count measured at another width
   * would mis-index a borrowing caller, so a mismatch reads as
   * unknown.
   */
  lineCountOf(sourceId: string, columns: number): number | null {
    const cached = this.sourceLines.get(sourceId)
    return cached !== undefined && cached.columns === columns ? cached.lineCount : null
  }

  /** A cached visible range at one width, or null when the rows were evicted or rendered at another width. */
  lineRangeOf(sourceId: string, columns: number, start: number, count: number): readonly TranscriptLine[] | null {
    const cached = this.sourceLines.get(sourceId)
    if (cached === undefined || cached.columns !== columns) return null
    return cached.lines === null ? null : cached.lines.slice(start, start + count)
  }

  /**
   * Monotonic count of source value comparisons. The zero-enumeration
   * contract is observable here: a fold adds only its touched and tail
   * sources, while a rebuild compares every source in the snapshot.
   */
  comparisonCount(): number {
    return this.sourceComparisons
  }

  /**
   * Fold one consecutive change batch onto the cached order. Positions
   * update during the walk while render sources resolve after it — a
   * ring-trim batch appends before it cuts, so mid-walk resolution
   * would read post-cut indexes. Any invariant failure returns false
   * so the caller rebuilds from the snapshot; entries the walk already
   * dropped simply re-render there.
   */
  private fold(batch: SourceChangeBatch, session: CacheSession, liveTail: readonly TranscriptTailInput[], columns: number): boolean {
    const transcript = session.transcript
    const tailMap = new Map<string, TranscriptTailInput>()
    for (const tail of liveTail) if (!tailMap.has(tail.sourceId)) tailMap.set(tail.sourceId, tail)
    const touchedIds = new Set<string>()
    for (const change of batch.changes) {
      if (change.kind === "reset") return false
      if (change.kind === "truncate") {
        if (change.from < 0 || change.to < change.from || change.to > this.order.length) return false
        for (let index = change.from; index < change.to; index += 1) {
          const sourceId = this.order[index]!
          this.positions.delete(sourceId)
          this.sourceLines.delete(sourceId)
        }
        this.order.splice(change.from, change.to - change.from)
        for (let index = change.from; index < this.order.length; index += 1) this.positions.set(this.order[index]!, index)
        continue
      }
      for (const sourceId of change.sourceIds) {
        if (change.kind === "append") {
          if (this.positions.has(sourceId)) return false
          this.positions.set(sourceId, this.order.length)
          this.order.push(sourceId)
        } else if (!this.positions.has(sourceId)) return false
        touchedIds.add(sourceId)
      }
    }
    if (this.order.length !== transcript.length) return false
    for (const sourceId of touchedIds) {
      const position = this.positions.get(sourceId)
      const block = position === undefined ? undefined : transcript[position]
      if (block === undefined || block.sourceId !== sourceId) return false
      const tail = tailMap.get(sourceId)
      this.upsert(sourceId, tail === undefined ? { kind: "block", block } : { kind: "tail", tail }, columns)
    }
    for (const tail of tailMap.values()) this.upsert(tail.sourceId, { kind: "tail", tail }, columns)
    const active = new Set<string>(this.order)
    for (const sourceId of tailMap.keys()) if (!this.positions.has(sourceId)) active.add(sourceId)
    for (const sourceId of this.sourceLines.keys()) if (!active.has(sourceId)) this.sourceLines.delete(sourceId)
    return true
  }

  /**
   * Rebuild from the full snapshot: order and positions re-derive from
   * the transcript itself — a tail source overlays its transcript slot,
   * only unplaced tail sources ride after it — while unchanged sources
   * reuse their indexes or cached rows.
   */
  private rebuild(session: CacheSession, liveTail: readonly TranscriptTailInput[], columns: number): TranscriptLineModel {
    if (this.entry === null || this.entry.columns !== columns) this.sourceLines.clear()
    this.order = []
    this.positions.clear()
    for (const block of session.transcript) {
      if (this.positions.has(block.sourceId)) continue
      this.positions.set(block.sourceId, this.order.length)
      this.order.push(block.sourceId)
    }
    const active = new Set<string>()
    for (const source of transcriptRenderSources(session, liveTail)) {
      const sourceId = source.kind === "block" ? source.block.sourceId : source.tail.sourceId
      active.add(sourceId)
      this.upsert(sourceId, source, columns)
    }
    for (const sourceId of this.sourceLines.keys()) if (!active.has(sourceId)) this.sourceLines.delete(sourceId)
    return this.publish(liveTail)
  }

  /** Reuse rows, index an exactly measured source lazily, or render as a fallback. */
  private upsert(sourceId: string, source: TranscriptRenderSource, columns: number): void {
    const cached = this.sourceLines.get(sourceId)
    if (cached !== undefined && cached.columns === columns) {
      this.sourceComparisons += 1
      if (sameRenderSource(cached.source, source)) {
        cached.source = source
        cached.touched = this.clock += 1
        return
      }
    }
    const measured = this.measure?.(source, columns)
    if (measured !== null && measured !== undefined && Number.isInteger(measured) && measured >= 0) {
      this.sourceLines.set(sourceId, {
        source,
        columns,
        lines: null,
        lineCount: measured,
        approxBytes: 0,
        touched: (this.clock += 1),
      })
      return
    }
    const lines = this.render(source, columns)
    this.sourceLines.set(sourceId, {
      source,
      columns,
      lines,
      lineCount: lines.length,
      approxBytes: approxBytesOf(lines),
      touched: (this.clock += 1),
    })
    this.evict()
  }

  /** Build the model over the cached order plus tail-only sources, then bound the cache. */
  private publish(liveTail: readonly TranscriptTailInput[]): TranscriptLineModel {
    const segments: (TranscriptLineSegment | TranscriptLazySegment)[] = []
    for (const sourceId of this.order) {
      const cached = this.sourceLines.get(sourceId)
      if (cached === undefined) throw new Error(`Transcript cache lost source: ${sourceId}`)
      segments.push({ sourceId, lineCount: cached.lineCount, materialize: (start, count) => this.materialize(sourceId, start, count) })
    }
    for (const tail of liveTail) {
      if (this.positions.has(tail.sourceId)) continue
      const cached = this.sourceLines.get(tail.sourceId)
      if (cached === undefined) continue
      segments.push({
        sourceId: tail.sourceId,
        lineCount: cached.lineCount,
        materialize: (start, count) => this.materialize(tail.sourceId, start, count),
      })
    }
    this.evict()
    return new TranscriptLineModel(segments)
  }

  /** Render one visible range or an evicted source on demand; the next commit re-bounds cached rows. */
  private materialize(sourceId: string, start: number, count: number): readonly TranscriptLine[] {
    const cached = this.sourceLines.get(sourceId)
    if (cached === undefined) return []
    if (cached.lines !== null) return cached.lines.slice(start, start + count)
    if (this.renderRange !== undefined) {
      const lines = this.renderRange(cached.source, cached.columns, start, count)
      if (lines.length !== count) {
        throw new Error(`Transcript range renderer changed its window: ${sourceId} expected ${count} rows, received ${lines.length}`)
      }
      cached.touched = this.clock += 1
      return lines
    }
    const lines = this.render(cached.source, cached.columns)
    if (lines.length !== cached.lineCount) {
      throw new Error(`Transcript source measurement changed: ${sourceId} expected ${cached.lineCount} rows, received ${lines.length}`)
    }
    cached.lines = lines
    cached.approxBytes = approxBytesOf(lines)
    cached.touched = this.clock += 1
    this.evict()
    return lines.slice(start, start + count)
  }

  /** Drop the least-recently-rendered rows until both cache bounds hold. */
  private evict(): void {
    let lines = 0
    let bytes = 0
    const materialized: CacheEntry[] = []
    for (const cached of this.sourceLines.values()) {
      if (cached.lines === null) continue
      lines += cached.lineCount
      bytes += cached.approxBytes
      materialized.push(cached)
    }
    if (lines <= this.maxCachedLines && bytes <= this.maxCachedBytes) return
    materialized.sort((left, right) => left.touched - right.touched)
    for (const cached of materialized) {
      if (lines <= this.maxCachedLines && bytes <= this.maxCachedBytes) return
      lines -= cached.lineCount
      bytes -= cached.approxBytes
      cached.lines = null
    }
  }
}

function sameRenderSource(left: TranscriptRenderSource, right: TranscriptRenderSource): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "tail" && right.kind === "tail") {
    if (left.tail.kind === "tool" || right.tail.kind === "tool") {
      if (left.tail.kind !== "tool" || right.tail.kind !== "tool") return false
      return sameToolRenderSource(left.tail, right.tail)
    }
    return (
      left.tail.sourceId === right.tail.sourceId &&
      left.tail.kind === right.tail.kind &&
      left.tail.body === right.tail.body &&
      left.tail.streaming === right.tail.streaming
    )
  }
  if (left.kind === "block" && right.kind === "block") {
    const a = left.block
    const b = right.block
    if (a.kind === "tool" || b.kind === "tool") {
      if (a.kind !== "tool" || b.kind !== "tool") return false
      return sameToolRenderSource(a, b)
    }
    return a.sourceId === b.sourceId && a.kind === b.kind && a.body === b.body && a.streaming === b.streaming
  }
  return false
}

/** Terminal geometry the viewport derives against. */
export interface TranscriptLayout {
  readonly columns: number
  readonly rows: number
}

/** Every card-less surface sharing the terminal with the transcript, as one snapshot carries it. */
export interface TranscriptChrome {
  readonly editor: { readonly kernel: ChromeEditorFace }
  readonly completion: { readonly items: readonly unknown[]; readonly total: number } | null
  readonly notice: { readonly title: string; readonly body: string } | null
  readonly queued: QueuedPreview
  /** Plan progress rows, one per plan id at its latest state; they never spend the queued preview's budget. */
  readonly planRows: readonly string[]
  readonly footer: readonly TextRun[]
  /** Running-children summary row above the footer; null while no child runs. */
  readonly agentsRunning: string | null
}

/**
 * The parked-input rows the frame paints: a bounded prefix plus one
 * elision row counting the rest. The run queue derives this once and
 * the host injects it at queue ingress, so the row budget and the
 * painted rows share one derivation inside the state layer.
 */
export interface QueuedPreview {
  readonly visible: readonly string[]
  readonly elided: number
}
