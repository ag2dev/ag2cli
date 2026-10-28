import { clipText } from "./measure.js"

export type ComposerSurfaceRow =
  | { readonly kind: "hint"; readonly text: string; readonly token: "muted" | "bashMode" }
  | { readonly kind: "gap" }
  | { readonly kind: "input"; readonly index: number }
  | { readonly kind: "candidate"; readonly index: number }

export interface ComposerSurfaceInput {
  /** Available terminal columns for each surface row. */
  readonly width: number
  /** Rows left after the rest of the terminal frame and footer are reserved. */
  readonly availableRows: number
  /** One transient or mode hint; ordinary idle and completion states have none. */
  readonly hint: { readonly text: string; readonly token: "muted" | "bashMode" } | null
  /** Natural editor wrapping from the shared composer kernel. */
  readonly inputRowCount: number
  /** Candidate rows available from the picker's bounded window. */
  readonly candidateCount: number
}

export interface ComposerSurfaceLayout {
  /** The one row ledger used by layout budgeting and rendering. */
  readonly rows: readonly ComposerSurfaceRow[]
  readonly inputRowCount: number
  readonly candidateRowCount: number
  readonly height: number
  readonly hintVisible: boolean
}

const MINIMUM_INPUT_ROWS = 1

/**
 * Allocate the candidate list and input rows from the same bounded row
 * ledger used by the view and transcript budget.
 */
export function composerSurfaceLayout(input: ComposerSurfaceInput): ComposerSurfaceLayout {
  const width = Math.max(1, Math.floor(input.width))
  let remaining = Math.max(0, Math.floor(input.availableRows))
  const naturalInputRows = Math.max(MINIMUM_INPUT_ROWS, Math.floor(input.inputRowCount))
  const availableCandidates = Math.max(0, Math.floor(input.candidateCount))

  if (remaining < MINIMUM_INPUT_ROWS) {
    return { rows: [], inputRowCount: 0, candidateRowCount: 0, height: 0, hintVisible: false }
  }

  let inputRowCount = MINIMUM_INPUT_ROWS
  remaining -= MINIMUM_INPUT_ROWS

  let candidateRowCount = 0
  if (availableCandidates > 0 && remaining > 0) {
    candidateRowCount = 1
    remaining -= 1
  }

  const hintText = input.hint?.text.trim() ?? ""
  const hintVisible = hintText.length > 0 && remaining > 0
  if (hintVisible) remaining -= 1

  const extraInputRows = Math.min(naturalInputRows - inputRowCount, remaining)
  inputRowCount += extraInputRows
  remaining -= extraInputRows

  const extraCandidateRows = Math.min(availableCandidates - candidateRowCount, remaining)
  candidateRowCount += extraCandidateRows
  remaining -= extraCandidateRows

  const candidateGap = candidateRowCount > 0 && remaining > 0
  if (candidateGap) remaining -= 1
  const footerGap = remaining > 0

  const rows: ComposerSurfaceRow[] = [
    ...(hintVisible && input.hint !== null
      ? [{ kind: "hint" as const, text: clipText(hintText, width).text, token: input.hint.token }]
      : []),
    ...Array.from({ length: candidateRowCount }, (_, index) => ({ kind: "candidate" as const, index })),
    ...(candidateGap ? [{ kind: "gap" as const }] : []),
    ...Array.from({ length: inputRowCount }, (_, index) => ({ kind: "input" as const, index })),
    ...(footerGap ? [{ kind: "gap" as const }] : []),
  ]

  return { rows, inputRowCount, candidateRowCount, height: rows.length, hintVisible }
}
