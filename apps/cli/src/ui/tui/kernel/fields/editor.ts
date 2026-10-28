/**
 * Composer editor kernel: the
 * draft state machine, framework-free and terminal-free. It owns the
 * plain text editing, grapheme-unit editing, undo/redo, paste chips,
 * the caret-follow window, and the completion token context. Intents from
 * keys/ drive it; the view renders its runs and never mutates the draft.
 *
 * Baseline semantics are frozen from the legacy composer surface:
 * submission is Enter-only and submits expanded paste-chip content, except the
 * line-continuation form — a backslash directly before the caret turns
 * Enter into a newline insert instead of a submit; arrows move
 * between logical lines; the visible window
 * offset is editor state, moved the shortest distance that keeps the
 * caret visible. Measurement goes through the text kernel so wrapping,
 * caret columns, and chip thresholds share one width table.
 */
import type { TuiIntent } from "../../keys/index.js"
import { graphemes, graphemeWidth, sanitizeText, textWidth } from "../../text/index.js"

const PREFIX_FIRST = "› "
const PREFIX_REST = "  "

/** Upper bound of cached per-line row templates; exceeded, the whole cache resets. */
const MAX_ROW_TEMPLATES = 1024

/** Pastes with more lines than this collapse into a chip. */
const PASTE_COLLAPSE_LINE_THRESHOLD = 3
/** Pastes wider than this collapse into a chip even when single-line. */
const PASTE_COLLAPSE_WIDTH_THRESHOLD = 200
/** Upper bound of remembered paste attachments. */
const MAX_PASTE_ATTACHMENTS = 100

/**
 * Fixed ceiling on the composer body. The kernel's caret-follow window
 * scrolls rows beyond it, so an unbounded draft can never crowd the
 * transcript and footer off the terminal. The number is a product
 * choice, not a derivation — changing it resizes the composer's share
 * of every tall terminal, so treat it as part of the capacity contract
 * (bodyRows feeds the transcript window's budget), not a free knob.
 */
export const COMPOSER_ROW_CAP = 38

const pastedTokenPattern = /\[Pasted text #(\d+)(?: \+\d+ (?:lines|chars))?\]/g

/**
 * Decide whether a pasted block is large enough to collapse into a
 * `[Pasted text #N …]` chip instead of flooding the composer.
 */
export function shouldCollapsePaste(value: string): boolean {
  if (value.length === 0) return false
  const lines = countPasteLines(value)
  if (lines > PASTE_COLLAPSE_LINE_THRESHOLD) return true
  return textWidth(value) > PASTE_COLLAPSE_WIDTH_THRESHOLD
}

/**
 * Render the composer-visible token for a collapsed paste. Multi-line pastes
 * report their line count (one trailing newline is not counted); long
 * single-line pastes report their grapheme count — the characters a human
 * reads, never UTF-16 units an emoji paste would double.
 */
export function formatPastedToken(index: number, content: string): string {
  const lines = countPasteLines(content)
  if (lines > 1) return `[Pasted text #${index} +${lines} lines]`
  return `[Pasted text #${index} +${graphemes(content).length} chars]`
}

/**
 * Replace paste tokens with their stored content. Tokens without a matching
 * attachment (edited tokens, entries from a previous process) stay literal so
 * silently dropping user text is impossible.
 */
export function expandPastedTokens(text: string, attachments: ReadonlyMap<number, string>): string {
  if (!text.includes("[Pasted text #")) return text
  return text.replace(pastedTokenPattern, (token, indexText: string) => {
    const content = attachments.get(Number(indexText))
    return content === undefined ? token : content
  })
}

function countPasteLines(value: string): number {
  let content = value
  if (content.endsWith("\n")) content = content.slice(0, -1)
  if (content.length === 0) return 1
  return content.split("\n").length
}

function isCompletionBoundary(value: string): boolean {
  return /[\s()[\]{}<>,;:!?\uFF0C\u3002\uFF01\uFF1F\u3001]/u.test(value)
}

function tokenEnd(text: string, start: number): number {
  let end = start
  while (end < text.length && !isCompletionBoundary(text[end]!)) end += 1
  return end
}

/** Derive context without making the editor depend on a picker. */
export function completionContextAt(text: string, caret: number): ComposerCompletionContext | null {
  const offset = Math.max(0, Math.min(text.length, caret))
  let start = offset
  while (start > 0 && !isCompletionBoundary(text[start - 1]!)) start -= 1
  const end = tokenEnd(text, start)
  const marker = text.lastIndexOf("@", Math.max(start, offset - 1))
  // A mention marker starts a token. This matches the TUI's submit parser:
  // prose such as `email@example.com` remains ordinary text, while `@src`
  // and `hello @src` are completion contexts.
  if (marker === start && marker < offset && marker < end) {
    return { kind: "mention", replaceRange: [marker, end], query: text.slice(marker + 1, Math.min(offset, end)) }
  }
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1
  if (text.slice(0, lineStart).length !== 0) return null
  if (start === lineStart) {
    const token = text.slice(lineStart, end)
    // A leading slash claims the line as a command token before any
    // path reading — `/tmp` is a slash lookup, not an absolute path.
    if (token.startsWith("/")) {
      return { kind: "command", replaceRange: [lineStart, end], query: token.slice(1, Math.min(offset, end) - lineStart) }
    }
    if (isPathToken(token)) {
      return { kind: "path", replaceRange: [lineStart, end], query: text.slice(lineStart, Math.min(offset, end)) }
    }
  }
  if (text[lineStart] === "!") {
    // A bang line is shell wholesale: the range spans the whole first
    // line and the query is the command text after the bang, clamped
    // to the caret so a query never runs ahead of what was typed.
    const lineEnd = text.indexOf("\n", lineStart)
    const bounded = lineEnd === -1 ? text.length : lineEnd
    return {
      kind: "shell",
      replaceRange: [lineStart, bounded],
      query: text.slice(lineStart + 1, Math.max(lineStart + 1, Math.min(offset, bounded))),
    }
  }
  return null
}

function isPathToken(token: string): boolean {
  return token.startsWith("./") || token.startsWith("../") || token.startsWith("~") || token.includes("/")
}

export type ComposerCompletionKind = "mention" | "command" | "shell" | "path"

/** Token under the caret that a TUI-local completion companion may replace. */
export interface ComposerCompletionContext {
  readonly kind: ComposerCompletionKind
  readonly replaceRange: readonly [number, number]
  readonly query: string
}

export type ComposerCompletionExpectation = Pick<ComposerCompletionContext, "kind" | "query">

export interface ComposerRender {
  /** Visible body rows (prefixed); border rows stay outside this list. */
  readonly lines: readonly string[]
  /** Caret row within the visible window (index into lines). */
  readonly caretRow: number
  readonly caretColumn: number
  /** First wrapped row of the visible window; editor state, never a scroll position. */
  readonly windowStartRow: number
  /** Wrapped rows the whole draft occupies at the render width. */
  readonly wrappedRows: number
}

export interface ComposerRenderRun {
  readonly text: string
  readonly token: "text" | "suggestion" | "bashMode"
  readonly overlays?: readonly "focus"[]
}

/** What an intent did to the draft: nothing, a change, or a submission. */
export type ComposerOutcome = { readonly kind: "changed" } | { readonly kind: "submitted"; readonly text: string }

export interface ComposerKernelOptions {
  /** TUI-local observer. Return false to keep the token ordinary. */
  readonly onCompletionContextChange?: (context: ComposerCompletionContext | null) => boolean | undefined
}

interface VisualRow {
  readonly text: string
  readonly logicalLine: number
  readonly startInLine: number
  readonly widthBefore: number
  readonly prefix: string
  readonly prefixKind: "ordinary" | "shell" | "continuation"
}

/**
 * Width-shaped wrapped rows for one logical line. `logicalLine` is
 * stamped at assembly, never cached: equal texts on different rows
 * share one template while the caret scan keeps per-row identity.
 */
interface RowTemplate {
  readonly text: string
  readonly startInLine: number
  readonly widthBefore: number
  readonly prefix: string
  readonly prefixKind: "ordinary" | "shell" | "continuation"
}

interface VisualLayout {
  readonly rows: readonly VisualRow[]
  readonly caretRow: number
  readonly caretColumn: number
  readonly windowStartRow: number
}

export class ComposerKernel {
  private draft = ""
  private caret = 0
  // Bounded-view window state: first wrapped row shown when a body budget
  // applies. Null means the next bounded render derives a fresh caret-reveal
  // window instead of reusing the previous offset.
  private windowStart: number | null = null
  private readonly undoStack: { text: string; caret: number }[] = []
  private readonly redoStack: { text: string; caret: number }[] = []
  private readonly pastedTokens = new Map<number, string>()
  private pasteSequence = 0
  private readonly onCompletionContextChange: ((context: ComposerCompletionContext | null) => boolean | undefined) | undefined
  private activeCompletionContext: ComposerCompletionContext | null = null
  private revision = 1
  // Per-logical-line row templates keyed by (width, first-line flag,
  // line text): a keystroke on one line re-segments only that line, so
  // per-key cost tracks the edited line instead of the whole draft.
  // Content-keyed — an edited line simply misses — and bounded by
  // MAX_ROW_TEMPLATES with a wholesale reset.
  private readonly rowTemplates = new Map<string, readonly RowTemplate[]>()
  // Line starts of the current draft, keyed by the draft value rather
  // than the revision: a delete sequence mutates the draft between its
  // two stepping calls, and a value key rebuilds exactly then.
  private lineStartsByDraft: { draft: string; starts: readonly number[] } | null = null

  constructor(options: ComposerKernelOptions = {}) {
    this.onCompletionContextChange = options.onCompletionContextChange
  }

  dispatch(intent: TuiIntent): ComposerOutcome | undefined {
    if (intent.kind === "activate") {
      // A backslash immediately before the caret is the line-continuation
      // form: Enter consumes it and breaks the line instead of submitting,
      // so Enter alone still sends.
      if (this.draft[this.caret - 1] === "\\") {
        return this.mutate(() => {
          // Replace the backslash with the newline; the caret (one past
          // it) stays put and lands at the new line's start.
          this.draft = `${this.draft.slice(0, this.caret - 1)}\n${this.draft.slice(this.caret)}`
        })
      }
      return this.submit()
    }
    if (intent.kind === "back") return undefined
    if (intent.kind === "paste") {
      const outcome = this.mutate(() => this.insertPasted(intent.text), false)
      // Recompute the context to invalidate old ranges, but do not open
      // a picker for the pasted fragment itself. A paste that changed
      // nothing (empty text) leaves no trace — highlight included.
      if (outcome !== undefined) this.notifyCompletionContext(false)
      return outcome
    }
    if (intent.kind === "navigate") return this.move(intent.direction)
    if (intent.kind === "advance") {
      // Tab reaches the editor only when the ring cannot claim it —
      // under the reader or below the floor — and is indent: it lands
      // as spaces, the paste width, so the draft never holds a raw
      // tab the layout would count as one cell while the terminal
      // advances to the next stop.
      return this.mutate(() => this.insert("    "))
    }
    if (intent.kind !== "input") return undefined
    const event = intent.event
    if (event.type === "char") {
      if (event.value === "\n") return this.mutate(() => this.insert("\n"))
      return this.mutate(() => this.insert(event.value))
    }
    if (event.type === "backspace") return this.mutate(() => this.deleteBackward())
    if (event.type === "delete") return this.mutate(() => this.deleteForward())
    if (event.type === "ctrl" && event.value === "z") return this.undoEdit()
    if (event.type === "ctrl" && event.value === "y") return this.redoEdit()
    if (event.type === "ctrl" && event.value === "a") return this.moveToLineEdge("start")
    if (event.type === "ctrl" && event.value === "e") return this.moveToLineEdge("end")
    return undefined
  }

  get text(): string {
    return this.draft
  }

  /** Monotone mutation counter: unchanged across reads of the same draft. */
  get draftRevision(): number {
    return this.revision
  }

  get caretOffset(): number {
    return this.caret
  }

  /** Clear the current draft without recording it as an accepted prompt. */
  clearDraft(): void {
    this.draft = ""
    this.rowTemplates.clear()
    this.caret = 0
    this.windowStart = null
    this.revision += 1
    this.notifyCompletionContext()
  }

  /**
   * Draft restore seam (session resume / test seeding); clamps the
   * caret. The seed is fresh content. A replaced draft is
   * recorded as one undo step — a seeded draft (the permissions card's
   * add-rule request) must not destroy composed text unrecoverably.
   * Like paste, the seed is host text the composer never decoded: it
   * lands sanitized and tab-widened, and the caret clamps to the
   * cleaned draft.
   */
  loadDraft(text: string, caret = text.length): void {
    const clean = sanitizeText(text).replace(/\t/g, "    ")
    if (this.draft.length > 0 && this.draft !== clean) {
      this.undoStack.push({ text: this.draft, caret: this.caret })
      this.redoStack.length = 0
    }
    this.draft = clean
    this.rowTemplates.clear()
    this.caret = Math.max(0, Math.min(clean.length, caret))
    this.windowStart = null
    this.revision += 1
    this.notifyCompletionContext()
  }

  completionContext(): ComposerCompletionContext | null {
    return completionContextAt(this.draft, this.caret)
  }

  /**
   * Re-evaluate the current completion context after an asynchronous source
   * refresh. The source callback owns the candidate list, but the editor
   * owns the token highlight; both must be updated by the same transaction.
   */
  refreshCompletionContext(): boolean {
    return this.notifyCompletionContext()
  }

  /** Replace a still-current completion token; stale effects are rejected. */
  replaceDraftRange(start: number, end: number, value: string, expected?: ComposerCompletionExpectation): boolean {
    const safeStart = Math.max(0, Math.min(this.draft.length, start))
    const safeEnd = Math.max(safeStart, Math.min(this.draft.length, end))
    const context = this.completionContext()
    if (
      context === null ||
      context.replaceRange[0] !== safeStart ||
      context.replaceRange[1] !== safeEnd ||
      (expected !== undefined && (context.kind !== expected.kind || context.query !== expected.query))
    ) {
      return false
    }
    this.undoStack.push({ text: this.draft, caret: this.caret })
    this.redoStack.length = 0
    this.draft = this.draft.slice(0, safeStart) + value + this.draft.slice(safeEnd)
    this.caret = safeStart + value.length
    this.windowStart = null
    this.revision += 1
    this.notifyCompletionContext()
    return true
  }

  /**
   * The body-row budget at one width: the draft's natural wrapped
   * height clamped to the fixed cap, or to a geometry-derived ceiling
   * when the caller knows how many rows the terminal actually has. It
   * depends on the draft and the width alone (plus that ceiling), so
   * the capacity arithmetic and the composer render both ask this one
   * question and always agree on the budget.
   */
  bodyRows(width: number, ceiling: number = COMPOSER_ROW_CAP, shellMode = false): number {
    // Both clamps always apply: the fixed cap survives even when the
    // caller passes a taller geometry ceiling, and the ceiling keeps a
    // short terminal from paying rows it does not have.
    return Math.max(1, Math.min(COMPOSER_ROW_CAP, ceiling, this.renderLines(width, undefined, shellMode).wrappedRows))
  }

  renderLines(width: number, maxBodyRows?: number, shellMode = false): ComposerRender {
    const layout = this.layout(width, maxBodyRows, shellMode)
    const bodyRows = maxBodyRows === undefined ? layout.rows.length : Math.max(1, Math.floor(maxBodyRows))
    const visible = layout.rows.slice(layout.windowStartRow, layout.windowStartRow + bodyRows)
    return {
      lines: visible.map((row) => row.text),
      caretRow: layout.caretRow - layout.windowStartRow,
      caretColumn: layout.caretColumn,
      windowStartRow: layout.windowStartRow,
      wrappedRows: layout.rows.length,
    }
  }

  /** Styled rows share the exact wrapping/window calculation used by renderLines. */
  renderRuns(
    width: number,
    maxBodyRows?: number,
    highlightCompletion = true,
    shellMode = false,
  ): readonly (readonly ComposerRenderRun[])[] {
    const layout = this.layout(width, maxBodyRows, shellMode)
    const bodyRows = maxBodyRows === undefined ? layout.rows.length : Math.max(1, Math.floor(maxBodyRows))
    const visible = layout.rows.slice(layout.windowStartRow, layout.windowStartRow + bodyRows)
    const range = highlightCompletion ? this.activeCompletionContext?.replaceRange : undefined
    return visible.map((row) => {
      const runs: ComposerRenderRun[] =
        row.prefixKind === "shell"
          ? [{ text: "!", token: "bashMode" }, ...(row.prefix.length > 1 ? [{ text: row.prefix.slice(1), token: "text" as const }] : [])]
          : [{ text: row.prefix, token: "text" }]
      const content = row.text.slice(row.prefix.length)
      let offset = this.lineStartForOffset(row.logicalLine) + row.startInLine
      for (const piece of graphemes(content)) {
        const highlighted = range !== undefined && offset < range[1] && offset + piece.length > range[0]
        const token: ComposerRenderRun["token"] = highlighted ? "suggestion" : "text"
        const overlays = highlighted ? (["focus"] as const) : undefined
        const previous = runs[runs.length - 1]
        const sameStyle = previous !== undefined && previous.token === token
        if (sameStyle) runs[runs.length - 1] = { ...previous, text: previous.text + piece }
        else runs.push({ text: piece, token, ...(overlays === undefined ? {} : { overlays }) })
        offset += piece.length
      }
      return runs
    })
  }

  private layout(width: number, maxBodyRows?: number, shellMode = false): VisualLayout {
    const rows: VisualRow[] = []
    const logical = this.draft.length === 0 ? [""] : this.draft.split("\n")
    for (let index = 0; index < logical.length; index += 1) {
      for (const template of this.lineRowTemplates(width, index === 0, logical[index]!, shellMode && index === 0)) {
        rows.push({ ...template, logicalLine: index })
      }
    }
    const caretLine = this.lineIndexForOffset(this.caret)
    const caretInLine = this.caret - this.lineStartForOffset(caretLine)
    let chosen = rows.length - 1
    let column = textWidth(rows[chosen]?.text ?? "")
    const shellFirstLine = shellMode && this.draft.startsWith("!")
    const shellHasSyntheticSpace = shellFirstLine && this.draft[1] !== undefined && this.draft[1] !== " " && this.draft[1] !== "\n"
    if (shellFirstLine && caretLine === 0 && caretInLine === 0) {
      chosen = 0
      column = 0
    } else if (shellHasSyntheticSpace && caretLine === 0 && caretInLine === 1) {
      chosen = 0
      column = 1
    } else {
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!
        const rowEnd = row.startInLine + row.text.slice(row.prefix.length).length
        if (row.logicalLine === caretLine && caretInLine >= row.startInLine && caretInLine <= rowEnd) {
          chosen = index
          column = row.widthBefore + textWidth(row.text.slice(row.prefix.length, row.prefix.length + (caretInLine - row.startInLine)))
          break
        }
      }
    }
    if (maxBodyRows === undefined) return { rows, caretRow: chosen, caretColumn: column, windowStartRow: 0 }
    const bodyRows = Math.max(1, Math.floor(maxBodyRows))
    // Minimal movement: clamp the window into the shrunk draft first, then
    // slide it the shortest distance that makes the caret visible.
    let start: number
    if (this.windowStart === null) {
      start = Math.max(0, Math.min(rows.length - bodyRows, chosen - bodyRows + 1))
    } else {
      start = Math.max(0, Math.min(this.windowStart, rows.length - bodyRows))
      if (chosen < start) start = chosen
      if (chosen >= start + bodyRows) start = chosen - bodyRows + 1
    }
    // Render-time window state: the offset derives against the render
    // geometry, so it updates where the geometry is known. The write is
    // idempotent — re-deriving with the stored start yields the same
    // start — so renderLines and renderRuns laying out the same frame
    // can never observe an intermediate window.
    this.windowStart = start
    return { rows, caretRow: chosen, caretColumn: column, windowStartRow: start }
  }

  /**
   * Wrapped rows for one logical line at one width, cached by
   * (width, first-line flag, text): a row's shape depends on nothing
   * else — PREFIX_FIRST is a line-0 property, the caret scan and
   * window state run after assembly — so an unchanged line's rows are
   * reused verbatim across frames and drafts.
   */
  private lineRowTemplates(width: number, isFirstLogicalLine: boolean, lineText: string, shellMode: boolean): readonly RowTemplate[] {
    const shellLine = isFirstLogicalLine && shellMode && lineText.startsWith("!")
    const firstPrefix = shellLine ? (lineText[1] !== undefined && lineText[1] !== " " && lineText[1] !== "\n" ? "! " : "!") : PREFIX_FIRST
    const sourceStart = shellLine ? 1 : 0
    const content = shellLine ? lineText.slice(1) : lineText
    const key = `${width}:${isFirstLogicalLine ? 1 : 0}:${shellLine ? 1 : 0}:${lineText}`
    const cached = this.rowTemplates.get(key)
    if (cached !== undefined) return cached
    const templates: RowTemplate[] = []
    let visual = ""
    let visualWidth = 0
    let startInLine = sourceStart
    let usedFirst = isFirstLogicalLine
    for (const piece of graphemes(content)) {
      const prefix = usedFirst ? firstPrefix : PREFIX_REST
      const widthBefore = textWidth(prefix)
      const pieceWidth = graphemeWidth(piece)
      // The row budget accrues per grapheme: rescanning the growing
      // row would make every keystroke on a long draft cost the row
      // width squared.
      if (widthBefore + visualWidth + pieceWidth > width && visualWidth > 0) {
        templates.push({
          text: prefix + visual,
          startInLine,
          widthBefore,
          prefix,
          prefixKind: usedFirst ? (shellLine ? "shell" : "ordinary") : "continuation",
        })
        startInLine += visual.length
        visual = ""
        visualWidth = 0
        usedFirst = false
      }
      visual += piece
      visualWidth += pieceWidth
    }
    const prefix = usedFirst ? firstPrefix : PREFIX_REST
    templates.push({
      text: prefix + visual,
      startInLine,
      widthBefore: textWidth(prefix),
      prefix,
      prefixKind: usedFirst ? (shellLine ? "shell" : "ordinary") : "continuation",
    })
    if (this.rowTemplates.size >= MAX_ROW_TEMPLATES) this.rowTemplates.clear()
    this.rowTemplates.set(key, templates)
    return templates
  }

  private notifyCompletionContext(allowOpen = true): boolean {
    const context = this.completionContext()
    const observed = this.onCompletionContextChange?.(allowOpen ? context : null)
    this.activeCompletionContext = allowOpen && observed !== false ? context : null
    return this.activeCompletionContext !== null
  }

  private changed(): ComposerOutcome {
    this.notifyCompletionContext()
    this.revision += 1
    return { kind: "changed" }
  }

  /**
   * Any text mutation: one undo unit, one revision bump. An edit that
   * declined (a delete at a boundary, an empty paste) leaves no trace —
   * no undo unit, no redo wipe, no revision — so an inert keypress
   * mints nothing upstream either.
   */
  private mutate(edit: () => void, notifyCompletion = true): ComposerOutcome | undefined {
    const before = { text: this.draft, caret: this.caret }
    this.undoStack.push(before)
    const redoCleared = this.redoStack.splice(0)
    edit()
    if (this.draft === before.text && this.caret === before.caret) {
      this.undoStack.pop()
      this.redoStack.push(...redoCleared)
      return undefined
    }
    if (notifyCompletion) this.notifyCompletionContext()
    this.revision += 1
    return { kind: "changed" }
  }

  private submit(): ComposerOutcome | undefined {
    if (this.draft.trim().length === 0) return undefined
    // The composer shows collapsed paste chips; the model and persistent
    // prompt history both receive the expanded content.
    const expanded = expandPastedTokens(this.draft, this.pastedTokens)
    this.undoStack.push({ text: this.draft, caret: this.caret })
    this.redoStack.length = 0
    this.draft = ""
    this.rowTemplates.clear()
    this.caret = 0
    this.windowStart = null
    this.revision += 1
    this.notifyCompletionContext()
    return { kind: "submitted", text: expanded }
  }

  /**
   * Large pastes collapse into chips; the raw content waits in the token
   * map. Bracketed paste and the host text ingress are the ingresses of
   * arbitrary host text, and the draft is display state the kernel
   * measures: both land sanitized — escape sequences stripped (Ink
   * passes OSC and BEL through verbatim, so unsanitized bytes would
   * reach the terminal) and tabs widened to spaces so the measured
   * width and the rendered width agree at the caret.
   */
  private insertPasted(value: string): void {
    const clean = sanitizeText(value).replace(/\t/g, "    ")
    if (!shouldCollapsePaste(clean)) {
      this.insert(clean)
      return
    }
    this.pasteSequence += 1
    if (this.pastedTokens.size >= MAX_PASTE_ATTACHMENTS) this.pastedTokens.clear()
    this.pastedTokens.set(this.pasteSequence, clean)
    this.insert(formatPastedToken(this.pasteSequence, clean))
  }

  private move(direction: "up" | "down" | "left" | "right" | "page-up" | "page-down"): ComposerOutcome | undefined {
    if (direction === "left" || direction === "right") {
      const next = this.stepGrapheme(direction === "left" ? -1 : 1)
      if (next === this.caret) return undefined
      this.caret = next
      return this.changed()
    }
    if (direction !== "up" && direction !== "down") return undefined
    const line = this.lineIndexForOffset(this.caret)
    const starts = this.lineStarts()
    const target = direction === "up" ? line - 1 : line + 1
    if (target < 0 || target >= starts.length) return undefined
    // The column carries by grapheme count, never code units, so the caret
    // always lands on a cluster boundary even when adjacent lines pair
    // surrogates or combining marks differently.
    const column = this.graphemeCount(this.draft.slice(this.lineStartForOffset(line), this.caret))
    this.caret = this.lineStartForOffset(target) + this.offsetAtGrapheme(this.logicalLineText(target), column)
    return this.changed()
  }

  /**
   * Caret-only edge moves (readline Ctrl+A/Ctrl+E): the caret lands on
   * the containing logical line's start or on its text end — before
   * the newline — and an inert move mints no revision and no undo unit.
   */
  private moveToLineEdge(edge: "start" | "end"): ComposerOutcome | undefined {
    const line = this.lineIndexForOffset(this.caret)
    const start = this.lineStartForOffset(line)
    const next = edge === "start" ? start : start + this.logicalLineText(line).length
    if (next === this.caret) return undefined
    this.caret = next
    return this.changed()
  }

  private graphemeCount(text: string): number {
    return graphemes(text).length
  }

  /** Code-unit offset `column` graphemes into `text`, clamped to the end. */
  private offsetAtGrapheme(text: string, column: number): number {
    let offset = 0
    let remaining = column
    for (const piece of graphemes(text)) {
      if (remaining <= 0) break
      offset += piece.length
      remaining -= 1
    }
    return offset
  }

  /**
   * Step the caret one grapheme across the draft, segmenting only the
   * logical line that holds it. Newlines are their own clusters (UAX
   * #29 GB4/GB5), so in-line boundaries match the whole-draft walk
   * exactly when the newline positions are honored: a left step off a
   * line start lands immediately before the previous line's newline,
   * and a right step at a line's text end crosses onto the next line
   * start.
   */
  private stepGrapheme(delta: number): number {
    const starts = this.lineStarts()
    const line = this.lineIndexForOffset(this.caret)
    const start = starts[line]!
    const inLine = this.caret - start
    const lineText = this.logicalLineText(line)
    if (delta < 0) {
      if (inLine === 0) return line === 0 ? 0 : start - 1
      let previous = 0
      let onBoundary = false
      let offset = 0
      for (const piece of graphemes(lineText)) {
        offset += piece.length
        if (offset >= inLine) {
          onBoundary = offset === inLine
          break
        }
        previous = offset
      }
      return onBoundary ? start + previous : this.caret
    }
    if (inLine < lineText.length) {
      let offset = 0
      for (const piece of graphemes(lineText)) {
        if (offset === inLine) return start + offset + piece.length
        offset += piece.length
      }
      return this.caret
    }
    return line + 1 < starts.length ? this.caret + 1 : this.caret
  }

  /**
   * Length of the grapheme cluster starting at the caret, segmenting
   * only the containing line. Past the line's last cluster the cluster
   * ahead is the newline itself (length 1 — forward-delete at a line
   * end joins lines); the final line has nothing beyond.
   */
  private forwardGraphemeLength(): number {
    const starts = this.lineStarts()
    const line = this.lineIndexForOffset(this.caret)
    const inLine = this.caret - starts[line]!
    let offset = 0
    for (const piece of graphemes(this.logicalLineText(line))) {
      if (offset >= inLine) return piece.length
      offset += piece.length
    }
    return line + 1 < starts.length ? 1 : 0
  }

  private insert(value: string): void {
    this.draft = this.draft.slice(0, this.caret) + value + this.draft.slice(this.caret)
    this.caret += value.length
  }

  private deleteBackward(): void {
    if (this.caret === 0) return
    this.caret = this.stepGrapheme(-1)
    this.draft = this.draft.slice(0, this.caret) + this.draft.slice(this.caret + this.forwardGraphemeLength())
  }

  private deleteForward(): void {
    if (this.caret >= this.draft.length) return
    this.draft = this.draft.slice(0, this.caret) + this.draft.slice(this.caret + this.forwardGraphemeLength())
  }

  private undoEdit(): ComposerOutcome | undefined {
    const previous = this.undoStack.pop()
    if (previous === undefined) return undefined
    this.redoStack.push({ text: this.draft, caret: this.caret })
    this.draft = previous.text
    this.caret = Math.min(previous.caret, this.draft.length)
    return this.changed()
  }

  private redoEdit(): ComposerOutcome | undefined {
    const next = this.redoStack.pop()
    if (next === undefined) return undefined
    this.undoStack.push({ text: this.draft, caret: this.caret })
    this.draft = next.text
    this.caret = Math.min(next.caret, this.draft.length)
    return this.changed()
  }

  /**
   * Logical-line start offsets for the current draft, rebuilt whenever
   * the draft value changes. One O(draft) pass serves the caret line
   * lookup, line starts, line text slices, and per-line grapheme
   * stepping, instead of a per-call rescan.
   */
  private lineStarts(): readonly number[] {
    if (this.lineStartsByDraft?.draft !== this.draft) {
      const starts = [0]
      for (let index = 0; index < this.draft.length; index += 1) {
        if (this.draft[index] === "\n") starts.push(index + 1)
      }
      this.lineStartsByDraft = { draft: this.draft, starts }
    }
    return this.lineStartsByDraft.starts
  }

  private lineIndexForOffset(offset: number): number {
    const starts = this.lineStarts()
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >>> 1
      if (starts[middle]! <= offset) low = middle
      else high = middle - 1
    }
    return low
  }

  private lineStartForOffset(line: number): number {
    const starts = this.lineStarts()
    return line < starts.length ? starts[line]! : this.draft.length
  }

  /** Text of one logical line, sliced from the cached line starts. */
  private logicalLineText(line: number): string {
    const starts = this.lineStarts()
    const start = starts[line]!
    const end = line + 1 < starts.length ? starts[line + 1]! - 1 : this.draft.length
    return this.draft.slice(start, end)
  }

  private clampCaret(): void {
    this.caret = Math.max(0, Math.min(this.draft.length, this.caret))
  }
}
