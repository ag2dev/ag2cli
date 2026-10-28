/**
 * The kernel contract: the input vocabulary, the closed command union,
 * the ports and the snapshot shape. It lives inside the coordinator —
 * next to its only implementation — so internals bind to it directly
 * and the module facade re-exports it without a cycle. Every member is
 * contract: adding, removing or reshaping one moves the seam tests
 * with it.
 */
import type { HostEvent } from "../input/index.js"
import type { ApprovalValue, AskValue, DecisionFact, RequestIdentity } from "../decisions/index.js"
import type { TuiCompletionSources } from "../fields/index.js"
import type { MirrorFact } from "../session-mirror/index.js"
import type { PromptHistoryEntryView, RewindCheckpointView, SearchEditor, TaskPagerView } from "../tasks/index.js"
import type { TuiSnapshotGroups } from "./snapshot.js"
import type { LiveTailBlock, SessionContent, SourceChangeBatch, TranscriptBlock } from "../../sessionprojection/index.js"
import type { ThemeId, TranscriptLine } from "../../text/index.js"
import type { TuiIntent } from "../../keys/index.js"

export interface TuiKernel {
  /** The single entry point; every input channel funnels through here. */
  dispatch(input: TuiInput): void
  /** Immutable view of the current state; the view layer reads only this. */
  snapshot(): TuiSnapshot
  subscribe(listener: (snapshot: TuiSnapshot) => void): () => void
  /**
   * The single outbound channel. Commands are delivered after dispatch
   * returns; a handler dispatching synchronously is a contract breach.
   */
  onCommand(handler: (command: TuiCommand) => void): void
  /**
   * Bootstrap reports that a frame revision is truly written. Recorded
   * for write-eligibility only — a late report never replays an Enter.
   */
  written(frameRevision: number): void
  /** Release kernel-owned timers when the containing TUI process shuts down. */
  dispose?(): void
  /**
   * Seeds the composer with keys buffered before the kernel existed.
   * The first session adoption keeps them when no stored draft exists;
   * a stored draft still replaces them.
   */
  adoptTypeAhead(text: string): void
}

export type TuiInput =
  | { kind: "key-intent"; intent: TuiIntent }
  | { kind: "host-event"; event: HostEvent }
  | { kind: "operation-result"; operationId: OperationId; origin: OperationOrigin; outcome: OperationOutcome }
  | {
      kind: "session-view"
      origin: SessionOrigin
      content: SessionContent
      readonly liveTail: readonly LiveTailBlock[]
      changes: SourceChangeBatch
    }
  | { kind: "mirror"; fact: MirrorFact }
  | { kind: "decision"; fact: DecisionFact }
  | { kind: "children"; fact: ChildrenFact }
  | {
      kind: "decision-status"
      request: RequestIdentity
      event: "authority-confirmed" | "authority-retracted" | "reconcile-still-pending" | "reconcile-undecidable"
    }
  | { kind: "command-failed"; command: TuiCommand["kind"]; message: string }

/** Terminal vocabulary of one delegated child, mirrored from the delegation facts. */
export type ChildStatus = "running" | "completed" | "failed" | "cancelled"

/**
 * Live delegation facts, session-scoped: they grow the children board
 * the way decision facts grow the decision chain. The board is the
 * only consumer; a reset is the host's to dispatch (the kernel's own
 * switch clear must not wipe facts the new session's backlog replay
 * re-delivers ahead of its first push).
 */
export type ChildrenFact =
  | {
      readonly type: "spawn"
      readonly childSessionId: string
      readonly description?: string
      readonly subagentType?: string
      readonly toolUseId?: string
    }
  /**
   * The durable agent tool_use row: it names only the tool call id and
   * arrives before the child session exists, so it annotates the entry
   * once the spawn binds the alias — or parks until then.
   */
  | { readonly type: "tool-use"; readonly toolUseId: string; readonly description?: string; readonly subagentType?: string }
  | { readonly type: "line"; readonly childSessionId: string; readonly text: string }
  | {
      readonly type: "finalize"
      readonly childSessionId?: string
      readonly toolUseId?: string
      readonly status: ChildStatus
      readonly summary?: string
    }
  | { readonly type: "reset" }

export type TuiCommand =
  | { kind: "submit"; text: string; scope: SessionScope; operationId: OperationId }
  | { kind: "remember-prompt"; text: string }
  | { kind: "shell"; command: string; scope: SessionScope }
  | { kind: "compact"; scope: SessionScope; instructions?: string }
  | { kind: "interrupt" | "cancel-run" | "cancel-child"; target: RunTarget }
  | { kind: "cancel-queued"; inputId: string; operationId: OperationId }
  | { kind: "resolve-ask"; request: RequestIdentity; value: AskValue }
  | { kind: "resolve-approval"; request: RequestIdentity; value: ApprovalValue }
  | { kind: "theme"; op: "preview" | "cancel"; themeId: ThemeId }
  | { kind: "theme"; op: "commit"; themeId: ThemeId; operationId: OperationId }
  | { kind: "rewind"; checkpoint: CheckpointId; operationId: OperationId }
  | { kind: "resume"; sessionId: string; operationId: OperationId }
  | { kind: "query"; target: QueryTarget; requestId: RequestId; scope: OperationOrigin }
  | { kind: "permission"; op: "mode"; mode: string; operationId: OperationId }
  | {
      kind: "permission"
      op: "rules"
      /** The complete rule set to commit; the canonical CAS owns concurrency. */
      rules: readonly TuiPermissionRule[]
      /** The mirror rows the set was computed from; rides for staleness observability, never re-read by the executor. */
      baseline: readonly TuiPermissionRule[]
      operationId: OperationId
    }
  | { kind: "add-dir"; directory: string; operationId: OperationId }
  | { kind: "exit" }

/** Session binding identity; the generation advances on every attach or switch. */
export type SessionOrigin = { sessionId: string; generation: number }

/**
 * Operation identity, graded by scope so late results can be judged
 * without trusting arrival order: client results always converge,
 * workspace results die with their workspace, session results die with
 * a binding mismatch.
 */
export type OperationOrigin =
  { scope: "client" } | { scope: "workspace"; workspaceId: string } | { scope: "session"; sessionId: string; generation: number }

export type OperationOutcome =
  | { op: "theme-commit"; status: "confirmed" | "failed-before-replace" | "uncertain-after-replace" }
  | { op: "rewind"; status: "ok"; restoredDraft: string }
  | { op: "rewind"; status: "failed" }
  | { op: "resume"; status: "attached"; sessionId: string }
  | { op: "resume"; status: "attach-failed"; sessionId: string }
  | { op: "permission"; status: "applied" | "stale" | "failed" }
  | { op: "add-dir"; status: "ok"; canonical: string; changed: boolean }
  | { op: "add-dir"; status: "error"; message: string }
  | { op: "submit"; status: "accepted"; inputId: string }
  | { op: "submit"; status: "rejected" }
  | { op: "cancel-queued"; inputId: string; status: "cancelled" | "cancelled-before-acceptance" | "already-delivered" }

/** Minted by the kernel when a world-changing command is emitted; executors echo it, never mint. */
export type OperationId = string

/**
 * Ports are synchronous probes read at dispatch time, once per
 * dispatch, so adjudication and rendering always see the same world.
 * Async fetches never ride the ports — they go out as query commands
 * and come back as mirror facts. The three kits are optional
 * injections over the coordinator's built-in wiring of the
 * kernel-owned algorithms; the kernel hosts no second implementations.
 */
export interface TuiKernelPorts {
  sessionFacts(): { sessionId: string | null; workspaceId: string | null }
  /**
   * Null until the host reports a mode — the unsown sync window every
   * permission-dependent path fails closed against. The kernel never
   * invents a default; the rest of the shape is the canonical mirror
   * the permission surfaces read (never a client-side copy).
   */
  permission(): {
    currentMode: string
    /** The modes this process may commit; seeded from the session, re-seeded on every switch. */
    selectableModes: readonly string[]
    /** Derived from the selectable set: auto only appears when a Guardian is resolved. */
    guardianAvailable: boolean
    rules: readonly TuiPermissionRule[]
    directories: readonly string[]
    /** The authorized workspace root path; null only in harnesses that never bind one. */
    workspaceRoot: string | null
    /** Newest first; cleared on every session switch. */
    deniedLedger: readonly TuiPermissionDenial[]
  } | null
  /** Rewind checkpoint rows, newest first; the adapter renders each label from the user row's body. */
  history(): { rewindCheckpoints: readonly RewindCheckpointView[] }
  /** Accepted or cleared composer prompts, newest first; absent means no history entries. */
  promptHistory?(): readonly PromptHistoryEntryView[]
  /** The palette rides the probe so the kernel holds no runtime edge into the text module. */
  theme(): { committedThemeId: ThemeId; themeIds: readonly ThemeId[] }
  completion(): TuiCompletionSources
  /** Report documents fall back to an explicit "not reported" line when a probe is absent. */
  provider?(): { label: string | null; modelName?: string | null; endpoint?: string | null; protocol?: string | null }
  /** Mirrors the host's context-usage payload; no budget exists anywhere in the session surface. */
  context?(): { model?: string; contextTokens?: number; contextEstimated?: boolean } | null
  /** Mirrors the adopted lineage's io health; a lineage switch re-reads it instead of inheriting the abandoned session's degrade. */
  io?(): { degraded: boolean }
  /** Editor kit injection; absent means the built-in composer. */
  readonly fields?: { createEditor(): SearchEditor }
  /** Pager kit injection; absent means the built-in document pager. */
  readonly reading?: { createPager(lines: readonly string[], height: number): TaskPagerView }
  /**
   * Transcript rendering kit: merges committed blocks with the live
   * tail and renders per source. Absent means the built-in wiring of
   * the text module's render sources; identity is the returned
   * array's, so the kernel caches by (blocks, tail, columns)
   * reference equality. The reader passes `detailed: true` to expand
   * tool input, result and diff sections; the main transcript passes false.
   */
  readonly transcript?: (
    blocks: readonly TranscriptBlock[],
    tail: readonly LiveTailBlock[],
    columns: number,
    detailed: boolean,
  ) => readonly TranscriptLine[]
  readonly capacity?: { viewStateBytes: number }
}

/**
 * The rendering contract for the view layer: terminal geometry plus
 * the owner groups the coordinator assembles. The groups stay typed
 * in the coordinator; the view reaches them through this shape.
 */
export interface TuiSnapshot extends TuiSnapshotGroups {
  readonly revision: number
  readonly layout: { readonly columns: number; readonly rows: number }
}

type SessionScope = SessionOrigin
type CheckpointId = string
type RequestId = string
type QueryTarget = "diff-files" | "resume-sessions"
type RunTarget = "current-run" | { readonly childId: string }

/** One permission rule row in the kernel's vocabulary; structurally the public grammar's row. */
export interface TuiPermissionRule {
  readonly name: string
  readonly behavior: "allow" | "ask" | "deny"
}

/** One converged tool-denial terminal as the Recently denied face reads it. */
export interface TuiPermissionDenial {
  readonly toolName: string
  readonly code: string
  readonly reason?: string
}
