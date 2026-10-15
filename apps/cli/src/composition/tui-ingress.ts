/**
 * Runtime ingress: canonical core events apply directly onto the session
 * projection writer — the Ink stack's kernel — and the few facts that are
 * host-level concerns (approval requests, context usage) return to the
 * caller. The mapping is deliberately narrow: the projection consumes
 * text rows, tool lifecycle applies, run finalize, and the transient
 * stream kinds; every other canonical event is run-scoped noise for this
 * surface and drops here. The ingress is stateful in exactly the places
 * the transcript needs: run start timestamps for duration rows,
 * shell-run discrimination for finalize skipping, and tool names for
 * late lifecycle applies whose canonical payloads omit them.
 */
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import { PERMISSION_DENIAL_CODES, type PermissionDenialCode, type ToolResultDenial } from "@ag2cli/core/tool-facts.js"
import { createSessionView, type SessionViewEvent } from "@ag2cli/client/session-view.js"
import type { SessionProjectionWriter, ToolDiff } from "../ui/tui/sessionprojection/index.js"
import type { ChildAgentsPanel, ChildToolUseFact } from "../ui/tui/state/index.js"
import { formatDuration } from "../ui/tui/text/index.js"

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

/**
 * Host-level facts the projection must not own: a live approval request
 * (the embedded session's approval port settles it), footer context
 * usage (assistant metadata that has no durable block to ride), and
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
      /** Resolve credentials for the composition's approval port: the runtime matches preparedEventId strictly and the revisions as optimistic-concurrency guards. */
      readonly resolve: {
        readonly runId: string
        readonly turn: number
        readonly preparedEventId: string
        readonly scopeRevision: number
        readonly policyRevision: number
      }
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
      readonly code: PermissionDenialCode
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
   * Child-agents panel: delegation facts route into it here — the spawn
   * fact, the attributed child stream's visible lines, and the agent
   * tool's terminal. Absent, those facts drop as before.
   */
  readonly agents?: ChildAgentsPanel
}

export interface TuiIngress {
  transient(event: TransientStreamEvent): void
  /** Apply one durable event; the returned facts are for the host, not the projection. */
  durable(event: AgentEvent): readonly TuiIngressFact[]
  /** Switch replay rendering on/off; tracked state survives the switch. */
  setReplayMode(replay: boolean): void
  /** Drop ingress state before replaying a complete canonical snapshot. */
  reset(): void
  /**
   * Drop ingress state AND the projection (the transport-resync
   * rebuild: the writer's watermark and source ids reset so a full
   * backlog replay re-derives every row).
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
type SemanticInput = Extract<SessionViewEvent, { readonly type: "input" }>
type PendingSemanticInput = {
  readonly item: SemanticInput
  readonly index: number
  readonly total: number
  readonly source: Pick<AgentEvent, "eventId" | "revision">
}

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

function shellDisplayText(text: string): string | null {
  const command = shellCommandFromText(text)
  if (command === null) return null
  return command.length === 0 ? "! " : `! ${command}`
}

/** The child attribution on the model stream kinds; absent on the parent's own stream. */
function attributedChildSessionId(event: TransientStreamEvent): string | undefined {
  if (
    event.type === "model_text_delta" ||
    event.type === "model_tool_call_start" ||
    event.type === "model_tool_call_delta" ||
    event.type === "model_tool_call_end"
  ) {
    return typeof event.payload.childSessionId === "string" ? event.payload.childSessionId : undefined
  }
  return undefined
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

/** Durable child lineage the agent tool's result metadata carries. */
function metadataChildSessionId(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined
  const value = (metadata as Record<string, unknown>).childSessionId
  return typeof value === "string" ? value : undefined
}

/** Durable lineage the agent tool's result metadata carries for awaited runs; a spawn handle carries no run id. */
function metadataChildRunId(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined
  const value = (metadata as Record<string, unknown>).childRunId
  return typeof value === "string" ? value : undefined
}

/**
 * Recently-denied fact from one converged structured denial. Live
 * in-process events bypass the protocol codec's decode validation, so
 * the closed code vocabulary is enforced here: a result carrying an
 * unknown code is not a converged denial and drops.
 */
function toolDenialFact(name: string, toolCallId: string, denial: ToolResultDenial | undefined): readonly TuiIngressFact[] {
  if (denial === undefined) return []
  if (!(PERMISSION_DENIAL_CODES as readonly string[]).includes(denial.code)) return []
  return [
    {
      kind: "tool-denial" as const,
      toolCallId,
      name,
      code: denial.code,
      ...(typeof denial.reason === "string" ? { reason: denial.reason } : {}),
    },
  ]
}

/** Build the ingress for one embedded session. */
export function createTuiIngress(options: TuiIngressOptions): TuiIngress {
  const writer = options.writer
  const agents = options.agents
  const runStartedAt = new Map<string, string>()
  const shellRuns = new Set<string>()
  const runKinds = new Map<string, RunKind>()
  const pendingInputs = new Map<string, PendingSemanticInput[]>()
  let pendingInputCount = 0
  const terminalRuns = new Set<string>()
  const terminalRunOrder: string[] = []
  // Tool-call ledger: names and inputs arrive across several events keyed
  // by toolUseId and are spent at each tool's terminal fact. A run that
  // dies mid-flight never sends those facts, so the run index ties every
  // mint to its run and finishRun spends the whole run's entries.
  const toolNames = new Map<string, string>()
  const toolInputs = new Map<string, unknown>()
  const runTools = new Map<string, string[]>()
  // Delegations the panel tracks, spent the same way: a tool result is
  // the delegation's terminal fact (or the handle that detaches the
  // child from its run), so only a stranded id survives to a run
  // terminal.
  const agentTools = new Set<string>()
  const sessionView = createSessionView()
  let replay = options.replay === true

  /**
   * One canonical event can fan out to several kernel applies, and the
   * kernel drops applies at or below its shared durable watermark — so
   * fan-out applies carry deterministic fractional sub-revisions
   * (ordered between the event's revision and its successor). Replay of
   * the same event re-derives the same values.
   */
  const subRevision = (
    source: Pick<AgentEvent, "eventId" | "revision"> | Pick<SessionViewEvent, "eventId" | "revision">,
    index: number,
    total: number,
  ): number => (total === 1 ? source.revision : source.revision + (index + 1) / (total + 1))

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

  const trackRunTool = (runId: string, toolUseId: string): void => {
    const ids = runTools.get(runId)
    if (ids === undefined) runTools.set(runId, [toolUseId])
    else if (!ids.includes(toolUseId)) ids.push(toolUseId)
  }

  // A run that dies mid-flight strands its delegations' panel entries:
  // seal each unspent one here or it runs forever. A detached child
  // spent its id at the handle result and outlives the run for the
  // durable task terminal to seal.
  const settleRunAgentTools = (runId: string, status: "failed" | "cancelled"): void => {
    const tools = runTools.get(runId)
    if (tools === undefined) return
    for (const toolUseId of tools) {
      if (!agentTools.has(toolUseId)) continue
      agents?.finalize({ toolUseId, status })
    }
  }

  const resetEphemeralState = (): void => {
    runStartedAt.clear()
    shellRuns.clear()
    runKinds.clear()
    pendingInputs.clear()
    pendingInputCount = 0
    terminalRuns.clear()
    terminalRunOrder.length = 0
    toolNames.clear()
    toolInputs.clear()
    runTools.clear()
    agentTools.clear()
  }

  const finishRun = (runId: string): void => {
    // Every terminal event is a durable fence, even when a partial replay did
    // not include the preceding start. Without this, a late RunStarted can
    // resurrect a finished shell row and late tool/input events can append to
    // it. history_reset clears the exact lifecycle ledger.
    runStartedAt.delete(runId)
    shellRuns.delete(runId)
    runKinds.delete(runId)
    discardPendingInputs(runId)
    // The run's tools can no longer send terminal facts; spend their
    // ledger entries so an abandoned run does not park them forever.
    const tools = runTools.get(runId)
    if (tools !== undefined) {
      runTools.delete(runId)
      for (const toolUseId of tools) {
        toolNames.delete(toolUseId)
        toolInputs.delete(toolUseId)
        agentTools.delete(toolUseId)
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
  const renderNotification = (
    item: SemanticInput,
    index: number,
    total: number,
    source: Pick<AgentEvent, "eventId" | "revision">,
  ): void => {
    const parsed = parseNotificationText(item.text)
    writer.applyDurable({
      revision: subRevision(source, index, total),
      kind: "status",
      body: parsed === undefined ? "background agent notification" : `${parsed.identity} ${parsed.status} after ${parsed.turns} turns`,
      inputId: item.inputId,
      ...(item.runId === undefined ? {} : { runId: String(item.runId) }),
    })
  }

  const renderInputRow = (item: SemanticInput, index: number, total: number, source: Pick<AgentEvent, "eventId" | "revision">): void => {
    writer.applyDurable({
      revision: subRevision(source, index, total),
      kind: "user",
      body: item.text,
      inputId: item.inputId,
      ...(item.runId === undefined ? {} : { runId: String(item.runId) }),
    })
  }

  const flushPendingInputs = (runId: string): void => {
    const pending = pendingInputs.get(runId) ?? []
    discardPendingInputs(runId)
    for (const entry of pending) renderInputRow(entry.item, entry.index, entry.total, entry.source)
  }

  const renderRunStart = (
    runId: string,
    goal: string,
    timestamp: string,
    source: Pick<AgentEvent, "eventId" | "revision">,
    index: number,
    total: number,
  ): void => {
    if (terminalFence(runId)) return
    runStartedAt.set(runId, timestamp)
    const shellBody = shellDisplayText(goal)
    runKinds.set(runId, shellBody === null ? "model" : "shell")
    writer.applyTransient({ streamId: runId, sequence: 0, kind: "start", goal })
    if (shellBody !== null) {
      shellRuns.add(runId)
      discardPendingInputs(runId)
      writer.applyDurable({ revision: subRevision(source, index, total), kind: "shell", body: shellBody, runId, shellPhase: "start" })
      return
    }
    shellRuns.delete(runId)
    flushPendingInputs(runId)
  }

  const renderInput = (item: SemanticInput, index: number, total: number, source: Pick<AgentEvent, "eventId" | "revision">): void => {
    if (item.kind === "notification") return renderNotification(item, index, total, source)
    const runId = item.runId === undefined ? undefined : String(item.runId)
    if (runId === undefined) return renderInputRow(item, index, total, source)
    if (terminalFence(runId) || runKinds.get(runId) === "shell") return
    const kind = runKinds.get(runId)
    if (kind === "model") return renderInputRow(item, index, total, source)
    // Existing live-only/replay feeds may deliver a normal input before the
    // run edge. Preserve that established projection contract; only a
    // leading-bang input is ambiguous enough to wait for RunStarted so a
    // shell row cannot be echoed as a user row.
    if (!item.text.startsWith("!")) return renderInputRow(item, index, total, source)
    const pending = pendingInputs.get(runId) ?? []
    // A canonical RunStarted normally follows promptly. The cap protects a
    // malformed/replayed stream from retaining unbounded user payloads while
    // it waits for that discriminator; dropping the ambiguous shell echo is
    // safer than displaying it twice if a shell start eventually arrives.
    if (pending.length >= MAX_PENDING_INPUTS_PER_RUN || pendingInputCount >= MAX_PENDING_INPUTS) return
    pending.push({ item, index, total, source })
    pendingInputCount += 1
    pendingInputs.set(runId, pending)
  }

  return {
    transient(event) {
      // Child-attributed stream facts feed the agents panel, never the
      // parent transcript: the spawn fact grows the entry, attributed
      // text and tool starts append its visible lines, and the streamed
      // input JSON drops as card noise.
      if (event.type === "child_agent_started") {
        agents?.applySpawn({
          childSessionId: event.payload.childSessionId,
          description: event.payload.description,
          ...(event.payload.subagentType === undefined ? {} : { subagentType: event.payload.subagentType }),
          ...(event.payload.toolUseId === undefined ? {} : { toolUseId: event.payload.toolUseId }),
        })
        return
      }
      const childSessionId = attributedChildSessionId(event)
      if (childSessionId !== undefined) {
        if (event.type === "model_text_delta") agents?.appendLine(childSessionId, event.payload.delta)
        else if (event.type === "model_tool_call_start") agents?.appendLine(childSessionId, `\n→ ${event.payload.name}`)
        return
      }
      // Run-scoped kinds die with their run.
      if ("runId" in event.payload && terminalFence(String(event.payload.runId))) return
      switch (event.type) {
        case "model_text_delta":
          writer.applyTransient({
            streamId: event.payload.runId,
            sequence: event.sequence,
            kind: "text-delta",
            text: event.payload.delta,
            runId: event.payload.runId,
            turn: event.payload.turn,
          })
          return
        case "model_tool_call_start":
          trackRunTool(event.payload.runId, event.payload.toolUseId)
          toolNames.set(event.payload.toolUseId, event.payload.name)
          writer.applyTransient({
            streamId: event.payload.runId,
            sequence: event.sequence,
            kind: "tool-start",
            toolUseId: event.payload.toolUseId,
            name: event.payload.name,
          })
          return
        case "model_tool_call_delta":
          writer.applyTransient({
            streamId: event.payload.runId,
            sequence: event.sequence,
            kind: "tool-input-delta",
            toolUseId: event.payload.toolUseId,
            text: event.payload.delta,
          })
          return
        case "model_tool_call_end":
          writer.applyTransient({
            streamId: event.payload.runId,
            sequence: event.sequence,
            kind: "tool-end",
            toolUseId: event.payload.toolUseId,
            input: event.payload.input,
          })
          return
        case "tool_output_delta":
          writer.applyTransient({
            streamId: event.payload.runId,
            sequence: event.sequence,
            kind: "tool-output-delta",
            toolUseId: event.payload.toolUseId,
            text: event.payload.delta,
          })
          return
        default:
          return
      }
    },
    setReplayMode(next) {
      replay = next
    },
    reset() {
      resetEphemeralState()
      sessionView.reset()
    },
    resetProjection() {
      writer.reset()
      resetEphemeralState()
      sessionView.reset()
    },
    durable(event) {
      const semantic = sessionView.apply(event)
      if (semantic.length > 0) return semantic.flatMap((item, index) => renderSemantic(item, index, semantic.length, event))
      switch (event.type) {
        case "RunStarted": {
          renderRunStart(String(event.payload.runId), event.payload.goal, event.timestamp, event, 0, 1)
          return []
        }
        case "ToolCallRequested": {
          if (terminalFence(String(event.payload.runId))) return []
          // The approval card's summary derives from the tool input, which
          // only this event carries; approvals arrive later by toolUseId.
          trackRunTool(String(event.payload.runId), String(event.payload.toolUseId))
          toolInputs.set(String(event.payload.toolUseId), event.payload.input)
          // A live delegation grows its panel entry before the spawn
          // fact binds the child session id.
          if (event.payload.name === "agent") {
            agentTools.add(String(event.payload.toolUseId))
            agents?.applyToolUse(String(event.payload.toolUseId), agentDelegationFact(event.payload.input))
          }
          return []
        }
        case "ToolApprovalRequested": {
          if (terminalFence(String(event.payload.runId))) return []
          trackRunTool(String(event.payload.runId), event.payload.toolUseId)
          toolNames.set(event.payload.toolUseId, event.payload.name)
          const toolInput = toolInputs.get(String(event.payload.toolUseId))
          writer.applyTool({
            revision: subRevision(event, 0, 1),
            runId: String(event.payload.runId),
            turn: event.payload.turn,
            toolUseId: event.payload.toolUseId,
            name: event.payload.name,
            input: toolInput,
            status: "waiting",
            collapsed: true,
            startedAt: event.timestamp,
          })
          // A guardian-owned ask is settled by the guardian review, never a
          // human card; the waiting block above still applies to both.
          if (replay || event.payload.ownedBy === "guardian") return []
          return [
            {
              kind: "approval-request" as const,
              requestId: event.payload.toolUseId,
              version: event.revision,
              toolName: event.payload.name,
              summary: approvalSummaryLines(toolInput, event.payload.name),
              resolve: {
                runId: String(event.payload.runId),
                turn: event.payload.turn,
                preparedEventId: event.payload.preparedEventId ?? "",
                scopeRevision: event.payload.scopeRevision ?? 0,
                policyRevision: event.payload.policyRevision ?? 0,
              },
            },
          ]
        }
        case "ToolApprovalResolved": {
          if (terminalFence(String(event.payload.runId))) return []
          const decision = event.payload.decision
          const name = toolNames.get(event.payload.toolUseId)
          // The kernel rejects empty names; an unresolved orphan has no
          // block to flip anyway.
          if (name === undefined) return []
          writer.applyTool({
            revision: subRevision(event, 0, 1),
            runId: String(event.payload.runId),
            turn: event.payload.turn,
            toolUseId: event.payload.toolUseId,
            name,
            status: decision,
            ...(decision === "denied" ? { result: "tool call denied" } : {}),
          })
          // A denied resolution is itself a converged terminal: the run
          // may settle without ever committing a tool result, so the
          // denial list must not depend on the result landing. The code
          // mirrors the runtime terminal: system forces denials under
          // stale policy, a guardian denial is its own terminal.
          if (decision !== "denied") return []
          // The denial precedes execution: the delegation never spawns,
          // so its panel entry seals here or runs forever.
          if (agentTools.delete(event.payload.toolUseId)) {
            agents?.finalize({ toolUseId: event.payload.toolUseId, status: "cancelled" })
          }
          toolNames.delete(event.payload.toolUseId)
          toolInputs.delete(event.payload.toolUseId)
          const attribution = event.payload.resolvedBy
          const code = attribution === "guardian" ? "guardian_denied" : attribution === "system" ? "stale_policy" : "user_denied"
          return toolDenialFact(name, event.payload.toolUseId, { code })
        }
        case "RunCompleted": {
          const runId = String(event.payload.runId)
          if (terminalFence(runId)) return []
          // The footer's busy set derives from parked runs: a terminal seals
          // the stream fence BEFORE finalize (the finalize adopt path closes
          // the stream itself, after which sealing can no longer un-park).
          writer.sealStream(runId, "")
          if (!shellRuns.has(runId)) {
            const finalText = event.payload.finalText
            writer.finalizeAssistant({
              runId,
              turn: event.payload.turns,
              text: finalText.trim().length > 0 ? finalText : EMPTY_RESPONSE_FALLBACK,
            })
          }
          writer.applyDurable({
            revision: subRevision(event, 1, 2),
            kind: "status",
            body: runStatusText("done", event.payload.turns, runStartedAt.get(runId), event.timestamp),
            runId,
          })
          finishRun(runId)
          return []
        }
        case "RunFailed": {
          const runId = String(event.payload.runId)
          if (terminalFence(runId)) return []
          writer.sealStream(runId, "")
          // The failed run never sends terminal tool upserts: abandon its
          // non-terminal tool blocks before the error row lands.
          writer.abandonRunTools(runId)
          settleRunAgentTools(runId, "failed")
          writer.applyDurable({
            revision: subRevision(event, 1, 2),
            kind: "error",
            body: `${event.payload.message} · ${runDuration(runStartedAt.get(runId), event.timestamp)}`,
            runId,
          })
          finishRun(runId)
          return []
        }
        case "RunCancelled": {
          const runId = String(event.payload.runId)
          if (terminalFence(runId)) return []
          writer.sealStream(runId, "")
          // The cancelled run never sends terminal tool upserts: abandon
          // its non-terminal tool blocks before the status row lands.
          writer.abandonRunTools(runId)
          settleRunAgentTools(runId, "cancelled")
          writer.applyDurable({
            revision: subRevision(event, 1, 2),
            kind: "status",
            body: `${event.payload.reason ?? "cancelled"} · ${runDuration(runStartedAt.get(runId), event.timestamp)}`,
            runId,
          })
          finishRun(runId)
          return []
        }
        default:
          return []
      }
    },
  }

  function renderSemantic(
    item: SessionViewEvent,
    index: number,
    total: number,
    source: Pick<AgentEvent, "eventId" | "revision">,
  ): readonly TuiIngressFact[] {
    switch (item.type) {
      case "input_queued":
        writer.applyDurable({
          revision: subRevision(source, index, total),
          kind: "status",
          body: `${item.kind === "steer" ? "Steering" : "Queued"}: ${item.text}`,
          inputId: item.inputId,
          ...(item.targetRunId === undefined ? {} : { runId: item.targetRunId }),
        })
        return []
      case "input_cancelled":
        writer.applyDurable({
          revision: subRevision(source, index, total),
          kind: "status",
          body: `Cancelled: ${item.text ?? item.inputId}${item.reason === undefined ? "" : ` (${item.reason})`}`,
          inputId: item.inputId,
        })
        return []
      case "input":
        renderInput(item, index, total, source)
        return []
      case "history_reset": {
        resetEphemeralState()
        writer.reset()
        // The replay re-derives the panel from the surviving events;
        // entries the rewind deletes (and their ledger ids) would
        // otherwise run forever with no terminal left to seal them.
        agents?.reset()
        const replayed = item.events.flatMap((nested) => renderSemantic(nested, 0, 1, nested))
        return replayed
      }
      case "run_started": {
        renderRunStart(item.runId, item.goal, item.timestamp, source, index, total)
        return []
      }
      case "assistant": {
        if (terminalFence(item.runId)) return []
        const text = item.content
          .filter((block): block is Extract<(typeof item.content)[number], { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join("")
        const toolUses = item.content.filter(
          (block): block is (typeof item.content)[number] & { type: "tool_use" } => block.type === "tool_use",
        )
        const usage =
          item.metadata?.usage && typeof item.metadata.usage === "object"
            ? (item.metadata.usage as { inputTokens?: unknown; estimated?: unknown })
            : undefined
        const contextTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : undefined
        writer.applyDurable({
          revision: subRevision(source, 0, toolUses.length + 1),
          kind: "assistant",
          body: text,
          runId: item.runId,
          turn: item.turn,
          streaming: false,
          ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
        })
        toolUses.forEach((block, toolIndex) => {
          trackRunTool(item.runId, block.id)
          toolNames.set(block.id, block.name)
          writer.applyTool({
            revision: subRevision(source, toolIndex + 1, toolUses.length + 1),
            runId: item.runId,
            turn: item.turn,
            toolUseId: block.id,
            name: block.name,
            input: block.input,
            status: "running",
            collapsed: true,
            startedAt: item.timestamp,
          })
          // A committed delegation replays as a running panel entry
          // until its result seals it.
          if (block.name === "agent") {
            agentTools.add(block.id)
            agents?.applyToolUse(block.id, agentDelegationFact(block.input))
          }
        })
        const model = typeof item.metadata?.model === "string" ? item.metadata.model : undefined
        return usageFact(model, contextTokens, usage)
      }
      case "tool_result": {
        if (terminalFence(item.runId)) return []
        const name = toolNames.get(item.toolUseId) ?? "tool"
        const outcome = item.result.metadata?.askUserOutcome
        // A shell run's denied tool result (a refused `!` command or an
        // execute_shell settlement) is as converged as a model tool's:
        // the denial list collects both, so this precedes the shell row.
        const denial = toolDenialFact(name, item.toolUseId, item.result.denial)
        // The result is the tool's terminal fact; its ledger entries are
        // spent — for a delegation that includes the panel-tracking id,
        // whether the result sealed the entry or detached the child.
        toolNames.delete(item.toolUseId)
        toolInputs.delete(item.toolUseId)
        agentTools.delete(item.toolUseId)
        if (name === "agent") {
          const childSessionId = metadataChildSessionId(item.result.metadata)
          // An async spawn's immediate result is the handle, not the
          // child's terminal: bind the lineage only, and let the durable
          // task terminal seal the entry (replay-safe by construction).
          if (item.result.isError !== true && childSessionId !== undefined && metadataChildRunId(item.result.metadata) === undefined) {
            agents?.applySpawn({ childSessionId, toolUseId: item.toolUseId })
          } else {
            // The awaited delegation's terminal: the result content is
            // the child's summary, its metadata the durable child lineage.
            agents?.finalize({
              ...(childSessionId === undefined ? {} : { childSessionId }),
              toolUseId: item.toolUseId,
              status:
                item.result.isError === true
                  ? item.result.content === CHILD_AGENT_CANCELLED_RESULT
                    ? "cancelled"
                    : "failed"
                  : "completed",
              summary: item.result.content,
            })
          }
        }
        if (shellRuns.has(item.runId)) {
          writer.applyDurable({
            revision: subRevision(source, index, total),
            kind: "shell",
            body: item.result.content,
            runId: item.runId,
            shellPhase: "result",
          })
          return denial
        }
        writer.applyTool({
          revision: subRevision(source, index, total),
          runId: item.runId,
          turn: item.turn,
          toolUseId: item.toolUseId,
          name,
          status: item.result.isError === true ? "error" : "done",
          result: item.result.content,
          ...(outcome === "answered" || outcome === "declined" || outcome === "rejected" ? { questionOutcome: outcome } : {}),
          // Display channel: the structured patch rides the upsert; the
          // projection whitelists it at ingress.
          ...(item.result.appliedPatch === undefined ? {} : { diff: item.result.appliedPatch as ToolDiff }),
        })
        return denial
      }
      case "run_terminal": {
        const runId = item.runId
        if (terminalFence(runId)) return []
        writer.sealStream(runId, "")
        if (item.status === "completed") {
          if (!shellRuns.has(runId)) {
            const text = item.text ?? ""
            writer.finalizeAssistant({
              runId,
              turn: item.turns,
              text: text.trim().length > 0 ? text : EMPTY_RESPONSE_FALLBACK,
            })
          }
          writer.applyDurable({
            revision: subRevision(source, 1, 2),
            kind: "status",
            body: runStatusText("done", item.turns, runStartedAt.get(runId), item.timestamp),
            runId,
          })
          finishRun(runId)
          return []
        }
        // The failed/cancelled run never sends terminal tool upserts:
        // abandon its non-terminal tool blocks before the row lands.
        writer.abandonRunTools(runId)
        settleRunAgentTools(runId, item.status === "failed" ? "failed" : "cancelled")
        writer.applyDurable({
          revision: subRevision(source, 1, 2),
          kind: item.status === "failed" ? "error" : "status",
          body: `${item.error ?? item.reason ?? "cancelled"} · ${runDuration(runStartedAt.get(runId), item.timestamp)}`,
          runId,
        })
        finishRun(runId)
        return []
      }
      // The durable task family is the async delegation's lifecycle: a
      // created record grows the panel entry the live spawn fact would
      // have grown (binding the task id as the child session id), and
      // the terminal is the async child's only durable settle — the
      // handle result carries lineage, never the outcome. Other task
      // families are not delegations and drop here.
      case "background_task_created": {
        if (item.taskType !== "agent") return []
        agents?.applySpawn({ childSessionId: item.taskId, description: item.title })
        return []
      }
      case "background_task_terminal": {
        if (item.taskType !== "agent") return []
        agents?.finalize({
          childSessionId: item.taskId,
          status: item.status,
          ...(item.status === "failed" && item.message !== undefined ? { summary: item.message } : {}),
          ...(item.status === "cancelled" && item.reason !== undefined ? { summary: item.reason } : {}),
        })
        return []
      }
    }
  }
}

/** Footer context-usage fact; omitted entirely when the turn carried neither model nor usage. */
function usageFact(
  model: string | undefined,
  contextTokens: number | undefined,
  usage: { readonly estimated?: unknown } | undefined,
): readonly TuiIngressFact[] {
  if (model === undefined && contextTokens === undefined) return []
  return [
    {
      kind: "context-usage" as const,
      ...(model === undefined ? {} : { model }),
      ...(contextTokens === undefined ? {} : { contextTokens, contextEstimated: usage?.estimated === true }),
    },
  ]
}
