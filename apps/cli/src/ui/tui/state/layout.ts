/**
 * Frame allocator: the one pure seam that turns one committed view
 * state's chrome plus the terminal geometry into every row budget the
 * frame spends — the open card's grant and painted rows, the
 * transcript window's capacity, the composer's body budget and rule
 * row — and the input and cursor ownership those budgets imply. Pure:
 * no store, no React, no terminal. The store calls it once per
 * committed revision and consumes exactly its fields, so the view
 * tree performs no second geometry arithmetic.
 *
 * Yoga fallback rule: the allocator's budgets are authoritative.
 * Every painted row is pre-wrapped or clipped by the text kernel
 * (wrapFooterSegments, renderCardLines, clipText, the editor kernel's
 * render runs) before Ink sees it, so Yoga measurement can neither
 * mint nor drop a row; wide-grapheme boundary rows count exactly one
 * row because the kernel wraps on grapheme boundaries. A real
 * divergence between a budget and the painted frame is a text-kernel
 * bug caught by frame and screen contract tests, never patched in the
 * view.
 *
 * Input pass-through order — the seam contract the store routes by
 * and the inputOwner field declares: the resting-screen policy claims
 * its vocabulary first, then the allocated card, then viewport
 * paging, then the completion picker, then the editor kernel as the
 * residual owner. A surface below its minimum rows holds no rights: a
 * card whose painted rows are zero, and every surface under the
 * support floor, loses its key claim — the keys fall through to the
 * next surface and the editor — and the editor cursor hides while a
 * modal owns input and below the support floor.
 */
import { CARD_ROW_CAP, renderCardLines, SUPPORT_FLOOR, wrapFooterSegments, type TextRun } from "../text/index.js"
import type { CardViewBody } from "./card.js"
import type { TranscriptChrome, TranscriptLayout } from "./lines.js"

/** The surface whose key claim holds; the editor is the residual owner. */
export type InputOwner = "card" | "completion" | "editor"

/** The open card's budget: what every other surface spends and what the frame paints. */
export interface CardAllocation {
  /** Natural rows under the shared cap — the budget capacity and the composer spend. */
  readonly budgetRows: number
  /** Rows the frame paints after the grant clamp. */
  readonly paintedRows: number
  /** The painted rows themselves; the snapshot carries them verbatim. */
  readonly lines: readonly (readonly TextRun[])[]
  /** A card with painted rows owns input; a zero-row card holds no claim. */
  readonly active: boolean
}

export interface FrameAllocation {
  readonly columns: number
  readonly rows: number
  readonly supportFloor: boolean
  readonly card: CardAllocation
  readonly transcriptCapacity: number
  readonly composerBodyRows: number
  readonly cursorVisible: boolean
  readonly inputOwner: InputOwner
  /**
   * The composer rule's absolute row once the rendered window is
   * known: the transcript rows it actually painted plus every chrome
   * surface between them and the rule.
   */
  composerPrefixRows(transcriptRows: number): number
}

/**
 * Rows every transcript-adjacent surface except the composer occupies:
 * the footer rule plus its wrapped lines, the hint, the two-row
 * notice, the parked-input rows plus their elision counter, the
 * picker's window plus its overflow letter, and the card rows handed
 * in — already pre-wrapped by the text kernel.
 */
function chromeRowsWithoutComposer(chrome: TranscriptChrome, columns: number, cardRows: number): number {
  let rows = 1 + wrapFooterSegments(chrome.footer, columns).length
  if (chrome.hint !== null) rows += 1
  if (chrome.notice !== null) rows += 2
  if (chrome.agentsRunning !== null) rows += 1
  rows += chrome.queued.visible.length + (chrome.queued.elided > 0 ? 1 : 0)
  if (chrome.completion !== null) {
    rows += chrome.completion.items.length + (chrome.completion.total > chrome.completion.items.length ? 1 : 0)
  }
  return rows + cardRows
}

/**
 * The composer's body-row budget: the draft's natural height under
 * its fixed cap, clamped to the rows left once every other surface —
 * including the composer's own rule row — claimed its own. Never
 * below one row: the composer always shows the line holding the
 * caret.
 */
function composerBodyRows(chrome: TranscriptChrome, layout: TranscriptLayout, cardRows: number): number {
  const columns = Math.max(1, layout.columns)
  return chrome.editor.kernel.bodyRows(columns, Math.max(1, layout.rows - chromeRowsWithoutComposer(chrome, columns, cardRows) - 1))
}

/**
 * Indicator-free transcript capacity: the rows left after every other
 * surface's rows under the geometry — the composer's rule row plus
 * its body at the geometry-clamped budget, and everything else
 * (including `cardRows` pre-wrapped rows) at natural rows. Natural
 * rows, never a granted budget, so no surface's height feeds back
 * into its own grant; the result clamps at zero.
 */
export function transcriptCapacity(chrome: TranscriptChrome, layout: TranscriptLayout, cardRows = 0): number {
  const columns = Math.max(1, layout.columns)
  const rows = 1 + chromeRowsWithoutComposer(chrome, columns, cardRows) + composerBodyRows(chrome, layout, cardRows)
  return Math.max(0, layout.rows - rows)
}

/**
 * Derive one frame's budgets from the chrome, the geometry and the
 * open card's view body. The grant ladder: the card's grant is the
 * capacity when no card paints; every other surface spends the card's
 * natural rows under the shared cap while the frame paints only the
 * granted prefix — a fitting card gives the window exactly its rows
 * back, and one that outgrows its grant floors the window at zero.
 */
export function allocateFrame(chrome: TranscriptChrome, layout: TranscriptLayout, card: CardViewBody | null): FrameAllocation {
  const columns = Math.max(1, layout.columns)
  const supportFloor = layout.columns < SUPPORT_FLOOR.columns || layout.rows < SUPPORT_FLOOR.rows
  const cardView = card === null ? null : { ...card, width: columns }
  const capped = cardView === null ? [] : renderCardLines(cardView, { maxRows: CARD_ROW_CAP })
  const budgetRows = capped.length
  const grant = transcriptCapacity(chrome, layout)
  const paintedGrant = Math.min(CARD_ROW_CAP, Math.max(0, grant))
  const lines = cardView !== null && budgetRows > paintedGrant ? renderCardLines(cardView, { maxRows: paintedGrant }) : capped
  const paintedRows = lines.length
  const active = !supportFloor && card !== null && paintedRows >= 1
  return {
    columns,
    rows: layout.rows,
    supportFloor,
    card: { budgetRows, paintedRows, lines, active },
    transcriptCapacity: transcriptCapacity(chrome, layout, budgetRows),
    composerBodyRows: composerBodyRows(chrome, layout, budgetRows),
    cursorVisible: !supportFloor && !active,
    inputOwner: active ? "card" : chrome.completion !== null && !supportFloor ? "completion" : "editor",
    composerPrefixRows: (transcriptRows) => {
      const footerRows = 1 + wrapFooterSegments(chrome.footer, columns).length
      // The hint and the running-children summary paint below the
      // rule, so their rows never count toward its baseline.
      return Math.max(
        0,
        transcriptRows +
          chromeRowsWithoutComposer(chrome, columns, paintedRows) -
          footerRows -
          (chrome.hint === null ? 0 : 1) -
          (chrome.agentsRunning === null ? 0 : 1),
      )
    },
  }
}
