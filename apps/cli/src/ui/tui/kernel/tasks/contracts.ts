/**
 * Task contracts: the typed invocation vocabulary every task engine and
 * the navigator share. A definition pairs its input with its result at
 * the type level — the navigator's open/complete are keyed by kind and
 * refuse mismatched values at compile time; no string result id plus
 * cast exists here. An invocation ends exactly once with one of three
 * reasons; invalidated is a real termination cause delivered to the
 * effective parent, never a disguised dismiss.
 */
import type { TuiIntent } from "../../keys/index.js"

/** The business results a caller may receive; dismissed carries no value. */
export type TaskCompletion<T> = { readonly kind: "completed"; readonly value: T } | { readonly kind: "dismissed" }

/** Why an invocation ended; only the first two are user outcomes. */
export type TaskEndReason = "completed" | "dismissed" | "invalidated"

/** What a caller actually receives: a completion, or the invalidation of the call. */
export type DeliveredCompletion<T> = TaskCompletion<T> | { readonly kind: "invalidated" }

/** The identity scope an invocation declares; scope changes drive pause or invalidation. */
export type TaskScope = "client" | "workspace" | "session"

/** Whether an open task replaces the composer or keeps it visible below the transcript. */
export type TaskComposerMode = "hidden" | "visible"

/** Engine events: the value that completes the invocation, or a feature effect for the host. */
export type TaskEngineEvent<R, E extends { readonly kind: string }> =
  { readonly kind: "completed"; readonly value: R } | { readonly kind: "effect"; readonly effect: E }

/** Engine-level Escape: an internal level popped, the root reached, or a dirty form refusing. */
export type TaskBackResult = "popped" | "root" | "dirty"

/** One choosable row of the current step's list; focused marks the preview carrier. */
export interface TaskRowView {
  readonly label: string
  /** The row's annotation (a diff stat, a binary marker); the card folds it into the label run. */
  readonly description?: string
  readonly focused: boolean
}

/** A task-owned horizontal header; tab changes never imply a task effect. */
export interface TaskTabsView {
  readonly labels: readonly string[]
  readonly activeIndex: number
  readonly focused: boolean
}

export interface TaskEngine<I, R, E extends { readonly kind: string }> {
  readonly title: string
  readonly scope: TaskScope
  readonly composerMode: TaskComposerMode
  readonly input: I
  /** Scope identities this invocation depends on, e.g. `workspace:<id>`; read by pause/invalidation. */
  identities(): readonly string[]
  /** One input the task owns; printable keys, navigation and Enter all arrive here. */
  handle(intent: TuiIntent): readonly TaskEngineEvent<R, E>[]
  /** Escape: pop one engine level, reach the invocation root, or refuse while dirty. */
  back(): TaskBackResult
  /** A dirty engine refuses a root Back until the discard choice is explicit. */
  dirty(): boolean
  /** Engine-internal step names, innermost last; the frame renders them as the task's own levels. */
  steps(): readonly string[]
  /** The current step's choosable rows; engines without a list surface report none. */
  rows?(): readonly TaskRowView[]
  /** Optional horizontal page navigation shown above the body rows. */
  tabs?(): TaskTabsView | undefined
  /** The current step's body lines (paged documents, tab annotations); engines without a body surface report none. */
  body?(): readonly string[]
  /** Key affordances of the current step, one phrase each. */
  hints(): readonly string[]
}

/** One canonical permission rule row as the permission surfaces read it. */
export interface PermissionRuleView {
  readonly name: string
  readonly behavior: "allow" | "ask" | "deny"
}

/**
 * One rewind checkpoint row as the rewind card reads it: the accepted
 * input's id (the identity the rewind command takes) plus the
 * adapter-rendered preview label. The label is presentation only —
 * the restored draft always comes back from the canonical rewind
 * outcome, never from this fold.
 */
export interface RewindCheckpointView {
  readonly checkpoint: string
  readonly label: string
  readonly acceptedAt?: string
}

/** One locally persisted composer prompt as the Ctrl+R picker reads it. */
export interface PromptHistoryEntryView {
  readonly id: string
  readonly text: string
  readonly submittedAt: string
}

/** One converged tool-denial terminal as the Recently denied face reads it. */
export interface PermissionDenialView {
  readonly toolName: string
  readonly code: string
  readonly reason?: string
}

/**
 * Live permission facts for the permission card and the full-access
 * confirm card. The coordinator assembles the probe over its ports and
 * submission state; the tasks read it at key and render time, so a
 * canonical echo or an operation outcome lands on the next frame
 * without any inbound channel into the engines.
 */
export interface PermissionTaskFacts {
  /** Null while the permission mirror is unsown — every dependent face fails closed. */
  readonly mirror: {
    readonly currentMode: string
    readonly selectableModes: readonly string[]
    readonly guardianAvailable: boolean
    readonly rules: readonly PermissionRuleView[]
    readonly directories: readonly string[]
    readonly workspaceRoot: string | null
    readonly deniedLedger: readonly PermissionDenialView[]
  } | null
  /** True once this session's full-access disclosure was confirmed in-process. */
  readonly fullAccessConfirmed: boolean
  /** The newest mode submission and its canonical outcome; null before the first one. */
  readonly modeSubmission: {
    readonly mode: string
    readonly status: "pending" | "applied" | "stale" | "failed"
    readonly viaConfirm: boolean
  } | null
  /** The newest rules submission and its canonical outcome; null before the first one. */
  readonly rulesSubmission: {
    readonly names: readonly string[]
    readonly status: "pending" | "applied" | "stale" | "failed"
  } | null
}

/** The absent-kit facts: no mirror, nothing submitted, unconfirmed. */
export const noPermissionFacts: PermissionTaskFacts = {
  mirror: null,
  fullAccessConfirmed: false,
  modeSubmission: null,
  rulesSubmission: null,
}

/**
 * One resumable session row as the resume card reads it: the catalog
 * identity plus the listing facts. Structural so tasks import no
 * sibling owner.
 */
export interface ResumeSessionRowView {
  readonly sessionId: string
  readonly title?: string
  readonly lastRevision: number
  readonly createdAt: string
}

/**
 * One hidden-pending decision row as the chooser reads it: the lease
 * identity plus the label the card paints. Structural so tasks import
 * no sibling owner.
 */
export interface PendingDecisionRowView {
  readonly requestId: string
  readonly kind: "ask" | "approval"
  readonly label: string
}

/** The algorithm seams a task consumes; the coordinator assembles them so tasks import no sibling owner. */
export interface TaskKit {
  readonly search: SearchEditorKit
  readonly pager: PagerKit
  /** Live workspace diff cache; undefined means its first listing is still in flight. */
  readonly diffFiles?: () => readonly TaskDiffFileView[] | undefined
  /** Rank a task's text candidates through the coordinator-owned search algorithm. */
  readonly rankText: (query: string, candidates: readonly SearchCandidate[]) => readonly string[]
  /** Live permission facts; absent means the permission surfaces report nothing. */
  readonly permissions?: () => PermissionTaskFacts
  /** Live rewind checkpoint rows, newest first; absent means the rewind card reports none. */
  readonly history?: () => { rewindCheckpoints: readonly RewindCheckpointView[] }
  /** Live accepted composer prompts, newest first; absent means the picker reports none. */
  readonly promptHistory?: () => readonly PromptHistoryEntryView[]
  /**
   * Live resumable-session rows; null while the listing query has not
   * answered (the loading face), absent when no listing is wired.
   */
  readonly resumeSessions?: () => { readonly rows: readonly ResumeSessionRowView[] } | null
  /** Live hidden-pending decision rows; absent means the chooser reports none. */
  readonly pendingDecisions?: () => { readonly rows: readonly PendingDecisionRowView[] }
}

/**
 * The token identity a completion insert must still match: the kind
 * and query the caller observed. Structural so tasks import no
 * sibling owner; the composer editor's expectation satisfies this.
 */
export interface SearchEditorExpectation {
  readonly kind: "mention" | "command" | "shell" | "path"
  readonly query: string
}

/**
 * The editor seam behind every in-task query field. The composer
 * editor satisfies this structurally, so a search field is a real
 * editor (graphemes, caret, paste) rather than a bare string.
 */
export interface SearchEditor {
  dispatch(intent: TuiIntent): unknown
  readonly text: string
  readonly caretOffset: number
  /** Clear the current draft. */
  clearDraft(): void
  /** Load a recalled prompt as one undoable replacement of the current draft. */
  loadDraft(text: string, caret?: number): void
  /** Replace a still-current completion token; a stale expectation is rejected. */
  replaceDraftRange(start: number, end: number, value: string, expected?: SearchEditorExpectation): boolean
}

export type SearchEditorKit = { readonly create: () => SearchEditor }

/** Stable text candidates the coordinator ranks for a task-owned search field. */
export interface SearchCandidate {
  readonly id: string
  readonly text: string
}

/** The pagination seam; the reading pager satisfies this structurally. */
export interface TaskPagerView {
  pageLines(): readonly string[]
  move(direction: "up" | "down" | "left" | "right" | "page-up" | "page-down"): boolean
  readonly pageNumber: number
  readonly pageCount: number
  anchorRow(): number
  restoreRow(row: number): void
}

export type PagerKit = {
  readonly create: (lines: readonly string[], height: number) => TaskPagerView
  readonly pageHeight?: () => number
  /** Reflow physical document rows when a fixed-width surface resizes. */
  readonly wrapLines?: (lines: readonly string[]) => readonly string[]
}

export type TaskDiffFileView = {
  readonly path: string
  readonly description?: string
  readonly detail: readonly string[]
}

export interface TaskDefinition<K extends string, I, R, E extends { readonly kind: string }> {
  readonly kind: K
  readonly scope: TaskScope
  create(input: I, kit: TaskKit): TaskEngine<I, R, E>
}

/** Identity helper so definition literals keep their full inference. */
export function defineTask<K extends string, I, R, E extends { readonly kind: string }>(
  definition: TaskDefinition<K, I, R, E>,
): TaskDefinition<K, I, R, E> {
  return definition
}
