/**
 * Document pager: fixed-height logical pages over a line document —
 * the one paging model every read-only card preview shares. Line
 * scroll walks within a page and crosses page boundaries (bottom of
 * one page into the top of the next, top of one into the bottom of
 * the previous); the horizontal and page keys move whole pages; a move
 * off the document edge changes nothing.
 */

/** Preview pages are the card's own row budget: the frame always fits. */
export const CARD_PAGE_HEIGHT = 9

export class DocPager {
  private readonly pages: readonly (readonly string[])[]
  private pageIndex = 0
  private lineOffset = 0

  constructor(
    lines: readonly string[],
    readonly height: number = CARD_PAGE_HEIGHT,
  ) {
    const normalized = lines.flatMap((line) => line.split("\n"))
    if (normalized.length === 0) {
      this.pages = [[]]
      return
    }
    const pages: (readonly string[])[] = []
    for (let start = 0; start < normalized.length; start += height) pages.push(normalized.slice(start, start + height))
    this.pages = pages
  }

  /** Whether the document holds any line at all. */
  get isEmpty(): boolean {
    return this.pages.length === 1 && this.pages[0]!.length === 0
  }

  /** The visible window: the current page from the scroll offset. */
  pageLines(): readonly string[] {
    return this.pages[this.pageIndex]!.slice(this.lineOffset)
  }

  /** 1-based page indicator. */
  get pageNumber(): number {
    return this.pageIndex + 1
  }

  get pageCount(): number {
    return this.pages.length
  }

  /**
   * Apply one move; false when nothing moved. Line keys (up/down)
   * scroll within a page and cross page boundaries; page keys and the
   * horizontal directions jump whole pages.
   */
  move(direction: "up" | "down" | "left" | "right" | "page-up" | "page-down"): boolean {
    const page = this.pages[this.pageIndex]!
    if (direction === "up" || direction === "down") {
      const next = this.lineOffset + (direction === "up" ? -1 : 1)
      if (next < 0) return this.jumpPage(this.pageIndex - 1, this.height - 1)
      if (next >= page.length) return this.jumpPage(this.pageIndex + 1, 0)
      this.lineOffset = next
      return true
    }
    if (direction === "page-up" || direction === "left") return this.jumpPage(this.pageIndex - 1, 0)
    return this.jumpPage(this.pageIndex + 1, 0)
  }

  /** Absolute row the visible window starts at: its page start plus the scroll offset. */
  anchorRow(): number {
    return this.pageIndex * this.height + this.lineOffset
  }

  /**
   * Restore an anchor captured before a re-wrap: every page but the
   * last holds exactly `height` rows, so the row resolves back to a
   * page and offset inside the new document.
   */
  restoreRow(row: number): void {
    const total = (this.pages.length - 1) * this.height + this.pages[this.pages.length - 1]!.length
    const bounded = Math.max(0, Math.min(total - 1, row))
    this.pageIndex = Math.floor(bounded / this.height)
    this.lineOffset = bounded - this.pageIndex * this.height
  }

  private jumpPage(index: number, lineOffset: number): boolean {
    if (index < 0 || index >= this.pages.length || index === this.pageIndex) return false
    this.pageIndex = index
    this.lineOffset = Math.max(0, Math.min(this.pages[index]!.length - 1, lineOffset))
    return true
  }
}
