/**
 * Runtime ingress and the projection pump built on it. The ingress maps
 * public session events directly onto the session projection writer —
 * the Ink stack's kernel — and the few facts that are host-level
 * concerns (approval requests, context usage) return to the caller. The
 * mapping is deliberately narrow: the projection consumes text rows,
 * tool lifecycle applies, run finalize, and the transient stream kinds;
 * every other public event is noise for this surface and drops here.
 * The ingress is stateful in exactly the places the transcript needs:
 * run start timestamps for duration rows, shell-run discrimination for
 * finalize skipping, tool inputs parsed back out of their
 * server-rendered form, the last assistant text per run (the public
 * stream carries the run terminal without one), the mailbox mirror of
 * still-queued inputs (the host's queued preview), and the plan mirror
 * of latest plan summaries (the host's plan rows). The pump rides on
 * top: one bounded feed from the live session projection into the
 * kernel's session-view input, gated by a single watermark alone.
 */
import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicTransientEvent } from "@ag2cli/app-server-protocol/dto/transient.js"
import type { PublicInputSnapshot, PublicPlanSummary } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type {
  PublicApprovalOption,
  PublicAskUserInteraction,
  PublicToolApprovalInteraction,
} from "@ag2cli/app-server-protocol/dto/interactions.js"
import type { SessionOrigin, TuiInput, TuiPlanRow, TuiQueueRow } from "../ui/tui/kernel/index.js"
import type {
  SessionProjectionWriter,
  TuiSessionProjection,
  ToolDiff,
  ToolDiffHunk,
  ToolDiffLine,
} from "../ui/tui/sessionprojection/index.js"
import { formatDuration } from "../ui/tui/text/index.js"

/**
 * One ask-card question row as the hooks receive it: identity is
 * optional because the public interaction surface carries it on every
 * row or none (the host's fact mapping fills index fallbacks).
 */
export interface TuiAskQuestion {
  readonly questionId?: string
  readonly question: string
  readonly header?: string
  readonly multiSelect?: boolean
  readonly options: readonly { readonly optionId?: string; readonly label: string; readonly description?: string }[]
}

/** Terminal vocabulary of one delegated child, as the sink records it. */
export type ChildAgentStatus = "running" | "completed" | "failed" | "cancelled"

/** One live spawn fact as the runner's transient stream carries it. */
export interface ChildSpawnFact {
  readonly childSessionId: string
  /** Omitted when only lineage binds (a spawn handle or durable task record): keep the entry's description. */
  readonly description?: string
  readonly subagentType?: string
  readonly toolUseId?: string
}

/** One durable replay fact as the parent's agent tool_use block carries it. */
export interface ChildToolUseFact {
  readonly description?: string
  readonly subagentType?: string
}

/** One terminal fact: the tool result's outcome for a delegation. */
export interface ChildFinalizeFact {
  readonly childSessionId?: string
  readonly toolUseId?: string
  readonly status: ChildAgentStatus
  readonly summary?: string
}

/**
 * The delegation-fact write side the ingress feeds. Narrow on purpose:
 * the facts ride to the kernel's children board verbatim, so the
 * shapes stay the session projection's own vocabulary.
 */
export interface ChildAgentsSink {
  applySpawn(fact: ChildSpawnFact): void
  applyToolUse(toolUseId: string, fact: ChildToolUseFact): void
  appendLine(childSessionId: string, text: string): void
  finalize(fact: ChildFinalizeFact): void
  reset(): void
}

/** Legacy fallback for a run that produced no displayable text. */
const EMPTY_RESPONSE_FALLBACK = "(the model returned no displayable text)"

/** Agent ask-card prompt excerpt: character budget across the emitted excerpt lines. */
export const AGENT_ASK_PROMPT_MAX_CHARS = 600

/** Agent ask-card prompt excerpt: maximum excerpt lines (each is one card body row). */
const AGENT_ASK_PROMPT_MAX_LINES = 5

/**
 * Truncation marker for the agent prompt excerpt, PREFIXED to the last
 * rendered line: card rows are clipped at the tail, so an end-appended
 * marker would be lost on any line near the frame width while a
 * start-placed one survives at every supported width.
 */
const AGENT_ASK_TRUNCATION_PREFIX = "… "

/** Summary line when the spawn input carries no prompt at all. */
const AGENT_ASK_NO_PROMPT_LINE = "(no prompt in the request)"

/**
 * Closed denial-code vocabulary. The public stream carries codes as
 * plain strings; the Recently denied list only collects converged
 * denials, so an unknown code is not one and drops.
 */
const PERMISSION_DENIAL_CODES: readonly string[] = [
  "stale_policy",
  "approval_required",
  "denied_by_rule",
  "plan_mode_rejected",
  "unknown_tool_or_input",
  "outside_workspace",
  "user_denied",
  "guardian_denied",
]

/**
 * Prompt excerpt as separate summary lines — one per logical line,
 * whitespace-normalized (card rows flatten embedded whitespace, so the
 * split happens here) — within the character and line budgets. Any
 * dropped content prefixes the marker to the last emitted line.
 */
function agentPromptExcerptLines(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [AGENT_ASK_NO_PROMPT_LINE]
  const logical = raw
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0)
  const lines: string[] = []
  let budget = AGENT_ASK_PROMPT_MAX_CHARS
  let truncated = false
  for (const line of logical) {
    if (lines.length >= AGENT_ASK_PROMPT_MAX_LINES || budget <= 0) {
      truncated = true
      break
    }
    const take = line.slice(0, budget)
    if (take.length < line.length) truncated = true
    lines.push(take)
    budget -= take.length
  }
  if (!truncated) return lines
  const last = lines.length - 1
  lines[last] = `${AGENT_ASK_TRUNCATION_PREFIX}${lines[last]!}`
  return lines
}

/** Approval card summary lines: the tool input's primary argument. */
export function approvalSummaryLines(input: unknown, toolName: string): string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return []
  const record = input as Record<string, unknown>
  // web_fetch approvals bind a URL string under a redirect-following
  // transport; the card must say what the approval does and does not cover.
  // The gate is the tool name, so a stray other key in the input can never
  // displace the disclosure lines.
  if (toolName === "web_fetch") {
    const url = record.url
    if (typeof url !== "string" || url.length === 0) return []
    return [
      url,
      "may follow up to 5 redirects (redirect targets are policy-checked, not per-hop approved)",
      "the approval binds the URL string, not content — later fetches of the same URL may differ",
    ]
  }
  // A delegation ask binds the whole model-authored spawn input; the
  // summary lines are the only pre-decision disclosure surface, so the
  // agent branch renders the description, the resolved profile, and a
  // bounded prompt excerpt — always at least one line.
  if (toolName === "agent") {
    const description = typeof record.description === "string" ? record.description.replace(/\s+/gu, " ").trim() : ""
    const profile = [record.subagent_type, record.model]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim())
    return [
      ...(description.length > 0 ? [description] : []),
      ...(profile.length > 0 ? [profile.join(" · ")] : []),
      ...agentPromptExcerptLines(record.prompt),
    ]
  }
  for (const key of ["path", "command", "pattern", "url"]) {
    const value = record[key]
    if (typeof value !== "string" || value.length === 0) continue
    return [value]
  }
  return []
}

/** Approval card summary lines from the interaction subject, when no tool input was tracked. */
export function subjectSummaryLines(subject: PublicToolApprovalInteraction["subject"]): string[] {
  if (subject.type !== "tool_call") return [subject.command]
  const primary = subject.command ?? subject.path ?? subject.pattern ?? subject.url
  const lines = [primary ?? subject.summary]
  if (subject.agentProfile !== undefined) {
    lines.push([subject.agentProfile.subagentType, subject.agentProfile.model].filter(Boolean).join(" · "))
  }
  if (subject.inputExcerpt !== undefined && subject.inputExcerpt.length > 0) lines.push(...agentPromptExcerptLines(subject.inputExcerpt))
  return lines
}

/**
 * Ask card question table from the public ask_user interaction: the
 * derived per-question and per-option ids ride along so the card's
 * answer effect can carry the canonical id-keyed rows.
 */
export function askCardQuestionsFromInteraction(interaction: PublicAskUserInteraction): readonly TuiAskQuestion[] {
  return interaction.questions.map((question) => ({
    questionId: question.questionId,
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    multiSelect: question.multiSelect,
    options: question.options.map((option) => ({
      optionId: option.optionId,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
  }))
}

/** Placeholder text the public projection substitutes for non-text model content. */
const PLACEHOLDER_BLOCK = /^unsupported content block: \w+$/

/**
 * Host-level facts the projection must not own: a live approval request
 * (the embedded session's approval port settles it), a live ask_user
 * request and its canonical resolution echo (the ask port resolves it
 * through the public interaction surface), footer context usage
 * (run-terminal telemetry that has no durable block to ride), and
 * converged tool denials (the Recently denied list accumulates them
 * from both live events and history replay).
 */
export type TuiIngressFact =
  | {
      readonly kind: "approval-request"
      readonly requestId: string
      readonly version: number
      readonly toolName: string
      readonly summary: readonly string[]
      readonly options: readonly PublicApprovalOption[]
      /** Resolve credentials for the composition's approval port: the interaction identity plus the CAS revisions. */
      readonly resolve: {
        readonly interactionId: string
        readonly policyRevision: number
        readonly scopeRevision: number
      }
    }
  | {
      readonly kind: "ask-request"
      readonly requestId: string
      /** Question table keyed by the interaction's derived question and option ids. */
      readonly questions: readonly TuiAskQuestion[]
    }
  | {
      /** The canonical echo (any outcome, any client) — an open card never outlives its interaction. */
      readonly kind: "ask-resolved"
      readonly requestId: string
    }
  | {
      readonly kind: "context-usage"
      readonly model?: string
      readonly contextTokens?: number
      readonly contextEstimated?: boolean
    }
  | {
      readonly kind: "tool-denial"
      readonly toolCallId: string
      readonly name: string
      readonly code: string
      readonly reason?: string
    }

export interface TuiIngressOptions {
  /** The session projection's writer half; the read facade stays with the host. */
  readonly writer: SessionProjectionWriter
  /**
   * Replay mode: historical events re-render transcript state only. A
   * replayed approval request flips its tool block to waiting instead of
   * raising a live approval card.
   */
  readonly replay?: boolean
  /**
   * Delegation-fact sink: spawn facts, the attributed child stream's
   * visible lines, and the agent tool's terminals route into it here.
   * Absent, those facts drop as before.
   */
  readonly agents?: ChildAgentsSink
}

export interface TuiIngress {
  transient(event: PublicTransientEvent): void
  /** Apply one public durable event; the returned facts are for the host, not the projection. */
  durable(event: PublicSessionEvent): readonly TuiIngressFact[]
  /** Switch replay rendering on/off; tracked state survives the switch. */
  setReplayMode(replay: boolean): void
  /**
   * Seed the mailbox mirror from the snapshot's input list (the
   * queued-status entries, in the snapshot's acceptedAt order); the
   * event stream keeps it live and full-history replay re-derives the
   * same set idempotently.
   */
  seedMailbox(inputs: readonly PublicInputSnapshot[]): void
  /** Mailbox inputs still queued, in acceptance order; the host mirrors them as the queued preview. */
  mailboxQueued(): readonly PublicInputSnapshot[]
  /**
   * Seed the plan mirror from the snapshot's active plan: every prior
   * row clears first (the snapshot names one plan, not a patch), and
   * the backlog replay re-derives rows idempotently afterwards.
   */
  seedPlans(plan: PublicPlanSummary | undefined): void
  /** Plan summaries in first-appearance order, latest state per plan id; the host mirrors them as plan rows. */
  planSummaries(): readonly PublicPlanSummary[]
  /** Drop ingress state before replaying a complete public snapshot. */
  reset(): void
  /**
   * Drop ingress state AND the projection (the transport-resync
   * rebuild: the writer's watermark and source ids reset so a full
   * backlog replay re-derives every row, and the agents panel empties
   * so the replay re-grows exactly the active timeline's delegations).
   */
  resetProjection(): void
}

function elapsedMs(startedAt: string | undefined, endedAt: string): number | undefined {
  if (startedAt === undefined) return undefined
  const value = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function runDuration(startedAt: string | undefined, endedAt: string): string {
  const duration = elapsedMs(startedAt, endedAt)
  return duration === undefined ? "unknown duration" : formatDuration(duration)
}

function runStatusText(label: string, turns: number, startedAt: string | undefined, endedAt: string): string {
  const duration = runDuration(startedAt, endedAt)
  return `${label} · ${turns} turn${turns === 1 ? "" : "s"} · ${duration}`
}

type RunKind = "model" | "shell"

const MAX_PENDING_INPUTS = 256
const MAX_PENDING_INPUTS_PER_RUN = 32
const MAX_TERMINAL_RUNS = 512

/** Shell identity is the exact TUI prompt grammar: only a leading bang counts. */
function shellCommandFromText(text: string): string | null {
  return text.startsWith("!") ? text.slice(1).trim() : null
}

export interface ParsedNotification {
  readonly status: "completed" | "failed" | "cancelled"
  readonly identity: string
  readonly turns: number
}

const NOTIFICATION_MARKER = /^<task-notification status="(finished|failed|cancelled)">\n(.+)\n<\/task-notification>$/s
const NOTIFICATION_HEADLINE = /^(.+) (completed|failed|cancelled) after (\d+) turns$/

/** Display facts from one task-notification marker; malformed text returns undefined. */
export function parseNotificationText(text: string): ParsedNotification | undefined {
  const marker = NOTIFICATION_MARKER.exec(text)
  if (marker === null) return undefined
  const rawStatus = marker[1]
  if (rawStatus !== "finished" && rawStatus !== "failed" && rawStatus !== "cancelled") return undefined
  const headline = NOTIFICATION_HEADLINE.exec(marker[2]!.split("\n")[0] ?? "")
  if (headline === null) return undefined
  return {
    status: rawStatus === "finished" ? "completed" : rawStatus,
    identity: headline[1]!,
    turns: Number(headline[3]),
  }
}

/**
 * One queued-mailbox row's preview: a notification reads as a task
 * headline; prompts keep their raw text. Null means the row is not part
 * of the preview.
 */
export function mailboxPreviewRow(input: PublicInputSnapshot): TuiQueueRow | null {
  if (input.kind === "steer") return null
  if (input.kind === "notification") {
    const parsed = parseNotificationText(input.text)
    return {
      inputId: input.inputId,
      kind: "notification",
      text: `task · ${parsed === undefined ? "background agent notification" : `${parsed.identity} ${parsed.status} after ${parsed.turns} turns`}`,
    }
  }
  return { inputId: input.inputId, kind: "prompt", text: input.text }
}

/**
 * One plan's chrome row mapped from the public summary: the step
 * detail and update stamp stay behind because the chrome paints only
 * the one-line progress row.
 */
export function planPreviewRow(plan: PublicPlanSummary): TuiPlanRow {
  return {
    planId: plan.planId,
    ...(plan.title === undefined ? {} : { title: plan.title }),
    status: plan.status,
    completedSteps: plan.completedSteps,
    totalSteps: plan.totalSteps,
  }
}

function shellDisplayText(text: string): string | null {
  const command = shellCommandFromText(text)
  if (command === null) return null
  return command.length === 0 ? "! " : `! ${command}`
}

/** The agent tool's cancelled terminal content; the panel maps it to its cancelled status. */
const CHILD_AGENT_CANCELLED_RESULT = "child agent cancelled"

/** Delegation facts a spawn input keeps: its description and profile. */
function agentDelegationFact(input: unknown): ChildToolUseFact {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {}
  const record = input as Record<string, unknown>
  const description = typeof record.description === "string" ? record.description : undefined
  const subagentType = typeof record.subagent_type === "string" ? record.subagent_type : undefined
  return {
    ...(description === undefined ? {} : { description }),
    ...(subagentType === undefined ? {} : { subagentType }),
  }
}

/**
 * The public stream carries tool inputs as the server-rendered JSON
 * document; the kernel derives block titles (and the approval card's
 * disclosure) from the parsed object, so the ingress parses it back.
 */
function parseRenderedToolInput(rendered: string | undefined): unknown {
  if (rendered === undefined) return undefined
  try {
    return JSON.parse(rendered)
  } catch {
    return undefined
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/

/**
 * The public diff is a rendered unified-diff string; the writer wants
 * hunks. The renderer's own format is deterministic, so the parse is a
 * faithful inverse; malformed text preserves counts without inventing hunks.
 */
function parseDiffPatch(patch: string, additions: number, deletions: number, sites: number, truncated?: boolean): ToolDiff | undefined {
  const counts = {
    addedLines: additions,
    removedLines: deletions,
    sites,
    ...(truncated === undefined ? {} : { truncated }),
  }
  const hunks: ToolDiffHunk[] = []
  let current: { oldStart: number; newStart: number; oldLines: number; newLines: number; lines: ToolDiffLine[] } | null = null
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      if (current !== null) hunks.push(current)
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      continue
    }
    if (current === null) return { hunks: [], ...counts, previewAvailable: false }
    if (line.startsWith("+")) current.lines.push({ kind: "added", text: line.slice(1) })
    else if (line.startsWith("-")) current.lines.push({ kind: "removed", text: line.slice(1) })
    else if (line.startsWith(" ")) current.lines.push({ kind: "context", text: line.slice(1) })
    else return { hunks: [], ...counts, previewAvailable: false }
  }
  if (current !== null) hunks.push(current)
  if (hunks.length === 0) return { hunks: [], ...counts, previewAvailable: false }
  return { hunks, ...counts }
}

/** Build the ingress for one embedded session. */
export function createTuiIngress(options: TuiIngressOptions): TuiIngress {
  const writer = options.writer
  const agents = options.agents
  const runStartedAt = new Map<string, string>()
  const shellRuns = new Set<string>()
  const runKinds = new Map<string, RunKind>()
  const pendingInputs = new Map<string, { readonly input: PublicInputSnapshot; readonly revision: number }[]>()
  let pendingInputCount = 0
  const terminalRuns = new Set<string>()
  const terminalRunOrder: string[] = []
  // Tool-call ledger: names and parsed inputs arrive with the requested
  // upsert keyed by toolCallId and are spent at each tool's terminal
  // fact. A run that dies mid-flight never sends those facts, so the
  // run index ties every mint to its run and finishRun spends the
  // whole run's entries.
  const toolNames = new Map<string, string>()
  const toolInputs = new Map<string, unknown>()
  const runTools = new Map<string, string[]>()
  // Delegations the panel tracks, spent the same way: a tool result is
  // the delegation's terminal fact (or the handle that detaches the
  // child from its run), so only a stranded id survives to a run
  // terminal.
  const agentTools = new Set<string>()
  // The public stream's run terminal carries no final text: the last
  // assistant message per run stands in for it at finalize.
  const runAssistantText = new Map<string, string>()
  // Open tool approvals by interaction id: resolutions name the
  // interaction only, so the tool call to flip is remembered here.
  const openApprovals = new Map<
    string,
    { readonly runId: string; readonly turn: number; readonly toolCallId: string; readonly toolName: string }
  >()
  // Live-raised asks by interaction id: only a live request can raise a
  // card, so only its resolution echo retracts one.
  const openAsks = new Set<string>()
  // Mailbox mirror: every input's acceptance parks it here in acceptance
  // order and the first terminal update (consumed, cancelled, failed)
  // removes it, so the set always answers "what is still queued" — the
  // host's queued-preview source. Insertion order is the acceptedAt
  // FIFO; a full-history replay re-derives the same set.
  const mailbox = new Map<string, PublicInputSnapshot>()
  // Plan mirror: one entry per plan id, latest summary overwriting in
  // place. Terminal statuses stay rendered as they arrived — a plan's
  // own lifecycle ends its row, nothing else removes it.
  const plans = new Map<string, PublicPlanSummary>()
  let replay = options.replay === true
  // Delivery dedup: the transport may re-deliver already-adopted events
  // (subscription overlap backfill). One core event fans out to at most
  // two public events SHARING a revision, so the watermark alone cannot
  // dedup; the current revision's event ids disambiguate the fanout.
  let lastRevision = 0
  let currentRevisionIds = new Set<string>()
  // Writer-revision mint: applies driven by one public event share its
  // revision, and same-revision siblings apply in stream order, so
  // every apply takes a deterministic fractional step above its event
  // revision (never reaching the successor).
  let mintBaseRevision = 0
  let mintCount = 0

  const nextRevision = (revision: number): number => {
    if (revision !== mintBaseRevision) {
      mintBaseRevision = revision
      mintCount = 0
    }
    mintCount += 1
    return mintCount === 1 ? revision : revision + mintCount / 1024
  }

  // Terminal run ids are lifecycle facts rather than an LRU cache: evicting
  // one would allow a late start to resurrect a finished shell. The fence is
  // bounded in insertion order (mirroring the projection's closed-shell-run
  // bound): eviction only re-arms against a start delayed past 512 later
  // terminal runs, which durable replay order cannot produce. The set is
  // scoped to this ingress and reset on history/session reset.
  const terminalFence = (runId: string): boolean => terminalRuns.has(runId)

  const discardPendingInputs = (runId: string): void => {
    const pending = pendingInputs.get(runId)
    if (pending !== undefined) pendingInputCount -= pending.length
    pendingInputs.delete(runId)
  }

  const trackRunTool = (runId: string, toolCallId: string): void => {
    const ids = runTools.get(runId)
    if (ids === undefined) runTools.set(runId, [toolCallId])
    else if (!ids.includes(toolCallId)) ids.push(toolCallId)
  }

  // A run that dies mid-flight strands its delegations' panel entries:
  // seal each unspent one here or it runs forever. A detached child
  // spent its id at the handle result and outlives the run for the
  // durable task terminal to seal.
  const settleRunAgentTools = (runId: string, status: "failed" | "cancelled"): void => {
    const tools = runTools.get(runId)
    if (tools === undefined) return
    for (const toolCallId of tools) {
      if (!agentTools.has(toolCallId)) continue
      agents?.finalize({ toolUseId: toolCallId, status })
    }
  }

  const resetEphemeralState = (): void => {
    runStartedAt.clear()
    shellRuns.clear()
    runKinds.clear()
    pendingInputs.clear()
    pendingInputCount = 0
    mailbox.clear()
    plans.clear()
    terminalRuns.clear()
    terminalRunOrder.length = 0
    toolNames.clear()
    toolInputs.clear()
    runTools.clear()
    agentTools.clear()
    runAssistantText.clear()
    openApprovals.clear()
    lastRevision = 0
    currentRevisionIds = new Set()
    mintBaseRevision = 0
    mintCount = 0
  }

  const finishRun = (runId: string): void => {
    // Every terminal event is a durable fence, even when a partial replay did
    // not include the preceding start. Without this, a late run start can
    // resurrect a finished shell row and late tool/input events can append to
    // it. history_reset clears the exact lifecycle ledger.
    runStartedAt.delete(runId)
    shellRuns.delete(runId)
    runKinds.delete(runId)
    discardPendingInputs(runId)
    runAssistantText.delete(runId)
    // The run's tools can no longer send terminal facts; spend their
    // ledger entries so an abandoned run does not park them forever.
    const tools = runTools.get(runId)
    if (tools !== undefined) {
      runTools.delete(runId)
      for (const toolCallId of tools) {
        toolNames.delete(toolCallId)
        toolInputs.delete(toolCallId)
        agentTools.delete(toolCallId)
      }
    }
    if (!terminalRuns.has(runId)) {
      terminalRuns.add(runId)
      terminalRunOrder.push(runId)
      while (terminalRunOrder.length > MAX_TERMINAL_RUNS) {
        const evicted = terminalRunOrder.shift()
        if (evicted !== undefined) terminalRuns.delete(evicted)
      }
    }
  }

  // A consumed notification is a child-completion fact, not a run echo: it
  // renders as a status row regardless of run fences, degrading to a generic
  // line when the marker text does not parse.
  const renderNotification = (input: PublicInputSnapshot, revision: number): void => {
    const parsed = parseNotificationText(input.text)
    writer.applyDurable({
      revision,
      kind: "status",
      body: parsed === undefined ? "background agent notification" : `${parsed.identity} ${parsed.status} after ${parsed.turns} turns`,
      inputId: input.inputId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    })
  }

  const renderInputRow = (input: PublicInputSnapshot, revision: number): void => {
    writer.applyDurable({
      revision,
      kind: "user",
      body: input.text,
      inputId: input.inputId,
      acceptedAt: input.acceptedAt,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    })
  }

  const flushPendingInputs = (runId: string): void => {
    const pending = pendingInputs.get(runId) ?? []
    discardPendingInputs(runId)
    for (const entry of pending) renderInputRow(entry.input, entry.revision)
  }

  const renderRunStart = (runId: string, goal: string, timestamp: string, revision: number): void => {
    if (terminalFence(runId)) return
    runStartedAt.set(runId, timestamp)
    const shellBody = shellDisplayText(goal)
    runKinds.set(runId, shellBody === null ? "model" : "shell")
    writer.applyTransient({ streamId: runId, sequence: 0, kind: "start", goal })
    if (shellBody !== null) {
      shellRuns.add(runId)
      discardPendingInputs(runId)
      writer.applyDurable({ revision, kind: "shell", body: shellBody, runId, shellPhase: "start" })
      return
    }
    shellRuns.delete(runId)
    flushPendingInputs(runId)
  }

  const renderConsumedInput = (input: PublicInputSnapshot, revision: number): void => {
    if (input.kind === "notification") return renderNotification(input, revision)
    const runId = input.runId
    if (runId === undefined) return renderInputRow(input, revision)
    if (terminalFence(runId) || runKinds.get(runId) === "shell") return
    const kind = runKinds.get(runId)
    if (kind === "model") return renderInputRow(input, revision)
    // The run edge may not have arrived yet. Only a leading-bang input
    // is ambiguous enough to wait for the run start so a shell row
    // cannot be echoed as a user row; everything else renders now.
    if (!input.text.startsWith("!")) return renderInputRow(input, revision)
    const pending = pendingInputs.get(runId) ?? []
    // A run start normally follows promptly. The cap protects a
    // malformed/replayed stream from retaining unbounded user payloads while
    // it waits for that discriminator; dropping the ambiguous shell echo is
    // safer than displaying it twice if a shell start eventually arrives.
    if (pending.length >= MAX_PENDING_INPUTS_PER_RUN || pendingInputCount >= MAX_PENDING_INPUTS) return
    pending.push({ input, revision })
    pendingInputCount += 1
    pendingInputs.set(runId, pending)
  }

  /** Footer context-usage fact; omitted entirely when the run carried neither model nor usage. */
  const usageFact = (usage: {
    readonly model?: string
    readonly inputTokens?: number
    readonly estimated?: boolean
  }): readonly TuiIngressFact[] => {
    if (usage.model === undefined && usage.inputTokens === undefined) return []
    return [
      {
        kind: "context-usage" as const,
        ...(usage.model === undefined ? {} : { model: usage.model }),
        ...(usage.inputTokens === undefined ? {} : { contextTokens: usage.inputTokens, contextEstimated: usage.estimated === true }),
      },
    ]
  }

  /** Recently-denied fact from one converged structured denial; unknown codes drop. */
  const toolDenialFact = (
    name: string,
    toolCallId: string,
    denial: { readonly code: string; readonly reason?: string },
  ): readonly TuiIngressFact[] => {
    if (!PERMISSION_DENIAL_CODES.includes(denial.code)) return []
    return [
      {
        kind: "tool-denial" as const,
        toolCallId,
        name,
        code: denial.code,
        ...(denial.reason === undefined ? {} : { reason: denial.reason }),
      },
    ]
  }

  return {
    transient(event) {
      // Child-attributed stream facts feed the agents panel, never the
      // parent transcript: the spawn fact grows the entry, attributed
      // text and tool starts append its visible lines, and the streamed
      // input JSON drops as card noise.
      if (event.kind === "child_agent_started") {
        agents?.applySpawn({
          childSessionId: event.childSessionId,
          description: event.title ?? "",
          ...(event.subagentType === undefined ? {} : { subagentType: event.subagentType }),
          ...(event.toolUseId === undefined ? {} : { toolUseId: event.toolUseId }),
        })
        return
      }
      const childSessionId = "childSessionId" in event ? event.childSessionId : undefined
      if (childSessionId !== undefined) {
        if (event.kind === "model_text_delta") agents?.appendLine(childSessionId, event.text)
        else if (event.kind === "model_tool_call_start") agents?.appendLine(childSessionId, `\n→ ${event.toolName}`)
        return
      }
      // Run-scoped kinds die with their run.
      if (terminalFence(event.runId)) return
      switch (event.kind) {
        case "model_text_delta":
          writer.applyTransient({
            streamId: event.runId,
            sequence: event.sequence,
            kind: "text-delta",
            text: event.text,
            runId: event.runId,
            turn: event.turn,
          })
          return
        case "model_tool_call_start":
          trackRunTool(event.runId, event.toolCallId)
          toolNames.set(event.toolCallId, event.toolName)
          writer.applyTransient({
            streamId: event.runId,
            sequence: event.sequence,
            kind: "tool-start",
            toolUseId: event.toolCallId,
            name: event.toolName,
          })
          return
        case "model_tool_call_delta":
          writer.applyTransient({
            streamId: event.runId,
            sequence: event.sequence,
            kind: "tool-input-delta",
            toolUseId: event.toolCallId,
            text: event.inputDelta,
          })
          return
        case "model_tool_call_end":
          writer.applyTransient({
            streamId: event.runId,
            sequence: event.sequence,
            kind: "tool-end",
            toolUseId: event.toolCallId,
          })
          return
        case "tool_output_delta":
          writer.applyTransient({
            streamId: event.runId,
            sequence: event.sequence,
            kind: "tool-output-delta",
            toolUseId: event.toolCallId,
            text: event.text,
          })
          return
        default:
          return
      }
    },
    setReplayMode(next) {
      replay = next
    },
    seedMailbox(inputs) {
      for (const input of inputs) {
        if (input.status !== "queued" || mailbox.has(input.inputId)) continue
        mailbox.set(input.inputId, input)
      }
    },
    mailboxQueued: () => [...mailbox.values()],
    seedPlans(plan) {
      plans.clear()
      if (plan !== undefined) plans.set(plan.planId, plan)
    },
    planSummaries: () => [...plans.values()],
    reset() {
      resetEphemeralState()
    },
    resetProjection() {
      writer.reset()
      resetEphemeralState()
      // The replay re-grows the panel from the active timeline; entries
      // a rewind deleted must not survive as ghosts beside them.
      agents?.reset()
    },
    durable(event) {
      if (event.revision < lastRevision) return []
      if (event.revision === lastRevision) {
        if (currentRevisionIds.has(event.eventId)) return []
        currentRevisionIds.add(event.eventId)
      } else {
        lastRevision = event.revision
        currentRevisionIds = new Set([event.eventId])
      }
      switch (event.type) {
        case "input.accepted": {
          // Every accepted input parks in the mailbox mirror. Prompts
          // surface through the host's queue preview until consumption
          // renders their user row.
          mailbox.set(event.input.inputId, event.input)
          return []
        }
        case "input.updated": {
          const input = event.input
          if (input.status !== "queued") mailbox.delete(input.inputId)
          if (input.status === "cancelled") {
            writer.applyDurable({
              revision: nextRevision(event.revision),
              kind: "status",
              body: `Cancelled: ${input.text}${input.cancelReason === undefined ? "" : ` (${input.cancelReason})`}`,
              inputId: input.inputId,
            })
            return []
          }
          if (input.status === "consumed") {
            renderConsumedInput(input, nextRevision(event.revision))
          }
          return []
        }
        case "input.failed": {
          mailbox.delete(event.inputId)
          writer.applyDurable({
            revision: nextRevision(event.revision),
            kind: "error",
            body: event.failure.message,
            inputId: event.inputId,
          })
          return []
        }
        case "run.updated": {
          const run = event.run
          if (run.status === "running") {
            renderRunStart(run.runId, run.goal ?? "", run.startedAt, nextRevision(event.revision))
            return []
          }
          const runId = run.runId
          if (terminalFence(runId)) return []
          writer.sealStream(runId, "")
          if (run.status === "completed") {
            if (!shellRuns.has(runId)) {
              const text = runAssistantText.get(runId) ?? ""
              writer.finalizeAssistant({
                runId,
                turn: run.turn,
                text: text.trim().length > 0 ? text : EMPTY_RESPONSE_FALLBACK,
              })
            }
            writer.applyDurable({
              revision: nextRevision(event.revision),
              kind: "status",
              body: runStatusText("done", run.turn, runStartedAt.get(runId), run.completedAt ?? event.timestamp),
              runId,
            })
            const usage = run.usage === undefined ? [] : usageFact(run.usage)
            finishRun(runId)
            return usage
          }
          // The failed/cancelled run never sends terminal tool upserts:
          // abandon its non-terminal tool blocks before the row lands.
          writer.abandonRunTools(runId)
          settleRunAgentTools(runId, run.status === "failed" ? "failed" : "cancelled")
          writer.applyDurable({
            revision: nextRevision(event.revision),
            kind: run.status === "failed" ? "error" : "status",
            // A cancelled run's failure message names whichever seam
            // aborted first ("Request was aborted.", "input cancelled")
            // — an internal artifact, not a user fact; the row names
            // the outcome.
            body: `${run.status === "failed" ? (run.failure?.message ?? "failed") : "cancelled"} · ${runDuration(runStartedAt.get(runId), run.completedAt ?? event.timestamp)}`,
            runId,
          })
          finishRun(runId)
          return []
        }
        case "message.upserted": {
          const message = event.message
          if (message.role !== "assistant") return []
          // The public projection flattens non-text model content into
          // placeholder text; a tool-use turn must not surface that way.
          const text = message.content
            .map((block) => (block.type === "text" && !PLACEHOLDER_BLOCK.test(block.text) ? block.text : ""))
            .join("")
          if (message.runId !== undefined) runAssistantText.set(message.runId, text)
          writer.applyDurable({
            revision: nextRevision(event.revision),
            kind: "assistant",
            body: text,
            ...(message.runId === undefined ? {} : { runId: message.runId }),
            ...(message.turn === undefined ? {} : { turn: message.turn }),
            streaming: false,
            ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
          })
          return []
        }
        case "tool_call.upserted": {
          const toolCall = event.toolCall
          if (terminalFence(toolCall.runId)) return []
          const parsedInput = parseRenderedToolInput(toolCall.input)
          trackRunTool(toolCall.runId, toolCall.toolCallId)
          toolNames.set(toolCall.toolCallId, toolCall.toolName)
          if (parsedInput !== undefined) toolInputs.set(toolCall.toolCallId, parsedInput)
          if (toolCall.toolName === "agent" && toolCall.status !== "denied") {
            agentTools.add(toolCall.toolCallId)
            agents?.applyToolUse(toolCall.toolCallId, agentDelegationFact(parsedInput))
          }
          if (toolCall.status === "requested" || toolCall.status === "running") {
            // A shell run owns its own row shape; the ledger above still
            // tracks the call so the terminal's facts can name it.
            if (!shellRuns.has(toolCall.runId)) {
              writer.applyTool({
                revision: nextRevision(event.revision),
                runId: toolCall.runId,
                turn: toolCall.turn ?? 1,
                toolUseId: toolCall.toolCallId,
                name: toolCall.toolName,
                input: parsedInput,
                status: "running",
                toolStatus: toolCall.status,
                collapsed: true,
                ...(toolCall.startedAt === undefined ? {} : { startedAt: toolCall.startedAt }),
              })
            }
            return []
          }
          if (toolCall.status === "awaiting_approval") return []
          // Terminal: the result is the tool's converged fact; its
          // ledger entries are spent — for a delegation that includes
          // the panel-tracking id, whether the result sealed the entry
          // or detached the child.
          const name = toolCall.toolName
          const denial = toolCall.denial === undefined ? [] : toolDenialFact(name, toolCall.toolCallId, toolCall.denial)
          toolNames.delete(toolCall.toolCallId)
          toolInputs.delete(toolCall.toolCallId)
          if (name === "agent") {
            const childSessionId = toolCall.childSessionId
            // An async spawn's immediate result is the handle, not the
            // child's terminal: bind the lineage only, and let the
            // durable task terminal seal the entry (replay-safe by
            // construction).
            if (
              toolCall.status !== "denied" &&
              toolCall.isError !== true &&
              childSessionId !== undefined &&
              toolCall.childRunId === undefined
            ) {
              agentTools.delete(toolCall.toolCallId)
              agents?.applySpawn({ childSessionId, toolUseId: toolCall.toolCallId })
            } else {
              agentTools.delete(toolCall.toolCallId)
              agents?.finalize({
                ...(childSessionId === undefined ? {} : { childSessionId }),
                toolUseId: toolCall.toolCallId,
                status:
                  toolCall.status === "denied"
                    ? "cancelled"
                    : toolCall.isError === true
                      ? toolCall.result === CHILD_AGENT_CANCELLED_RESULT
                        ? "cancelled"
                        : "failed"
                      : "completed",
                summary: toolCall.result,
              })
            }
          } else {
            agentTools.delete(toolCall.toolCallId)
          }
          if (shellRuns.has(toolCall.runId)) {
            writer.applyDurable({
              revision: nextRevision(event.revision),
              kind: "shell",
              body: toolCall.result ?? "",
              runId: toolCall.runId,
              shellPhase: "result",
            })
            return denial
          }
          const outcome = toolCall.questionOutcome
          writer.applyTool({
            revision: nextRevision(event.revision),
            runId: toolCall.runId,
            turn: toolCall.turn ?? 1,
            toolUseId: toolCall.toolCallId,
            name,
            status: toolCall.status === "failed" ? "error" : toolCall.status === "denied" ? "denied" : "done",
            toolStatus: toolCall.status,
            ...(toolCall.result === undefined ? {} : { result: toolCall.result }),
            ...(outcome === "answered" || outcome === "declined" || outcome === "rejected" ? { questionOutcome: outcome } : {}),
            ...(toolCall.diff === undefined
              ? {}
              : {
                  diff: parseDiffPatch(
                    toolCall.diff.patch,
                    toolCall.diff.additions,
                    toolCall.diff.deletions,
                    toolCall.diff.sites,
                    toolCall.diff.truncated,
                  ),
                }),
          })
          return denial
        }
        case "interaction.requested": {
          const interaction = event.interaction
          if (interaction.kind === "ask_user") {
            // History re-renders only; a card exists solely for a live ask.
            if (replay || terminalFence(interaction.runId)) return []
            openAsks.add(interaction.interactionId)
            return [
              {
                kind: "ask-request" as const,
                requestId: interaction.interactionId,
                questions: askCardQuestionsFromInteraction(interaction),
              },
            ]
          }
          if (interaction.kind !== "tool_approval") return []
          if (terminalFence(interaction.runId)) return []
          const toolName = interaction.subject.type === "tool_call" ? interaction.subject.toolName : interaction.title
          trackRunTool(interaction.runId, interaction.toolCallId)
          toolNames.set(interaction.toolCallId, toolName)
          openApprovals.set(interaction.interactionId, {
            runId: interaction.runId,
            turn: interaction.turn,
            toolCallId: interaction.toolCallId,
            toolName,
          })
          const trackedInput = toolInputs.get(interaction.toolCallId)
          const inputSummary = trackedInput === undefined ? [] : approvalSummaryLines(trackedInput, toolName)
          writer.applyTool({
            revision: nextRevision(event.revision),
            runId: interaction.runId,
            turn: interaction.turn,
            toolUseId: interaction.toolCallId,
            name: toolName,
            input: trackedInput,
            status: "waiting",
            toolStatus: "awaiting_approval",
            collapsed: true,
            startedAt: interaction.createdAt,
          })
          // A guardian-owned ask is settled by the guardian review, never a
          // human card; the waiting block above still applies to both.
          if (replay || interaction.ownedBy === "guardian") return []
          return [
            {
              kind: "approval-request" as const,
              requestId: interaction.interactionId,
              version: event.revision,
              toolName,
              summary: inputSummary.length > 0 ? inputSummary : subjectSummaryLines(interaction.subject),
              options: interaction.options,
              resolve: {
                interactionId: interaction.interactionId,
                policyRevision: interaction.policyRevision,
                scopeRevision: interaction.scopeRevision,
              },
            },
          ]
        }
        case "interaction.resolved": {
          const resolution = event.resolution
          if (resolution.kind === "ask_user") {
            // Every outcome — this client's own answer, another client's,
            // or the expiry sweep — retracts: a card never outlives its
            // interaction.
            if (!openAsks.delete(resolution.interactionId)) return []
            return [{ kind: "ask-resolved" as const, requestId: resolution.interactionId }]
          }
          if (resolution.kind !== "tool_approval") return []
          const open = openApprovals.get(resolution.interactionId)
          openApprovals.delete(resolution.interactionId)
          // An expired card was superseded by a re-request; the successor
          // owns the block from here.
          if (open === undefined || resolution.outcome === "expired") return []
          if (terminalFence(open.runId)) return []
          const toolCallId = open.toolCallId
          writer.applyTool({
            revision: nextRevision(event.revision),
            runId: open.runId,
            turn: open.turn,
            toolUseId: toolCallId,
            name: open.toolName,
            status: resolution.outcome === "denied" ? "denied" : "approved",
            toolStatus: resolution.outcome === "denied" ? "denied" : "requested",
            ...(resolution.outcome === "denied" ? { result: "tool call denied" } : {}),
          })
          if (resolution.outcome !== "denied") return []
          // The denial precedes execution: the delegation never spawns,
          // so its panel entry seals here or runs forever.
          if (agentTools.delete(toolCallId)) {
            agents?.finalize({ toolUseId: toolCallId, status: "cancelled" })
          }
          toolNames.delete(toolCallId)
          toolInputs.delete(toolCallId)
          // The code mirrors the runtime terminal: system forces denials
          // under stale policy, a guardian denial is its own terminal.
          const attribution = resolution.resolver
          const code = attribution === "guardian" ? "guardian_denied" : attribution === "system" ? "stale_policy" : "user_denied"
          return toolDenialFact(open.toolName, toolCallId, { code })
        }
        case "background_task.updated": {
          // The durable task family is the async delegation's lifecycle:
          // a created record grows the panel entry the live spawn fact
          // would have grown (binding the task id as the child session
          // id), and the terminal is the async child's only durable
          // settle. Other task kinds are not delegations and drop here.
          if (event.task.kind !== "agent") return []
          if (event.task.status === "queued" || event.task.status === "running") {
            agents?.applySpawn({ childSessionId: event.task.taskId, description: event.task.title })
            return []
          }
          agents?.finalize({ childSessionId: event.task.taskId, status: event.task.status })
          return []
        }
        case "plan.updated": {
          // The informational plan fact paints one row per plan id: the
          // latest summary overwrites in place, terminal statuses
          // included, and no transcript block rides it.
          plans.set(event.plan.planId, event.plan)
          return []
        }
        default:
          return []
      }
    },
  }
}

export interface TuiProjectionPumpOptions {
  /** Holder getter; null before the first projection lands or after teardown. */
  readonly reader: () => TuiSessionProjection | null
  readonly dispatch: (input: TuiInput) => void
  /** Binding getter; a push without a session origin has nothing truthful to stamp. */
  readonly origin: () => SessionOrigin | null
}

export interface TuiProjectionPump {
  /** Deliver the projection state that moved since the last push, if any. */
  push(): void
  /** Drop the watermark so the next push is a full one. */
  reset(): void
}

export function createTuiProjectionPump(options: TuiProjectionPumpOptions): TuiProjectionPump {
  let watermark: number | null = null

  const fullPush = (reader: TuiSessionProjection, origin: SessionOrigin): void => {
    const content = reader.content()
    options.dispatch({
      kind: "session-view",
      origin,
      content,
      liveTail: reader.liveTail(),
      changes: { sinceRevision: 0, upToRevision: content.projectionRevision, changes: [] },
    })
    watermark = content.projectionRevision
  }

  return {
    push() {
      const reader = options.reader()
      if (reader === null) return
      const origin = options.origin()
      if (origin === null) return
      if (watermark === null) return fullPush(reader, origin)
      const batch = reader.changesSince(watermark)
      // A null batch means the bounded log no longer covers the range:
      // the gap is a wholesale reset, so one full push re-seats the kernel.
      if (batch === null) return fullPush(reader, origin)
      // The revision alone gates the delivery; the change list may be
      // legitimately empty while the revision moved.
      if (batch.upToRevision <= watermark) return
      options.dispatch({
        kind: "session-view",
        origin,
        content: reader.content(),
        liveTail: reader.liveTail(),
        changes: batch,
      })
      watermark = batch.upToRevision
    },
    reset() {
      watermark = null
    },
  }
}
