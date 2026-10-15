/**
 * Framework-free store bridge between the session projection core and the
 * Ink view tree: the view subscribes (useSyncExternalStore-compatible) and
 * reads one immutable snapshot per store revision. The store advances a
 * revision — and notifies — only when session content, the live tail, the
 * terminal layout, the composer draft, the completion picker, the
 * resting-screen hint, the slash feedback surface, the host-mirrored
 * footer telemetry, the open card or the host-mirrored parked queue
 * actually changed, so re-polls, redraws and resize rebuilds can never
 * advance a revision or mint phantom updates. Every committed revision
 * re-derives the transcript window (the sliced lines and the
 * scrolled-off indicator) from the layout through one choke point, so
 * whatever moved the chrome moves the window in the same revision.
 * Canonical events, projection revisions and commit counts stay owned by
 * the projection; this module only sequences what the view sees. Routed
 * key intents enter through one pipeline — the resting-screen policy
 * claims exit confirmations, idle escape chains and permission rotation
 * first; an allocated card claims its modal keys next (a card below
 * its row budget and every surface below the support floor lose their
 * claims to the editor); everything
 * transparent falls to the completion picker and the editor kernel;
 * submissions split into prompts, shell commands, slash inputs and local
 * slash failures — and return their effects (the one outbound seam:
 * submissions, slash dispatches, card outcomes and global key effects
 * the host executes).
 */
import type { TuiIntent } from "../keys/index.js"
import type { LiveTailBlock, PendingRun, SessionContent, SourceChangeBatch } from "../sessionprojection/index.js"
import {
  THEME_IDS,
  createToolDetailCache,
  expandTabs,
  renderDetailedTranscriptSource,
  renderDetailedTranscriptSourceRange,
  sanitizeText,
  textRunsEqual,
  wrapVerbatim,
  type TextRun,
  type TranscriptLine,
} from "../text/index.js"
import { ComposerKernel } from "./editor.js"
import { footerMinimalSegments, footerSegments, type FooterTelemetry } from "./footer.js"
import {
  TranscriptLineCache,
  sameToolRenderSource,
  type QueuedPreview,
  type TranscriptChrome,
  type TranscriptLayout,
  type TranscriptLineModel,
} from "./lines.js"
import { allocateFrame, type FrameAllocation } from "./layout.js"
import {
  FOLLOW_VIEWPORT,
  WHEEL_STEP_LINES,
  resolveViewport,
  viewportIndicator,
  viewportPageDown,
  viewportPageUp,
  viewportPosition,
  viewportWheelDown,
  viewportWheelUp,
  viewportResetByContent,
  viewportWindow,
  type TranscriptViewport,
} from "./viewport.js"
import { RootKeyPolicy, type RootKeyHostEffect } from "./rootkeys.js"
import { EMPTY_AGENTS_VIEW, type ChildAgentView, type ChildAgentsPanel, type TuiAgentsView, type TuiChildPanelView } from "./agents.js"
import { ThemeCard, type ThemeCardEffect } from "./theme-card.js"
import { RewindCard, type RewindCardEffect, type RewindCheckpoint } from "./rewind-card.js"
import { ResumeCard, type ResumeCardEffect, type ResumeSessionOption } from "./resume-card.js"
import {
  PERMISSIONS_RULE_ADD_DRAFT,
  PermissionsCard,
  type PermissionModeOption,
  type PermissionRule,
  type PermissionsCardEffect,
  type PermissionsCardTab,
  type TuiDeniedCall,
} from "./permissions-card.js"
import { FullAccessConfirmCard, type FullAccessConfirmCardEffect } from "./confirm-card.js"
import { DiffCard, type DiffFileOption } from "./diff-card.js"
import { DocCard, type DocCardDocument } from "./doc-card.js"
import { AskCard, type AskCardEffect, type AskRequest } from "./ask-card.js"
import { ApprovalCard, type ApprovalCardEffect, type ApprovalRequestInput } from "./approval-card.js"
import { cardBaseEqual, type CardSnapshot } from "./card.js"
import {
  CORE_SLASH_COMMANDS,
  createSlashCommandRegistry,
  parseSlashSubmission,
  slashCompletionItems,
  slashParseErrorNotice,
  unknownSlashNotice,
  type SlashCommandRegistry,
  type SlashInput,
  type SlashNotice,
} from "./slash.js"
import { CompletionPicker, MAX_MENTION_CANDIDATES, commandCandidates, mentionCandidates, type CompletionWindow } from "./completion.js"
import { COMMAND_PROFILE, FILE_PROFILE, matchCompletions, type CompletionItem } from "./matching.js"

// The denial row type lives with the card that renders it; the store
// imports it for the ledger and keeps the barrel export stable.
export type { TuiDeniedCall }

/**
 * Editor slice of the snapshot: the kernel is the editor's whole read API
 * (text, mode, completion context, render runs); the revision is the
 * kernel's monotone draft counter at commit time.
 */
export interface TuiEditorState {
  readonly kernel: ComposerKernel
  readonly revision: number
}

/** The visible transcript window: the sliced lines, their absolute start row, plus the scrolled-off indicator. */
export interface TuiTranscriptView {
  readonly lines: readonly TranscriptLine[]
  /** Absolute transcript row of `lines[0]`; the view keys rows by it so a scroll reconciles instead of remounting. */
  readonly start: number
  readonly indicator: string | null
}

/** The reader window: the sliced lines, their absolute start row, and the position label its heading reads. */
export interface TuiToolTranscriptView {
  readonly lines: readonly TranscriptLine[]
  /** Absolute row of `lines[0]`; the view keys rows by it so a scroll reconciles instead of remounting. */
  readonly start: number
  /** The window's position label; the heading reads it without parsing an indicator row. */
  readonly position: string | null
}

/** View-facing snapshot; identity is stable per store revision. */
export interface TuiStateSnapshot {
  /** Advances only on a committed content change; starts at 0. */
  readonly revision: number
  readonly session: SessionContent
  readonly liveTail: readonly LiveTailBlock[]
  /** Terminal geometry the window derives against; null until the first layout dispatch. */
  readonly layout: TranscriptLayout | null
  /** Derived transcript window; empty until the first layout dispatch. */
  readonly transcript: TuiTranscriptView
  /** Whether the full-screen detailed transcript currently owns the main surface. */
  readonly toolTranscriptOpen: boolean
  /** Detailed transcript window; it shares the projection but has its own renderer and viewport. */
  readonly toolTranscript: TuiToolTranscriptView
  /**
   * Intro rows the frame paints while the transcript holds nothing,
   * clamped to the window capacity at the current layout; the first
   * real session row empties them.
   */
  readonly introLines: readonly string[]
  readonly editor: TuiEditorState
  /** Visible completion picker window; null while hidden. */
  readonly completion: CompletionWindow | null
  /** One resting-screen hint line; null hides it. */
  readonly hint: string | null
  /** Feedback surface for the latest slash submission; null hides it. */
  readonly slashNotice: SlashNotice | null
  /**
   * Submissions parked behind the active run as the frame paints them:
   * a bounded prefix plus one elision count, derived from the host's
   * queue mirror at ingress so the painted rows and the row budget
   * share one derivation.
   */
  readonly queued: QueuedPreview
  /** Prebuilt footer runs; telemetry when mirrored, the minimal line otherwise. */
  readonly footer: readonly TextRun[]
  /** The single modal surface that currently owns key input, if any. */
  readonly activeCard: CardSnapshot | null
  /** Card rows rendered under the current grant, shared by layout and the view. */
  readonly cardLines: readonly (readonly TextRun[])[]
  /**
   * Rows the composer body claims at the current layout — the draft's
   * natural height under the fixed cap, clamped to what the terminal
   * has left for it. One row until the first layout dispatch; the view
   * renders exactly this budget so the frame and the capacity
   * arithmetic cannot disagree.
   */
  readonly composerRows: number
  /**
   * The composer rule's row from the frame origin — the absolute-row
   * baseline the cursor rides. Zero until the first layout dispatch.
   */
  readonly composerPrefix: number
  /**
   * Whether the editor cursor paints: hidden while an allocated card
   * owns input and below the support floor. The frame allocation
   * decides; the view renders the field verbatim.
   */
  readonly cursorVisible: boolean
  /**
   * Whether the terminal sits below the support floor: the frame
   * allocation decides once per revision, and the root renders its
   * too-small diagnostic off this one field instead of re-deriving
   * the predicate from the layout numbers.
   */
  readonly supportFloor: boolean
  /**
   * Converged tool denials, newest first: one entry per call identity
   * (tool name + call id), bounded by the store. Seeded by history
   * replay and extended by live denials through the same dispatch.
   */
  readonly recentlyDenied: readonly TuiDeniedCall[]
  /**
   * Child-agents kanban view: one bounded entry per delegated child,
   * with focus shared between the main surface and the entries. The
   * stable empty view while no panel is wired.
   */
  readonly agents: TuiAgentsView
  /**
   * The running-children summary row above the footer: one chrome row
   * naming the count and the focus keys, null while no child runs.
   */
  readonly agentsSummary: string | null
  /**
   * The focused child's panel painted in place of the transcript
   * window — header, wrapped read-only buffer rows, and the hint row
   * with the cancel affordance — already budgeted to the frame's
   * transcript capacity. Null on main focus.
   */
  readonly childPanel: TuiChildPanelView | null
}

/** Effects a dispatch produced for the host to execute. */
export type TuiStateEffect =
  | { readonly kind: "submit"; readonly text: string }
  | { readonly kind: "shell"; readonly command: string }
  | { readonly kind: "slash"; readonly input: SlashInput }
  | { readonly kind: "clear-transcript" }
  | RootKeyHostEffect
  | ThemeCardEffect
  | RewindCardEffect
  | ResumeCardEffect
  | PermissionsCardEffect
  | FullAccessConfirmCardEffect
  | AskCardEffect
  | ApprovalCardEffect
  | { readonly kind: "cancel-child"; readonly childSessionId: string }
  | { readonly kind: "urgent-card-freed" }

/**
 * Session scope of each effect kind, exhaustively: a client effect
 * never speaks for a particular session (client-local theme writes,
 * teardown, the host-runqueue interrupt), so a session switch must
 * still run it; every other effect acts on the session that
 * dispatched it and dies with the dispatch's generation. This record
 * is the single classification — the host consumes it instead of a
 * local allowlist, and a new effect kind must be classified here to
 * compile.
 */
const EFFECT_SESSION_SCOPE: { readonly [K in TuiStateEffect["kind"]]: "session" | "client" } = {
  submit: "session",
  shell: "session",
  slash: "session",
  "clear-transcript": "session",
  interrupt: "client",
  exit: "client",
  "open-rewind": "session",
  "rotate-permission": "session",
  "theme-preview": "client",
  "theme-commit": "client",
  "theme-cancel": "client",
  rewind: "session",
  resume: "session",
  "permission-mode": "session",
  "permission-rules": "session",
  // Payload-keyed, process-local fact: it speaks for the session the
  // confirmation named, never for whichever session dispatches it, so
  // a switch must not swallow it.
  "full-access-confirm": "client",
  "ask-answer": "session",
  "approval-decision": "session",
  // Speaks for the focused child of the dispatching session's panel.
  "cancel-child": "session",
  // The freed-surface notice speaks for the host's child-approval
  // bridge, which outlives every session dispatch.
  "urgent-card-freed": "client",
}

/** Whether an effect never speaks for the session that dispatched it. */
export const isSessionIndependentEffect = (effect: TuiStateEffect): boolean => EFFECT_SESSION_SCOPE[effect.kind] === "client"

/** Every classified effect kind; the drift pin derives its corpus from this. */
export const EFFECT_KINDS = Object.keys(EFFECT_SESSION_SCOPE) as readonly TuiStateEffect["kind"][]

/**
 * Completion corpora the host injects; the picker never goes to the
 * filesystem or a registry itself. An absent mention family keeps the
 * token ordinary text; an absent command family falls back to the
 * store's own slash registry, so the palette always ranks the commands
 * submissions dispatch to.
 */
export interface TuiCompletionSources {
  readonly mention?: () => readonly CompletionItem[]
  readonly command?: () => readonly CompletionItem[]
}

/**
 * Resting-screen policy wiring injected by the host: the clock the
 * confirmation windows live on, the canonical permission rotation
 * Shift+Tab requests, and the slash registry that intercepts
 * submissions (the default registry carries the core local commands).
 */
export interface TuiStateStoreOptions {
  /** Clock the confirmation windows live on; exposed back as now(). */
  readonly now?: () => number
  /**
   * Identity lines the frame shows while the transcript holds nothing:
   * brand, workspace, model, and the resting hint. View state, not
   * history — the first real session row replaces them.
   */
  readonly intro?: readonly string[]
  /**
   * Prompt history the composer's recall ring seeds from, oldest
   * first; the kernel owns the ring after construction.
   */
  readonly history?: readonly string[]
  readonly permissionModes?: readonly string[]
  readonly permissionMode?: () => string | null
  /**
   * Whether this process has already confirmed full access for the
   * session a confirmation would speak about. Default true — an
   * unwired host has no confirmation fact to demand, so no card opens.
   */
  readonly fullAccessConfirmed?: () => boolean
  /**
   * Live session identity; the confirmation card captures it at open
   * so the emitted fact names the session the user confirmed. Default
   * null (no session identity wired).
   */
  readonly sessionId?: () => string | null
  readonly slash?: SlashCommandRegistry
  /**
   * Child-agents panel wired by the host: key routing (focus cycling,
   * paging redirection, the cancel-child claim) reads it live and the
   * snapshot mirrors its view per revision. Absent, the store carries
   * the stable empty view and every agents routing degrades to the
   * plain transcript semantics.
   */
  readonly agents?: ChildAgentsPanel
  /** Theme palette for the theme card; defaults to the closed theme table. */
  readonly themes?: readonly string[]
  /** Committed theme the card seeds focus onto at open; null picks the first. */
  readonly committedTheme?: () => string | null
  /**
   * Checkpoint source for the rewind card. Wired, the idle escape chain
   * opens the card in place of bubbling its rewind request; absent the
   * request leaves as a host effect.
   */
  readonly rewind?: { checkpoints(): readonly RewindCheckpoint[] }
  /**
   * Canonical permission probes for the permissions card. Wired, the
   * /permissions umbrella opens the card over them; absent the request
   * mints nothing.
   */
  readonly permissions?: {
    readonly modes: () => readonly PermissionModeOption[]
    readonly currentMode: () => string | null
    readonly rules: () => readonly PermissionRule[]
    /**
     * Authorized workspace root plus the canonical additional
     * directories for the card's Workspace tab; a null root keeps the
     * tab honest with its unknown-root placeholder.
     */
    readonly workspace: {
      readonly root: () => string | null
      readonly additionalDirectories?: () => readonly string[]
    }
  }
}

/** Store input union: geometry, session ingress, queue ingress, routed key intents, window expiry, card requests. */
export type TuiStateInput =
  | {
      readonly kind: "session-content"
      readonly content: SessionContent
      readonly liveTail: readonly LiveTailBlock[]
      /**
       * Canonical source generation behind the content; a bump (replace
       * or reset reminted every source id) resumes the viewport's tail.
       */
      readonly sourceGeneration?: number
      /**
       * Structural changes since the mirrored revision; a null batch
       * (log evicted) or any reset/through-end cut resumes the tail.
       * Omitted by batch-less pollers, which fall back to shape checks.
       */
      readonly changes?: SourceChangeBatch | null
    }
  | { readonly kind: "layout"; readonly columns: number; readonly rows: number }
  | { readonly kind: "queue-preview"; readonly preview: QueuedPreview }
  | { readonly kind: "footer-telemetry"; readonly telemetry: FooterTelemetry | null }
  | { readonly kind: "key-intent"; readonly intent: TuiIntent }
  | { readonly kind: "slash-notice"; readonly notice: SlashNotice | null }
  | {
      readonly kind: "load-draft"
      readonly text: string
    }
  | { readonly kind: "expire-windows" }
  | { readonly kind: "open-theme-card" }
  | { readonly kind: "open-rewind-card" }
  | { readonly kind: "open-resume-card"; readonly sessions: readonly ResumeSessionOption[] }
  | { readonly kind: "open-permissions-card"; readonly tab?: PermissionsCardTab }
  | {
      /**
       * The host diverted a full-access mode commit this process has
       * not confirmed (the mirror may or may not be full access yet);
       * the confirmation card opens over the captured facts.
       */
      readonly kind: "open-full-access-confirm"
    }
  | { readonly kind: "permission-applied"; readonly commit: "mode" | "rules"; readonly close: boolean }
  | { readonly kind: "permission-stale"; readonly commit: "mode" | "rules"; readonly message: string }
  | {
      /** The host mirrored a canonical rules echo; an open permissions card reseeds its rows. */
      readonly kind: "permission-rules-mirrored"
    }
  | {
      /** The host mirrored a canonical workspace directories echo; an open card reseeds its rows. */
      readonly kind: "workspace-directories-mirrored"
    }
  | { readonly kind: "open-diff-card"; readonly files: readonly DiffFileOption[] }
  | { readonly kind: "open-doc-card"; readonly document: DocCardDocument }
  | { readonly kind: "open-ask-card"; readonly request: AskRequest }
  | { readonly kind: "approval-request"; readonly request: ApprovalRequestInput }
  | {
      /**
       * The host's child-approval bridge retracted its raised card
       * (abort, invalidation or sweep): the named request's card closes
       * without a decision; a card for any other request stays put.
       */
      readonly kind: "close-urgent-card"
      readonly requestId: string
    }
  | {
      /** One converged denial terminal observed by the host (live or replayed). */
      readonly kind: "tool-denial"
      readonly toolCallId: string
      readonly name: string
      readonly code: string
      readonly reason?: string
    }
  | {
      /**
       * The host detached from its session (a switch, before the incoming
       * session attaches): session-scoped surfaces die with it — the
       * denial ledger drops and the cards mirroring the detached session
       * close, the approval undecided. The incoming session's replay
       * re-seeds state afterwards.
       */
      readonly kind: "session-detached"
    }
  | {
      /**
       * The host mirrored panel mutations (spawn facts, child lines,
       * terminals, focus moves its own key paths commit); an unchanged
       * panel revision is the same view state and mints nothing.
       */
      readonly kind: "agents-mirrored"
    }

/** Store seam the React root binds to. */
export interface TuiStateStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): TuiStateSnapshot
  /**
   * Whether the theme panel holds the card surface right now — the
   * host scopes its theme preview transaction on this live machine
   * fact, not on a snapshot field.
   */
  themeCardVisible(): boolean
  dispatch(input: TuiStateInput): readonly TuiStateEffect[]
  /** When the earliest live confirmation window ends; null when none. */
  windowDeadline(): number | null
  /**
   * The clock the confirmation windows live on. Hosts schedule the
   * expiry against windowDeadline() using THIS clock — a foreign clock
   * makes the deadline arithmetic meaningless.
   */
  now(): number
}

const EMPTY_SESSION: SessionContent = { projectionRevision: 0, transcript: [], pending: [] }

function liveTailEqual(a: readonly LiveTailBlock[], b: readonly LiveTailBlock[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!
    const right = b[index]!
    if (left.sourceId !== right.sourceId || left.kind !== right.kind) return false
    if (left.kind === "tool") {
      if (right.kind !== "tool") return false
      if (!sameToolRenderSource(left, right)) return false
      continue
    }
    if (right.kind === "tool") return false
    if (left.body !== right.body || left.streaming !== right.streaming) return false
  }
  return true
}

/** Value equality for the picker window; equal digests reuse the previous reference. */
function completionEqual(a: CompletionWindow | null, b: CompletionWindow | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.selectedKey === b.selectedKey &&
    a.selectedIndex === b.selectedIndex &&
    a.startIndex === b.startIndex &&
    a.total === b.total &&
    a.items.length === b.items.length &&
    a.items.every((item, index) => {
      const other = b.items[index]!
      const left = item.matchRanges ?? []
      const right = other.matchRanges ?? []
      return (
        item.key === other.key &&
        item.label === other.label &&
        item.insertText === other.insertText &&
        item.disabled === other.disabled &&
        item.detail === other.detail &&
        left.length === right.length &&
        left.every((range, position) => range.start === right[position]!.start && range.end === right[position]!.end)
      )
    })
  )
}

/** Value equality for bounded painted-card rows; equal rows reuse the previous array. */
function cardLinesEqual(a: readonly (readonly TextRun[])[], b: readonly (readonly TextRun[])[]): boolean {
  return a.length === b.length && a.every((row, index) => textRunsEqual(row, b[index]!))
}

/** Value equality for the focused child's panel; an equal panel reuses the previous object. */
function childPanelEqual(a: TuiChildPanelView | null, b: TuiChildPanelView | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.rows === b.rows &&
    a.header === b.header &&
    a.hint === b.hint &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, index) => line === b.lines[index]!)
  )
}

/** Denials the Recently denied list keeps; older observations drop past it. */
const MAX_RECENT_DENIALS = 50

/** Rows the reader frame paints around the tool transcript body: its heading and hint. */
const READER_CHROME_ROWS = 2

/** Value equality for the denial list; identical re-observations mint nothing. */
function deniedCallsEqual(a: readonly TuiDeniedCall[], b: readonly TuiDeniedCall[]): boolean {
  return (
    a.length === b.length &&
    a.every((call, index) => {
      const other = b[index]!
      return call.toolCallId === other.toolCallId && call.name === other.name && call.code === other.code && call.reason === other.reason
    })
  )
}

/** Build the store around one active session's projection. */
export function createTuiStateStore(sources: TuiCompletionSources = {}, options: TuiStateStoreOptions = {}): TuiStateStore {
  const kernel = new ComposerKernel(options.history === undefined ? {} : { history: options.history })
  const picker = new CompletionPicker()
  const themeCard = new ThemeCard({ themes: options.themes ?? THEME_IDS })
  const rewindCard = new RewindCard()
  const resumeCard = new ResumeCard()
  const permissionsCard =
    options.permissions === undefined
      ? null
      : new PermissionsCard({
          modes: options.permissions.modes,
          currentMode: options.permissions.currentMode,
          rules: options.permissions.rules,
          // The ledger is store state: the closure reads it live, so the
          // card's denial rows and the snapshot field can never diverge.
          denials: () => recentlyDenied,
          workspace: options.permissions.workspace,
        })
  const diffCard = new DiffCard()
  const docCard = new DocCard()
  const askCard = new AskCard()
  const approvalCard = new ApprovalCard()
  const confirmCard = new FullAccessConfirmCard()
  /** Probes the full-access confirmation captures at open time. */
  const fullAccessConfirmed = options.fullAccessConfirmed ?? ((): boolean => true)
  const sessionIdentity = options.sessionId ?? ((): string | null => null)
  const permissionModeMirror = options.permissionMode ?? ((): string | null => null)
  const slash = options.slash ?? createSlashCommandRegistry(CORE_SLASH_COMMANDS)
  /** Slash candidates default to the registry the store dispatches with. */
  const commandSource = sources.command ?? ((): readonly CompletionItem[] => slashCompletionItems(slash))
  /** The one clock the store and its policy measure confirmation windows on. */
  const clock = options.now ?? Date.now
  /**
   * Every card machine on the one-card-wide modal surface, in the
   * routing order (panels, then blocking requests). The store's card
   * derivations — visibility, routing, and preemption — share this
   * single enumeration: adding a machine here is what makes it
   * visible, routed, and closed by the next open.
   */
  const cardMachines = [
    themeCard,
    rewindCard,
    resumeCard,
    ...(permissionsCard === null ? [] : [permissionsCard]),
    confirmCard,
    diffCard,
    docCard,
    askCard,
    approvalCard,
  ]
  /** Whether any card surface is currently visible over the composer. */
  const anyCardVisible = (): boolean => cardMachines.some((card) => card.isVisible())
  /** The wired child-agents panel; key routing and mirroring degrade without it. */
  const agents = options.agents
  /** Panel revision behind the last committed agents view. */
  let committedAgentsRevision: number | null = agents === undefined ? null : agents.revision
  /**
   * The agents view one commit carries: an unchanged panel revision
   * keeps the committed view object, so unrelated commits cannot flap
   * entry identities in front of memoized view boundaries.
   */
  const agentsView = (): TuiAgentsView => {
    if (agents === undefined) return EMPTY_AGENTS_VIEW
    if (committedAgentsRevision === agents.revision) return snapshot.agents
    committedAgentsRevision = agents.revision
    return agents.snapshot()
  }

  // The last committed active-card snapshot: the snapshot exposes one
  // card field, so the store stabilizes it here — an unrelated commit
  // over an unchanged card keeps its reference for every card, not
  // just the ones that pass the shell machine straight through.
  let lastActiveCard: CardSnapshot | null = null
  /**
   * The one card the frame renders: the first visible machine's
   * snapshot in the routing order (panels, then blocking requests).
   */
  const activeCardOf = (): CardSnapshot | null => {
    let next: CardSnapshot | null = null
    for (const card of cardMachines) {
      next = card === docCard ? docCard.snapshot(layout?.columns) : card.snapshot()
      if (next !== null) break
    }
    if (next !== null && lastActiveCard !== null && cardBaseEqual(lastActiveCard, next)) return lastActiveCard
    lastActiveCard = next
    return next
  }
  /**
   * The card surface is one card wide. Whatever opens closes every
   * other visible card (chrome grants, key claims, and the rendered
   * affordance can never disagree about which modal is up); a panel
   * never opens over a blocking request — callers check first.
   */
  const closeCardsBesides = (open: unknown): void => {
    for (const card of cardMachines) {
      if (card !== open) card.close()
    }
  }
  /** A blocking host request owns the surface until it settles. */
  const urgentCardVisible = (): boolean => askCard.isVisible() || approvalCard.isVisible()
  const policy = new RootKeyPolicy({
    isDraftEmpty: () => kernel.text.length === 0,
    consumesEscape: () => kernel.consumesEscape(),
    modalCardOpen: anyCardVisible,
    permissionModes: options.permissionModes,
    permissionMode: options.permissionMode,
    now: clock,
  })
  const emptyTranscriptView: TuiTranscriptView = { lines: [], start: 0, indicator: null }
  const emptyToolTranscriptView: TuiToolTranscriptView = { lines: [], start: 0, position: null }
  let snapshot: TuiStateSnapshot = {
    revision: 0,
    session: EMPTY_SESSION,
    liveTail: [],
    layout: null,
    transcript: emptyTranscriptView,
    toolTranscriptOpen: false,
    toolTranscript: emptyToolTranscriptView,
    introLines: [],
    activeCard: null,
    cardLines: [],
    composerRows: 1,
    composerPrefix: 0,
    cursorVisible: true,
    supportFloor: false,
    editor: { kernel, revision: kernel.draftRevision },
    completion: null,
    hint: null,
    slashNotice: null,
    queued: { visible: [], elided: 0 },
    footer: footerMinimalSegments([], kernel.editorMode),
    recentlyDenied: [],
    agents: agents === undefined ? EMPTY_AGENTS_VIEW : agents.snapshot(),
    agentsSummary: null,
    childPanel: null,
  }
  const listeners = new Set<() => void>()
  let slashNotice: SlashNotice | null = null
  let footerTelemetry: FooterTelemetry | null = null
  /** Newest-first denial ledger; one entry per call identity, capped. */
  let recentlyDenied: readonly TuiDeniedCall[] = []
  let layout: TranscriptLayout | null = null
  let viewport: TranscriptViewport = FOLLOW_VIEWPORT
  let toolTranscriptViewport: TranscriptViewport = FOLLOW_VIEWPORT
  let toolTranscriptOpen = false
  let sourceGeneration: number | undefined
  /**
   * Whether a detach voided the numeric session lineage without a
   * newer mirror landing yet: the numbers belong to whichever
   * projection minted them, and after a detach equal readings cannot
   * prove the same view state — the first mirror always commits and
   * rebuilds.
   */
  let sessionLineageVoided = false
  const lineCache = new TranscriptLineCache()
  const toolDetailCache = createToolDetailCache()
  // Non-tool rows are identical under both renderers, so the reader's
  // cache borrows the compact cache's rows — but only at the width
  // they were rendered at: a count or slice from another width would
  // mis-index the source, so both reads are width-gated misses that
  // fall back to the renderer.
  const toolTranscriptCache = new TranscriptLineCache({
    render: renderDetailedTranscriptSource,
    renderRange: (source, columns, start, count) => {
      const block = source.kind === "block" ? source.block : source.tail
      if (block.kind === "tool") return toolDetailCache.range(block, columns, start, count)
      const sourceId = source.kind === "block" ? source.block.sourceId : source.tail.sourceId
      return lineCache.lineRangeOf(sourceId, columns, start, count) ?? renderDetailedTranscriptSourceRange(source, columns, start, count)
    },
    measure: (source, columns) => {
      const block = source.kind === "block" ? source.block : source.tail
      if (block.kind === "tool") return toolDetailCache.measure(block, columns)
      const sourceId = source.kind === "block" ? source.block.sourceId : source.tail.sourceId
      return lineCache.lineCountOf(sourceId, columns)
    },
  })
  // Structural batch behind the last committed session-content mirror;
  // the cache consumes it only when the lineage it was minted for is
  // the one being re-derived — a generation bump nulls it so the fold
  // cannot trust a numerically coincident window across a remint.
  let sessionChanges: SourceChangeBatch | null | undefined = undefined
  // The last committed frame allocation: key routing reads its input
  // ownership, and the paging paths spend its capacity rather than
  // re-deriving the row arithmetic between commits.
  let lastAllocation: FrameAllocation | null = null
  // The transcript view's reuse key: the line model's identity plus the
  // window coordinates and the label the view carries (the indicator
  // for the main window, the position for the reader). modelFor holds
  // the model object while the session, tail and columns identities
  // hold, so a chrome-only commit that leaves the window where it was
  // keeps the committed view object — no re-slice of stable history.
  let lastTranscript: {
    readonly model: TranscriptLineModel
    readonly start: number
    readonly end: number
    readonly indicator: string | null
    readonly view: TuiTranscriptView
  } | null = null
  let lastToolTranscript: {
    readonly model: TranscriptLineModel
    readonly start: number
    readonly end: number
    readonly position: string | null
    readonly view: TuiToolTranscriptView
  } | null = null

  /** Footer runs derive from the mirror, the editor mode and the pending set. */
  const hasToolActivity = (content: SessionContent, liveTail: readonly LiveTailBlock[]): boolean =>
    content.transcript.some((block) => block.kind === "tool") || liveTail.some((block) => block.kind === "tool")

  const footerRuns = (
    pending: readonly PendingRun[],
    hasTools = hasToolActivity(snapshot.session, snapshot.liveTail),
  ): readonly TextRun[] => {
    const segments =
      footerTelemetry === null
        ? [...footerMinimalSegments(pending, kernel.editorMode)]
        : [...footerSegments({ telemetry: footerTelemetry, editorMode: kernel.editorMode, pending })]
    // A card owns every key but interrupt, so the reader's open path
    // refuses ctrl+o under it — the footer must not advertise it.
    if (hasTools && !anyCardVisible()) segments.push({ text: "ctrl+o tool details", token: "muted" })
    return segments
  }

  /** The card-less chrome sharing the terminal with the transcript, as one snapshot carries it. */
  const chromeOf = (view: TuiStateSnapshot): TranscriptChrome => ({
    editor: view.editor,
    completion: view.completion,
    hint: view.hint,
    notice: view.slashNotice,
    queued: view.queued,
    footer: view.footer,
    agentsRunning: view.agentsSummary,
  })

  /** Body rows the focused panel's window gets; a one-row grant spends all on the header. */
  const childBodyBudgetOf = (capacity: number): number => Math.max(0, capacity - (capacity >= 2 ? 2 : capacity))

  /**
   * Raw index the window starting at `start` ends at: the longest run
   * of lines whose wrapped rows fit the budget at `columns`. The first
   * line is always consumed, so a line taller than the budget anchors
   * a one-line window the paint splices rather than skips.
   */
  const childWindowEndAfter = (entry: ChildAgentView, start: number, budget: number, columns: number): number => {
    let rows = 0
    let index = Math.max(0, Math.min(start, entry.lines.length))
    const first = index
    while (index < entry.lines.length) {
      const wrapped = wrapVerbatim(expandTabs(sanitizeText(entry.lines[index]!)), columns).length
      if (rows + wrapped > budget && index !== first) break
      rows += wrapped
      index += 1
    }
    return index
  }

  /** The tail mirror of childWindowEndAfter: where the window ending at `end` starts. */
  const childWindowStartOf = (entry: ChildAgentView, end: number, budget: number, columns: number): number => {
    let rows = 0
    let index = Math.min(end, entry.lines.length)
    const first = index
    while (index > 0) {
      const wrapped = wrapVerbatim(expandTabs(sanitizeText(entry.lines[index - 1]!)), columns).length
      if (rows + wrapped > budget && index !== first) break
      rows += wrapped
      index -= 1
    }
    return index
  }

  /**
   * The focused entry's window end: the raw row the painted body stops
   * at. The scroll clamp counts wrapped rows — raw-line arithmetic
   * would strand a wrapping buffer's head behind the body budget.
   */
  const childWindowEndOf = (entry: ChildAgentView, budget: number, columns: number): number => {
    if (entry.scroll <= 0) return entry.lines.length
    const head = childWindowEndAfter(entry, 0, budget, columns)
    return entry.lines.length - Math.min(entry.scroll, Math.max(0, entry.lines.length - head))
  }

  /**
   * The focused child's panel as one budgeted surface: the header and
   * hint each spend one capacity row (the hint drops below two), body
   * rows are the buffer's tail sanitized and wrapped at the layout
   * width, and the entry's scroll lifts the window off the tail. Null
   * while no entry holds focus. The hint names the cancel affordance
   * only while the interrupt would reach the child — a visible card
   * owns Ctrl+C first.
   */
  const childPanelOf = (view: TuiAgentsView, capacity: number, columns: number, cardVisible: boolean): TuiChildPanelView | null => {
    if (view.focusIndex === null) return null
    // The header paints unconditionally, so a zero-row grant must not
    // mint a panel: nothing may paint against rows the frame never
    // budgeted.
    if (capacity < 1) return null
    const entry: ChildAgentView | undefined = view.entries[view.focusIndex]
    if (entry === undefined) return null
    const chromeRows = capacity >= 2 ? 2 : capacity
    const bodyBudget = childBodyBudgetOf(capacity)
    const end = childWindowEndOf(entry, bodyBudget, columns)
    const body: string[] = []
    for (let index = end - 1; index >= 0 && body.length < bodyBudget; index -= 1) {
      const wrapped = [...wrapVerbatim(expandTabs(sanitizeText(entry.lines[index]!)), columns)]
      const room = bodyBudget - body.length
      if (wrapped.length > room) wrapped.splice(0, wrapped.length - room)
      body.unshift(...wrapped)
    }
    // The interrupt routing rejects the cancellation under any visible
    // card, so the hint must not promise it there.
    const cancelable = entry.status === "running" && entry.childSessionId !== null && !cardVisible
    return {
      // The description is model-authored; the header shares the body's
      // control-sequence hygiene.
      header: sanitizeText(
        `${entry.subagentType ?? "agent"}${entry.description.length > 0 ? `: ${entry.description}` : ""} · ${entry.status}`,
      ),
      lines: body,
      hint: capacity >= 2 ? `alt+←/→ switch${cancelable ? " · ctrl+c cancel" : ""}` : null,
      rows: chromeRows + body.length,
    }
  }

  /**
   * Window coordinates and labels without materializing lines — lazy
   * segments render on slice, so stillness probes compare coordinates
   * here and slice only on the commit that paints them.
   */
  const windowCoords = (
    model: TranscriptLineModel,
    view: TranscriptViewport,
    capacity: number,
  ): {
    readonly start: number
    readonly end: number
    readonly indicator: string | null
    readonly position: string | null
  } => {
    // Both windows spend the same budget: the indicator rides the
    // composer's rule, so crossing the follow boundary never shifts
    // the frame by a row.
    const window = viewportWindow(view, model, Math.max(0, capacity))
    if (window === null) return { start: 0, end: 0, indicator: null, position: null }
    return {
      start: window.start,
      end: window.end,
      indicator: viewportIndicator(view, window, model.total, capacity),
      position: viewportPosition(view, window, model.total, capacity),
    }
  }

  /** The window one view renders at one capacity: coordinates plus the slice the view paints. */
  const deriveWindow = (
    model: TranscriptLineModel,
    view: TranscriptViewport,
    capacity: number,
  ): {
    readonly start: number
    readonly end: number
    readonly lines: readonly TranscriptLine[]
    readonly indicator: string | null
    readonly position: string | null
  } => {
    const coords = windowCoords(model, view, capacity)
    return { ...coords, lines: model.slice(coords.start, coords.end - coords.start) }
  }

  /**
   * Re-derive the transcript window for one committed view state — the
   * single choke point every revision passes through, so content, tail,
   * layout, key, queue, notice, card and footer commits all move the
   * window with the state they committed.
   */
  const deriveTranscript = (next: TuiStateSnapshot): TuiStateSnapshot => {
    const active = activeCardOf()
    // The reset fields are re-derived below; the previous values seed
    // the reuse gates so an unchanged surface keeps its reference.
    const previousCardLines = next.cardLines
    const previousIntroLines = next.introLines
    const previousChildPanel = next.childPanel
    // The running-children summary is one chrome row above the footer;
    // derived with the agents view so every commit path budgets it.
    const agentsSummary = next.agents.runningCount > 0 ? `agents: ${next.agents.runningCount} running · alt+←/→ to focus` : null
    const normalized = {
      ...next,
      agentsSummary,
      activeCard: active,
      cardLines: [],
      introLines: [],
      composerPrefix: 0,
      cursorVisible: active === null,
      supportFloor: false,
    }
    if (layout === null) return normalized
    // One allocation decides every row budget and the input ownership
    // this revision renders; the comments that named the ladder's
    // rules live on the allocator now.
    const allocation = allocateFrame(chromeOf(normalized), layout, active === null ? null : active.cardView)
    lastAllocation = allocation
    const model = lineCache.modelFor(normalized.session, normalized.liveTail, layout.columns, sessionChanges)
    const window = deriveWindow(model, resolveViewport(viewport, model), allocation.transcriptCapacity)
    const transcript =
      lastTranscript !== null &&
      lastTranscript.model === model &&
      lastTranscript.start === window.start &&
      lastTranscript.end === window.end &&
      lastTranscript.indicator === window.indicator
        ? lastTranscript.view
        : { lines: window.lines, start: window.start, indicator: window.indicator }
    lastTranscript = {
      model,
      start: window.start,
      end: window.end,
      indicator: window.indicator,
      view: transcript,
    }
    let toolTranscript: TuiToolTranscriptView = emptyToolTranscriptView
    if (toolTranscriptOpen) {
      const detailedModel = toolTranscriptCache.modelFor(normalized.session, normalized.liveTail, layout.columns, sessionChanges)
      toolTranscriptViewport = resolveViewport(toolTranscriptViewport, detailedModel)
      const detailedCapacity = Math.max(0, layout.rows - READER_CHROME_ROWS)
      const detailedWindow = deriveWindow(detailedModel, toolTranscriptViewport, detailedCapacity)
      toolTranscript =
        lastToolTranscript !== null &&
        lastToolTranscript.model === detailedModel &&
        lastToolTranscript.start === detailedWindow.start &&
        lastToolTranscript.end === detailedWindow.end &&
        lastToolTranscript.position === detailedWindow.position
          ? lastToolTranscript.view
          : {
              lines: detailedWindow.lines,
              start: detailedWindow.start,
              position: detailedWindow.position,
            }
      lastToolTranscript = {
        model: detailedModel,
        start: detailedWindow.start,
        end: detailedWindow.end,
        position: detailedWindow.position,
        view: toolTranscript,
      }
    }
    // The focused child's panel replaces the transcript surface: same
    // capacity budget, wrapped at the layout width; the main window's
    // indicator hides beneath it.
    const childPanel = childPanelOf(normalized.agents, allocation.transcriptCapacity, allocation.columns, active !== null)
    const transcriptEmpty = normalized.session.transcript.length === 0 && normalized.liveTail.length === 0
    const introLines =
      transcriptEmpty && options.intro !== undefined ? options.intro.slice(0, Math.max(0, allocation.transcriptCapacity)) : []
    const introEqual =
      introLines.length === previousIntroLines.length && introLines.every((line, index) => line === previousIntroLines[index])
    const cardLines = allocation.card.lines
    const transcriptRows = childPanel !== null ? childPanel.rows : transcriptEmpty ? introLines.length : window.lines.length
    return {
      ...normalized,
      transcript,
      toolTranscriptOpen,
      toolTranscript,
      introLines: introEqual ? previousIntroLines : introLines,
      cardLines: cardLinesEqual(cardLines, previousCardLines) ? previousCardLines : cardLines,
      composerRows: allocation.composerBodyRows,
      composerPrefix: allocation.composerPrefixRows(transcriptRows),
      cursorVisible: allocation.cursorVisible,
      supportFloor: allocation.supportFloor,
      childPanel: childPanelEqual(childPanel, previousChildPanel) ? previousChildPanel : childPanel,
    }
  }

  const commit = (next: TuiStateSnapshot): void => {
    snapshot = deriveTranscript(next)
    // Copy the listener set: unsubscribing from inside a notification must
    // not skip subscribers that are still registered. A throwing listener
    // must not stall the commit or swallow the notifications owed to the
    // others; the first fault is rethrown once everyone was notified.
    let firstFault: unknown
    let failed = false
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (fault) {
        if (!failed) {
          firstFault = fault
          failed = true
        }
      }
    }
    if (failed) throw firstFault
  }

  /**
   * Re-derive picker candidates from the draft's current token context.
   * A paste keeps the companion closed: the kernel already vetoed the
   * token highlight for the pasted fragment, and the next ordinary key
   * re-derives a fresh context that may reopen it.
   */
  const resyncCompletion = (allowOpen = true): void => {
    const context = allowOpen ? kernel.completionContext() : null
    const source = context === null ? undefined : context.kind === "mention" ? sources.mention : commandSource
    if (context === null || source === undefined) {
      picker.sync(null, [])
      return
    }
    const matches = matchCompletions(
      context.query,
      source(),
      context.kind === "mention" ? FILE_PROFILE : COMMAND_PROFILE,
      context.kind === "mention" ? { limit: MAX_MENTION_CANDIDATES } : undefined,
    )
    picker.sync(context, context.kind === "mention" ? mentionCandidates(matches) : commandCandidates(matches))
  }

  /**
   * Publish the current editor, picker, hint, slash and card state as
   * one revision. A visible card or an open reader hides the
   * completion surface in the snapshot — both own every key, so a
   * picker row advertising Enter/arrows under them would promise a
   * routing that never happens (and double-count the transcript
   * budget).
   */
  const commitView = (): void => {
    // Unchanged surfaces keep their previous references: the editor
    // state is identical while the kernel's draft counter held, and
    // value-equal footer runs and picker windows reuse the committed
    // objects, so memoized view boundaries see stable props.
    const editor = kernel.draftRevision === snapshot.editor.revision ? snapshot.editor : { kernel, revision: kernel.draftRevision }
    const footer = footerRuns(snapshot.session.pending)
    const completion = anyCardVisible() || toolTranscriptOpen ? null : picker.isVisible() ? picker.window() : null
    commit({
      ...snapshot,
      revision: snapshot.revision + 1,
      layout,
      editor,
      completion: completionEqual(completion, snapshot.completion) ? snapshot.completion : completion,
      hint: policy.hint(),
      slashNotice,
      footer: textRunsEqual(footer, snapshot.footer) ? snapshot.footer : footer,
      recentlyDenied,
      agents: agentsView(),
    })
  }

  /**
   * Route one composer submission: plain prompts bubble as submissions;
   * a "!" prefix bubbles as a shell command (prefix stripped, remainder
   * trimmed — the host owns execution and the queue text keeps the "!").
   * Slash text never reaches the prompt path — it either bubbles as a
   * slash input for the host to execute through its busy coordination, or
   * the failure lands the local feedback surface. The surface reflects
   * the latest submission only.
   */
  const routeSubmission = (text: string): readonly TuiStateEffect[] => {
    try {
      const input = parseSlashSubmission(text)
      if (input === null) {
        slashNotice = null
        // An accepted submission is an explicit return to the tail.
        viewport = FOLLOW_VIEWPORT
        if (text.startsWith("!")) return [{ kind: "shell", command: text.slice(1).trim() }]
        return [{ kind: "submit", text }]
      }
      if (slash.resolve(input.name) === undefined) {
        slashNotice = unknownSlashNotice(input)
        return []
      }
      slashNotice = null
      // An accepted submission is an explicit return to the tail.
      viewport = FOLLOW_VIEWPORT
      return [{ kind: "slash", input }]
    } catch (error) {
      slashNotice = slashParseErrorNotice(error)
      return []
    }
  }

  /**
   * Route one key intent while the theme card is visible: the card claims
   * its modal vocabulary (movement previews live, Enter commits and
   * spends the draft, Escape restores and keeps it); every unclaimed key
   * stays draft-driven — characters land in the composer and resync as
   * the card's query. The picker never sees keys while a card is open.
   */
  const dispatchThemeCardIntent = (intent: TuiIntent): readonly TuiStateEffect[] => {
    const cardEffects = themeCard.dispatch(intent)
    if (cardEffects !== null) {
      // A commit spends the draft (never recalled from history); a cancel
      // keeps it for further edits.
      if (cardEffects.some((effect) => effect.kind === "theme-commit")) kernel.clearDraft(false)
      resyncCompletion()
      commitView()
      return cardEffects
    }
    const outcome = kernel.dispatch(intent)
    if (outcome === undefined) return []
    themeCard.syncQuery(kernel.text)
    resyncCompletion(intent.kind !== "paste")
    commitView()
    return []
  }

  /**
   * Route one key intent while the rewind card is visible: the card owns
   * every key but interrupt — movement and digit picks move focus, Enter
   * confirms, Escape closes; absorbed keys commit nothing and the draft
   * never moves under the modal.
   */
  const dispatchRewindCardIntent = (intent: TuiIntent): readonly TuiStateEffect[] => {
    const result = rewindCard.dispatch(intent)
    if (result === null) return []
    // A confirmed rewind forks from an earlier input: the transcript the
    // reader may have anchored to is replaced, so the viewport resumes
    // the tail.
    if (result.effects.some((effect) => effect.kind === "rewind")) viewport = FOLLOW_VIEWPORT
    if (result.changed) commitView()
    return result.effects
  }

  /**
   * Route one key intent while the resume card is visible: the card owns
   * every key but interrupt — movement and digit picks move focus, Enter
   * switches the session, Escape closes; absorbed keys commit nothing.
   */
  const dispatchResumeCardIntent = (intent: TuiIntent): readonly TuiStateEffect[] => {
    const result = resumeCard.dispatch(intent)
    if (result === null) return []
    // A confirmed resume swaps the whole session: the viewport resumes
    // the tail of the incoming transcript.
    if (result.effects.some((effect) => effect.kind === "resume")) viewport = FOLLOW_VIEWPORT
    if (result.changed) commitView()
    return result.effects
  }

  /**
   * Route one key intent while the permissions card is visible: the card
   * owns every key but interrupt. Enter on a row bubbles the canonical
   * commit (the host answers through the permission-applied and
   * permission-stale inputs); the add-rule request stays internal — the
   * card is closed and the composer draft seeded in the same dispatch.
   * A full-access mode commit this process has not confirmed is held
   * back: the confirmation card replaces both the commit and the card
   * that requested it until Enter confirms.
   */
  const dispatchPermissionsCardIntent = (intent: TuiIntent): readonly TuiStateEffect[] => {
    const result = permissionsCard!.dispatch(intent)
    if (result === null) return []
    const effects: TuiStateEffect[] = []
    let intercepted = false
    for (const effect of result.effects) {
      if (effect.kind === "permission-rule-add") kernel.loadDraft(PERMISSIONS_RULE_ADD_DRAFT)
      else if (effect.kind === "permission-mode" && effect.mode === "full-access" && !fullAccessConfirmed()) {
        confirmCard.open(permissionModeMirror() !== "full-access", sessionIdentity())
        permissionsCard!.close()
        intercepted = true
      } else effects.push(effect)
    }
    resyncCompletion()
    if (intercepted || result.changed) commitView()
    return effects
  }

  /**
   * Route one key intent while the full-access confirmation card is
   * visible: the card owns every key but interrupt — Enter records the
   * confirmation (plus the canonical mode commit when the entry
   * implies one), Escape cancels to the composer. Once Enter submits a
   * mode change the card itself absorbs every key until the canonical
   * echo resolves the wait.
   */
  const dispatchConfirmCardIntent = (intent: TuiIntent): readonly TuiStateEffect[] => {
    const result = confirmCard.dispatch(intent)
    if (result === null) return []
    if (result.changed) commitView()
    return result.effects
  }

  /**
   * Route one key intent while the diff card is visible: the card owns
   * every key but interrupt. Enter adopts the focused file's detail as
   * the preview document inside the same card; Escape pops one level.
   * Nothing bubbles — the host seeded the file list and the card holds
   * no git or projection authority.
   */
  const dispatchDiffCardIntent = (intent: TuiIntent): readonly TuiStateEffect[] => {
    const result = diffCard.dispatch(intent)
    if (result === null) return []
    if (result.changed) commitView()
    return result.effects
  }

  /**
   * Route one key intent while the document card is visible: the card
   * owns every key but interrupt — navigation pages the document,
   * Escape closes it, and stray characters are absorbed. Nothing
   * bubbles: the host composed the document and the card holds no
   * authority beyond showing it.
   */
  const dispatchDocCardIntent = (intent: TuiIntent): readonly TuiStateEffect[] => {
    const result = docCard.dispatch(intent)
    if (result === null) return []
    if (result.changed) commitView()
    return []
  }

  /**
   * Route one key intent while the ask card is visible: the card owns
   * every key but interrupt. Enter on the last question bubbles the
   * answer table, "c" the chat escape and Escape on the first the
   * decline; every outcome closes the card, and the host resolves the
   * request through its answers port.
   */
  const dispatchAskCardIntent = (intent: TuiIntent): readonly TuiStateEffect[] => {
    const result = askCard.dispatch(intent)
    if (result === null) return []
    if (result.changed) commitView()
    return result.effects
  }

  /**
   * Route one key intent while an approval is pending: the card owns
   * every key. Cardinal directions flip the decision and Enter commits
   * it once — the effect bubbles for the host to resolve through its
   * approval port, and the card is closed in the same dispatch.
   * Escape is claimed and swallowed: a pending approval must be decided.
   */
  const dispatchApprovalCardIntent = (intent: TuiIntent): readonly TuiStateEffect[] => {
    const result = approvalCard.dispatch(intent)
    if (result === null) return []
    if (result.changed) commitView()
    return result.effects
  }

  /**
   * Route one key intent: the resting-screen policy claims its vocabulary
   * first (the draft clear it requests is applied here), a visible card
   * claims its modal keys next, everything transparent falls through to
   * the visible picker and the kernel.
   */
  const dispatchKeyIntent = (intent: TuiIntent): readonly TuiStateEffect[] => {
    const effects: TuiStateEffect[] = []
    const revisionBefore = snapshot.revision
    const policyBefore = policy.revision
    const cardClaim = lastAllocation === null || lastAllocation.card.active
    const cardOwnsKeys = cardClaim && anyCardVisible()
    // The focus chord needs a paintable panel: a zero capacity or the
    // support floor paints none (the header paints from one row up),
    // so cycling an invisible child would ambush the surface that does
    // render. Unlike the abort, the move also needs geometry — before
    // it nothing has painted at all.
    const childPanelPaintable = lastAllocation !== null && lastAllocation.transcriptCapacity >= 1 && !lastAllocation.supportFloor
    // The focused entry's scrolls need a paintable body window: a one-
    // or two-row panel spends its whole grant on chrome, so scrolling
    // there would bank a shift no paint reveals.
    const childBodyPaintable =
      lastAllocation !== null && childBodyBudgetOf(lastAllocation.transcriptCapacity) >= 1 && !lastAllocation.supportFloor
    // A running child holding focus turns the abort into its
    // cancellation — never under a card: the modal keeps the interrupt
    // (its exit claim disarms there, its approval pressure stays). The
    // detailed reader hides the panel, and so does a grant that cannot
    // paint it (zero capacity or the support floor, where only the
    // exit path survives); under both the interrupt keeps its root
    // semantics instead of cancelling an invisible child. Before any
    // geometry the visible check stands in.
    if (agents !== undefined && intent.kind === "interrupt") {
      const target = agents.focusedRunningChild()
      if (
        target !== null &&
        !anyCardVisible() &&
        !toolTranscriptOpen &&
        (lastAllocation === null || (lastAllocation.transcriptCapacity >= 1 && !lastAllocation.supportFloor))
      ) {
        // The press still passes the policy's activity gate: an armed
        // exit window must not outlive the cancellation press.
        const disarmed = policy.noteActivity()
        const cancelEffects: TuiStateEffect[] = [{ kind: "cancel-child", childSessionId: target }]
        if (disarmed) commitView()
        return cancelEffects
      }
    }
    if (toolTranscriptOpen && !cardOwnsKeys && (intent.kind === "back" || intent.kind === "tool-details")) {
      toolTranscriptOpen = false
      policy.noteActivity()
      commitView()
      return []
    }
    // Rotation is a resting-screen affordance whose only feedback is
    // the footer chip — under the reader the footer is hidden, so the
    // key stays inert instead of rotating an invisible mode.
    if (toolTranscriptOpen && !cardOwnsKeys && intent.kind === "input" && intent.event.type === "shift-tab") {
      if (policy.noteActivity()) commitView()
      return []
    }
    const rootEffects = policy.dispatch(intent)
    // A key the policy passes through can still cancel its confirmation
    // windows (any unrelated key disarms both): the hint transition the
    // policy minted must reach the view even when the surface that took
    // the key treats it as inert. Paths that already committed carry the
    // new hint with them, so settling stays a no-op there.
    const settle = (result: readonly TuiStateEffect[]): readonly TuiStateEffect[] => {
      if (policy.revision !== policyBefore && snapshot.revision === revisionBefore) commitView()
      return result
    }
    if (rootEffects !== null) {
      for (const effect of rootEffects) {
        if (effect.kind === "clear-draft") kernel.clearDraft(true)
        else if (effect.kind === "open-rewind" && options.rewind !== undefined) {
          // A wired checkpoint source makes the card the chain's
          // destination; the rewind request stays internal.
          rewindCard.open(options.rewind.checkpoints())
        } else effects.push(effect)
      }
      resyncCompletion()
      // A claimed-but-inert key (Shift+Tab with no mode sequence) must not
      // mint a revision; every observable policy move bumps its counter.
      if (policy.revision !== policyBefore) commitView()
      return effects
    }
    // Focus cycling is a frame-level chord: the policy passed it
    // through and no card binds Alt+←/→, so the panel claims it as a
    // pure view commit — the transcript surface the frame renders is
    // what moves. A visible card that owns keys still claims every key
    // first (cycling beneath a modal would ambush its close with a
    // focused child panel), and the detailed reader replaces the
    // surface entirely, so under either the chord is inert.
    if (agents !== undefined && intent.kind === "focus-cycle" && !cardOwnsKeys && !toolTranscriptOpen && childPanelPaintable) {
      if (!agents.cycleFocus(intent.direction)) return settle([])
      commitView()
      return []
    }
    // The allocation owns the card's key claim: a card below its row
    // budget (zero painted rows) or the whole terminal below the
    // support floor loses it, and its keys fall through to paging, the
    // picker and the editor. Before any geometry the visible check
    // stands in.
    if (cardClaim && themeCard.isVisible()) return settle(dispatchThemeCardIntent(intent))
    if (cardClaim && rewindCard.isVisible()) return settle(dispatchRewindCardIntent(intent))
    if (cardClaim && resumeCard.isVisible()) return settle(dispatchResumeCardIntent(intent))
    if (cardClaim && permissionsCard !== null && permissionsCard.isVisible()) return settle(dispatchPermissionsCardIntent(intent))
    if (cardClaim && confirmCard.isVisible()) return settle(dispatchConfirmCardIntent(intent))
    if (cardClaim && diffCard.isVisible()) return settle(dispatchDiffCardIntent(intent))
    if (cardClaim && docCard.isVisible()) return settle(dispatchDocCardIntent(intent))
    if (cardClaim && askCard.isVisible()) return settle(dispatchAskCardIntent(intent))
    if (cardClaim && approvalCard.isVisible()) return settle(dispatchApprovalCardIntent(intent))
    if (intent.kind === "tool-details") {
      if (
        anyCardVisible() ||
        layout === null ||
        lastAllocation === null ||
        lastAllocation.supportFloor ||
        !hasToolActivity(snapshot.session, snapshot.liveTail)
      ) {
        return settle([])
      }
      toolTranscriptOpen = true
      toolTranscriptViewport = FOLLOW_VIEWPORT
      commitView()
      return []
    }
    if (toolTranscriptOpen) {
      // The reader rides the frame's fate: below the support floor the
      // root paints only its too-small diagnostic, so scrolling an
      // invisible reader mints nothing until the terminal recovers.
      if (layout === null || lastAllocation === null || lastAllocation.supportFloor) return settle([])
      if (intent.kind === "navigate" && ["up", "down", "page-up", "page-down"].includes(intent.direction)) {
        const model = toolTranscriptCache.modelFor(snapshot.session, snapshot.liveTail, layout.columns, sessionChanges)
        const capacity = Math.max(0, layout.rows - READER_CHROME_ROWS)
        toolTranscriptViewport = resolveViewport(toolTranscriptViewport, model)
        const current = windowCoords(model, toolTranscriptViewport, capacity)
        const next =
          intent.direction === "up"
            ? viewportWheelUp(toolTranscriptViewport, model, capacity, 1)
            : intent.direction === "down"
              ? viewportWheelDown(toolTranscriptViewport, model, capacity, 1)
              : intent.direction === "page-up"
                ? viewportPageUp(toolTranscriptViewport, model, capacity)
                : viewportPageDown(toolTranscriptViewport, model, capacity)
        const moved = windowCoords(model, resolveViewport(next, model), capacity)
        // The reader view carries the position label, so stillness is measured in it.
        if (moved.start === current.start && moved.end === current.end && moved.position === current.position) return settle([])
        toolTranscriptViewport = next
        commitView()
        return []
      }
      if (intent.kind === "wheel") {
        const model = toolTranscriptCache.modelFor(snapshot.session, snapshot.liveTail, layout.columns, sessionChanges)
        const capacity = Math.max(0, layout.rows - READER_CHROME_ROWS)
        toolTranscriptViewport = resolveViewport(toolTranscriptViewport, model)
        const current = windowCoords(model, toolTranscriptViewport, capacity)
        const next =
          intent.direction === "up"
            ? viewportWheelUp(toolTranscriptViewport, model, capacity)
            : viewportWheelDown(toolTranscriptViewport, model, capacity)
        const moved = windowCoords(model, resolveViewport(next, model), capacity)
        if (moved.start === current.start && moved.end === current.end && moved.position === current.position) return settle([])
        toolTranscriptViewport = next
        commitView()
        return []
      }
      return settle([])
    }
    if (intent.kind === "navigate" && (intent.direction === "page-up" || intent.direction === "page-down")) {
      // The viewport claims paging after the cards and before the
      // picker: an open card paged above, and the editor kernel ignores
      // the keys, so the transcript is what they move. Until geometry
      // arrives there is no window to move; below the support floor
      // the frame paints only its diagnostic, so the window is
      // invisible and its scrolls mint nothing until the terminal
      // recovers. The capacity is the last committed allocation's —
      // the same budget the window rendered with, never re-derived
      // between commits.
      if (layout === null || lastAllocation === null || lastAllocation.supportFloor) return settle([])
      // A focused entry owns the paging: its buffer pages, the main
      // transcript's viewport holds — including when the body cannot
      // paint, where the press mints nothing rather than moving the
      // main window the panel paints over.
      if (agents !== undefined && agents.focusedEntry() !== null) {
        if (!childBodyPaintable) return settle([])
        const entry = agents.focusedEntry()!
        const step = lastAllocation.transcriptCapacity
        const budget = childBodyBudgetOf(step)
        const columns = lastAllocation.columns
        // The body spends wrapped rows, so the page step and the scroll
        // clamp count raw lines through the wrap walks the paint
        // performs; a raw step would skip screens of a wrapping buffer.
        // A stale scroll above the clamp (a shrink since the last
        // paint) stillness-gates like the main surface.
        const before = childWindowEndOf(entry, budget, columns)
        const delta =
          intent.direction === "page-up"
            ? before - childWindowStartOf(entry, before, budget, columns)
            : -(childWindowEndAfter(entry, before, budget, columns) - before)
        if (!agents.scrollFocused(delta, childWindowEndAfter(entry, 0, budget, columns))) return settle([])
        // The entry view captured above is immutable; re-read it so the
        // gate sees the scroll the mutation landed.
        if (childWindowEndOf(agents.focusedEntry()!, budget, columns) === before) return settle([])
        commitView()
        return []
      }
      const model = lineCache.modelFor(snapshot.session, snapshot.liveTail, layout.columns, sessionChanges)
      const capacity = lastAllocation.transcriptCapacity
      const current = windowCoords(model, resolveViewport(viewport, model), capacity)
      // The viewport module owns the tiling arithmetic: pages step by
      // the anchored height, never skipping a line between windows.
      const next = intent.direction === "page-up" ? viewportPageUp(viewport, model, capacity) : viewportPageDown(viewport, model, capacity)
      const moved = windowCoords(model, resolveViewport(next, model), capacity)
      // A claimed-but-inert press (at the top, at the tail, everything
      // fitting) leaves the coordinates untouched and mints nothing.
      if (moved.start === current.start && moved.end === current.end && moved.indicator === current.indicator) return settle([])
      viewport = next
      commitView()
      return []
    }
    if (intent.kind === "wheel") {
      // Mouse wheel is its own normalized input. Cards above own it first;
      // only the transcript scrolls while the main surface has focus.
      if (layout === null || lastAllocation === null || lastAllocation.supportFloor) return settle([])
      // The focused entry owns the wheel exactly as it owns paging, at
      // the wheel notch every other wheel surface scrolls by; a body
      // that cannot paint mints nothing rather than moving the main
      // window the panel paints over.
      if (agents !== undefined && agents.focusedEntry() !== null) {
        if (!childBodyPaintable) return settle([])
        const entry = agents.focusedEntry()!
        const budget = childBodyBudgetOf(lastAllocation.transcriptCapacity)
        const columns = lastAllocation.columns
        // The notch steps raw lines at the size every other wheel
        // surface scrolls by; the clamp counts wrapped rows like the
        // paint, and the stillness rule the paging branch carries
        // applies.
        const visible = childWindowEndAfter(entry, 0, budget, columns)
        const before = childWindowEndOf(entry, budget, columns)
        if (!agents.scrollFocused(intent.direction === "up" ? WHEEL_STEP_LINES : -WHEEL_STEP_LINES, visible)) return settle([])
        if (childWindowEndOf(agents.focusedEntry()!, budget, columns) === before) return settle([])
        commitView()
        return []
      }
      const model = lineCache.modelFor(snapshot.session, snapshot.liveTail, layout.columns, sessionChanges)
      const capacity = lastAllocation.transcriptCapacity
      const current = windowCoords(model, resolveViewport(viewport, model), capacity)
      const next = intent.direction === "up" ? viewportWheelUp(viewport, model, capacity) : viewportWheelDown(viewport, model, capacity)
      const moved = windowCoords(model, resolveViewport(next, model), capacity)
      if (moved.start === current.start && moved.end === current.end && moved.indicator === current.indicator) return settle([])
      viewport = next
      commitView()
      return []
    }
    // The support floor strips the picker's claim too: below it keys
    // fall through to the editor kernel untouched.
    const pickerOutcome = lastAllocation?.supportFloor === true ? undefined : picker.dispatch(intent)
    if (pickerOutcome === undefined) {
      const outcome = kernel.dispatch(intent)
      if (outcome === undefined) return settle([])
      if (outcome.kind === "submitted") effects.push(...routeSubmission(outcome.text))
    } else if (pickerOutcome.kind === "commit") {
      // The kernel re-derives the token and rejects the replacement when
      // the range went stale between sync and keypress — or now answers
      // a different query than the one this ranking was minted against;
      // the picker has already consumed the keypress, so the snapshot
      // still re-publishes.
      if (
        kernel.replaceDraftRange(
          pickerOutcome.replaceRange[0],
          pickerOutcome.replaceRange[1],
          pickerOutcome.insertText,
          pickerOutcome.expected,
        )
      ) {
        if (pickerOutcome.submitAfter) {
          const submitted = kernel.dispatch({ kind: "activate" })
          if (submitted?.kind === "submitted") effects.push(...routeSubmission(submitted.text))
        }
      }
    } else if (!pickerOutcome.changed) {
      // A selection clamped onto the row the window already shows left
      // every observable untouched: no revision mints.
      return settle([])
    }
    resyncCompletion(intent.kind !== "paste")
    commitView()
    return effects
  }

  const baseStore: TuiStateStore = {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      return snapshot
    },
    themeCardVisible() {
      return themeCard.isVisible()
    },
    windowDeadline() {
      return policy.nextWindowDeadline()
    },
    now() {
      return clock()
    },
    dispatch(input) {
      if (input.kind === "key-intent") return dispatchKeyIntent(input.intent)
      if (input.kind === "layout") {
        // The single geometry authority: degenerate sizes clamp to one
        // column and zero rows, a non-finite reading (a host reading a
        // terminal that cannot report geometry) clamps to the same
        // floor instead of poisoning the layout with NaN, and a
        // value-equal layout mints nothing.
        const next: TranscriptLayout = {
          columns: Number.isFinite(input.columns) ? Math.max(1, Math.floor(input.columns)) : 1,
          rows: Number.isFinite(input.rows) ? Math.max(0, Math.floor(input.rows)) : 0,
        }
        if (layout !== null && layout.columns === next.columns && layout.rows === next.rows) return []
        layout = next
        commitView()
        return []
      }
      if (input.kind === "expire-windows") {
        // The host schedules this at windowDeadline(); an expiry that
        // disarms nothing (a fresh press already re-armed the window)
        // commits nothing.
        if (!policy.expireWindows()) return []
        commit({ ...snapshot, revision: snapshot.revision + 1, hint: policy.hint() })
        return []
      }
      if (input.kind === "slash-notice") {
        // The host executed a command and reports its outcome; the same
        // notice twice is the same view state, and null clears it.
        const current = snapshot.slashNotice
        const equal =
          current === input.notice ||
          (current !== null &&
            input.notice !== null &&
            current.kind === input.notice.kind &&
            current.title === input.notice.title &&
            current.body === input.notice.body)
        if (equal) return []
        slashNotice = input.notice
        commit({ ...snapshot, revision: snapshot.revision + 1, slashNotice: input.notice })
        return []
      }
      if (input.kind === "load-draft") {
        // The host restores a draft — a confirmed rewind returns the
        // consumed prompt as an editable seed. An equal seed is the
        // same view state: no revision, no notification.
        if (kernel.text === input.text) return []
        kernel.loadDraft(input.text)
        resyncCompletion()
        commitView()
        return []
      }
      if (input.kind === "queue-preview") {
        // The host mirrors its run queue's derived preview; a mirror
        // that paints the same rows (a re-poll or a tail change under
        // the elision cap) mints nothing.
        const queued = input.preview
        if (
          queued.elided === snapshot.queued.elided &&
          queued.visible.length === snapshot.queued.visible.length &&
          queued.visible.every((text, index) => text === snapshot.queued.visible[index])
        ) {
          return []
        }
        commit({ ...snapshot, revision: snapshot.revision + 1, queued })
        return []
      }
      if (input.kind === "footer-telemetry") {
        // The host mirrors the runtime facts the footer renders; the
        // mirror digests into runs here, so a re-poll that renders the
        // same line mints nothing, and null falls back to the minimal
        // pending letter.
        footerTelemetry = input.telemetry
        if (textRunsEqual(footerRuns(snapshot.session.pending), snapshot.footer)) return []
        commitView()
        return []
      }
      if (input.kind === "open-theme-card") {
        // The host asks for the panel (the /theme command lands here); the
        // draft doubles as the query, so open reflects whatever it holds.
        // A palette with no match for it has nothing to show — no revision.
        if (urgentCardVisible()) return []
        themeCard.open(options.committedTheme?.() ?? null)
        themeCard.syncQuery(kernel.text)
        if (!themeCard.isVisible()) return []
        closeCardsBesides(themeCard)
        commitView()
        return []
      }
      if (input.kind === "open-rewind-card") {
        // The host asks for the card (the /rewind command lands here);
        // it opens over fresh checkpoints and always has the (current)
        // sentinel to offer, so an empty list is a valid card, not a
        // refusal — without a wired checkpoint source there is no
        // card and no revision.
        if (options.rewind === undefined || urgentCardVisible()) return []
        rewindCard.open(options.rewind.checkpoints())
        closeCardsBesides(rewindCard)
        commitView()
        return []
      }
      if (input.kind === "open-resume-card") {
        // The host fetched the resumable list (the /resume command
        // lands here). The slash layer already reports an empty
        // catalog as status text, so an empty list reaching this seam
        // has nothing to choose — no card, no revision.
        if (input.sessions.length === 0 || urgentCardVisible()) return []
        resumeCard.open(input.sessions)
        closeCardsBesides(resumeCard)
        commitView()
        return []
      }
      if (input.kind === "open-permissions-card") {
        // The host asks for the panel (the /permissions command lands
        // here, /add-dir lands on the Workspace tab); the card seeds
        // focus onto the tab's natural row. Without mode probes there
        // is nothing to show — no revision.
        if (permissionsCard === null || urgentCardVisible()) return []
        permissionsCard.open(input.tab)
        if (!permissionsCard.isVisible()) return []
        closeCardsBesides(permissionsCard)
        commitView()
        return []
      }
      if (input.kind === "open-full-access-confirm") {
        // The host diverted a full-access mode commit this process
        // has not confirmed (the mirror may or may not be full access
        // yet): the confirmation card opens over the facts captured
        // now, closing whatever panel held the surface.
        if (urgentCardVisible()) return []
        confirmCard.open(permissionModeMirror() !== "full-access", sessionIdentity())
        closeCardsBesides(confirmCard)
        commitView()
        return []
      }
      if (input.kind === "permission-applied") {
        // The host landed a commit of one genus: a landed retry clears
        // the stale line, and a mode commit also closes the card. The
        // awaiting full-access confirmation closes only on the MODE
        // echo it stands for — a rules echo (close false) leaves it
        // waiting, and a foreign echo before Enter answers nothing of
        // its own. An inert result (nothing open, nothing stale) mints
        // nothing.
        let changed = false
        if (permissionsCard !== null) {
          changed = permissionsCard.clearError() || changed
          if (input.close) changed = permissionsCard.close() || changed
        }
        if (input.commit === "mode" && input.close && confirmCard.isAwaiting()) changed = confirmCard.close() || changed
        if (changed) commitView()
        return []
      }
      if (input.kind === "permission-stale") {
        // The host could not apply a commit of one genus: the card that
        // requested it stays open with the inline error and the user's
        // place kept — the Mode tab's canonical marker shows what
        // actually holds. The confirmation card answers only its own
        // in-flight MODE commit (genus plus awaiting): a rules stale
        // never re-arms its answer keys over an unresolved mode commit,
        // and a report before Enter — or after the requesting card
        // closed (a self-closed confirmation, or one preempted by
        // another card, an ask among them) — shows nothing: its outcome
        // stays observable in the Mode tab and /permissions is the
        // recovery path.
        let changed = false
        if (permissionsCard !== null && permissionsCard.isVisible()) {
          permissionsCard.reportStale(input.message)
          changed = true
        }
        if (input.commit === "mode" && confirmCard.isAwaiting()) {
          confirmCard.reportStale(input.message)
          changed = true
        }
        if (changed) commitView()
        return []
      }
      if (input.kind === "permission-rules-mirrored") {
        // The host mirrored a canonical rules echo (its own commit's
        // echo or a replayed one): an open card reseeds its rule rows
        // in the same revision the mirror moved — the same landing the
        // denial ledger's input performs. An inert echo (nothing open,
        // fingerprint unchanged) mints nothing.
        if (permissionsCard === null || !permissionsCard.isVisible()) return []
        if (!permissionsCard.refresh()) return []
        commit({ ...snapshot, revision: snapshot.revision + 1 })
        return []
      }
      if (input.kind === "workspace-directories-mirrored") {
        // The host mirrored a canonical workspace directories echo: an
        // open card reseeds its Workspace rows in the same revision the
        // mirror moved. An inert echo (nothing open, fingerprint
        // unchanged) mints nothing.
        if (permissionsCard === null || !permissionsCard.isVisible()) return []
        if (!permissionsCard.refresh()) return []
        commit({ ...snapshot, revision: snapshot.revision + 1 })
        return []
      }
      if (input.kind === "open-diff-card") {
        // The host seeded the file list (the /diff command or the review
        // request lands here); with nothing to show there is no revision.
        if (urgentCardVisible()) return []
        diffCard.open(input.files)
        if (!diffCard.isVisible()) return []
        closeCardsBesides(diffCard)
        commitView()
        return []
      }
      if (input.kind === "open-doc-card") {
        // The host composed a read-only document (a report command
        // lands here); a document with no line shows nothing.
        if (urgentCardVisible()) return []
        if (!docCard.open(input.document)) return []
        closeCardsBesides(docCard)
        commitView()
        return []
      }
      if (input.kind === "open-ask-card") {
        // The host raised an ask (the runtime question lands here); the
        // card opens over the whole request. With no question to show
        // there is no revision. A blocking request preempts whatever
        // panel is up — it owns the surface until it settles.
        askCard.open(input.request)
        if (!askCard.isVisible()) return []
        closeCardsBesides(askCard)
        commitView()
        return []
      }
      if (input.kind === "approval-request") {
        // The host raised an approval (the pending tool run lands
        // here); adoption is compare-and-swap on version, and a stale
        // request mints nothing. The pending decision preempts
        // whatever panel is up.
        if (!approvalCard.open(input.request)) return []
        closeCardsBesides(approvalCard)
        commitView()
        return []
      }
      if (input.kind === "close-urgent-card") {
        // The host's bridge retracted its raised entry: the matching
        // card closes without a decision; any other card (a displaced
        // parent request, an entry already settled) stays put.
        const closed = askCard.closeIfRequest(input.requestId) || approvalCard.closeIfRequest(input.requestId)
        if (!closed) return []
        commitView()
        return []
      }
      if (input.kind === "tool-denial") {
        // The host observed a converged denial terminal (live or a
        // replayed one seeding a resumed session). The ledger keeps
        // the newest observation per call identity, newest first; a
        // value-identical re-observation (the resolution fact and the
        // committed result of one call) mints nothing.
        const next: readonly TuiDeniedCall[] = [
          {
            toolCallId: input.toolCallId,
            name: input.name,
            code: input.code,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
          ...recentlyDenied.filter((call) => !(call.name === input.name && call.toolCallId === input.toolCallId)),
        ].slice(0, MAX_RECENT_DENIALS)
        if (deniedCallsEqual(next, recentlyDenied)) return []
        recentlyDenied = next
        // The card reads the ledger through its denials probe, so an open
        // card reseeds its rows in the same revision the ledger moved.
        commit({
          ...snapshot,
          revision: snapshot.revision + 1,
          recentlyDenied,
        })
        return []
      }
      if (input.kind === "agents-mirrored") {
        // The host mirrored panel mutations (spawn facts, child lines,
        // terminals); a revision that already rode a key path or an
        // earlier mirror is the same view state.
        if (agents === undefined || committedAgentsRevision === agents.revision) return []
        commitView()
        return []
      }
      if (input.kind === "session-detached") {
        // The host detached from its session: the incoming session's
        // replay re-seeds state afterwards, so everything mirroring the
        // detached session dies first — the ledger, the feedback line
        // (it mirrors the detached session's command outcome; whatever
        // the incoming session reports lands after its replay) and the
        // session-scoped cards (ask and approval close undecided; the
        // full-access confirmation dies with its session; permissions,
        // rewind and resume cards render detached-session rows, and
        // the doc card joins them because /help's registry listing
        // shares the surface). Client-local surfaces (theme) and
        // workspace-scoped ones (diff) survive. An already-clean store
        // is the steady state — no revision.
        let changed = recentlyDenied.length > 0 || toolTranscriptOpen
        toolTranscriptOpen = false
        toolTranscriptViewport = FOLLOW_VIEWPORT
        // The main anchor dies with the session too: the incoming
        // session's first mirror derives against the tail, never
        // against an anchor the detached session armed.
        viewport = FOLLOW_VIEWPORT
        // The numeric lineage dies with it: the numbers belong to the
        // projection that minted them, and a detach ends any claim
        // they still describe this store's session — equal readings
        // are coincidence, so the first mirror must commit and
        // rebuild, never read as a re-poll or fold onto the detached
        // session's cached rows.
        sourceGeneration = undefined
        sessionChanges = undefined
        sessionLineageVoided = true
        // The reader cache is fed only while the reader is open, so
        // the one-mirror void above never reaches it through a mirror:
        // an entry frozen on the detached session would fold a
        // numerically aligned batch from the incoming session onto
        // rows the detached session rendered.
        toolTranscriptCache.invalidate()
        recentlyDenied = []
        if (agents !== undefined) {
          agents.reset()
          if (committedAgentsRevision !== agents.revision) changed = true
        }
        if (slashNotice !== null) {
          slashNotice = null
          changed = true
        }
        for (const card of [askCard, permissionsCard, confirmCard, rewindCard, resumeCard, docCard]) {
          if (card === null) continue
          changed = card.close() || changed
        }
        // The approval card's staleness baseline is the detached
        // session's revision space: canonical revisions restart per
        // session, so the sweep resets the baseline instead of merely
        // closing — the incoming session's first approval adopts
        // however low its revision reads.
        changed = approvalCard.detach() || changed
        if (!changed) return []
        commitView()
        return []
      }
      const current = snapshot
      // Same projection revision plus value-equal tail is the same view
      // state: the projection re-mints live-tail arrays on every read, so
      // identity would flapping-advance revisions on pure re-polls. A
      // source-generation bump is never "the same" — the ids were
      // reminted even when the bodies read equal — so it falls through
      // to the viewport reset; a voided lineage (a detach without a
      // newer mirror yet) reads the same way however the numbers land.
      if (
        !sessionLineageVoided &&
        input.content.projectionRevision === current.session.projectionRevision &&
        liveTailEqual(input.liveTail, current.liveTail) &&
        (input.sourceGeneration === undefined || input.sourceGeneration === sourceGeneration)
      ) {
        return []
      }
      // Viewport discipline over committed content: a source-generation
      // bump (a replace or reset reminted every id) or a structural
      // change batch reporting an identity reset or a through-end cut
      // resumes the tail. Evictions, appends and mid-drops keep the
      // anchor; a vanished one reads as follow. Batch-less pollers keep
      // the shape fallback (strict-prefix ids mean the anchored head
      // moved).
      const changeReset =
        input.changes === undefined
          ? viewportResetByContent(
              current.session.transcript.map((block) => block.sourceId),
              input.content.transcript.map((block) => block.sourceId),
            )
          : input.changes === null ||
            input.changes.changes.some((change) => change.kind === "reset" || (change.kind === "truncate" && change.throughEnd))
      // A voided lineage distrusts the batch the way a generation bump
      // does: the window speaks for a projection the cache never held.
      const generationBumped = sessionLineageVoided || (input.sourceGeneration !== undefined && input.sourceGeneration !== sourceGeneration)
      if (generationBumped || changeReset) {
        viewport = FOLLOW_VIEWPORT
        toolTranscriptViewport = FOLLOW_VIEWPORT
      }
      // A poll that omits the generation keeps the last defined one: an
      // undefined write here would disarm the bump check for the next
      // poll that carries one again.
      if (input.sourceGeneration !== undefined) sourceGeneration = input.sourceGeneration
      // The committing mirror re-arms the numeric lineage for the
      // session it belongs to.
      sessionLineageVoided = false
      // A generation bump voids every prior source id, so the batch's
      // window speaks for a lineage the cached order never held: drop it
      // and let the line cache rebuild from the full snapshot rather
      // than trust the numeric revision tie.
      sessionChanges = generationBumped ? null : input.changes
      // Same reuse gate as commitView: a poll whose pending set and
      // editor mode render the same footer keeps its reference.
      const footer = footerRuns(input.content.pending, hasToolActivity(input.content, input.liveTail))
      commit({
        revision: current.revision + 1,
        session: input.content,
        liveTail: input.liveTail,
        layout,
        transcript: snapshot.transcript,
        toolTranscriptOpen,
        toolTranscript: snapshot.toolTranscript,
        introLines: snapshot.introLines,
        activeCard: snapshot.activeCard,
        cardLines: snapshot.cardLines,
        composerRows: snapshot.composerRows,
        composerPrefix: snapshot.composerPrefix,
        cursorVisible: snapshot.cursorVisible,
        supportFloor: snapshot.supportFloor,
        editor: snapshot.editor,
        completion: snapshot.completion,
        hint: policy.hint(),
        slashNotice,
        queued: snapshot.queued,
        footer: textRunsEqual(footer, snapshot.footer) ? snapshot.footer : footer,
        recentlyDenied,
        agents: agentsView(),
        agentsSummary: snapshot.agentsSummary,
        childPanel: snapshot.childPanel,
      })
      return []
    },
  }
  /**
   * The bridged card-surface seam: a dispatch that cleared the urgent
   * surface (a decided approval, an answered ask, a retraction or the
   * session sweep) reports the freed surface once, so the host's
   * child-approval bridge can re-raise its parked head. The host runs
   * the effect after this call returns — the base dispatch never sees
   * a reentrant input.
   */
  return {
    ...baseStore,
    dispatch(input) {
      const wasUrgent = urgentCardVisible()
      const effects = baseStore.dispatch(input)
      if (wasUrgent && !urgentCardVisible()) return [...effects, { kind: "urgent-card-freed" as const }]
      return effects
    },
  }
}
