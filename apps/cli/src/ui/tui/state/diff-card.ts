/**
 * Diff card: the changed-file list (/diff and the review list) with a
 * paged document preview stacked inside one card. The list renders
 * markerless rows — files are operable navigation units, not a pick-one
 * answer — and Enter adopts the focused file's detail as the preview
 * document: logical pages of a fixed height, line scroll walking within
 * a page across page boundaries, whole-page jumps on the horizontal and
 * page keys. Escape pops one level (preview back to the list, list to
 * the TUI); a visible card owns every key but interrupt — stray
 * characters are absorbed, never drafted. The card holds no git or
 * projection authority: the host seeds the file list, and the review
 * seeding derives it from settled tool blocks.
 */
import type { TuiIntent } from "../keys/index.js"
import { CardShellMachine, cardSnapshot, type CardSnapshot } from "./card.js"
import { DocPager } from "./pager.js"

/** One changed file: path label, summary line, and the preview body. */
export interface DiffFileOption {
  readonly path: string
  readonly description: string
  readonly detail: readonly string[]
}

/** Diff line shape of a review entry (mirrors the projection vocabulary without a type edge). */
export interface DiffReviewLine {
  readonly kind: "context" | "added" | "removed"
  readonly text: string
}

/** Structured patch of a review entry (display channel; counts and truncation flag included). */
export interface DiffReviewPatch {
  readonly hunks: readonly {
    readonly oldStart: number
    readonly newStart: number
    readonly oldLines: number
    readonly newLines: number
    readonly lines: readonly DiffReviewLine[]
  }[]
  readonly addedLines: number
  readonly removedLines: number
  readonly sites: number
  readonly truncated?: boolean
}

/** Structural view of a settled tool block carrying a display diff; the projection's tool block satisfies this without a type edge. */
export interface DiffReviewBlock {
  readonly name: string
  readonly input?: unknown
  readonly diff: DiffReviewPatch
}

/**
 * Seed the review list from settled diff-carrying tool blocks: one
 * entry per block, labeled by file path with counts, the full persisted
 * patch as preview lines, and an honest truncation marker when the size
 * cap applied.
 */
export function diffReviewOptions(blocks: readonly DiffReviewBlock[]): readonly DiffFileOption[] {
  return blocks.map((block) => {
    const input =
      typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
        ? (block.input as Record<string, unknown>)
        : undefined
    const rawPath = input?.file_path ?? input?.path
    const path = typeof rawPath === "string" && rawPath.length > 0 ? rawPath : block.name
    return {
      path,
      description: `+${block.diff.addedLines} · -${block.diff.removedLines}${block.diff.sites > 1 ? ` · ${block.diff.sites} sites` : ""}${
        block.diff.truncated === true ? " · truncated" : ""
      }`,
      detail: patchText(block.diff),
    }
  })
}

/**
 * Full patch as plain preview lines: hunk headers and sigil rows, line
 * terminators stripped. The truncation tail carries no cap numbers —
 * the size limits live outside the TUI tree, and duplicating them here
 * would be a second source of truth.
 */
function patchText(diff: DiffReviewPatch): readonly string[] {
  const lines: string[] = []
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) {
      const sigil = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "
      lines.push(`${sigil}${line.text.replace(/\r?\n$/u, "")}`)
    }
  }
  if (diff.truncated === true) lines.push("… patch truncated")
  return lines
}

/** One dispatched key while the card is visible. */
export interface DiffCardResult {
  /** Whether the visible card changed; the store repaints only then. */
  readonly changed: boolean
  readonly effects: readonly never[]
}

/** Preview pages are the card's own row budget: the frame always fits. */
const PREVIEW_PAGE_HEIGHT = 9

const TAB_KEY = "diff"
const TAB_LABEL = "Changes"
const LIST_HINTS = ["enter open", "esc close"] as const

export class DiffCard {
  private readonly machine = new CardShellMachine({ itemWindow: 8 })
  private files: readonly DiffFileOption[] = []
  private opened = false
  /** The preview document: null keeps the card in list mode. */
  private preview: { readonly path: string; readonly pager: DocPager } | null = null

  /** Open the file list with focus on the first file; the preview resets. */
  open(files: readonly DiffFileOption[]): void {
    this.opened = true
    this.files = [...files]
    this.preview = null
    this.machine.load([
      {
        key: TAB_KEY,
        label: TAB_LABEL,
        items: files.map((file) => ({
          key: file.path,
          label: file.path,
          ...(file.description.length === 0 ? {} : { description: file.description }),
        })),
      },
    ])
  }

  /** Close the visible card; false when it was already hidden. */
  close(): boolean {
    if (!this.opened) return false
    this.opened = false
    return true
  }

  /** Claimable while open with at least one file to show. */
  isVisible(): boolean {
    return this.opened && this.files.length > 0
  }

  /**
   * Route one intent while visible: null only when the card is not
   * visible; a visible card claims every key (an unhandled one is
   * absorbed with changed false — the draft never moves under a modal).
   */
  dispatch(intent: TuiIntent): DiffCardResult | null {
    if (!this.isVisible()) return null
    if (intent.kind === "back") {
      // Escape pops one level: a preview returns to its list, a list closes.
      if (this.preview !== null) {
        this.preview = null
        return { changed: true, effects: [] }
      }
      this.opened = false
      return { changed: true, effects: [] }
    }
    if (this.preview !== null) {
      if (intent.kind !== "navigate") return { changed: false, effects: [] }
      return { changed: this.preview.pager.move(intent.direction), effects: [] }
    }
    const result = this.machine.dispatch(intent)
    if (result.outcome === "confirmed") {
      const file = this.focusedFile()
      if (file === undefined) return { changed: false, effects: [] }
      this.preview = { path: file.path, pager: new DocPager(file.detail, PREVIEW_PAGE_HEIGHT) }
      return { changed: true, effects: [] }
    }
    return { changed: result.changed, effects: [] }
  }

  /**
   * Render-ready snapshot; null hides it. The list renders markerless
   * rows with the open/close legend; the preview renders the document
   * window — crumbs naming the list it sits above, the visible page
   * lines from the scroll offset, and the page indicator as the hint.
   */
  snapshot(): CardSnapshot | null {
    if (!this.isVisible()) return null
    if (this.preview === null) {
      return cardSnapshot({ ...this.machine.snapshot(), markers: "none", hints: [...LIST_HINTS] })
    }
    const pager = this.preview.pager
    return cardSnapshot({
      tabLabels: [this.preview.path],
      activeTabIndex: 0,
      body: pager.pageLines().map((line) => [{ text: line, token: "text" as const }]),
      items: [],
      focusedIndex: null,
      focusedKey: null,
      multiSelect: false,
      lastTab: true,
      hints: [`page ${pager.pageNumber}/${pager.pageCount}`, "esc back"],
      markers: "none",
      breadcrumb: [TAB_LABEL, this.preview.path],
    })
  }

  /** The file under the machine's focus; rows are keyed by their unique path. */
  private focusedFile(): DiffFileOption | undefined {
    const key = this.machine.snapshot().focusedKey
    return key === null ? undefined : this.files.find((file) => file.path === key)
  }
}
