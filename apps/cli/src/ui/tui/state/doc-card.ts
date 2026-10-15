/**
 * Document card: a read-only host document (the /help listing, the
 * /status report, the provider and context views) as one paged card —
 * the title names the frame, the lines render as the body through the
 * shared document pager, and nothing is operable. A visible card owns
 * every key but interrupt: the navigation keys page the document,
 * Escape closes it, and stray characters are absorbed — the draft
 * never moves under a modal. The card holds no authority of its own:
 * the host composes the lines and hands them over.
 */
import type { TuiIntent } from "../keys/index.js"
import { expandTabs, frameInnerWidth, sanitizeText, wrapVerbatim } from "../text/index.js"
import { cardSnapshot, type CardSnapshot } from "./card.js"
import { DocPager } from "./pager.js"

/** The document the host wants shown, composed at open time. */
export interface DocCardDocument {
  readonly title: string
  readonly lines: readonly string[]
}

/** One dispatched key while the card is visible. */
export interface DocCardResult {
  /** Whether the visible card changed; the store repaints only then. */
  readonly changed: boolean
}

const HINT_CLOSE = "esc close"

export class DocCard {
  private document: DocCardDocument | null = null
  private pager: DocPager | null = null
  private pagerWidth: number | null = null

  /**
   * Open a document; false when it holds no line at all (there is
   * nothing to show, and the request mints no revision).
   */
  open(document: DocCardDocument): boolean {
    const pager = new DocPager(document.lines)
    if (pager.isEmpty) return false
    this.document = { title: document.title, lines: [...document.lines] }
    this.pager = pager
    this.pagerWidth = null
    return true
  }

  /** Close the visible card; false when it was already hidden. */
  close(): boolean {
    if (this.document === null) return false
    this.document = null
    this.pager = null
    this.pagerWidth = null
    return true
  }

  /** Claimable while a document is open. */
  isVisible(): boolean {
    return this.document !== null
  }

  /**
   * Route one intent while visible: null only when nothing is open; a
   * visible card claims every key — navigation pages the document,
   * Escape closes it, and everything else is absorbed without change.
   */
  dispatch(intent: TuiIntent): DocCardResult | null {
    if (this.document === null) return null
    if (intent.kind === "back") {
      this.close()
      return { changed: true }
    }
    if (intent.kind === "navigate") return { changed: this.pager!.move(intent.direction) }
    return { changed: false }
  }

  /**
   * Render-ready snapshot; null hides it. The document window is the
   * visible page of lines; the page indicator joins the close legend
   * as the hint row.
   */
  snapshot(width?: number): CardSnapshot | null {
    if (this.document === null || this.pager === null) return null
    const innerWidth = width === undefined ? null : Math.max(1, frameInnerWidth(width))
    if (innerWidth !== this.pagerWidth) {
      // Re-wrapping re-pages the document; the reading position rides
      // its absolute row so a resize glances instead of restarting
      // from the top.
      const anchor = this.pager.anchorRow()
      const lines =
        innerWidth === null
          ? this.document.lines
          : // Verbatim spans count a raw tab as one cell, so the card
            // expands tabs at the terminal's stops before wrapping.
            this.document.lines.flatMap((line) => wrapVerbatim(expandTabs(sanitizeText(line)), innerWidth))
      this.pager = new DocPager(lines)
      this.pager.restoreRow(anchor)
      this.pagerWidth = innerWidth
    }
    const pager = this.pager
    return cardSnapshot({
      tabLabels: [this.document.title],
      activeTabIndex: 0,
      body: pager.pageLines().map((line) => [{ text: line, token: "text" as const }]),
      items: [],
      focusedIndex: null,
      focusedKey: null,
      multiSelect: false,
      lastTab: true,
      hints: [`page ${pager.pageNumber}/${pager.pageCount}`, HINT_CLOSE],
      markers: "none",
      title: this.document.title,
    })
  }
}
