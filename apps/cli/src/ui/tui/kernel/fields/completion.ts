/**
 * Completion picker state: the non-modal companion beside the composer. It
 * never owns the draft or the query — the editor kernel derives the
 * completion context, this kernel only keeps a bounded candidate snapshot,
 * the selection, and dismiss state. The visible window is derived
 * statelessly from the selection (fzf-style: clamped around a
 * selection-biased center), so every candidate stays reachable with the
 * arrow keys regardless of the granted row budget.
 */
import type { TuiIntent } from "../../keys/index.js"
import { graphemes, sanitizeText } from "../../text/index.js"
import type { MatchResult } from "./matching.js"

/** Where a completion token sits in the draft and what it queries. */
export interface CompletionContext {
  readonly kind: "mention" | "command"
  readonly replaceRange: readonly [number, number]
  readonly query: string
}

/** One selectable candidate row of a picker. */
export interface CompletionCandidate {
  readonly key: string
  readonly label: string
  readonly insertText: string
  readonly disabled?: boolean
  readonly detail?: string
  /** Label-grapheme ranges to underline as matched. */
  readonly matchRanges?: readonly { readonly start: number; readonly end: number }[]
}

/** Candidate rows the view should render plus the list's global shape. */
export interface CompletionWindow {
  readonly items: readonly CompletionCandidate[]
  readonly selectedKey: string | null
  /** 0-based index of the selection within the FULL candidate list. */
  readonly selectedIndex: number
  /** Index of the first visible row within the FULL candidate list. */
  readonly startIndex: number
  readonly total: number
}

/**
 * What the picker did with an intent it accepted. A handled outcome
 * carries whether the visible window moved: a selection clamped onto
 * the row the window already shows changed nothing the owner could
 * commit, so an inert press mints no revision upstream.
 */
export type PickerOutcome =
  | {
      readonly kind: "commit"
      readonly insertText: string
      readonly replaceRange: readonly [number, number]
      /**
       * The kind and query this ranking was minted against: the
       * kernel's replaceDraftRange guard rejects the replacement when
       * the range now answers a different token than the one these
       * candidates were ranked for.
       */
      readonly expected: Pick<CompletionContext, "kind" | "query">
      /** Command contexts submit right after inserting (Enter runs it). */
      readonly submitAfter: boolean
    }
  | { readonly kind: "handled"; readonly changed: boolean }

const WINDOW_ROWS = 8
/**
 * @ mention pickers page the top of the ranking (corpora are whole trees);
 * command registries are small enough to list whole.
 */
export const MAX_MENTION_CANDIDATES = 50

export class CompletionPicker {
  private items: readonly CompletionCandidate[] = []
  private selectedKey: string | null = null
  private context: CompletionContext | null = null
  private dismissed = false
  private signature: string | null = null

  /**
   * Replace the snapshot; a changed context (kind, range, query) resets
   * selection and dismissal — typing on is a fresh list, not the old one.
   */
  sync(context: CompletionContext | null, candidates: readonly CompletionCandidate[]): void {
    const signature = context === null ? null : `${context.kind}:${context.replaceRange[0]}:${context.replaceRange[1]}:${context.query}`
    if (signature !== this.signature) {
      this.dismissed = false
      this.selectedKey = null
      this.signature = signature
    }
    this.context = context
    this.items = [...candidates]
    if (this.selectedKey !== null && !this.items.some((item) => item.key === this.selectedKey)) this.selectedKey = null
  }

  selected(): CompletionCandidate | undefined {
    if (this.selectedKey === null) return this.items.find((item) => !item.disabled)
    const selected = this.items.find((item) => item.key === this.selectedKey)
    if (selected !== undefined && !selected.disabled) return selected
    return this.items.find((item) => !item.disabled)
  }

  isVisible(): boolean {
    return this.context !== null && !this.dismissed && this.items.some((item) => !item.disabled)
  }

  /**
   * The visible slice: the window centers on the selection (clamped to the
   * list bounds), so a selection inside the current band keeps the window
   * and one past its midpoint slides it.
   */
  window(maxRows = WINDOW_ROWS): CompletionWindow {
    const selected = this.selected()
    const selectedKey = selected?.key ?? null
    const selectedIndex = selected === undefined ? 0 : this.items.findIndex((item) => item.key === selected.key)
    const total = this.items.length
    const rows = this.windowRows(maxRows)
    if (rows === 0) return { items: [], selectedKey, selectedIndex, startIndex: selectedIndex, total }
    if (total <= rows) return { items: this.items, selectedKey, selectedIndex, startIndex: 0, total }
    const desired = Math.max(0, Math.min(selectedIndex - Math.floor(rows / 2), total - rows))
    return { items: this.items.slice(desired, desired + rows), selectedKey, selectedIndex, startIndex: desired, total }
  }

  /**
   * Accept an intent while visible: Escape dismisses, Enter commits (and
   * submits for command contexts), Tab only inserts, arrows move the
   * selection. Anything else returns undefined for the caller to route.
   */
  dispatch(intent: TuiIntent): PickerOutcome | undefined {
    if (!this.isVisible()) return undefined
    if (intent.kind === "back") {
      this.dismissed = true
      return { kind: "handled", changed: true }
    }
    if (intent.kind === "activate") return this.commit(false)
    if (intent.kind === "advance") return this.commit(true)
    if (intent.kind === "navigate" && (intent.direction === "up" || intent.direction === "down")) {
      const available = this.items.filter((item) => !item.disabled)
      const current = this.selected()
      const currentIndex = current === undefined ? -1 : available.findIndex((item) => item.key === current.key)
      return this.select(currentIndex + (intent.direction === "up" ? -1 : 1))
    }
    return undefined
  }

  private commit(insertOnly: boolean): PickerOutcome | undefined {
    const selected = this.selected()
    const context = this.context
    if (selected === undefined || selected.disabled || context === null) return undefined
    this.dismissed = true
    return {
      kind: "commit",
      insertText: selected.insertText,
      replaceRange: context.replaceRange,
      expected: { kind: context.kind, query: context.query },
      submitAfter: !insertOnly && context.kind === "command",
    }
  }

  private select(position: number): PickerOutcome | undefined {
    const available = this.items.filter((item) => !item.disabled)
    if (available.length === 0) return undefined
    const target = available[Math.max(0, Math.min(available.length - 1, position))]
    if (target === undefined) return undefined
    // The effective selection (fallback included) decides whether the
    // move is observable: clamping onto the row the window already
    // shows is not a visible move.
    const before = this.selected()?.key ?? null
    this.selectedKey = target.key
    return { kind: "handled", changed: before !== target.key }
  }

  private windowRows(maxRows: number): number {
    return Math.max(0, Math.min(WINDOW_ROWS, this.items.length, Math.floor(maxRows)))
  }
}

/** Grapheme offset of `needle` inside `haystack`, or null when absent. */
function graphemeSubsequenceOffset(haystack: readonly string[], needle: readonly string[]): number | null {
  if (needle.length === 0) return 0
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((value, index) => haystack[start + index] === value)) return start
  }
  return null
}

function graphemesOf(text: string): readonly string[] {
  return graphemes(text)
}

/**
 * Translate a match's field coordinates onto the displayed label. The
 * field's clusters inside the label land every range on the cluster it
 * matched; overlapping ranges merge. The offset is the field's first
 * occurrence in the label: when the label repeats the field text the
 * underline may sit on the earlier copy — cosmetic only, both copies
 * highlight the same matched field.
 */
function matchRangesForLabel(labelClusters: readonly string[], result: MatchResult): readonly { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  for (const fieldMatch of result.fieldMatches) {
    const fields = result.item.fields as Readonly<Record<string, string | undefined>> | undefined
    const value =
      fields?.[fieldMatch.field] ?? (fieldMatch.field === "basename" || fieldMatch.field === "command" ? result.item.label : undefined)
    if (value === undefined) continue
    const offset = graphemeSubsequenceOffset(labelClusters, graphemesOf(value))
    if (offset === null) continue
    for (const range of fieldMatch.matchedRanges) ranges.push({ start: offset + range.start, end: offset + range.end })
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: { start: number; end: number }[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.start <= previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) }
    } else {
      merged.push(range)
    }
  }
  return merged
}

/**
 * Minting is the sanitization seam for picker content: rows render
 * label and detail as raw spans and the committed text lands in the
 * draft, so control bytes from source strings (file names, registry
 * details) die here. A newline flattens to a space because a picker
 * row is one line by contract.
 */
const displayLine = (text: string): string => sanitizeText(text).replace(/[\t\n]/g, " ")

/** Mint the mention picker rows for a query's ranked matches. */
export function mentionCandidates(matches: readonly MatchResult[]): readonly CompletionCandidate[] {
  return matches.slice(0, MAX_MENTION_CANDIDATES).map((result) => {
    const label = displayLine(result.item.label)
    const insertText = `@${label}`
    // Directories keep the cursor inside the path (no trailing space) so
    // typing continues the match; files commit the token.
    const directory = result.item.label.endsWith("/")
    return {
      key: result.item.id,
      label,
      insertText: directory ? insertText : `${insertText} `,
      ...(result.item.detail === undefined ? {} : { detail: displayLine(result.item.detail) }),
      matchRanges: matchRangesForLabel(graphemesOf(label), result),
    }
  })
}

/** Mint the command picker rows for a query's ranked matches. */
export function commandCandidates(matches: readonly MatchResult[]): readonly CompletionCandidate[] {
  return matches.map((result) => {
    const label = `/${displayLine(result.item.label)}`
    return {
      key: result.item.id,
      label,
      insertText: `${label} `,
      ...(result.item.detail === undefined ? {} : { detail: displayLine(result.item.detail) }),
      matchRanges: matchRangesForLabel(graphemesOf(label), result),
    }
  })
}
