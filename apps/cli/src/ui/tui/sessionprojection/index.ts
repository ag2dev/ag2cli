/**
 * Session projection protocol: immutable content snapshots with a projection
 * revision. The viewModel reads one revision per frame; half-updated state
 * is structurally unreachable. Blocks are a typed union: every block carries
 * a canonical plain-text view in `body` (tool blocks derive theirs from the
 * structured payload at merge time); tool-only fields live behind the kind
 * discriminator.
 */

/** Immutable projection snapshot. */
export interface SessionContent {
  readonly projectionRevision: number
  readonly transcript: readonly TranscriptBlock[]
  readonly pending: readonly PendingRun[]
}

/** Text-bearing transcript block kinds. */
export type TextBlockKind = "user" | "assistant" | "status" | "shell" | "error"

/** Tool lifecycle statuses; done/error/denied are terminal. */
export type ToolStatus = "streaming" | "running" | "waiting" | "approved" | "denied" | "done" | "error"
export type PublicToolStatus = "requested" | "awaiting_approval" | "running" | "completed" | "failed" | "denied"

/** Diff line kinds (TUI-local view of a structured patch; mirrors core's vocabulary without importing it). */
export type ToolDiffLineKind = "context" | "added" | "removed"

export interface ToolDiffLine {
  readonly kind: ToolDiffLineKind
  readonly text: string
}

export interface ToolDiffHunk {
  readonly oldStart: number
  readonly newStart: number
  readonly oldLines: number
  readonly newLines: number
  readonly lines: readonly ToolDiffLine[]
}

/** Structured diff view of an applied tool edit; minted from the display channel at the adapter. */
export interface ToolDiff {
  readonly hunks: readonly ToolDiffHunk[]
  readonly addedLines: number
  readonly removedLines: number
  readonly sites: number
  readonly truncated?: boolean
  /** False when the received unified preview could not be parsed; counts remain factual. */
  readonly previewAvailable?: boolean
}

/** Text transcript block (user/assistant/system/shell/error rows). */
export interface TranscriptTextBlock {
  readonly kind: TextBlockKind
  readonly revision: number
  readonly body: string
  /** Canonical input identity carried by user rows. */
  readonly inputId?: string
  /** Canonical acceptance instant carried by user rows. */
  readonly acceptedAt?: string
  /**
   * Stable TUI-local identity minted by the projection: it survives
   * streaming→final reconciliation, in-place tool merges, shell results,
   * and optimistic-row claims; snapshot adoption re-mints. Never part of
   * runtime events or persistence.
   */
  readonly sourceId: string
  /** Run association: the run that produced it (assistant) or owns it (user/status/error). */
  readonly runId?: string
  readonly turn?: number
  readonly streaming?: boolean
  readonly durationMs?: number
}

/** Structured tool call block; merged in place per toolUseId. */
export interface ToolBlock {
  readonly kind: "tool"
  readonly revision: number
  /** Canonical plain-text view derived from name and status at merge time. */
  readonly body: string
  readonly sourceId: string
  readonly runId: string
  readonly turn: number
  readonly toolUseId: string
  readonly name: string
  readonly input: unknown
  /** Display title derived from a string `description` input at merge time; absent when the input carries none. */
  readonly title?: string
  readonly status: ToolStatus
  /** Canonical public tool-call lifecycle status, retained alongside the renderer status. */
  readonly toolStatus?: PublicToolStatus
  readonly result?: string
  readonly partialInput?: string
  readonly collapsed: boolean
  readonly startedAt?: string
  readonly durationMs?: number
  readonly questionOutcome?: "answered" | "declined" | "rejected"
  /** Display-channel diff of the applied edit (done tool_edit/write_file); TUI-local, never persisted. */
  readonly diff?: ToolDiff
}

/** Committed transcript block projection. */
export type TranscriptBlock = TranscriptTextBlock | ToolBlock

/** Pending run summary projection. */
export interface PendingRun {
  readonly runId: string
  readonly goal: string
}

/** Unfinalized live block view; sourceId joins renderer reflow identity. */
export type LiveTailBlock =
  | {
      readonly sourceId: string
      /** Block kind carried so an assistant tail renders under its entry gutter. */
      readonly kind: TextBlockKind
      readonly body: string
      readonly streaming?: boolean
    }
  | {
      readonly sourceId: string
      readonly kind: "tool"
      readonly body: string
      readonly runId: string
      readonly turn: number
      readonly toolUseId: string
      readonly name: string
      readonly input: unknown
      readonly title?: string
      readonly status: ToolStatus
      readonly toolStatus?: PublicToolStatus
      readonly result?: string
      readonly partialInput?: string
      readonly durationMs?: number
      readonly questionOutcome?: "answered" | "declined" | "rejected"
      readonly diff?: ToolDiff
    }

/**
 * One structural transcript-list change minted at its mutation point.
 * Fold in mint order: every index is relative to the list as it stood
 * just before that change.
 */
export type SourceChange =
  /** Blocks appended at the end, in order. */
  | { readonly kind: "append"; readonly sourceIds: readonly string[] }
  /** Blocks mutated in place: identity and position stable, content new. */
  | { readonly kind: "replace"; readonly sourceIds: readonly string[] }
  /**
   * Half-open block-index range removed from the pre-cut list;
   * `throughEnd` marks a cut that removed through the then-final block.
   */
  | { readonly kind: "truncate"; readonly from: number; readonly to: number; readonly throughEnd: boolean }
  /** Identity remint (adoption/reset): every prior source id is void. */
  | { readonly kind: "reset" }

/** Ordered structural changes between two projection revisions. */
export interface SourceChangeBatch {
  readonly sinceRevision: number
  readonly upToRevision: number
  readonly changes: readonly SourceChange[]
}

/** Projection facade (apply/replace/rebase; called by the application only). */
export interface TuiSessionProjection {
  content(): SessionContent
  /** Unfinalized live blocks, in transcript order; empty when idle. */
  liveTail(): readonly LiveTailBlock[]
  /**
   * Current source identity generation; bumps when adoption re-mints
   * every source id. O(1) — structural detail lives in changesSince.
   */
  sourceGeneration(): number
  /**
   * Structural transcript changes minted after a revision, in mutation
   * order. An empty batch means no structural change advanced (a
   * revision may move without one); null means the bounded log no
   * longer covers the range and the caller must treat the gap as a
   * wholesale reset.
   */
  changesSince(revision: number): SourceChangeBatch | null
  /**
   * Source ids of transcript blocks still subject to in-place mutation
   * (non-terminal tool blocks, open shell runs): rendering must keep them
   * in the mutable tail until they settle — committing them early would
   * freeze pre-merge content in the append-only scrollback.
   */
  unsettledSourceIds(): ReadonlySet<string>
}

export {
  createSessionProjection,
  type SessionProjectionWriter,
  type TransientStreamInput,
  type DurableBlockInput,
  type ToolApplyInput,
  type RunFinalizeInput,
  type ProjectionReplaceInput,
} from "./projection.js"
