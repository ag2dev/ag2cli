/**
 * Snapshot groups: the rendering contract beyond geometry, one group
 * per owner. The facade's TuiSnapshot carries these structurally; the
 * view layer reads them through indexed access on TuiSnapshot, so the
 * groups stay internal to the coordinator while the facade's export
 * surface stays fixed.
 */
import type { ChildStatus, SessionOrigin } from "./contract.js"
import type { SlotOwner } from "./run-queue.js"
import type { SubmissionReceipt } from "./submissions.js"
import type { PausedTaskRef } from "../tasks/index.js"
import type { DecisionFact } from "../decisions/index.js"
import type { TuiPlanRow } from "../session-mirror/index.js"
import type { AskSurfaceRow, ComposerSurfaceRow, TextRun, TranscriptLine } from "../../text/index.js"
import type { TaskComposerMode, TaskTabsView } from "../tasks/index.js"

export interface ComposerView {
  readonly text: string
  readonly caretOffset: number
  readonly visible: boolean
  /**
   * True exactly while no modal surface holds the input, or below the
   * support floor where the fallback routes every key back to the
   * composer — the same predicate the adjudication world carries.
   */
  readonly active: boolean
  /** Shared hint, rails, input and completion row ledger used by budgeting and Ink paint. */
  readonly surfaceRows: readonly ComposerSurfaceRow[]
  /** Styled visible editor rows from the same caret-follow window the composer kernel uses. */
  readonly inputRows: readonly (readonly TextRun[])[]
  readonly inputCaretRow: number
  readonly inputCaretColumn: number
}

export interface TaskFrameView {
  readonly title: string
  readonly composerMode: TaskComposerMode
  readonly steps: readonly string[]
  readonly tabs?: TaskTabsView
  /** The current step's choosable rows; empty for engines without a list surface. */
  readonly rows: readonly { readonly label: string; readonly description?: string; readonly focused: boolean }[]
  /** The current step's body lines (paged documents, tab annotations); empty when the engine carries none. */
  readonly body: readonly string[]
  readonly hints: readonly string[]
  readonly dirty: boolean
}

export interface CompanionCandidateView {
  readonly id: string
  readonly label: string
  readonly detail?: string
  /** The label's matched character ranges; the view emphasizes them against the query. */
  readonly matchRanges?: readonly { readonly start: number; readonly end: number }[]
}

export interface CompanionView {
  readonly open: boolean
  readonly kind: "command" | "path"
  readonly candidates: readonly CompanionCandidateView[]
  readonly focusIndex: number
  /** The affordance phrase the surface renders; null when no companion surface is open. */
  readonly typeRow: string | null
  /** The focused candidate's 1-based position and the full corpus size; null while uncounted. */
  readonly position: { readonly index: number; readonly total: number } | null
}

export interface RunSlotView {
  /** The run currently in flight per the session facts; null when the session is idle. */
  readonly runId: string | null
  readonly owner: SlotOwner
  readonly queued: readonly string[]
}

/**
 * The frame's parked-input preview: the mailbox rows plus the parked
 * slash queue, as one bounded prefix and the count of the rest. The
 * row budget here and the painted rows share this single derivation.
 */
export interface QueuePreviewView {
  readonly visible: readonly string[]
  readonly elided: number
}

export interface DecisionCursorView {
  readonly questionIndex: number
  /** The focused choice row over the card's full row space; null only when an ask has no options. */
  readonly armedIndex: number | null
  /** The option window's start index; the confirm and decline rows render outside it. */
  readonly windowStart: number
  readonly focus: "choices" | "other"
}

export interface DecisionsView {
  readonly presenting: {
    readonly fact: DecisionFact
    readonly cursor: DecisionCursorView
    /** The presenting question's working selection from the lease; the view paints the markers from it. */
    readonly selectedOptionIds: readonly string[]
    /** Ask's actual visible row ledger; kernel budgeting and Ink paint this same list. */
    readonly surfaceRows?: readonly AskSurfaceRow[]
  } | null
  readonly hiddenPending: readonly string[]
  readonly resolving: readonly string[]
  readonly unknown: readonly string[]
}

export interface TranscriptView {
  /** Every rendered line, fold-cached; the reader and the empty-check read it. */
  readonly lines: readonly TranscriptLine[]
  /** Current detailed-reader page; kept separate from the compact transcript viewport. */
  readonly readerRows: readonly string[]
  /** Same physical reader rows with their original transcript run styles. */
  readonly readerRuns: readonly (readonly TextRun[])[]
  /** The viewport's visible window at the frame's own transcript capacity. */
  readonly visible: readonly TranscriptLine[]
  /** The scrolled-off indicator the composer's rule row carries; null while following. */
  readonly indicator: string | null
  readonly readerOpen: boolean
  readonly readerPage: number
  readonly readerPages: number
}

/** A short composer gesture and its shared acceptance/display deadline. */
export type GestureHintView = {
  readonly kind: "exit" | "ctrl-d-exit" | "escape-clear" | "escape-rewind"
  readonly deadline: number
}
/** Compatibility projection for consumers that only inspect Ctrl+C exit confirmation. */
export type ExitConfirmView = { readonly deadline: number }

export interface FooterTelemetryView {
  readonly modelName?: string
  readonly contextTokens?: number
  readonly contextEstimated?: boolean
  readonly permissionMode?: string
}

export interface FooterView {
  readonly pending: readonly { readonly runId: string; readonly goal: string }[]
  /** Null while the host reports no context facts; the footer then renders its minimal line. */
  readonly telemetry: FooterTelemetryView | null
  /**
   * True while a tool block sits in the current content and no task or
   * decision card holds the stage; derived per frame, so the footer's
   * ctrl+o hint segment clears with the content itself.
   */
  readonly toolDetailsHint: boolean
}

/**
 * One delegated child on the board: identity and lifecycle plus the
 * retained tail ring. Terminal entries stay retained — the Alt ring
 * keeps reaching them — with the terminal summary in place of the
 * cancel affordance.
 */
export interface ChildEntryView {
  readonly childSessionId: string
  readonly description: string
  readonly subagentType?: string
  readonly status: ChildStatus
  readonly summary: string | null
  readonly lines: readonly string[]
}

/**
 * The focused panel's own window: page 0 is the newest tail window and
 * paging walks toward older lines, the step being the panel window
 * size. The window is derived, so the painted rows and the budget
 * cannot disagree.
 */
export interface ChildrenPanelView {
  readonly childSessionId: string
  readonly description: string
  readonly subagentType?: string
  readonly status: ChildStatus
  readonly summary: string | null
  readonly visibleLines: readonly string[]
  readonly page: number
  readonly pageCount: number
}

export interface ChildrenView {
  readonly entries: readonly ChildEntryView[]
  /** The focused child session id; null is the main conversation. */
  readonly focus: string | null
  readonly runningCount: number
  /** The registered summary row, present only while at least one child runs. */
  readonly summaryRow: string | null
  /** The focused entry's panel; null while the main conversation holds the stage. */
  readonly panel: ChildrenPanelView | null
}

/** The task's exit lever is snapshot-only state the taskFrame hints already carry. */
export interface FocusView {
  /** True while the open task's exit lever holds the form's Tab seat. */
  readonly taskActions: boolean
}

export interface TuiSnapshotGroups {
  readonly composer: ComposerView
  readonly taskFrame: TaskFrameView | null
  readonly notices: readonly string[]
  readonly receipts: readonly SubmissionReceipt[]
  readonly companion: CompanionView
  readonly runSlot: RunSlotView
  /** The plan chrome rows in first-appearance order; the view formats each row. */
  readonly plans: readonly TuiPlanRow[]
  readonly queue: QueuePreviewView
  /**
   * True exactly while the idle queue branch armed its cancel hint
   * and cancelable rows still exist; the view ranks its hint row
   * from this flag rather than re-deriving the branch.
   */
  readonly queueCancel: boolean
  readonly decisions: DecisionsView
  readonly transcript: TranscriptView
  readonly footer: FooterView
  readonly gestureHint: GestureHintView | null
  readonly exitConfirm: ExitConfirmView | null
  readonly pausedTasks: readonly PausedTaskRef[]
  readonly children: ChildrenView
  readonly focus: FocusView
  readonly binding: SessionOrigin | null
  readonly degraded: boolean
}
