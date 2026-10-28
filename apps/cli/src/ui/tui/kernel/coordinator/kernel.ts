/**
 * The coordinator: the single dispatch loop that assembles the owners
 * behind the kernel facade. Every input channel funnels here; the
 * declarative adjudication table decides who owns a key, the write
 * barrier and arm ledger decide whether a business claim may execute,
 * the run queue serializes queue-policy slash commands against the one
 * run slot, and the operation ledger adjudicates late results by the
 * origin they were minted under. Commands leave only through the
 * buffered channel — flushed after dispatch returns. The degraded gate
 * refuses only session-scoped commands; client-scoped ones (theme,
 * exit, query) leave regardless. Routing decides ownership only;
 * execution verdicts are separate and never buffered.
 */
import type { BindingIdentity, InputWorld, OwnerClaim } from "../input/index.js"
import { ArmLedger, WriteBarrier, executionGate, resolveIntent } from "../input/index.js"
import {
  TaskNavigator,
  createConfirmTask,
  createDiffTask,
  createDocumentTask,
  createPendingChooserTask,
  createPermissionsTask,
  createPromptHistoryTask,
  createResumeTask,
  createRewindTask,
  createThemeTask,
  nextPermissionMode,
} from "../tasks/index.js"
import type {
  PendingDecisionRowView,
  PermissionsTaskResult,
  PromptHistoryTaskResult,
  SearchEditor,
  TaskDelivery,
  TaskPagerView,
  TaskTicket,
} from "../tasks/index.js"
import { DecisionLeases, needsReview } from "../decisions/index.js"
import { ChildrenBoard } from "./children.js"
import type { AskQuestionFact, DecisionFact } from "../decisions/index.js"
import { MirrorStore } from "../session-mirror/index.js"
import type { TuiPlanRow, TuiQueueRow } from "../session-mirror/index.js"
import {
  COMMAND_PROFILE,
  ComposerKernel,
  CompletionPicker,
  FILE_PROFILE,
  COMPOSER_ROW_CAP,
  commandCandidates,
  completionContextAt,
  matchCompletions,
  mentionCandidates,
  type CompletionContext,
} from "../fields/index.js"
import {
  FOLLOW_VIEWPORT,
  DocPager,
  TranscriptLineCache,
  resolveViewport,
  viewportIndicator,
  viewportPageDown,
  viewportPageUp,
  viewportResetByContent,
  viewportWheelDown,
  viewportWheelUp,
  viewportWindow,
  type TranscriptLineModel,
  type TranscriptViewport,
} from "../reading/index.js"
import {
  appendToolDetailsHint,
  askSurfaceRows,
  ASK_OPTION_WINDOW_COMPACT,
  ASK_OPTION_WINDOW_WIDE,
  footerMinimalSegments,
  prioritizeFooterSegments,
  footerSegments,
  renderDetailedTranscriptSource,
  renderTranscriptSource,
  horizontalTabDirection,
  composerSurfaceLayout,
  moveHorizontalTab,
  taskSurfaceRowHeight,
  textWidth,
  wrapVerbatim,
  transcriptRenderSources,
  wrapFooterSegments,
  type ThemeId,
  type TextRun,
  type ComposerSurfaceLayout,
  type TranscriptLine,
} from "../../text/index.js"
import type { LiveTailBlock, SessionContent, TranscriptBlock } from "../../sessionprojection/index.js"
import type { TuiIntent } from "../../keys/index.js"
import type { SessionOrigin, TuiCommand, TuiInput, TuiKernel, TuiKernelPorts, TuiPermissionRule, TuiSnapshot } from "./contract.js"
import { SlashSyntaxError, parseSlashSubmission, routeSlash, slashBusyPolicy, slashCompletionCandidates, slashHelpLines } from "./slash.js"
import type { SlashInput, SlashRouting } from "./slash.js"
import { createRunQueue } from "./run-queue.js"
import { PermissionDesk, type ModeSubmitOrigin } from "./permissions.js"
import { OperationLedger } from "./operations.js"
import { SubmissionReceipts } from "./submissions.js"
import { SessionDrafts } from "./drafts.js"
import type { TaskFrameView, TuiSnapshotGroups } from "./snapshot.js"

function physicalReaderRows(lines: readonly TranscriptLine[]): {
  readonly rows: readonly string[]
  readonly runs: readonly (readonly TextRun[])[]
} {
  const rows: string[] = []
  const runs: (readonly TextRun[])[] = []
  for (const line of lines) {
    const physicalRuns: TextRun[][] = [[]]
    for (const run of line.runs) {
      const fragments = run.text.split("\n")
      fragments.forEach((text, index) => {
        if (text.length > 0 || fragments.length === 1) {
          physicalRuns[physicalRuns.length - 1]!.push(text === run.text ? run : { ...run, text })
        }
        if (index < fragments.length - 1) physicalRuns.push([])
      })
    }
    for (const rowRuns of physicalRuns) {
      runs.push(rowRuns)
      rows.push(rowRuns.map((run) => run.text).join(""))
    }
  }
  return { rows, runs }
}

/** Below this geometry the modal surfaces cede their keys to the composer fallback. */
const SUPPORT_FLOOR = { columns: 40, rows: 12 } as const
/** The stable request identity the /diff browser reads and backfills through. */
const DIFF_QUERY_ID = "diff-files:live"
/** The stable request identity the resume listing reads and backfills through. */
const RESUME_QUERY_ID = "resume-sessions:live"
const DEFAULT_VIEW_STATE_BYTES = 65536
/** Shared lifetime for idle Ctrl+C exit and root Escape clear/rewind gestures. */
const EXIT_CONFIRM_WINDOW_MS = 800
/** How long unrelated transient notices stay visible. */
const NOTICE_DURATION_MS = 2500
/** The open task's exit lever hint: Tab arms the lever, Enter walks the shared exit. */
export const TASK_EXIT_FOCUS_HINT = "tab: edit · enter: leave this form"
/** The queue preview's bounded visible prefix; the rest counts into one elision row. */
const QUEUE_PREVIEW_ROWS = 3
const BASH_MODE_HINT = "Bash mode · Enter to run · Esc twice clears"
const BASH_MODE_HINT_COMPACT = "Bash mode · Enter · Esc×2 clears"
const QUEUE_CANCEL_HINT = "press ctrl+c again to cancel queued prompts"

interface ComposerSurfacePlan {
  readonly layout: ComposerSurfaceLayout
  readonly companion: TuiSnapshotGroups["companion"]
}

const ASK_OPTION_PREVIEW_ROWS_COMPACT = 1
const ASK_OPTION_PREVIEW_ROWS_WIDE = 2

/**
 * The choice-list window idiom for the decision card: an armed option
 * row below or past the window drags it along; the confirm and decline
 * rows render outside the window and never move it.
 */
const decisionWindowFollow = (windowStart: number, armedIndex: number, optionCount: number, windowSize: number): number => {
  if (armedIndex >= optionCount) return windowStart
  let start = windowStart
  if (armedIndex < start) start = armedIndex
  if (armedIndex >= start + windowSize) start = armedIndex - windowSize + 1
  return Math.max(0, Math.min(start, Math.max(0, optionCount - windowSize)))
}

/**
 * The built-in transcript kit: pure wiring of the text module's source
 * merge and per-source renderer — the adapter owns no algorithm. The
 * projection's block vocabulary satisfies the renderer's input shapes
 * structurally, never by import.
 */
const renderTranscriptKit = (
  blocks: readonly TranscriptBlock[],
  tail: readonly LiveTailBlock[],
  columns: number,
  detailed = false,
): readonly TranscriptLine[] =>
  transcriptRenderSources({ transcript: blocks }, tail).flatMap((source) =>
    detailed ? renderDetailedTranscriptSource(source, columns) : renderTranscriptSource(source, columns),
  )

/**
 * Commands that write or bind the degraded session's canonical state.
 * Client-scoped commands (theme, exit, query) never appear here: a
 * degraded session is read-only but alive, and process lifecycle and
 * client config keep working.
 */
const SESSION_COMMANDS: ReadonlySet<TuiCommand["kind"]> = new Set([
  "submit",
  "shell",
  "compact",
  "interrupt",
  "cancel-run",
  "cancel-queued",
  "cancel-child",
  "resolve-ask",
  "resolve-approval",
  "rewind",
  "resume",
  "permission",
  "add-dir",
])

export function createTuiKernel(ports: TuiKernelPorts): TuiKernel {
  // Kit resolution: an injected kit overrides the built-in wiring; the
  // built-ins are the kernel-owned algorithms, not second implementations.
  const editorKit = ports.fields ?? { createEditor: (): SearchEditor => new ComposerKernel() }
  const pagerKit = ports.reading ?? {
    createPager: (lines: readonly string[], height: number): TaskPagerView => new DocPager(lines, height),
  }
  const transcriptKit = ports.transcript ?? renderTranscriptKit
  let revision = 0
  let disposed = false
  let layout: { columns: number; rows: number } = { columns: 80, rows: 24 }
  let changed = false
  let degraded = false
  let permissionMode: string | null = null
  let sessionOrigin: SessionOrigin | null = null
  // Type-ahead is adopted before any binding exists; only the first
  // adoption must keep it, so the guard is process-lifetime, not
  // binding-shaped — detach nulls sessionOrigin without touching the
  // editor, so a null origin alone cannot tell the two apart.
  let hasAdoptedBinding = false
  // First-run theme offer: read once at the first session-view adoption;
  // a switch or a later push never re-opens the picker.
  let pendingRuns: readonly { readonly runId: string; readonly goal: string }[] = []
  let editor: SearchEditor = editorKit.createEditor()
  let notices: readonly string[] = []
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let noticeGeneration = 0
  let gestureHint: { kind: "exit" | "ctrl-d-exit" | "escape-clear" | "escape-rewind"; deadline: number } | null = null
  let gestureTimer: ReturnType<typeof setTimeout> | null = null
  let gestureGeneration = 0
  // The indexed line model behind the transcript viewport, refreshed
  // once per session-view push (fold-cached) and per resize (rebuilt
  // at the new width); the source-id order feeds the reset-by-content
  // check that pulls a truncated history back to following.
  let viewport: TranscriptViewport = FOLLOW_VIEWPORT
  let viewportSourceIds: readonly string[] = []
  let viewportModel: TranscriptLineModel | null = null
  let sessionContent: { readonly content: SessionContent; readonly tail: readonly LiveTailBlock[] } | null = null
  // One rendering per kernel: the viewport's line cache resolves each
  // source back to its projection block and routes it through the
  // same transcript kit the reader's lines use, so an injected port
  // governs both faces identically.
  const lineCache = new TranscriptLineCache({
    render: (source, columns) => {
      const sourceId = source.kind === "tail" ? source.tail.sourceId : source.block.sourceId
      const held = sessionContent
      if (held !== null) {
        const tail = held.tail.find((block) => block.sourceId === sourceId)
        if (tail !== undefined) return transcriptKit([], [tail], columns, false)
        const block = held.content.transcript.find((entry) => entry.sourceId === sourceId)
        if (block !== undefined) return transcriptKit([block], [], columns, false)
      }
      return renderTranscriptSource(source, columns)
    },
  })
  // Ctrl+C/Ctrl+D exit and Escape clear/rewind share one acceptance/display
  // deadline. Its timer commits expiry so the hint redraws on time.
  let decisionFacts = new Map<string, DecisionFact>()
  type AskCursor = { questionIndex: number; armedIndex: number | null; windowStart: number; focus: "choices" | "other" }
  let decisionCursor: AskCursor = { questionIndex: 0, armedIndex: null, windowStart: 0, focus: "choices" }
  const askQuestionCursors = new Map<string, Omit<AskCursor, "questionIndex">>()
  const askOtherEditors = new Map<string, ComposerKernel>()

  const barrier = new WriteBarrier()
  const arms = new ArmLedger()
  const ledger = new OperationLedger()
  const receipts = new SubmissionReceipts()
  const drafts = new SessionDrafts(ports.capacity?.viewStateBytes ?? DEFAULT_VIEW_STATE_BYTES)
  const mirror = new MirrorStore()
  const leases = new DecisionLeases()
  const children = new ChildrenBoard()
  const desk = new PermissionDesk()
  const runQueue = createRunQueue({ busyPolicy: (input) => slashBusyPolicy(input.name) })
  // The kernel owns the queued-mailbox rows: the mirror fact only
  // reports them. Rows keep their first-seen seq so a re-asserted
  // order never reorders the preview, and a row under a live cancel
  // stays visible until its settle removes it — no provisional rows
  // are ever minted from receipts. Parked slash rows join the same
  // seq order from their park moment, minted here rather than the
  // composition seam.
  let queueEntries = new Map<string, { row: TuiQueueRow; seq: number; cancelling: boolean }>()
  let queueSeq = 0
  const parkSeq = new Map<string, number>()
  let queueHintArmed = false
  // Plan chrome rows follow the queue contract: the kernel owns the
  // rows, the latest fact overwrites a plan in place, first-seen seq
  // keeps first-appearance order, and an id absent from a fact drops.
  let planEntries = new Map<string, { row: TuiPlanRow; seq: number }>()
  let planSeq = 0
  // Displacement emissions (exit, resume) settle silently: the world
  // they were minted for is already gone.
  const displacementOps = new Set<string>()
  const tasks = new TaskNavigator(
    {
      theme: createThemeTask(ports.theme().themeIds),
      diff: createDiffTask(),
      document: createDocumentTask(),
      permissions: createPermissionsTask(),
      confirm: createConfirmTask(),
      rewind: createRewindTask(),
      resume: createResumeTask(),
      chooser: createPendingChooserTask(),
      "prompt-history": createPromptHistoryTask(),
    },
    {
      search: { create: () => editorKit.createEditor() },
      pager: {
        create: (lines, height) => pagerKit.createPager(lines, height),
        pageHeight: () => documentPageHeight(),
        wrapLines: (lines) => lines.flatMap((line) => wrapVerbatim(line, Math.max(1, layout.columns - 4))),
      },
      diffFiles: () =>
        mirror.queryResult(DIFF_QUERY_ID)?.map((file) => ({
          path: file.path,
          ...(file.description === undefined ? {} : { description: file.description }),
          detail: file.detail ?? [],
        })),
      rankText: (query, candidates) =>
        matchCompletions(
          query,
          candidates.map(({ id, text }) => ({ id, label: text, kind: "history" as const, fields: { command: text } })),
          COMMAND_PROFILE,
        ).map(({ item }) => item.id),
      permissions: () => desk.facts(sessionOrigin?.sessionId ?? null, ports.permission()),
      history: () => ports.history(),
      promptHistory: () => ports.promptHistory?.() ?? [],
      resumeSessions: () => {
        const rows = mirror.resumeSessions(RESUME_QUERY_ID)
        return rows === undefined ? null : { rows }
      },
      pendingDecisions: () => ({ rows: pendingDecisionRows() }),
    },
  )
  // Task tickets the permission settlement owes a force-complete: the
  // open confirm card, and the permissions card it was opened above.
  let confirmTicket: TaskTicket<"confirm"> | null = null
  let permissionsTicket: TaskTicket<"permissions"> | null = null
  let permissionsTicketUnderConfirm: TaskTicket<"permissions"> | null = null
  // The open resume invocation and its pending auto-pick: every
  // delivery, switch and detach clears both so neither leaks into a
  // later card.
  let resumeTicket: TaskTicket<"resume"> | null = null
  let resumeAutoPick = false
  // The open pending-decision chooser; every delivery clears it.
  let chooserTicket: TaskTicket<"chooser"> | null = null
  // The draft palette: the picker owns the ranking snapshot, selection
  // and dismissal; the kernel mirrors the context it was synced for and
  // the send-arm suspension an Enter-accepted file mention carries.
  const picker = new CompletionPicker()
  let paletteContext: CompletionContext | null = null
  let sendArmSuspended = false
  let reader = { open: false, pager: pagerKit.createPager([], 1), runs: [] as readonly (readonly TextRun[])[] }
  // The open task's exit lever steers view focus beside the surface it commands.
  let taskActionsFocused = false

  let commandHandler: ((command: TuiCommand) => void) | undefined
  let pendingCommands: TuiCommand[] = []
  const listeners = new Set<(snapshot: TuiSnapshot) => void>()

  /** True when the command left; a refused session command mints a notice and its caller keeps every local effect undone. */
  const emit = (command: TuiCommand): boolean => {
    if (degraded && SESSION_COMMANDS.has(command.kind)) {
      notice(`degraded: ${command.kind} refused`)
      return false
    }
    pendingCommands.push(command)
    return true
  }

  const notice = (text: string): void => {
    noticeGeneration += 1
    const generation = noticeGeneration
    if (noticeTimer !== null) clearTimeout(noticeTimer)
    notices = [text]
    changed = true
    noticeTimer = setTimeout(() => {
      if (disposed || generation !== noticeGeneration) return
      noticeTimer = null
      notices = []
      changed = true
      commit()
    }, NOTICE_DURATION_MS)
    noticeTimer.unref?.()
  }

  const clearGestureHint = (): void => {
    gestureGeneration += 1
    if (gestureTimer !== null) clearTimeout(gestureTimer)
    gestureTimer = null
    if (gestureHint !== null) {
      gestureHint = null
      changed = true
    }
  }

  const armGestureHint = (kind: NonNullable<typeof gestureHint>["kind"], now = Date.now()): void => {
    gestureGeneration += 1
    const generation = gestureGeneration
    if (gestureTimer !== null) clearTimeout(gestureTimer)
    gestureHint = { kind, deadline: now + EXIT_CONFIRM_WINDOW_MS }
    changed = true
    gestureTimer = setTimeout(() => {
      if (disposed || generation !== gestureGeneration) return
      gestureTimer = null
      gestureHint = null
      changed = true
      commit()
    }, EXIT_CONFIRM_WINDOW_MS)
    gestureTimer.unref?.()
  }

  const resetEditor = (text: string): void => {
    const fresh = editorKit.createEditor()
    if (text.length > 0) fresh.dispatch({ kind: "paste", text })
    editor = fresh
    sendArmSuspended = false
    syncPalette()
  }

  /**
   * Mirror the draft's completion context into the picker: a command
   * token ranks the command corpus (the syntax registry when the host
   * injects none), a mention token ranks the mention corpus, and any
   * other token closes the palette. The picker keeps its selection and
   * dismissal across a sync whose context signature did not change.
   */
  const syncPalette = (): void => {
    const context = completionContextAt(editor.text, editor.caretOffset)
    paletteContext =
      context !== null && (context.kind === "command" || context.kind === "mention")
        ? { kind: context.kind, replaceRange: context.replaceRange, query: context.query }
        : null
    if (paletteContext === null) {
      picker.sync(null, [])
      return
    }
    if (paletteContext.kind === "command") {
      const corpus = ports.completion().command?.() ?? slashCompletionCandidates()
      picker.sync(paletteContext, commandCandidates(matchCompletions(paletteContext.query, corpus, COMMAND_PROFILE)))
    } else {
      picker.sync(
        paletteContext,
        mentionCandidates(matchCompletions(paletteContext.query, ports.completion().mention?.() ?? [], FILE_PROFILE)),
      )
    }
  }

  const taskOpen = (): boolean => tasks.path().length > 0

  /** What became of one mode change request; "confirm-open" parks it behind the disclosure card. */
  type ModeChangeOutcome = "submitted" | "confirm-open" | "refused"

  /**
   * The one throat every mode change crosses — the direct grammar,
   * the Mode row, permission cycling and the confirm card. A
   * full-access target in an unconfirmed session never submits here:
   * the disclosure card opens and submits itself once confirmed.
   */
  const submitModeChange = (mode: string, origin: Exclude<ModeSubmitOrigin, "confirm">): ModeChangeOutcome => {
    if (sessionOrigin === null) {
      notice("no session bound")
      return "refused"
    }
    if (ports.permission() === null) {
      notice("permissions not reported by host yet")
      return "refused"
    }
    if (mode === "full-access" && !desk.isConfirmed(sessionOrigin.sessionId)) {
      confirmTicket = tasks.open("confirm", { mode })
      permissionsTicketUnderConfirm = origin === "mode-row" ? permissionsTicket : null
      // The card opens without any emit, so no echo will dirty the frame.
      changed = true
      return "confirm-open"
    }
    const operationId = ledger.mint({ scope: "session", sessionId: sessionOrigin.sessionId, generation: sessionOrigin.generation })
    if (!emit({ kind: "permission", op: "mode", mode, operationId })) return "refused"
    desk.submitMode(operationId, mode, origin)
    return "submitted"
  }

  /** The confirm card's Enter: submits the fact and the switch as one canonical change. */
  const submitConfirmSwitch = (): void => {
    if (sessionOrigin === null) {
      notice("no session bound")
      return
    }
    if (ports.permission() === null) {
      notice("permissions not reported by host yet")
      return
    }
    const operationId = ledger.mint({ scope: "session", sessionId: sessionOrigin.sessionId, generation: sessionOrigin.generation })
    if (!emit({ kind: "permission", op: "mode", mode: "full-access", operationId })) return
    desk.submitMode(operationId, "full-access", "confirm")
  }

  /** The rules throat: the complete set leaves against the baseline it was composed from. */
  const submitRules = (rules: readonly TuiPermissionRule[], baseline: readonly TuiPermissionRule[]): boolean => {
    if (sessionOrigin === null) {
      notice("no session bound")
      return false
    }
    const operationId = ledger.mint({ scope: "session", sessionId: sessionOrigin.sessionId, generation: sessionOrigin.generation })
    if (!emit({ kind: "permission", op: "rules", rules, baseline, operationId })) return false
    desk.submitRules(
      operationId,
      rules.map((rule) => rule.name),
    )
    return true
  }

  /** Advance to the ring's next selectable mode through the shared throat. */
  const performRotation = (): void => {
    if (sessionOrigin === null) {
      notice("no session bound")
      return
    }
    const permission = ports.permission()
    if (permission === null) {
      notice("permissions not reported by host yet")
      return
    }
    const next = nextPermissionMode(permission.currentMode, permission.selectableModes)
    if (next === null) {
      notice("no selectable permission mode")
      return
    }
    submitModeChange(next, "rotation")
  }

  /** The companion action: reattach every paused invocation, in pause order. */
  const resumePausedTasks = (): void => {
    const paused = tasks.pausedTasks()
    if (paused.length === 0) {
      notice("no paused tasks")
      return
    }
    for (const ref of paused) tasks.resume(ref.ticket.id)
    notice(`${paused.length} task(s) resumed`)
  }

  /**
   * The full-access gate every run-seam channel crosses: prompts,
   * shell escapes and queue-policy slash refuse until the session's
   * disclosure is confirmed. An unsown mirror cannot prove the
   * session is not full-access, so it fails closed as syncing.
   */
  const runSeamGate = (): "open" | "unconfirmed" | "syncing" => {
    const permission = ports.permission()
    if (permission === null) return "syncing"
    if (permission.currentMode === "full-access" && !desk.isConfirmed(sessionOrigin?.sessionId ?? null)) return "unconfirmed"
    return "open"
  }

  const runSeamRefusal = (gate: "unconfirmed" | "syncing"): void => {
    notice(
      gate === "syncing" ? "permissions still syncing — try again shortly" : "full access not confirmed — open /permissions to confirm",
    )
  }

  const belowFloor = (): boolean => layout.columns < SUPPORT_FLOOR.columns || layout.rows < SUPPORT_FLOOR.rows

  const presentingDecision = (): { id: string; fact: DecisionFact; disclosure: number } | null => {
    for (const [id, fact] of decisionFacts) {
      const lease = leases.lease(id)
      if (lease !== undefined && lease.state === "presenting") return { id, fact, disclosure: lease.disclosure }
    }
    return null
  }

  /**
   * The chooser's rows: one per hidden-pending lease. Collapsed and
   * fresh births are indistinguishable here on purpose — reopening is
   * the user's call, and the label stays stable across both.
   */
  const pendingDecisionRows = (): readonly PendingDecisionRowView[] => {
    const rows: PendingDecisionRowView[] = []
    for (const [id, fact] of decisionFacts) {
      const lease = leases.lease(id)
      if (lease === undefined || lease.state !== "hidden-pending") continue
      const label =
        fact.kind === "approval" ? fact.fact.toolName : (fact.fact.questions[0]?.header ?? fact.fact.questions[0]?.question ?? "ask")
      rows.push({ requestId: id, kind: fact.kind, label })
    }
    return rows
  }

  /** The chooser opens at most once; a repeat Enter on an empty draft is a no-op. */
  const openChooserTask = (): void => {
    if (chooserTicket !== null) return
    chooserTicket = tasks.open("chooser", { rows: pendingDecisionRows() })
    changed = true
  }

  const world = (): InputWorld => {
    const presenting = presentingDecision() !== null
    // The completion face is the single visibility derivation: the
    // draft palette, masked under a task's fields and
    // the fullscreen reader. An invisible companion claims nothing —
    // no candidate wipe, no Enter execution — and resurfaces when the
    // mask lifts.
    const companionNow = companionFace()
    return {
      layout,
      supportFloor: SUPPORT_FLOOR,
      reader: { open: reader.open },
      peers: { count: tasks.peers().length, taskHoldsInput: taskOpen() },
      children: { count: children.count(), focused: children.focused() !== null },
      companion: { visible: companionNow.open, kind: companionNow.kind },
      task: { open: taskOpen() },
      decision: { presenting },
      askPresenting: presentingDecision()?.fact.kind === "ask",
      // Below the floor every key routes back to the composer, so the
      // fallback stays live even while a modal surface is technically open.
      editor: { active: (!taskOpen() && !presenting) || belowFloor() },
    }
  }

  /**
   * The one derivation of the completion face. The snapshot, the
   * transcript budget and the adjudication world all read it, so the
   * three can never disagree about which surface shows or how many
   * rows it spends. The palette's rows are the picker's window, not
   * the whole ranking; the position pair counts the ranking itself.
   */
  const companionFace = (): TuiSnapshotGroups["companion"] => {
    const frame = taskFrameView()
    const visible = (frame === null || frame.composerMode === "visible") && presentingDecision() === null
    return composerSurfacePlan(visible).companion
  }

  const submitBinding = (): BindingIdentity => ({
    owner: "editor",
    action: "submit",
    target: `session:${sessionOrigin?.sessionId ?? "unbound"}`,
    epoch: sessionOrigin?.generation ?? 0,
  })

  const decisionBinding = (id: string, disclosure: number): BindingIdentity => ({
    owner: "decision",
    action: "resolve",
    target: id,
    epoch: disclosure,
  })

  const offeredBindings = (): readonly BindingIdentity[] => {
    const offered: BindingIdentity[] = []
    if (editor.text.trim().length > 0) offered.push(submitBinding())
    const presenting = presentingDecision()
    if (presenting !== null) offered.push(decisionBinding(presenting.id, presenting.disclosure))
    return offered
  }

  /** Arming rides user dispatches only — a late write report never promotes a pending arm. */
  const maintainArms = (): void => {
    // A suspended send arm stays down: the Enter that accepted a file
    // mention is spent, and only a real edit or caret move re-arms it.
    if (!sendArmSuspended && editor.text.trim().length > 0) arms.arm(submitBinding(), barrier)
    const presenting = presentingDecision()
    if (presenting !== null) arms.arm(decisionBinding(presenting.id, presenting.disclosure), barrier)
  }

  /**
   * Write one palette commit into the draft token; the editor's own
   * stale-range guard rejects a replacement the draft has moved past.
   * An Enter-accepted mention that ends the token (a file row)
   * suspends the send arm for one gesture — the accepting key is
   * spent, and a repeat Enter must not fire a submit the user has not
   * re-armed by editing on. Tab carries no such ambiguity: an inserted
   * token never suspends the send.
   */
  const insertPaletteCandidate = (
    insertText: string,
    replaceRange: readonly [number, number],
    expected: { readonly kind: "command" | "mention"; readonly query: string },
    suspendSend: boolean,
  ): boolean => {
    if (!editor.replaceDraftRange(replaceRange[0], replaceRange[1], insertText, expected)) return false
    if (suspendSend && paletteContext?.kind === "mention" && insertText.endsWith(" ")) {
      arms.disarm(submitBinding())
      sendArmSuspended = true
    }
    syncPalette()
    changed = true
    return true
  }

  const askEditorKey = (requestId: string, disclosure: number, questionId: string): string => `${requestId}:${disclosure}:${questionId}`

  const askEditorFor = (requestId: string, disclosure: number, questionId: string): ComposerKernel => {
    const key = askEditorKey(requestId, disclosure, questionId)
    let held = askOtherEditors.get(key)
    if (held === undefined) {
      held = new ComposerKernel()
      askOtherEditors.set(key, held)
    }
    return held
  }

  const clearAskState = (id: string, fact: DecisionFact | undefined): void => {
    if (fact?.kind !== "ask") return
    for (const question of fact.fact.questions) {
      const key = askEditorKey(id, fact.disclosure, question.questionId)
      askQuestionCursors.delete(key)
      askOtherEditors.delete(key)
    }
  }

  const clearAllAskState = (): void => {
    askQuestionCursors.clear()
    askOtherEditors.clear()
    decisionCursor = { questionIndex: 0, armedIndex: null, windowStart: 0, focus: "choices" }
  }

  const askWindowSize = (): number => (layout.columns <= 40 ? ASK_OPTION_WINDOW_COMPACT : ASK_OPTION_WINDOW_WIDE)

  const validAskSelection = (question: AskQuestionFact, selected: readonly string[]): readonly string[] => {
    const valid = selected.filter(
      (id, index) => question.options.some((option) => option.optionId === id) && selected.indexOf(id) === index,
    )
    return question.multiSelect ? valid : valid.slice(0, 1)
  }

  const askAnswers = (
    presentation: { id: string; fact: Extract<DecisionFact, { kind: "ask" }> },
    lease: ReturnType<typeof leases.lease>,
  ) => {
    const questions = presentation.fact.fact.questions
    const answers = questions.map((question) => ({
      questionId: question.questionId,
      selectedOptionIds: validAskSelection(question, lease?.answers[question.questionId] ?? []),
    }))
    const freeText = questions.flatMap((question) => {
      const text = askOtherEditors.get(askEditorKey(presentation.id, presentation.fact.disclosure, question.questionId))?.text ?? ""
      const hasSingleSelection =
        !question.multiSelect && (answers.find((answer) => answer.questionId === question.questionId)?.selectedOptionIds.length ?? 0) > 0
      return text.trim().length === 0 || hasSingleSelection ? [] : [{ questionId: question.questionId, text }]
    })
    const isValid = questions.every(
      (question, index) =>
        answers[index]!.selectedOptionIds.length > 0 || freeText.some((entry) => entry.questionId === question.questionId),
    )
    return { answers, freeText, isValid }
  }

  /** Available fixed-height rows for the presenting Ask, excluding its own surface. */
  const askAvailableRows = (): number => {
    const width = Math.max(1, layout.columns)
    const footerLines = wrapFooterSegments(footerTelemetryRuns(footerTelemetry()), width).length
    let fixed = tasks.pausedTasks().length + notices.length + receipts.pendingCount()
    let hidden = false
    let resolving = false
    let unknown = false
    for (const [id] of decisionFacts) {
      const state = leases.lease(id)?.state
      if (state === "hidden-pending") hidden = true
      else if (state === "resolving") resolving = true
      else if (state === "unknown") unknown = true
    }
    if (hidden) fixed += 1
    if (resolving) fixed += 1
    if (unknown) fixed += 1
    if (pendingRuns.length > 0) fixed += 1
    const queue = queuePreview()
    fixed += queue.visible.length + (queue.elided > 0 ? 1 : 0)
    fixed += planPreview().length
    if (children.runningCount() > 0) fixed += 1
    fixed += footerLines
    return Math.max(0, layout.rows - fixed)
  }

  const askSurfaceRowsFor = (
    id: string,
    fact: Extract<DecisionFact, { kind: "ask" }>,
    questionIndex: number,
    selectedOptionIds: readonly string[],
    cursor: AskCursor,
  ) => {
    const question = fact.fact.questions[questionIndex]
    const otherEditor = question === undefined ? null : askOtherEditors.get(askEditorKey(id, fact.disclosure, question.questionId))
    const otherRender = otherEditor?.renderLines(Math.max(1, layout.columns), 1)
    const answerState = askAnswers({ id, fact }, leases.lease(id))
    return askSurfaceRows({
      ...(fact.fact.attribution === undefined ? {} : { attribution: fact.fact.attribution }),
      questions: fact.fact.questions,
      questionIndex,
      selectedOptionIds,
      armedIndex: cursor.armedIndex,
      windowStart: cursor.windowStart,
      otherText: otherEditor?.text ?? "",
      otherEditing: cursor.focus === "other",
      canSubmit: answerState.isValid,
      ctrlDHint: gestureHint?.kind === "ctrl-d-exit",
      ...(otherRender === undefined ? {} : { otherLines: otherRender.lines, otherCaretColumn: otherRender.caretColumn }),
      width: layout.columns,
      maxRows: askAvailableRows(),
    })
  }

  /** Row count of the presenting choice list: approval options, or the bounded Ask ledger. */
  const decisionRows = (fact: DecisionFact): number => {
    if (fact.kind === "approval") return fact.fact.options.length
    const question = fact.fact.questions[Math.min(decisionCursor.questionIndex, fact.fact.questions.length - 1)]
    return (question?.options.length ?? 0) + 3
  }

  const firstDecisionCursor = (fact: DecisionFact, questionIndex = 0) => {
    const question = fact.kind === "ask" ? fact.fact.questions[questionIndex] : undefined
    return {
      questionIndex,
      // Focus the first choice, or Other for a free-text-only question.
      armedIndex: fact.kind === "approval" || question !== undefined ? 0 : null,
      windowStart: 0,
      focus: "choices" as const,
    }
  }

  const saveQuestionCursor = (presentation: { id: string; fact: Extract<DecisionFact, { kind: "ask" }> }): void => {
    const question = presentation.fact.fact.questions[decisionCursor.questionIndex]
    if (question === undefined) return
    askQuestionCursors.set(askEditorKey(presentation.id, presentation.fact.disclosure, question.questionId), {
      armedIndex: decisionCursor.armedIndex,
      windowStart: decisionCursor.windowStart,
      focus: decisionCursor.focus,
    })
  }

  const switchAskQuestion = (presentation: { id: string; fact: Extract<DecisionFact, { kind: "ask" }> }, nextIndex: number): void => {
    const questions = presentation.fact.fact.questions
    const next = Math.max(0, Math.min(questions.length - 1, nextIndex))
    if (next === decisionCursor.questionIndex) return
    saveQuestionCursor(presentation)
    const question = questions[next]
    const saved =
      question === undefined
        ? undefined
        : askQuestionCursors.get(askEditorKey(presentation.id, presentation.fact.disclosure, question.questionId))
    decisionCursor = saved === undefined ? firstDecisionCursor(presentation.fact, next) : { questionIndex: next, ...saved }
    changed = true
  }

  const decisionGroups = (): TuiSnapshotGroups["decisions"] => {
    let presenting: TuiSnapshotGroups["decisions"]["presenting"] = null
    const hiddenPending: string[] = []
    const resolving: string[] = []
    const unknown: string[] = []
    for (const [id, fact] of decisionFacts) {
      const lease = leases.lease(id)
      if (lease === undefined) continue
      if (lease.state === "presenting" && presenting === null) {
        const question =
          fact.kind === "ask" ? fact.fact.questions[Math.min(decisionCursor.questionIndex, fact.fact.questions.length - 1)] : undefined
        const optionCount = question?.options.length ?? 0
        const questionIndex = Math.min(decisionCursor.questionIndex, fact.kind === "ask" ? fact.fact.questions.length - 1 : 0)
        const askCursor: AskCursor = {
          questionIndex,
          armedIndex: decisionCursor.armedIndex,
          windowStart: decisionCursor.windowStart,
          focus: decisionCursor.focus,
        }
        const selectedOptionIds = question === undefined ? [] : validAskSelection(question, lease.answers[question.questionId] ?? [])
        const surfaceRows = fact.kind === "ask" ? askSurfaceRowsFor(id, fact, questionIndex, selectedOptionIds, askCursor) : undefined
        presenting = {
          fact,
          cursor: {
            questionIndex,
            armedIndex:
              decisionCursor.armedIndex === null
                ? null
                : Math.min(Math.max(0, decisionCursor.armedIndex), Math.max(0, decisionRows(fact) - 1)),
            windowStart: Math.max(0, Math.min(decisionCursor.windowStart, Math.max(0, optionCount - askWindowSize()))),
            focus: decisionCursor.focus,
          },
          selectedOptionIds,
          ...(surfaceRows === undefined ? {} : { surfaceRows }),
        }
      } else if (lease.state === "hidden-pending") hiddenPending.push(id)
      else if (lease.state === "resolving") resolving.push(id)
      else if (lease.state === "unknown") unknown.push(id)
    }
    return { presenting, hiddenPending, resolving, unknown }
  }

  /**
   * Fold-cached transcript lines: the viewport model renders only
   * touched sources into the bounded LRU, so the full line array is a
   * slice over cached segments and a streaming delta never re-renders
   * stable history. Keyed by the pushed array identities — a re-push
   * carrying the same transcript and tail reuses the array, and any
   * commit that touches neither reuses it untouched.
   */
  let transcriptCache: {
    transcript: readonly TranscriptBlock[]
    tail: readonly LiveTailBlock[]
    columns: number
    lines: readonly TranscriptLine[]
  } | null = null
  let detailedTranscriptCache: {
    transcript: readonly TranscriptBlock[]
    tail: readonly LiveTailBlock[]
    columns: number
    rows: readonly string[]
    runs: readonly (readonly TextRun[])[]
  } | null = null

  const renderedTranscript = (): readonly TranscriptLine[] => {
    const held = sessionContent
    if (held === null || viewportModel === null) return []
    if (
      transcriptCache !== null &&
      transcriptCache.transcript === held.content.transcript &&
      transcriptCache.tail === held.tail &&
      transcriptCache.columns === layout.columns
    ) {
      return transcriptCache.lines
    }
    const lines = viewportModel.slice(0, viewportModel.total)
    transcriptCache = { transcript: held.content.transcript, tail: held.tail, columns: layout.columns, lines }
    return lines
  }

  /** Detailed rows and style metadata share the reader pager's physical row projection. */
  const readerLines = (): readonly string[] => {
    const held = sessionContent
    if (held === null) {
      detailedTranscriptCache = null
      return []
    }
    if (
      detailedTranscriptCache !== null &&
      detailedTranscriptCache.transcript === held.content.transcript &&
      detailedTranscriptCache.tail === held.tail &&
      detailedTranscriptCache.columns === layout.columns
    ) {
      return detailedTranscriptCache.rows
    }
    const detailedRows = physicalReaderRows(transcriptKit(held.content.transcript, held.tail, layout.columns, true))
    detailedTranscriptCache = {
      transcript: held.content.transcript,
      tail: held.tail,
      columns: layout.columns,
      ...detailedRows,
    }
    return detailedRows.rows
  }

  const readerDocument = (): { readonly rows: readonly string[]; readonly runs: readonly (readonly TextRun[])[] } => {
    const rows = readerLines()
    return { rows, runs: detailedTranscriptCache?.runs ?? [] }
  }

  const readerPageRuns = (): readonly (readonly TextRun[])[] => {
    const pageRows = reader.pager.pageLines()
    return reader.runs.slice(reader.pager.anchorRow(), reader.pager.anchorRow() + pageRows.length)
  }

  /**
   * The footer's tool-details hint flag, derived per frame: a tool
   * block in the held content while no task or decision card holds
   * the stage. Stateless on purpose — /clear and a session switch
   * drop it with the content, so no sticky flag can outlive the
   * tools it speaks for.
   */
  const toolDetailsHint = (): boolean => {
    if (taskOpen() || presentingDecision() !== null) return false
    const held = sessionContent
    if (held === null) return false
    return held.content.transcript.some((block) => block.kind === "tool") || held.tail.some((block) => block.kind === "tool")
  }

  const footerTelemetryRuns = (telemetry: TuiSnapshot["footer"]["telemetry"]): readonly TextRun[] =>
    prioritizeFooterSegments(
      appendToolDetailsHint(
        telemetry === null ? footerMinimalSegments(pendingRuns) : footerSegments({ telemetry, pending: pendingRuns }),
        toolDetailsHint(),
      ),
      Math.max(1, layout.columns),
    )

  const composerHint = (
    shellMode: boolean,
    scrollIndicator: string | null,
  ): { readonly text: string; readonly token: "muted" | "bashMode" } | null => {
    const visibleGesture = pendingRuns.length === 0 || gestureHint?.kind === "ctrl-d-exit" ? gestureHint : null
    if (visibleGesture !== null) {
      switch (visibleGesture.kind) {
        case "exit":
          return { text: "press ctrl+c again to exit", token: "muted" }
        case "ctrl-d-exit":
          return { text: "press ctrl+d again to exit", token: "muted" }
        case "escape-clear":
          return { text: "press esc again to clear draft", token: "muted" }
        case "escape-rewind":
          return { text: "press esc again to rewind", token: "muted" }
      }
    }
    if (queueHintArmed && cancelableQueueRows().length > 0) return { text: QUEUE_CANCEL_HINT, token: "muted" }
    if (shellMode) {
      const compact = layout.columns <= 40
      return { text: compact ? BASH_MODE_HINT_COMPACT : BASH_MODE_HINT, token: "bashMode" }
    }
    if (scrollIndicator !== null) return { text: scrollIndicator, token: "muted" }
    return null
  }

  /** One ledger owns the composer's fixed rows and its selection-centered completion window. */
  const composerSurfacePlan = (visible: boolean, scrollIndicator: string | null = null): ComposerSurfacePlan => {
    const closedCompanion: TuiSnapshotGroups["companion"] = {
      open: false,
      kind: "command",
      candidates: [],
      focusIndex: 0,
      typeRow: null,
      position: null,
    }
    if (!visible) {
      return {
        layout: composerSurfaceLayout({
          width: layout.columns,
          availableRows: 0,
          hint: null,
          inputRowCount: 1,
          candidateCount: 0,
        }),
        companion: closedCompanion,
      }
    }

    const width = Math.max(1, layout.columns)
    const shellMode = editor.text.startsWith("!")
    const completionVisible =
      picker.isVisible() && !taskOpen() && !reader.open && presentingDecision() === null && children.focused() === null
    const maximumWindow = picker.window(completionVisible ? 8 : 0)
    const candidateKind = paletteContext?.kind === "mention" ? "path" : "command"
    const renderable = editor as SearchEditor & Partial<Pick<ComposerKernel, "bodyRows" | "renderLines" | "renderRuns">>
    const naturalInputRows =
      typeof renderable.bodyRows === "function"
        ? renderable.bodyRows(width, COMPOSER_ROW_CAP, shellMode)
        : Math.max(1, wrapVerbatim(editor.text, Math.max(1, width - 2)).length)
    const rowsBeforeTask = fixedRowsBeforeTask(false)
    const taskFrame = taskFrameView()
    const taskRows = taskFrame === null ? 0 : taskSurfaceRowHeight(taskFrame, width, Math.max(0, layout.rows - rowsBeforeTask))
    const availableRows = Math.max(0, layout.rows - rowsBeforeTask - taskRows)
    const surface = composerSurfaceLayout({
      width,
      availableRows,
      hint: composerHint(shellMode, scrollIndicator),
      inputRowCount: Math.min(COMPOSER_ROW_CAP, naturalInputRows),
      candidateCount: maximumWindow.items.length,
    })
    const window = picker.window(surface.candidateRowCount)
    const open = window.items.length > 0
    const position = open && window.total > 0 ? { index: window.selectedIndex + 1, total: window.total } : null
    return {
      layout: surface,
      companion: {
        open,
        kind: candidateKind,
        candidates: window.items.map((item) => ({
          id: item.key,
          label: item.label,
          ...(item.detail === undefined ? {} : { detail: item.detail }),
          ...(item.matchRanges === undefined ? {} : { matchRanges: item.matchRanges }),
        })),
        focusIndex: Math.max(0, window.selectedIndex - window.startIndex),
        typeRow: null,
        position,
      },
    }
  }

  const composerInputRows = (
    surface: ComposerSurfaceLayout,
    shellMode: boolean,
  ): { readonly rows: readonly (readonly TextRun[])[]; readonly caretRow: number; readonly caretColumn: number } => {
    const width = Math.max(1, layout.columns)
    if (surface.inputRowCount === 0) return { rows: [], caretRow: 0, caretColumn: 0 }
    const renderable = editor as SearchEditor & Partial<Pick<ComposerKernel, "renderLines" | "renderRuns">>
    if (typeof renderable.renderLines === "function" && typeof renderable.renderRuns === "function") {
      const rendered = renderable.renderLines(width, surface.inputRowCount, shellMode)
      return {
        rows: renderable.renderRuns(width, surface.inputRowCount, true, shellMode).map((runs) => runs.map((run) => ({ ...run }))),
        caretRow: rendered.caretRow,
        caretColumn: rendered.caretColumn,
      }
    }

    const bodyWidth = Math.max(1, width - 2)
    const wrappedLines = wrapVerbatim(editor.text, bodyWidth)
    const lines = wrappedLines.length === 0 ? [""] : wrappedLines
    const visibleLines = lines.slice(-surface.inputRowCount)
    const beforeCaret = wrapVerbatim(editor.text.slice(0, editor.caretOffset), bodyWidth)
    const rows = visibleLines.map((line, index) => [
      { text: index === 0 ? "› " : "  ", token: "text" as const },
      { text: line, token: "text" as const },
    ])
    return {
      rows,
      caretRow: Math.max(0, Math.min(visibleLines.length - 1, beforeCaret.length - 1 - (lines.length - visibleLines.length))),
      caretColumn: textWidth((visibleLines.at(-1) === undefined ? "› " : "  ") + (beforeCaret.at(-1) ?? "")),
    }
  }

  /**
   * The transcript row budget of the full-column frame. The view owns
   * the layout; this mirror exists because the viewport window must be
   * cut before the frame is built, and the two budgets must agree: the
   * view renders the pre-cut window verbatim. Every chrome row the
   * full frame can spend is accounted here once.
   */
  /** Mirror upsert: first-seen seq wins, absent ids drop, marks survive re-assertion. */
  const upsertMirrorQueue = (rows: readonly TuiQueueRow[]): boolean => {
    let changedHere = false
    const seen = new Set<string>()
    for (const row of rows) {
      seen.add(row.inputId)
      const held = queueEntries.get(row.inputId)
      if (held === undefined) {
        queueEntries.set(row.inputId, { row, seq: ++queueSeq, cancelling: false })
        changedHere = true
      } else if (held.row.text !== row.text || held.row.kind !== row.kind) {
        queueEntries.set(row.inputId, { ...held, row })
        changedHere = true
      }
    }
    for (const id of [...queueEntries.keys()]) {
      if (!seen.has(id) && queueEntries.delete(id)) changedHere = true
    }
    return changedHere
  }

  /** Mirror upsert for the plan chrome: first-seen seq wins, absent ids drop, changed rows re-render. */
  const upsertMirrorPlans = (rows: readonly TuiPlanRow[]): boolean => {
    let changedHere = false
    const seen = new Set<string>()
    for (const row of rows) {
      seen.add(row.planId)
      const held = planEntries.get(row.planId)
      if (held === undefined) {
        planEntries.set(row.planId, { row, seq: ++planSeq })
        changedHere = true
      } else if (
        held.row.title !== row.title ||
        held.row.status !== row.status ||
        held.row.completedSteps !== row.completedSteps ||
        held.row.totalSteps !== row.totalSteps
      ) {
        planEntries.set(row.planId, { ...held, row })
        changedHere = true
      }
    }
    for (const id of [...planEntries.keys()]) {
      if (!seen.has(id) && planEntries.delete(id)) changedHere = true
    }
    return changedHere
  }

  const clearQueueState = (): void => {
    queueEntries = new Map()
    parkSeq.clear()
    queueHintArmed = false
    planEntries = new Map()
  }

  /**
   * The cancelable ring: live prompt rows and parked slash rows in one
   * seq order — a row parked before a mailbox row landed cancels
   * first. Notification rows are display-only and never resolve here.
   */
  const cancelableQueueRows = (): readonly { id: string; parked: boolean }[] => {
    const rows: { id: string; parked: boolean; seq: number }[] = []
    for (const [id, entry] of queueEntries) {
      if (entry.row.kind === "prompt" && !entry.cancelling) rows.push({ id, parked: false, seq: entry.seq })
    }
    for (const [id, seq] of parkSeq) {
      if (runQueue.queuedRows().some((row) => row.id === id)) rows.push({ id, parked: true, seq })
    }
    return rows.sort((a, b) => a.seq - b.seq).map(({ id, parked }) => ({ id, parked }))
  }

  /** One queued row leaves by the idle gesture: parked rows cancel locally, prompts by receipt. */
  const cancelOldestQueued = (): void => {
    const oldest = cancelableQueueRows()[0]
    if (oldest === undefined) return
    if (oldest.parked) {
      if (runQueue.cancelParked(oldest.id)) parkSeq.delete(oldest.id)
      changed = true
      return
    }
    const origin = sessionOrigin
    if (origin === null) return
    const entry = queueEntries.get(oldest.id)
    if (entry === undefined) return
    queueEntries.set(oldest.id, { ...entry, cancelling: true })
    const operationId = ledger.mint({ scope: "session", sessionId: origin.sessionId, generation: origin.generation })
    emit({ kind: "cancel-queued", inputId: oldest.id, operationId })
    changed = true
  }

  /**
   * Displacement: leaving the world (exit, resume switch) cancels every
   * live prompt row by receipt first — notification ids are never
   * named. Settles arrive for a world already left, so they stay
   * silent.
   */
  const emitExitDisplacement = (): void => {
    const origin = sessionOrigin
    if (origin === null) return
    const live = [...queueEntries.entries()]
      .filter(([, entry]) => entry.row.kind === "prompt" && !entry.cancelling)
      .sort((a, b) => a[1].seq - b[1].seq)
    for (const [id, entry] of live) {
      queueEntries.set(id, { ...entry, cancelling: true })
      const operationId = ledger.mint({ scope: "session", sessionId: origin.sessionId, generation: origin.generation })
      displacementOps.add(operationId)
      emit({ kind: "cancel-queued", inputId: id, operationId })
    }
  }

  /**
   * The frame's queue preview: mailbox rows in acceptance order, then
   * the parked slash queue; one bounded prefix plus the elision count,
   * derived here so the row budget and the painted rows cannot
   * disagree.
   */
  const queuePreview = (): TuiSnapshotGroups["queue"] => {
    const mirrorRows = [...queueEntries.values()].sort((a, b) => a.seq - b.seq).map((entry) => entry.row.text)
    const parkedRows = runQueue
      .queuedRows()
      .filter((row) => parkSeq.has(row.id))
      .sort((a, b) => (parkSeq.get(a.id) ?? 0) - (parkSeq.get(b.id) ?? 0))
      .map((row) => row.raw)
    const rows = [...mirrorRows, ...parkedRows]
    const visible = rows.slice(0, QUEUE_PREVIEW_ROWS)
    return { visible, elided: Math.max(0, rows.length - visible.length) }
  }

  /**
   * The frame's plan chrome rows: every live plan, one row each, in
   * first-appearance order. Unlike the queue preview there is no row
   * budget — plan chrome is unbounded standing state, and the budget
   * spends exactly the rows returned here.
   */
  const planPreview = (): readonly TuiPlanRow[] => [...planEntries.values()].sort((a, b) => a.seq - b.seq).map((entry) => entry.row)

  /**
   * The open task's composed frame view: one derivation shared by the
   * snapshot's taskFrame and the transcript budget, so the painted
   * card's height and the rows the viewport gives up cannot disagree —
   * exit-lever hint included.
   */
  const taskFrameView = (): TaskFrameView | null => {
    if (tasks.topTicket() === null) return null
    const tabs = tasks.topTabs()
    return {
      title: tasks.topTitle() ?? "",
      composerMode: tasks.topComposerMode(),
      steps: tasks.topSteps(),
      ...(tabs === undefined ? {} : { tabs }),
      rows: tasks.topRows(),
      body: tasks.topBody(),
      hints: taskActionsFocused ? [...tasks.topHints(), TASK_EXIT_FOCUS_HINT] : tasks.topHints(),
      dirty: tasks.topDirty(),
    }
  }

  const fixedRowsBeforeTask = (composerVisible: boolean): number => {
    const width = Math.max(layout.columns, 1)
    const footerLines = wrapFooterSegments(footerTelemetryRuns(footerTelemetry()), width).length
    const presenting = presentingDecision()
    let fixed = tasks.pausedTasks().length + notices.length + receipts.pendingCount()
    if (presenting !== null) {
      if (presenting.fact.kind === "ask") {
        fixed += decisionGroups().presenting?.surfaceRows?.length ?? 0
      } else {
        const approval = presenting.fact.fact
        const summaryRows = approval.summary.length === 0 ? 0 : wrapVerbatim(approval.summary, Math.max(1, layout.columns)).length
        const optionRows = approval.options.reduce((count, option, index) => {
          const prefix = `${decisionCursor.armedIndex === index ? "›" : " "} `
          const rows = wrapVerbatim(option.label, Math.max(1, width - textWidth(prefix))).length
          const rowLimit = layout.columns <= 40 ? ASK_OPTION_PREVIEW_ROWS_COMPACT : ASK_OPTION_PREVIEW_ROWS_WIDE
          return count + Math.min(rows, rowLimit)
        }, 0)
        fixed += 1 + summaryRows + optionRows + 1
      }
    }
    const leasesBehind = decisionGroups()
    if (leasesBehind.hiddenPending.length > 0) fixed += 1
    if (leasesBehind.resolving.length > 0) fixed += 1
    if (leasesBehind.unknown.length > 0) fixed += 1
    if (pendingRuns.length > 0) fixed += 1
    const queue = queuePreview()
    fixed += queue.visible.length + (queue.elided > 0 ? 1 : 0)
    fixed += planPreview().length
    if (children.focused() !== null) return layout.rows
    if (children.runningCount() > 0) fixed += 1
    fixed += footerLines
    if (composerVisible && presenting === null) fixed += composerSurfacePlan(true).layout.height
    return fixed
  }

  const documentPageHeight = (): number => {
    // A document card needs its top and bottom frame rows plus one hint row.
    // The same fixed rows are removed before Root grants the task surface;
    // reserve one transcript row and spend the rest on readable document lines.
    return Math.max(1, layout.rows - fixedRowsBeforeTask(false) - 4)
  }

  const transcriptCapacity = (): number => {
    const taskFrame = taskFrameView()
    const composerVisible = (taskFrame === null || taskFrame.composerMode === "visible") && presentingDecision() === null
    let fixed = fixedRowsBeforeTask(composerVisible)
    if (children.focused() !== null) return 0
    if (taskFrame !== null) fixed += taskSurfaceRowHeight(taskFrame, Math.max(layout.columns, 1), Math.max(0, layout.rows - fixed))
    return Math.max(0, layout.rows - fixed)
  }

  /** The viewport's visible window and the composer rule row's scrolled-off indicator. */
  const transcriptWindow = (): { readonly visible: readonly TranscriptLine[]; readonly indicator: string | null } => {
    const model = viewportModel
    if (model === null || model.total === 0) return { visible: [], indicator: null }
    const baseCapacity = transcriptCapacity()
    const baseWindow = viewportWindow(viewport, model, baseCapacity)
    if (baseWindow === null) return { visible: [], indicator: null }
    const baseIndicator = viewportIndicator(viewport, baseWindow, model.total, baseCapacity)
    let capacity = baseCapacity
    let indicator = baseIndicator
    if (baseIndicator !== null) {
      const taskFrame = taskFrameView()
      const composerVisible = (taskFrame === null || taskFrame.composerMode === "visible") && presentingDecision() === null
      const basePlan = composerSurfacePlan(composerVisible)
      const hintedPlan = composerSurfacePlan(composerVisible, baseIndicator)
      capacity = Math.max(0, baseCapacity - (hintedPlan.layout.height - basePlan.layout.height))
      const finalWindow = viewportWindow(viewport, model, capacity)
      if (finalWindow === null) return { visible: [], indicator: null }
      indicator = viewportIndicator(viewport, finalWindow, model.total, capacity)
      return { visible: model.slice(finalWindow.start, finalWindow.end - finalWindow.start), indicator }
    }
    const window = viewportWindow(viewport, model, capacity)
    if (window === null) return { visible: [], indicator: null }
    return {
      visible: model.slice(window.start, window.end - window.start),
      indicator,
    }
  }

  const footerTelemetry = (): TuiSnapshotGroups["footer"]["telemetry"] => {
    const context = ports.context?.() ?? null
    const telemetry: { modelName?: string; contextTokens?: number; contextEstimated?: boolean; permissionMode?: string } = {}
    const liveModel = context?.model?.trim()
    const configuredModel = ports.provider?.().modelName?.trim()
    const modelName = liveModel || configuredModel
    if (modelName !== undefined && modelName !== null && modelName.length > 0) telemetry.modelName = modelName
    if (context?.contextTokens !== undefined) telemetry.contextTokens = context.contextTokens
    if (context?.contextEstimated !== undefined) telemetry.contextEstimated = context.contextEstimated
    if (permissionMode !== null) telemetry.permissionMode = permissionMode
    return Object.keys(telemetry).length > 0 ? telemetry : null
  }

  const buildFrame = (): TuiSnapshot => {
    const taskFrame = taskFrameView()
    const decisions = decisionGroups()
    const visible = (taskFrame === null || taskFrame.composerMode === "visible") && decisions.presenting === null
    const transcript = transcriptWindow()
    const composerPlan = composerSurfacePlan(visible, transcript.indicator)
    const input = composerInputRows(composerPlan.layout, editor.text.startsWith("!"))
    const surfaceRows = composerPlan.layout.rows
    return {
      revision,
      layout,
      composer: {
        text: editor.text,
        caretOffset: editor.caretOffset,
        visible,
        active: (!taskOpen() && decisions.presenting === null) || belowFloor(),
        surfaceRows,
        inputRows: input.rows,
        inputCaretRow: input.caretRow,
        inputCaretColumn: input.caretColumn,
      },
      taskFrame,
      notices,
      receipts: receipts.listing(),
      companion: composerPlan.companion,
      runSlot: { runId: pendingRuns[0]?.runId ?? null, owner: runQueue.slotOwner(), queued: runQueue.queuedInputs() },
      plans: planPreview(),
      queue: queuePreview(),
      queueCancel: queueHintArmed && cancelableQueueRows().length > 0,
      decisions,
      transcript: {
        lines: renderedTranscript(),
        readerRows: reader.open ? reader.pager.pageLines() : [],
        readerRuns: reader.open ? readerPageRuns() : [],
        ...transcript,
        readerOpen: reader.open,
        readerPage: reader.pager.pageNumber,
        readerPages: reader.pager.pageCount,
      },
      footer: {
        pending: pendingRuns,
        telemetry: footerTelemetry(),
        toolDetailsHint: toolDetailsHint(),
      },
      gestureHint: pendingRuns.length === 0 || gestureHint?.kind === "ctrl-d-exit" ? gestureHint : null,
      exitConfirm: pendingRuns.length === 0 && gestureHint?.kind === "exit" ? { deadline: gestureHint.deadline } : null,
      pausedTasks: tasks.pausedTasks(),
      children: children.view(),
      focus: { taskActions: taskActionsFocused },
      binding: sessionOrigin,
      degraded,
    }
  }

  /** The frame identity uSES requires: built once per committed change, handed out unchanged between commits. */
  let frame: TuiSnapshot = buildFrame()

  const snapshot = (): TuiSnapshot => frame

  const commit = (): void => {
    if (disposed) return
    // The task's exit lever exists only while its form holds the stage.
    if (taskActionsFocused && !taskOpen()) {
      taskActionsFocused = false
      changed = true
    }
    if (!changed) return
    changed = false
    revision += 1
    barrier.publish(revision, offeredBindings())
    frame = buildFrame()
    for (const listener of listeners) listener(frame)
  }

  const documentLines = (title: string): readonly string[] => {
    const facts = ports.sessionFacts()
    if (title === "Available commands") return slashHelpLines()
    if (title === "Status") {
      const permission = ports.permission()
      const provider = ports.provider?.() ?? null
      return [
        `session ${facts.sessionId ?? "none"}`,
        `permission mode ${permission?.currentMode ?? "not reported by host"}`,
        provider?.label == null ? "provider not reported by host" : `provider ${provider.label}`,
        provider?.endpoint == null ? "endpoint not reported by host" : `endpoint ${provider.endpoint}`,
        provider?.protocol == null ? "protocol not reported by host" : `protocol ${provider.protocol}`,
        `pending runs ${pendingRuns.length}`,
        `rewind checkpoints ${ports.history().rewindCheckpoints.length}`,
      ]
    }
    if (title === "Provider") {
      const provider = ports.provider?.() ?? null
      if (provider === null)
        return [
          "provider not reported by host",
          "model not reported by host",
          "endpoint not reported by host",
          "protocol not reported by host",
        ]
      return [
        provider.label == null ? "provider not reported by host" : `provider ${provider.label}`,
        provider.modelName == null ? "model not reported by host" : `model ${provider.modelName}`,
        provider.endpoint == null ? "endpoint not reported by host" : `endpoint ${provider.endpoint}`,
        provider.protocol == null ? "protocol not reported by host" : `protocol ${provider.protocol}`,
      ]
    }
    if (title === "Context") {
      const context = ports.context?.() ?? null
      if (context === null) return ["context usage not reported by host"]
      const lines: string[] = []
      if (context.model !== undefined) lines.push(`model ${context.model}`)
      if (context.contextTokens !== undefined)
        lines.push(`context ${context.contextEstimated === true ? "~" : ""}${context.contextTokens} tokens`)
      return lines.length > 0 ? lines : ["context usage not reported by host"]
    }
    return [title]
  }

  const openRoutingTask = (routing: Extract<SlashRouting, { readonly kind: "task" }>): void => {
    const open = routing.open
    if (open.task === "theme") tasks.open("theme", { initialThemeId: ports.theme().committedThemeId })
    else if (open.task === "diff") openDiffTask()
    else if (open.task === "permissions")
      permissionsTicket = tasks.open("permissions", open.initialTab === undefined ? {} : { initialTab: open.initialTab })
    else if (open.task === "rewind") tasks.open("rewind", {})
    else if (open.task === "resume") openResumeTask(true)
    else tasks.open("document", { title: open.title!, lines: documentLines(open.title!) })
  }

  const openDiffTask = (): void => {
    const workspaceId = ports.sessionFacts().workspaceId ?? "workspace"
    const cached = mirror.queryResult(DIFF_QUERY_ID)
    if (cached === undefined) {
      emit({ kind: "query", target: "diff-files", requestId: DIFF_QUERY_ID, scope: { scope: "workspace", workspaceId } })
      tasks.open("diff", { workspaceId, files: [], loading: true })
      return
    }
    tasks.open("diff", { workspaceId, files: cached.map((file) => ({ ...file, detail: file.detail ?? [] })) })
  }

  /**
   * The resume switch's one submission: a client-scoped mint — the
   * switch works bound and detached alike — and the command leaves;
   * the canonical outcome lands the notice and, on success, the
   * adoption.
   */
  const submitResume = (sessionId: string): boolean => {
    // The switch abandons the live lineage: its queued prompts leave by
    // receipt ahead of the switch itself.
    emitExitDisplacement()
    const operationId = ledger.mint({ scope: "client" })
    return emit({ kind: "resume", sessionId, operationId })
  }

  const openResumeTask = (autoPick: boolean): void => {
    const cached = mirror.resumeSessions(RESUME_QUERY_ID)
    if (cached === undefined) {
      emit({ kind: "query", target: "resume-sessions", requestId: RESUME_QUERY_ID, scope: { scope: "client" } })
      resumeAutoPick = autoPick
      resumeTicket = tasks.open("resume", { sessions: [] })
      return
    }
    // A warm client cache predates any switch; the now-live session is
    // a re-attach target, never a candidate.
    const rows = cached.filter((row) => row.sessionId !== sessionOrigin?.sessionId)
    if (!autoPick || rows.length >= 2) {
      resumeTicket = tasks.open("resume", { sessions: rows })
      return
    }
    if (rows.length === 1) submitResume(rows[0]!.sessionId)
    else notice("no sessions to resume")
  }

  /** Apply one routed slash disposition; every path that leaves the composer clears the draft. */
  const handleRouting = (routing: SlashRouting): void => {
    switch (routing.kind) {
      case "submit":
        performPlainSubmit(routing.text)
        return
      case "compact": {
        const origin = sessionOrigin
        if (origin === null) {
          notice("no session bound")
          return
        }
        if (
          !emit({ kind: "compact", scope: origin, ...(routing.instructions === undefined ? {} : { instructions: routing.instructions }) })
        )
          return
        resetEditor("")
        changed = true
        return
      }
      case "clear":
        viewport = FOLLOW_VIEWPORT
        viewportSourceIds = []
        viewportModel = null
        sessionContent = null
        resetEditor("")
        notice("transcript cleared")
        return
      case "exit":
        emitExitDisplacement()
        emit({ kind: "exit" })
        resetEditor("")
        changed = true
        return
      case "theme-commit": {
        const operationId = ledger.mint({ scope: "client" })
        emit({ kind: "theme", op: "commit", themeId: routing.themeId, operationId })
        resetEditor("")
        changed = true
        return
      }
      case "permission-mode": {
        // A refused change keeps the draft; a confirm-open or submitted
        // one has left the composer's possession either way.
        if (submitModeChange(routing.mode, "slash") !== "refused") {
          resetEditor("")
          changed = true
        }
        return
      }
      case "permission-rules": {
        const origin = sessionOrigin
        if (origin === null) {
          notice("no session bound")
          return
        }
        const permission = ports.permission()
        if (permission === null) {
          notice("permissions not reported by host yet")
          return
        }
        // The full set is composed against the canonical mirror: add is
        // an upsert, remove of an absent row is an error — never a silent
        // no-op over a set the user cannot see.
        const baseline = permission.rules
        let rules: readonly (typeof baseline)[number][]
        if (routing.action.type === "add") {
          const row = { name: routing.action.name, behavior: routing.action.behavior }
          const existing = baseline.some((rule) => rule.name === row.name)
          rules = existing ? baseline.map((rule) => (rule.name === row.name ? row : rule)) : [...baseline, row]
        } else {
          if (!baseline.some((rule) => rule.name === routing.action.name)) {
            notice(`no rule for ${routing.action.name}`)
            return
          }
          rules = baseline.filter((rule) => rule.name !== routing.action.name)
        }
        if (submitRules(rules, baseline)) {
          resetEditor("")
          changed = true
        }
        return
      }
      case "add-dir": {
        const origin = sessionOrigin
        if (origin === null) {
          notice("no session bound")
          return
        }
        const operationId = ledger.mint({ scope: "session", sessionId: origin.sessionId, generation: origin.generation })
        if (!emit({ kind: "add-dir", directory: routing.directory, operationId })) return
        resetEditor("")
        changed = true
        return
      }
      case "resume": {
        // An exact id is a re-attach, not a candidate — the live
        // session's own id included.
        if (submitResume(routing.sessionId)) {
          resetEditor("")
          changed = true
        }
        return
      }
      case "resume-tasks":
        resumePausedTasks()
        resetEditor("")
        changed = true
        return
      case "task":
        resetEditor("")
        openRoutingTask(routing)
        changed = true
        return
      case "error":
        notice(routing.text)
        return
    }
  }

  const performPlainSubmit = (text: string): void => {
    const origin = sessionOrigin
    if (origin === null) {
      notice("no session bound")
      return
    }
    // The missing binding outranks the seam state: a detached submit
    // names the session, not the disclosure.
    const gate = runSeamGate()
    if (gate !== "open") {
      runSeamRefusal(gate)
      return
    }
    const operationId = ledger.mint({ scope: "session", sessionId: origin.sessionId, generation: origin.generation })
    // A refused emit keeps the draft and mints no receipt — the submit can be repeated after recovery.
    if (!emit({ kind: "submit", text, scope: origin, operationId })) return
    receipts.open(text)
    resetEditor("")
    changed = true
  }

  const performSubmission = (): void => {
    const raw = editor.text
    const gate = runSeamGate()
    if (raw.trim().startsWith("!")) {
      const command = raw.trim().slice(1).trim()
      if (command.length === 0) return
      const origin = sessionOrigin
      if (origin === null) {
        notice("no session bound")
        return
      }
      if (gate !== "open") {
        runSeamRefusal(gate)
        return
      }
      if (!emit({ kind: "shell", command, scope: origin })) return
      resetEditor("")
      changed = true
      return
    }
    if (!raw.startsWith("/")) {
      const text = raw.trim()
      if (text.length === 0) return
      performPlainSubmit(text)
      return
    }
    let parse: ReturnType<typeof parseSlashSubmission>
    try {
      parse = parseSlashSubmission(raw)
    } catch (error) {
      if (error instanceof SlashSyntaxError) {
        notice(error.message)
        return
      }
      throw error
    }
    if ("prompt" in parse) return
    // Immediate commands stay reachable in an unconfirmed session —
    // mode and rules submissions are the way out of it.
    if (gate !== "open" && slashBusyPolicy(parse.slash.name) === "queue") {
      runSeamRefusal(gate)
      return
    }
    const events = runQueue.submitSlash(parse.slash)
    applyQueueEvents(events)
    // A freshly parked row takes its seq now, not at preview time, so
    // it cancels ahead of mailbox rows that landed after its park.
    for (const row of runQueue.queuedRows()) {
      if (!parkSeq.has(row.id)) parkSeq.set(row.id, ++queueSeq)
    }
    // A parked input moves its raw text into the queue; an executed
    // routing already decided its own draft disposition.
    if (events.length === 0) {
      resetEditor("")
      changed = true
    }
  }

  const executeSlash = (input: SlashInput): void => {
    handleRouting(routeSlash(input, ports.theme().themeIds, ports.permission()?.selectableModes ?? []))
  }

  const applyQueueEvents = (inputs: readonly SlashInput[]): void => {
    for (const input of inputs) executeSlash(input)
    if (inputs.length > 0) changed = true
  }

  /**
   * The run slot reconciles only against session facts: a run in
   * flight adopts a held slash slot, a settled run frees it, and a
   * slot-owning slash with no run behind it drains the next parked
   * command — one per freed slot.
   */
  const reconcileRunSlot = (): void => {
    for (let guard = 0; guard < 64; guard += 1) {
      const busyRun = pendingRuns.length > 0
      const owner = runQueue.slotOwner()
      if (busyRun) {
        if (owner === "run") return
        if (owner === "slash") {
          applyQueueEvents(runQueue.slashFinished(false))
          continue
        }
        runQueue.markRunBusy()
        return
      }
      if (owner === "run") {
        const events = runQueue.runEpisodeSettled()
        applyQueueEvents(events)
        if (events.length > 0) return
        continue
      }
      if (owner === "slash") {
        const events = runQueue.slashFinished(true)
        applyQueueEvents(events)
        if (events.length > 0) return
        continue
      }
      return
    }
  }

  const receiveDelivery = (delivery: TaskDelivery): void => {
    if (delivery.ticket.kind === "prompt-history") {
      const value = delivery.completion.kind === "completed" ? (delivery.completion.value as PromptHistoryTaskResult) : null
      if (value?.kind === "picked") {
        editor.loadDraft(value.text)
        sendArmSuspended = false
        syncPalette()
      }
      changed = true
      return
    }
    if (delivery.ticket.kind === "confirm") {
      // The card ends programmatically on the canonical receipt or by
      // the user's own Escape; either way no command leaves here.
      confirmTicket = null
      permissionsTicketUnderConfirm = null
      changed = true
      return
    }
    if (delivery.ticket.kind === "permissions") {
      permissionsTicket = null
      if (permissionsTicketUnderConfirm?.id === delivery.ticket.id) permissionsTicketUnderConfirm = null
      // The "a" add-rule key closes into a composer draft, ready to type the tool name.
      const value = delivery.completion.kind === "completed" ? (delivery.completion.value as PermissionsTaskResult) : null
      if (value !== null && value.kind === "draft") resetEditor(value.draft)
      changed = true
      return
    }
    if (delivery.ticket.kind === "resume") {
      // The card ended by pick, Escape, switch or detach; a pick's
      // command already left through the effect channel.
      resumeTicket = null
      resumeAutoPick = false
      changed = true
      return
    }
    if (delivery.ticket.kind === "chooser") {
      chooserTicket = null
      // The reopen guard runs at delivery time: a decision raised while
      // the chooser was open owns the stage, and a lease resolved
      // elsewhere no longer reopens. Both re-checks race the world the
      // card closes into, never the world it opened from.
      const value = delivery.completion.kind === "completed" ? (delivery.completion.value as { requestId: string }) : null
      const lease = value === null ? undefined : leases.lease(value.requestId)
      if (value !== null && presentingDecision() === null && lease !== undefined && lease.state === "hidden-pending") {
        leases.dispatch(value.requestId, { kind: "open" })
        const fact = decisionFacts.get(value.requestId)
        if (fact !== undefined) decisionCursor = firstDecisionCursor(fact)
      }
      changed = true
      return
    }
    if (delivery.ticket.kind !== "theme") return
    if (delivery.completion.kind === "completed") {
      const operationId = ledger.mint({ scope: "client" })
      emit({ kind: "theme", op: "commit", themeId: (delivery.completion.value as { themeId: ThemeId }).themeId, operationId })
    } else if (delivery.completion.kind === "dismissed") {
      emit({ kind: "theme", op: "cancel", themeId: ports.theme().committedThemeId })
    }
    changed = true
  }

  const dispatchTaskIntent = (intent: TuiIntent): void => {
    // The open task's exit lever: the ring gestures park the form's Tab
    // seat (Tab again returns to editing), Enter on it leaves through
    // the shared back path, and any other task intent unparks it.
    if (intent.kind === "advance" || intent.kind === "focus-cycle") {
      taskActionsFocused = !taskActionsFocused
      changed = true
      return
    }
    if (intent.kind === "activate" && taskActionsFocused) {
      const outcome = tasks.back()
      taskActionsFocused = false
      changed = true
      if (outcome.status === "dirty-guard") notice("unsaved changes — discard explicitly")
      else if (outcome.status === "dismissed") receiveDelivery(outcome.delivery)
      return
    }
    if (taskActionsFocused) {
      taskActionsFocused = false
      changed = true
    }
    const dispatchResult = tasks.handleIntent(intent)
    if (dispatchResult === null) return
    for (const effect of dispatchResult.effects) {
      if (effect.kind === "theme-preview") emit({ kind: "theme", op: "preview", themeId: effect.themeId as ThemeId })
      else if (effect.kind === "permission-mode") submitModeChange(effect.mode as string, "mode-row")
      else if (effect.kind === "permission-rules")
        submitRules(effect.rules as readonly TuiPermissionRule[], effect.baseline as readonly TuiPermissionRule[])
      else if (effect.kind === "full-access-confirm") submitConfirmSwitch()
      else if (effect.kind === "rewind-checkpoint") submitRewind(effect.checkpoint as string)
      else if (effect.kind === "resume-session") submitResume(effect.sessionId as string)
    }
    if (dispatchResult.delivery !== null) receiveDelivery(dispatchResult.delivery)
    changed = true
  }

  /**
   * The rewind card's one submission: mint the operation against the
   * live binding and let the command leave. The card has already
   * closed itself — the restored draft and the status line land with
   * the canonical outcome.
   */
  const submitRewind = (checkpoint: string): void => {
    const origin = sessionOrigin
    if (origin === null) {
      notice("no session bound")
      return
    }
    const operationId = ledger.mint({ scope: "session", sessionId: origin.sessionId, generation: origin.generation })
    emit({ kind: "rewind", checkpoint, operationId })
  }

  const openReader = (): void => {
    const document = readerDocument()
    reader = { open: true, pager: pagerKit.createPager(document.rows, readerHeight()), runs: document.runs }
    changed = true
  }

  const closeReader = (): void => {
    reader = { open: false, pager: pagerKit.createPager([], 1), runs: [] }
    changed = true
  }

  // FullFrame reserves one title row and one paging row around this page.
  const readerHeight = (): number => Math.max(1, layout.rows - 2)

  const toggleReader = (): void => {
    if (reader.open) closeReader()
    else openReader()
  }

  /**
   * The presenting face closed (settled or authority-closed): the
   * next never-presented hidden-pending lease takes the stage. A
   * collapsed lease waits for the chooser, and terminal states and
   * undecidable reads never re-present — a race-lost approval would
   * otherwise loop forever.
   */
  const autoOpenNextDecision = (): void => {
    if (presentingDecision() !== null) return
    for (const [id] of decisionFacts) {
      const lease = leases.lease(id)
      if (lease === undefined || lease.state !== "hidden-pending" || lease.everPresented) continue
      leases.dispatch(id, { kind: "open" })
      const fact = decisionFacts.get(id)
      if (fact !== undefined) decisionCursor = firstDecisionCursor(fact)
      changed = true
      return
    }
  }

  /**
   * The final resolve press: settle only after the command truly left.
   * A refused emit leaves the lease presenting so the same press can
   * be repeated after recovery — settling first would strand a lease
   * in resolving for a command that never left the kernel.
   */
  const resolveDecision = (presentation: { id: string; disclosure: number }, command: TuiCommand): void => {
    const binding = decisionBinding(presentation.id, presentation.disclosure)
    const verdict = executionGate({
      binding,
      current: binding,
      enabled: true,
      armed: arms.isArmed(binding),
      written: barrier.eligible(binding),
    })
    if (!verdict.execute) return
    if (!emit(command)) return
    arms.consume(binding)
    if (leases.dispatch(presentation.id, { kind: "settle" })) changed = true
    autoOpenNextDecision()
  }

  const askResolution = (
    presentation: { id: string; fact: Extract<DecisionFact, { kind: "ask" }>; disclosure: number },
    lease: ReturnType<typeof leases.lease>,
  ) => askAnswers(presentation, lease)

  const submitAsk = (presentation: { id: string; fact: Extract<DecisionFact, { kind: "ask" }>; disclosure: number }): void => {
    const answerState = askResolution(presentation, leases.lease(presentation.id))
    if (!answerState.isValid) return
    resolveDecision(
      { id: presentation.id, disclosure: presentation.disclosure },
      {
        kind: "resolve-ask",
        request: presentation.fact.fact.request,
        value: {
          kind: "answered",
          answers: answerState.answers,
          ...(answerState.freeText.length === 0 ? {} : { freeText: answerState.freeText }),
        },
      },
    )
  }

  const chatWithAskContext = (presentation: { id: string; fact: Extract<DecisionFact, { kind: "ask" }>; disclosure: number }): void => {
    const answerState = askResolution(presentation, leases.lease(presentation.id))
    const contextAnswers = answerState.answers.filter((answer) => answer.selectedOptionIds.length > 0)
    resolveDecision(
      { id: presentation.id, disclosure: presentation.disclosure },
      {
        kind: "resolve-ask",
        request: presentation.fact.fact.request,
        value: {
          kind: "chat",
          ...(contextAnswers.length === 0 ? {} : { contextAnswers }),
          ...(answerState.freeText.length === 0 ? {} : { contextFreeText: answerState.freeText }),
        },
      },
    )
  }

  const enterAskOther = (
    presentation: { id: string; fact: Extract<DecisionFact, { kind: "ask" }>; disclosure: number },
    question: AskQuestionFact,
  ): ComposerKernel => {
    if (!question.multiSelect) leases.answer(presentation.id, question.questionId, [])
    decisionCursor = { ...decisionCursor, focus: "other" }
    saveQuestionCursor(presentation)
    changed = true
    return askEditorFor(presentation.id, presentation.fact.disclosure, question.questionId)
  }

  const selectAskOption = (
    presentation: { id: string; fact: Extract<DecisionFact, { kind: "ask" }>; disclosure: number },
    question: AskQuestionFact,
    optionIndex: number,
  ): void => {
    const option = question.options[optionIndex]
    if (option === undefined) return
    const current = leases.lease(presentation.id)?.answers[question.questionId] ?? []
    if (question.multiSelect) {
      const next = current.includes(option.optionId) ? current.filter((entry) => entry !== option.optionId) : [...current, option.optionId]
      leases.answer(presentation.id, question.questionId, next)
      changed = true
      return
    }

    askOtherEditors.get(askEditorKey(presentation.id, presentation.fact.disclosure, question.questionId))?.clearDraft()
    leases.answer(presentation.id, question.questionId, [option.optionId])
    changed = true
    const questions = presentation.fact.fact.questions
    if (decisionCursor.questionIndex < questions.length - 1) {
      switchAskQuestion(presentation, decisionCursor.questionIndex + 1)
      return
    }
    submitAsk(presentation)
  }

  const askEditorIntent = (
    presentation: { id: string; fact: Extract<DecisionFact, { kind: "ask" }>; disclosure: number },
    intent: TuiIntent,
  ): boolean => {
    const question = presentation.fact.fact.questions[decisionCursor.questionIndex]
    if (question === undefined) return true
    const askEditor = askEditorFor(presentation.id, presentation.fact.disclosure, question.questionId)
    if (intent.kind === "back" || intent.kind === "activate") {
      decisionCursor = { ...decisionCursor, focus: "choices" }
      saveQuestionCursor(presentation)
      changed = true
      return true
    }
    if (intent.kind === "advance") {
      switchAskQuestion(presentation, moveHorizontalTab(decisionCursor.questionIndex, presentation.fact.fact.questions.length, "right"))
      return true
    }
    if (intent.kind === "permission-cycle") {
      switchAskQuestion(presentation, moveHorizontalTab(decisionCursor.questionIndex, presentation.fact.fact.questions.length, "left"))
      return true
    }
    const outcome = askEditor.dispatch(intent)
    if (outcome?.kind === "changed") changed = true
    return true
  }

  const handleAskInput = (
    presentation: { id: string; fact: Extract<DecisionFact, { kind: "ask" }>; disclosure: number },
    intent: TuiIntent,
  ): boolean => {
    const questions = presentation.fact.fact.questions
    const question = questions[decisionCursor.questionIndex]
    if (question === undefined) return true
    const optionCount = question.options.length
    const otherIndex = optionCount
    const submitIndex = optionCount + 1
    const chatIndex = optionCount + 2

    if (decisionCursor.focus === "other") return askEditorIntent(presentation, intent)

    if (intent.kind === "back") {
      resolveDecision(
        { id: presentation.id, disclosure: presentation.disclosure },
        {
          kind: "resolve-ask",
          request: presentation.fact.fact.request,
          value: { kind: "declined" },
        },
      )
      return true
    }
    const tabDirection = horizontalTabDirection(intent)
    if (tabDirection !== null) {
      switchAskQuestion(presentation, moveHorizontalTab(decisionCursor.questionIndex, questions.length, tabDirection))
      return true
    }
    if (intent.kind === "navigate" || intent.kind === "wheel") {
      const delta = intent.direction === "up" ? -1 : 1
      const rowCount = optionCount + 3
      const armed = Math.min(Math.max(0, (decisionCursor.armedIndex ?? 0) + delta), Math.max(0, rowCount - 1))
      decisionCursor = {
        ...decisionCursor,
        armedIndex: armed,
        windowStart: decisionWindowFollow(decisionCursor.windowStart, armed, optionCount, askWindowSize()),
      }
      changed = true
      return true
    }

    if (intent.kind === "input" && intent.event.type === "char") {
      const value = intent.event.value
      const armed = decisionCursor.armedIndex
      if (armed === otherIndex) {
        const otherEditor = enterAskOther(presentation, question)
        const outcome = otherEditor.dispatch(intent)
        if (outcome?.kind === "changed") changed = true
        return true
      }
      if (value === "c" && armed !== otherIndex) {
        chatWithAskContext(presentation)
        return true
      }
      if (value >= "1" && value <= "9") {
        const target = Number(value) - 1
        if (target < optionCount) {
          decisionCursor = {
            ...decisionCursor,
            armedIndex: target,
            windowStart: decisionWindowFollow(decisionCursor.windowStart, target, optionCount, askWindowSize()),
          }
          selectAskOption(presentation, question, target)
        }
        return true
      }
      if (value === " " && question.multiSelect && armed !== null && armed < optionCount) {
        selectAskOption(presentation, question, armed)
        return true
      }
      return true
    }

    if (intent.kind === "paste" && decisionCursor.armedIndex === otherIndex) {
      const otherEditor = enterAskOther(presentation, question)
      const outcome = otherEditor.dispatch(intent)
      if (outcome?.kind === "changed") changed = true
      return true
    }
    if (
      intent.kind === "input" &&
      (intent.event.type === "backspace" || intent.event.type === "delete") &&
      decisionCursor.armedIndex === otherIndex
    ) {
      const otherEditor = enterAskOther(presentation, question)
      const outcome = otherEditor.dispatch(intent)
      if (outcome?.kind === "changed") changed = true
      return true
    }

    if (intent.kind !== "activate" || decisionCursor.armedIndex === null) return true
    const armedIndex = Math.min(decisionCursor.armedIndex, chatIndex)
    if (armedIndex < optionCount) {
      selectAskOption(presentation, question, armedIndex)
    } else if (armedIndex === otherIndex) {
      enterAskOther(presentation, question)
    } else if (armedIndex === submitIndex) {
      submitAsk(presentation)
    } else {
      chatWithAskContext(presentation)
    }
    return true
  }

  const handleDecisionInput = (claim: OwnerClaim, intent: TuiIntent): boolean => {
    if (claim.owner !== "decision") return false
    const presentation = presentingDecision()
    if (presentation === null) return true
    const lease = leases.lease(presentation.id)
    if (lease === undefined) return true
    if (presentation.fact.kind === "ask")
      return handleAskInput({ id: presentation.id, fact: presentation.fact, disclosure: presentation.disclosure }, intent)

    const rows = decisionRows(presentation.fact)
    if (intent.kind === "back") {
      leases.dispatch(presentation.id, { kind: "collapse" })
      decisionCursor = firstDecisionCursor(presentation.fact)
      changed = true
      return true
    }
    if (intent.kind === "navigate" || intent.kind === "wheel") {
      const delta = intent.direction === "up" ? -1 : 1
      const armed = Math.min(Math.max(0, (decisionCursor.armedIndex ?? 0) + delta), rows - 1)
      decisionCursor = { ...decisionCursor, armedIndex: armed }
      changed = true
      return true
    }
    if (intent.kind !== "activate" || decisionCursor.armedIndex === null) return true
    const option = presentation.fact.fact.options[decisionCursor.armedIndex]
    if (option === undefined) return true
    resolveDecision(presentation, {
      kind: "resolve-approval",
      request: presentation.fact.fact.request,
      value: { optionId: option.optionId },
    })
    return true
  }

  /**
   * Walk the traversal ring: composer → panels → composer.
   * Tab and the Alt arrows walk it; a panel hop resets the page
   * (focusChild). Adjudication freezes the ring under
   * modals and the reader, so this only ever runs on the free stage.
   */
  const ringFocus = (direction: "prev" | "next"): boolean => {
    const panelIds = children.entryIds()
    const focusedId = children.focused()?.childSessionId ?? null
    const current = focusedId === null ? 0 : 1 + panelIds.indexOf(focusedId)
    const size = 1 + panelIds.length
    const next = (current + (direction === "next" ? 1 : size - 1)) % size
    return children.focusChild(next === 0 ? null : panelIds[next - 1]!)
  }

  const handleOwnerInput = (claim: OwnerClaim, intent: TuiIntent): boolean => {
    if (claim.owner === "decision") return handleDecisionInput(claim, intent)
    switch (claim.owner) {
      case "quit": {
        const ctrlD = intent.kind === "input" && intent.event.type === "ctrl" && intent.event.value === "d"
        if (ctrlD) {
          if (gestureHint?.kind === "ctrl-d-exit" && Date.now() <= gestureHint.deadline) {
            clearGestureHint()
            queueHintArmed = false
            changed = true
            emitExitDisplacement()
            emit({ kind: "exit" })
            return true
          }
          // Ctrl+D is a distinct confirmation key: a Ctrl+C arm never
          // authorizes it, and the first press has no business effects.
          clearGestureHint()
          queueHintArmed = false
          armGestureHint("ctrl-d-exit")
          return true
        }
        if (intent.kind === "interrupt") {
          // A modal stage swallows the press outright: no run kill, no
          // queue cancel, no exit arm while a card holds the input.
          if (taskOpen() || presentingDecision() !== null) return true
          const focusedChild = children.focused()
          if (focusedChild !== null && !reader.open) {
            if (focusedChild.status === "running") {
              emit({ kind: "cancel-child", target: { childId: focusedChild.childSessionId } })
            }
            // A terminal panel swallows the press: its cancel affordance is gone.
            return true
          }
          if (pendingRuns.length > 0) {
            emit({ kind: "interrupt", target: "current-run" })
            return true
          }
          // The idle queue branch: cancelable rows park the press here.
          // Entering the branch retires any armed exit window; the
          // first press arms the cancel hint, each later press takes
          // the seq-oldest row. Below the floor the branch never
          // engages and the exit arm keeps the press.
          if (!belowFloor() && cancelableQueueRows().length > 0) {
            clearGestureHint()
            if (!queueHintArmed) {
              queueHintArmed = true
              changed = true
              return true
            }
            cancelOldestQueued()
            return true
          }
        }
        // A lone idle Ctrl+C arms the confirm window and only the second
        // press inside it exits. Queued prompts leave by receipt first.
        if (intent.kind !== "interrupt" || (gestureHint?.kind === "exit" && Date.now() <= gestureHint.deadline)) {
          clearGestureHint()
          queueHintArmed = false
          changed = true
          emitExitDisplacement()
          emit({ kind: "exit" })
          return true
        }
        armGestureHint("exit")
        return true
      }
      case "permission-cycle":
        performRotation()
        return true
      case "reader":
        if (intent.kind === "tool-details") {
          toggleReader()
          return true
        }
        if (!reader.open) return false
        if (intent.kind === "back") {
          closeReader()
          return true
        }
        if (intent.kind === "navigate" || intent.kind === "wheel") {
          if (reader.pager.move(intent.direction)) changed = true
          return true
        }
        return false
      case "focus-cycle": {
        if (intent.kind !== "focus-cycle" && intent.kind !== "advance") return false
        const direction: "prev" | "next" = intent.kind === "advance" ? "next" : intent.direction
        const peers = tasks.peers()
        if (peers.length >= 2 && !taskOpen()) {
          const current = peers.indexOf(tasks.activePeer())
          const offset = direction === "next" ? 1 : -1
          tasks.switchPeer(peers[(current + offset + peers.length) % peers.length]!)
          changed = true
          return true
        }
        if (ringFocus(direction)) changed = true
        return true
      }
      case "panel": {
        if (intent.kind === "back") {
          if (children.clearFocus()) changed = true
          return true
        }
        if (intent.kind === "navigate" || intent.kind === "wheel") {
          const direction =
            intent.direction === "up" || intent.direction === "page-up"
              ? "up"
              : intent.direction === "down" || intent.direction === "page-down"
                ? "down"
                : null
          if (direction !== null && children.pagePanel(direction)) changed = true
          return true
        }
        return true
      }
      case "companion": {
        // The draft palette: the picker owns dismissal and selection. A
        // command commit crosses the editor's own submit gate — the
        // verdict is read before any state moves, so a refusal leaves
        // the palette, the draft and the arms exactly as they were. A
        // mention commit only writes the token; the Enter that accepted
        // a file row suspends the send for one gesture, Tab never does.
        if (intent.kind === "back" || intent.kind === "navigate") {
          const outcome = picker.dispatch(intent)
          if (outcome !== undefined && outcome.kind === "handled" && outcome.changed) changed = true
          return true
        }
        if (intent.kind === "advance" || intent.kind === "activate") {
          if (intent.kind === "activate" && paletteContext?.kind === "command") {
            const binding = submitBinding()
            const verdict = executionGate({
              binding,
              current: binding,
              enabled: editor.text.trim().length > 0,
              armed: arms.isArmed(binding),
              written: barrier.eligible(binding),
            })
            if (verdict.execute) {
              arms.consume(binding)
              const outcome = picker.dispatch(intent)
              if (outcome?.kind === "commit" && insertPaletteCandidate(outcome.insertText, outcome.replaceRange, outcome.expected, false)) {
                performSubmission()
              }
            }
            return true
          }
          const outcome = picker.dispatch(intent)
          if (outcome === undefined) return true
          if (outcome.kind === "commit") {
            insertPaletteCandidate(outcome.insertText, outcome.replaceRange, outcome.expected, intent.kind === "activate")
          } else if (outcome.changed) changed = true
          return true
        }
        return false
      }
      case "task":
        if (intent.kind === "back") {
          const outcome = tasks.back()
          changed = true
          if (outcome.status === "dirty-guard") notice("unsaved changes — discard explicitly")
          else if (outcome.status === "dismissed") receiveDelivery(outcome.delivery)
          return true
        }
        dispatchTaskIntent(intent)
        return true
      case "viewport": {
        if (viewportModel === null) return true
        const capacity = transcriptCapacity()
        const next =
          intent.kind === "wheel"
            ? intent.direction === "up"
              ? viewportWheelUp(viewport, viewportModel, capacity)
              : viewportWheelDown(viewport, viewportModel, capacity)
            : intent.kind === "navigate" && intent.direction === "page-up"
              ? viewportPageUp(viewport, viewportModel, capacity)
              : intent.kind === "navigate" && intent.direction === "page-down"
                ? viewportPageDown(viewport, viewportModel, capacity)
                : viewport
        if (next !== viewport) {
          viewport = next
          changed = true
        }
        return true
      }
      case "resting":
        if (intent.kind === "back") return true
        return true
      case "editor":
        if (intent.kind === "prompt-history") {
          tasks.open("prompt-history", {})
          changed = true
          return true
        }
        if (intent.kind === "activate") {
          // Enter on an empty resting draft is the pending-decision
          // gesture: the chooser opens when hidden work waits and no
          // other surface holds the stage.
          if (
            editor.text.trim().length === 0 &&
            !belowFloor() &&
            !taskOpen() &&
            presentingDecision() === null &&
            pendingDecisionRows().length > 0
          ) {
            openChooserTask()
            return true
          }
          const binding = submitBinding()
          const verdict = executionGate({
            binding,
            current: binding,
            enabled: editor.text.trim().length > 0,
            armed: arms.isArmed(binding),
            written: barrier.eligible(binding),
          })
          if (verdict.execute) {
            arms.consume(binding)
            performSubmission()
          }
          return true
        }
        // The editor's own outcome is the change signal: caret-only and
        // mode-only edits leave the text untouched but must still bump
        // the frame, or the cached snapshot hides the moved caret. Any
        // real edit clears the send suspension; a text edit revives a
        // closed palette, while a caret move only re-ranks one that is
        // already open — an accepted or dismissed palette stays down
        // until the draft itself changes.
        const paletteLive = picker.isVisible()
        const draftBefore = editor.text
        const outcome = editor.dispatch(intent)
        if (outcome !== undefined) {
          sendArmSuspended = false
          changed = true
          if (editor.text !== draftBefore || paletteLive) syncPalette()
        }
        return true
    }
  }

  const switchSession = (origin: SessionOrigin): void => {
    clearGestureHint()
    if (sessionOrigin !== null) {
      const outcome = drafts.save(sessionOrigin.sessionId, editor.text)
      if (outcome.overflow !== null)
        notice(`draft storage full (${outcome.overflow.bytes}/${outcome.overflow.budget} bytes); drafts kept in memory`)
    }
    // The adopted lineage owns a fresh history; the viewport follows it from the first push.
    viewport = FOLLOW_VIEWPORT
    viewportSourceIds = []
    viewportModel = null
    sessionContent = null
    // The adoption also ends an open resume invocation: its rows would
    // name bindings the card can no longer adopt.
    for (const delivery of tasks.invalidate((ruling) => ruling.scope === "session" || ruling.kind === "resume")) receiveDelivery(delivery)
    const pausedTasks = tasks.pause((ruling) => ruling.kind === "theme" || ruling.kind === "diff")
    if (pausedTasks.paused.length > 0) notice(`${pausedTasks.paused.length} task(s) paused for the session switch`)
    for (const delivery of pausedTasks.deliveries) receiveDelivery(delivery)
    runQueue.interrupt()
    clearAllAskState()
    decisionFacts = new Map<string, DecisionFact>()
    leases.reset()
    receipts.supersede()
    // Pending permission submissions die with the abandoned lineage;
    // their late results fail the origin check above. Confirmed
    // sessions survive — the disclosure fact is per process.
    desk.clearTransient()
    // Queued mailbox rows carry the abandoned lineage; the new lineage
    // mirrors its own on its next projection push. The seq counter
    // keeps counting so late-re-ingested seeds still order after the
    // clear. Session-scoped query caches die with their binding;
    // workspace and client entries survive the switch.
    clearQueueState()
    mirror.invalidateScopes(origin)
    sessionOrigin = origin
    // Degrade is lineage-scoped: adoption re-reads the host mirror
    // instead of inheriting the abandoned session's io health, so a
    // clean switch recovers while a degraded lineage's mid-replay
    // event still holds.
    degraded = ports.io?.().degraded ?? false
    const incomingDraft = drafts.load(origin.sessionId)
    // The first adoption of the process keeps type-ahead already seeded
    // into the editor — with no stored draft the seed IS the user's
    // draft. Every later adoption loads its stored draft as before.
    if (incomingDraft.length > 0 || hasAdoptedBinding) resetEditor(incomingDraft)
    hasAdoptedBinding = true
    changed = true
  }

  /**
   * A failed switch abandoned the live binding: the kernel holds a
   * sessionless state — the draft survives in storage, every session
   * face closes or pauses, and the run seam refuses until a later
   * resume adopts a binding again.
   */
  const detach = (origin: SessionOrigin): void => {
    drafts.save(origin.sessionId, editor.text)
    sessionOrigin = null
    sessionContent = null
    detailedTranscriptCache = null
    viewport = FOLLOW_VIEWPORT
    viewportSourceIds = []
    viewportModel = null
    for (const delivery of tasks.invalidate((ruling) => ruling.scope === "session" || ruling.kind === "resume")) receiveDelivery(delivery)
    const pausedTasks = tasks.pause((ruling) => ruling.kind === "theme" || ruling.kind === "diff")
    if (pausedTasks.paused.length > 0) notice(`${pausedTasks.paused.length} task(s) paused`)
    for (const delivery of pausedTasks.deliveries) receiveDelivery(delivery)
    runQueue.interrupt()
    clearAllAskState()
    decisionFacts = new Map<string, DecisionFact>()
    leases.reset()
    receipts.supersede()
    desk.clearTransient()
    clearQueueState()
    // No live binding: every session-scoped query cache entry dies.
    mirror.invalidateScopes(null)
    degraded = ports.io?.().degraded ?? false
    pendingRuns = []
    clearGestureHint()
    reconcileRunSlot()
    changed = true
  }

  const handleOperationResult = (input: Extract<TuiInput, { kind: "operation-result" }>): void => {
    const settlement = ledger.settle(input.operationId, input.origin)
    if (!settlement.accepted) return
    // A converged result must also still belong to the live world: a
    // session result from a superseded binding and a workspace result
    // from another workspace arrive too late to move anything.
    if (
      input.origin.scope === "session" &&
      (sessionOrigin === null || input.origin.sessionId !== sessionOrigin.sessionId || input.origin.generation !== sessionOrigin.generation)
    )
      return
    if (input.origin.scope === "workspace" && ports.sessionFacts().workspaceId !== input.origin.workspaceId) return
    const outcome = input.outcome
    switch (outcome.op) {
      case "theme-commit":
        if (outcome.status === "confirmed") notice("theme saved")
        else if (outcome.status === "failed-before-replace") notice("theme change failed")
        else notice("theme change uncertain — it may have applied")
        return
      case "rewind":
        if (outcome.status === "ok") {
          resetEditor(outcome.restoredDraft)
          notice("rewound — draft restored")
        } else notice("rewind failed")
        return
      case "resume":
        if (outcome.status === "attached") notice("session attached")
        else notice(`Could not resume session: ${outcome.sessionId}`)
        return
      case "cancel-queued": {
        queueEntries.delete(outcome.inputId)
        changed = true
        // A displacement settle names a world already left: the row is
        // gone and nothing else lands.
        if (displacementOps.delete(input.operationId)) return
        if (outcome.status === "already-delivered") notice(`queued prompt already delivered (${outcome.inputId})`)
        return
      }
      case "permission": {
        const settled = desk.settle(input.operationId, outcome.status)
        if (outcome.status === "applied" && settled?.target === "mode" && settled.origin === "confirm") {
          // The disclosure held: record the fact for this session's
          // process lifetime, then close the card (and the card it was
          // opened above) with the confirmed outcome. The under-confirm
          // ticket is captured first — the confirm delivery's own
          // receive clears the field before the second completion runs.
          const underConfirm = permissionsTicketUnderConfirm
          if (sessionOrigin !== null) desk.markConfirmed(sessionOrigin.sessionId)
          notice("full access confirmed")
          if (confirmTicket !== null) {
            const delivery = tasks.complete(confirmTicket, { confirmed: true })
            if (delivery !== null) receiveDelivery(delivery)
          }
          if (underConfirm !== null) {
            const delivery = tasks.complete(underConfirm, { kind: "closed" })
            if (delivery !== null) receiveDelivery(delivery)
          }
          return
        }
        if (outcome.status === "applied" && settled?.target === "mode" && settled.origin === "mode-row") {
          notice("permission applied")
          if (permissionsTicket !== null) {
            const delivery = tasks.complete(permissionsTicket, { kind: "closed" })
            if (delivery !== null) receiveDelivery(delivery)
          }
          return
        }
        notice(
          outcome.status === "applied"
            ? "permission applied"
            : outcome.status === "stale"
              ? "permission change was stale"
              : "permission change failed",
        )
        return
      }
      case "add-dir":
        if (outcome.status === "error") notice(`add-dir failed: ${outcome.message}`)
        else if (outcome.changed) notice(`directory added: ${outcome.canonical}`)
        else notice(`already in session scope: ${outcome.canonical}`)
        return
      case "submit":
        if (outcome.status === "accepted") {
          if (receipts.accept(outcome.inputId) !== null) changed = true
        } else if (receipts.reject() !== null) {
          notice("submission rejected")
          changed = true
        }
        return
    }
  }

  const handleSessionView = (input: Extract<TuiInput, { kind: "session-view" }>): void => {
    if (
      sessionOrigin === null ||
      input.origin.sessionId !== sessionOrigin.sessionId ||
      input.origin.generation !== sessionOrigin.generation
    ) {
      switchSession(input.origin)
    }
    pendingRuns = input.content.pending
    if (input.content.pending.length > 0) {
      if (gestureHint?.kind !== "ctrl-d-exit") clearGestureHint()
      // A run back in flight re-routes the next Ctrl+C through the
      // run-interrupt leg; the queue hint's premise is gone.
      queueHintArmed = false
    }
    const readerAnchor = reader.open ? reader.pager.anchorRow() : null
    const readerFollowedTail =
      reader.open && readerAnchor !== null && readerAnchor + reader.pager.pageLines().length >= readerLines().length
    // The viewport model folds once per push; a history whose head
    // moved backwards (truncation, replace) resumes following because
    // its anchors now point at different content.
    const ids = [...input.content.transcript.map((block) => block.sourceId)]
    const seen = new Set(ids)
    for (const tail of input.liveTail) {
      if (!seen.has(tail.sourceId)) {
        ids.push(tail.sourceId)
        seen.add(tail.sourceId)
      }
    }
    if (viewportResetByContent(viewportSourceIds, ids)) viewport = FOLLOW_VIEWPORT
    viewportSourceIds = ids
    sessionContent = { content: input.content, tail: input.liveTail }
    viewportModel = lineCache.modelFor(input.content, input.liveTail, layout.columns, input.changes)
    viewport = resolveViewport(viewport, viewportModel)
    if (reader.open) {
      const document = readerDocument()
      const pager = pagerKit.createPager(document.rows, readerHeight())
      if (readerFollowedTail) {
        pager.restoreRow(Math.max(0, (pager.pageCount - 1) * readerHeight()))
      } else if (readerAnchor !== null) {
        pager.restoreRow(readerAnchor)
      }
      reader = { open: true, pager, runs: document.runs }
    }
    changed = true
    reconcileRunSlot()
  }

  const handleDecisionRaise = (input: Extract<TuiInput, { kind: "decision" }>): void => {
    const id = input.fact.fact.request.id
    const previousFact = decisionFacts.get(id)
    const before = leases.lease(id)
    decisionFacts.set(id, input.fact)
    leases.raise(input.fact)
    const after = leases.lease(id)
    if (after === undefined) return
    if (before !== undefined && before.disclosure !== after.disclosure) clearAskState(id, previousFact)
    if (after.state === "presenting" && before !== undefined && before.disclosure !== after.disclosure) {
      // The presenting content truly changed: the new disclosure must
      // be reviewed before any settle. The binding's epoch rides the
      // disclosure, so the write barrier forces the re-disclosed frame
      // out before Enter re-arms — that is the review.
      leases.dispatch(id, { kind: "review" })
      decisionCursor = firstDecisionCursor(input.fact)
    }
    if (presentingDecision() === null && after.state === "hidden-pending" && !after.everPresented) {
      leases.dispatch(id, { kind: "open" })
      decisionCursor = firstDecisionCursor(input.fact)
    }
    changed = true
  }

  const handleDecisionStatus = (input: Extract<TuiInput, { kind: "decision-status" }>): void => {
    const id = input.request.id
    const lease = leases.lease(id)
    if (lease === undefined) return
    if (input.event === "authority-confirmed") {
      if (lease.state === "presenting") {
        if (needsReview(lease)) leases.dispatch(id, { kind: "review" })
        leases.dispatch(id, { kind: "settle" })
        leases.dispatch(id, { kind: "authority-confirmed" })
      } else if (lease.state === "resolving") {
        leases.dispatch(id, { kind: "authority-confirmed" })
      } else if (lease.state === "hidden-pending") {
        // Answered elsewhere before it ever presented: compose the
        // whole lifecycle to the terminal state. No resolve command
        // leaves — the authority already settled it.
        leases.dispatch(id, { kind: "open" })
        leases.dispatch(id, { kind: "settle" })
        leases.dispatch(id, { kind: "authority-confirmed" })
      }
    } else if (input.event === "authority-retracted") {
      leases.dispatch(id, { kind: "authority-retracted" })
    } else if (input.event === "reconcile-still-pending") {
      leases.dispatch(id, { kind: "reconcile", read: "still-pending" })
    } else {
      leases.dispatch(id, { kind: "reconcile", read: "undecidable" })
    }
    const after = leases.lease(id)
    if (after?.state === "resolved" || after?.state === "retracted") clearAskState(id, decisionFacts.get(id))
    if (leases.lease(id) !== lease) {
      autoOpenNextDecision()
      changed = true
    }
  }

  return {
    dispatch(input: TuiInput) {
      if (disposed) return
      pendingCommands = []
      switch (input.kind) {
        case "key-intent": {
          const intent = input.intent
          const ctrlD = intent.kind === "input" && intent.event.type === "ctrl" && intent.event.value === "d"
          // Ctrl+C and Ctrl+D are independent same-key gestures. Any
          // cross-key press retires only the Ctrl+D arm before routing.
          if (intent.kind === "interrupt" && gestureHint?.kind === "ctrl-d-exit") clearGestureHint()
          if (gestureHint?.kind === "ctrl-d-exit" && !ctrlD && intent.kind !== "interrupt") clearGestureHint()
          // The one dismissal rule: any key but Ctrl+C clears a live
          // exit window or queue hint — ahead of adjudication. Ctrl+D
          // keeps its own arm until another key or its deadline.
          if (intent.kind !== "interrupt" && !ctrlD && intent.kind !== "back" && (gestureHint !== null || queueHintArmed)) {
            clearGestureHint()
            queueHintArmed = false
          }
          const rootEscape =
            intent.kind === "back" &&
            !taskOpen() &&
            presentingDecision() === null &&
            !reader.open &&
            children.focused() === null &&
            !companionFace().open &&
            !belowFloor()
          if (!ctrlD && (intent.kind === "back" ? !rootEscape : intent.kind !== "interrupt" || gestureHint?.kind !== "exit")) {
            clearGestureHint()
          }
          if (rootEscape) {
            // Esc is a non-Ctrl+C gesture. It replaces the queue cancel
            // arm before it may show its own one-shot hint.
            if (queueHintArmed) {
              queueHintArmed = false
              changed = true
            }
            if (pendingRuns.length > 0) {
              // OpenClaude's running-state Escape interrupts the current
              // execution and leaves the user's composer draft untouched.
              clearGestureHint()
              emit({ kind: "interrupt", target: "current-run" })
              break
            }
            const now = Date.now()
            if (gestureHint?.kind.startsWith("escape-") && now <= gestureHint.deadline) {
              clearGestureHint()
              if (editor.text.length > 0) {
                const cleared = editor.text
                if (cleared.trim().length > 0) emit({ kind: "remember-prompt", text: cleared })
                editor.clearDraft()
                sendArmSuspended = false
                syncPalette()
                changed = true
              } else {
                handleRouting({ kind: "task", open: { task: "rewind" } })
              }
              break
            }
            if (!companionFace().open) armGestureHint(editor.text.length > 0 ? "escape-clear" : "escape-rewind", now)
          }
          maintainArms()
          const resolution = resolveIntent(intent, world())
          if ("unhandled" in resolution) break
          handleOwnerInput(resolution, intent)
          break
        }
        case "host-event": {
          if (input.event.type === "resize") {
            if (input.event.columns === layout.columns && input.event.rows === layout.rows) break
            layout = { columns: input.event.columns, rows: input.event.rows }
            if (sessionContent !== null) viewportModel = lineCache.modelFor(sessionContent.content, sessionContent.tail, layout.columns)
            if (reader.open) {
              const anchor = reader.pager.anchorRow()
              const document = readerDocument()
              reader = { open: true, pager: pagerKit.createPager(document.rows, readerHeight()), runs: document.runs }
              reader.pager.restoreRow(anchor)
            }
            // A resize that crosses under the floor strands the task's
            // parked exit lever — the fallback routes keys to the composer.
            if (belowFloor()) {
              taskActionsFocused = false
            }
            changed = true
            break
          }
          if (input.event.type === "degraded") {
            if (input.event.value === degraded) break
            degraded = input.event.value
            if (degraded) {
              runQueue.interrupt()
              notice("io degraded — session commands refused until recovery")
            } else {
              notice("io recovered")
            }
            break
          }
          if (input.event.type === "session-detached") {
            // Host generations are monotonic: an event at or past the
            // held binding detaches (the at-past case covers the
            // overlapping-switch window the kernel never adopted); an
            // older one names a binding already left behind.
            if (sessionOrigin === null || input.event.generation < sessionOrigin.generation) break
            detach(sessionOrigin)
            break
          }
          if (input.event.type === "permission-mode" && input.event.value !== permissionMode) {
            permissionMode = input.event.value
            changed = true
          }
          break
        }
        case "operation-result":
          handleOperationResult(input)
          break
        case "session-view":
          handleSessionView(input)
          break
        case "mirror":
          // Queue and plan facts ride every projection push: the store
          // records the source, and only a true row change in the
          // kernel's upsert mints a revision.
          if (input.fact.source === "queue") {
            mirror.ingest(input.fact)
            if (upsertMirrorQueue(input.fact.rows)) changed = true
          } else if (input.fact.source === "plan") {
            mirror.ingest(input.fact)
            if (upsertMirrorPlans(input.fact.rows)) changed = true
          } else if (mirror.ingest(input.fact)) changed = true
          // The listing answered a still-open auto-pick card: one row
          // picks itself, none dismisses the card, several stay the
          // user's choice.
          if (input.fact.source === "resume-sessions" && input.fact.requestId === RESUME_QUERY_ID && resumeAutoPick) {
            resumeAutoPick = false
            if (input.fact.rows.length === 1 && resumeTicket !== null) {
              const delivery = tasks.complete(resumeTicket, { kind: "picked", sessionId: input.fact.rows[0]!.sessionId })
              if (delivery !== null) receiveDelivery(delivery)
              submitResume(input.fact.rows[0]!.sessionId)
            } else if (input.fact.rows.length === 0) {
              const delivery = resumeTicket === null ? null : tasks.dismiss(resumeTicket)
              if (delivery !== null) receiveDelivery(delivery)
              notice("no sessions to resume")
            }
          }
          break
        case "decision":
          if (gestureHint?.kind !== "ctrl-d-exit") clearGestureHint()
          handleDecisionRaise(input)
          break
        case "decision-status":
          handleDecisionStatus(input)
          break
        case "children":
          if (children.ingest(input.fact)) changed = true
          break
        case "command-failed":
          // A refused cancel leaves its row retryable: the mark comes
          // off so the gesture can take the row again.
          if (input.command === "cancel-queued") {
            for (const [id, entry] of queueEntries) {
              if (entry.cancelling) queueEntries.set(id, { ...entry, cancelling: false })
            }
          }
          notice(`command failed: ${input.message}`)
          break
      }
      commit()
      const commands = pendingCommands
      pendingCommands = []
      for (const command of commands) commandHandler?.(command)
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onCommand(handler) {
      commandHandler = handler
    },
    written(frameRevision) {
      barrier.written(frameRevision)
    },
    dispose() {
      disposed = true
      clearGestureHint()
      clearAllAskState()
      if (noticeTimer !== null) clearTimeout(noticeTimer)
      noticeTimer = null
      noticeGeneration += 1
      listeners.clear()
      pendingCommands = []
      commandHandler = undefined
    },
    adoptTypeAhead(text: string): void {
      if (text.length === 0) return
      editor.dispatch({ kind: "paste", text })
      sendArmSuspended = false
      syncPalette()
      changed = true
      commit()
    },
  }
}
