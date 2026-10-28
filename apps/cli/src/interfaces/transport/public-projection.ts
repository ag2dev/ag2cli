import type { AgentEvent, AgentEventType } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import type { ContentBlock } from "@ag2cli/core/message.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import type { StructuredPatch } from "@ag2cli/core/tool-facts.js"
import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicTransientEvent } from "@ag2cli/app-server-protocol/dto/transient.js"
import type {
  PublicContentBlock,
  PublicFailure,
  PublicInputKind,
  PublicInputSnapshot,
  PublicMessage,
  PublicPermissionModeValue,
  PublicRunPhase,
  PublicRunSnapshot,
  PublicRunUsage,
  PublicSessionSnapshot,
  PublicSessionStatus,
  PublicTaskSummary,
  PublicToolCall,
  PublicToolDenial,
  PublicToolDiff,
} from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type {
  PublicAskUserInteraction,
  PublicPendingInteraction,
  PublicToolApprovalInteraction,
} from "@ag2cli/app-server-protocol/dto/interactions.js"
import { isShellToolUseId } from "@ag2cli/runtime/application/execution/execute-shell.js"
import { askOptionId, askQuestionId } from "./interaction-identity.js"

/**
 * Projection from canonical session facts to the public wire DTOs. The
 * projector consumes the ACTIVE lineage of a session (rewind/branch selection
 * happens upstream, same as the internal snapshot rebuild) and turns one core
 * event into at most one public event — the single sanctioned exception is
 * InputAccepted, which also carries the full user text as a message.upserted
 * with the derived id `message:{inputId}` so replay clients can rebuild the
 * conversation from the message stream alone. Internal-only
 * facts (writer epochs, hash chains, traces, fingerprints, provider
 * metadata, security preparation records) never enter any output: every
 * public object is constructed field by field, never cloned from the event.
 */

/** Core event types that never surface on the public stream. */
export const NOT_PUBLISHED_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  "SessionCreated",
  "CommandAccepted",
  "RunStopRequested",
  "RunRetryRequested",
  "ModelAttemptStarted",
  "ModelAttemptAbandoned",
  "ModelRetryScheduled",
  "ToolCallPrepared",
  "ToolAttemptStarted",
  "ToolAttemptAbandoned",
  "HeadMoved",
  "BranchCreated",
  "ForkRequested",
  "ForkCompleted",
  "ForkRejected",
  "SessionCheckpointCreated",
  "PlanGenerationFailed",
  "PlanGenerationCancelled",
  "ContextCompacted",
  "SessionContextCompacted",
  "SessionContextWindowSet",
  "SessionContextWindowCleared",
  "SessionAgentSelected",
  "SessionGoalUpdated",
  "BackgroundTaskOutputAppended",
])

const TEXT_PREVIEW_LIMIT = 200
const DEFAULT_RECENT_MESSAGES = 20
const DEFAULT_TERMINATED_INPUT_HISTORY = 20

/** Hard caps on projector-internal history so a long-lived instance cannot grow unbounded. */
const MAX_TRACKED_MESSAGES = 1_000
const MAX_TRACKED_TERMINATED_INPUTS = 256
const MAX_TRACKED_FINISHED_TOOL_CALLS = 512
const MAX_TRACKED_RUNS = 128
const MAX_TRACKED_TASKS = 256

function preview(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim().slice(0, TEXT_PREVIEW_LIMIT)
}

function publicContentBlocks(content: readonly ContentBlock[]): PublicContentBlock[] {
  return content.map((block) =>
    block.type === "text"
      ? { type: "text" as const, text: block.text }
      : { type: "text" as const, text: `unsupported content block: ${block.type}` },
  )
}

function commandFromToolInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const command = (input as { command?: unknown }).command
  return typeof command === "string" && command.length > 0 ? command : undefined
}

function stringFact(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Title from the tool input's own description, whitespace-normalized. */
function toolTitleFromInput(input: unknown): string | undefined {
  const description = stringFact(input, "description")
  if (description === undefined) return undefined
  const title = description.replaceAll(/\s+/g, " ").trim()
  return title.length > 0 ? title : undefined
}

const UNSERIALIZABLE_TOOL_INPUT = "[unserializable tool input]"

/** Server-rendered input document; unserializable payloads never throw. */
function renderToolInput(input: unknown): string {
  try {
    const rendered = JSON.stringify(input, null, 2)
    return rendered === undefined ? UNSERIALIZABLE_TOOL_INPUT : rendered
  } catch {
    return UNSERIALIZABLE_TOOL_INPUT
  }
}

interface ApprovalSubjectFacts {
  readonly path?: string
  readonly pattern?: string
  readonly url?: string
  readonly agentProfile?: { readonly subagentType: string; readonly model?: string }
  readonly inputExcerpt?: string
}

/** Subject extension facts derived from the same tool input the TUI renders. */
function approvalSubjectFacts(input: unknown): ApprovalSubjectFacts {
  const path = stringFact(input, "path")
  const pattern = stringFact(input, "pattern")
  const url = stringFact(input, "url")
  const subagentType = stringFact(input, "subagent_type")
  const model = stringFact(input, "model")
  const prompt = stringFact(input, "prompt")
  const excerpt = prompt === undefined ? undefined : prompt.replaceAll(/\s+/g, " ").trim().slice(0, 600)
  return {
    ...(path === undefined ? {} : { path }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(url === undefined ? {} : { url }),
    ...(subagentType === undefined ? {} : { agentProfile: { subagentType, ...(model === undefined ? {} : { model }) } }),
    ...(excerpt === undefined || excerpt.length === 0 ? {} : { inputExcerpt: excerpt }),
  }
}

/** Unified-diff rendering of the structured patch a tool committed. */
function publicDiff(patch: StructuredPatch): PublicToolDiff {
  return {
    additions: patch.addedLines,
    deletions: patch.removedLines,
    sites: patch.sites,
    ...(patch.truncated === undefined ? {} : { truncated: patch.truncated }),
    patch: patch.hunks
      .map((hunk) =>
        [
          `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
          ...hunk.lines.map((line) => `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.text}`),
        ].join("\n"),
      )
      .join("\n"),
  }
}

/** Host-level facts the projector cannot derive from the event stream. */
export interface ProjectionContext {
  readonly title?: string
  readonly workspace: {
    readonly workspaceId: string
    readonly displayName: string
    readonly availability: "available" | "unavailable"
  }
  readonly selectableModes: readonly PublicPermissionModeValue[]
  readonly recentMessagesLimit?: number
  readonly inputHistoryLimit?: number
}

type TrackedInputStatus = "queued" | "consumed" | "cancelled"

interface TrackedInput {
  readonly inputId: string
  readonly commandId: string
  readonly kind: PublicInputKind
  status: TrackedInputStatus
  readonly acceptedAt: string
  readonly text: string
  runId?: string
  cancelReason?: string
}

interface TrackedToolCall {
  readonly toolCallId: string
  readonly runId: string
  readonly toolName: string
  title: string
  status: PublicToolCall["status"]
  turn?: number
  startedAt?: string
  completedAt?: string
  interactionId?: string
  resultSummary?: string
  result?: string
  diff?: PublicToolDiff
  denial?: PublicToolDenial
  isError?: boolean
  questionOutcome?: string
  childSessionId?: string
  childRunId?: string
  readonly input?: unknown
}

interface TrackedRun {
  readonly runId: string
  status: PublicRunSnapshot["status"]
  turn: number
  readonly startedAt: string
  completedAt?: string
  goal?: string
  usage?: PublicRunUsage
  lastPhase: PublicRunPhase
  activeToolCallId?: string
  failure?: PublicFailure
}

interface TrackedTask {
  readonly taskId: string
  readonly kind: PublicTaskSummary["kind"]
  title: string
  status: PublicTaskSummary["status"]
  updatedAt: string
}

export class PublicSessionProjector {
  private readonly inputs = new Map<string, TrackedInput>()
  private readonly cancelledBeforeAcceptance = new Set<string>()
  private readonly toolCalls = new Map<string, TrackedToolCall>()
  private readonly runs = new Map<string, TrackedRun>()
  private readonly openInteractions = new Map<string, PublicPendingInteraction>()
  private readonly interactionsByToolUse = new Map<string, string>()
  private readonly tasks = new Map<string, TrackedTask>()
  private messages: PublicMessage[] = []
  private currentRunId?: string
  private lastTimestamp?: string
  private lastRevision = 0
  private lastFailureCode?: string
  private permissionMode: PublicPermissionModeValue = "manual"
  private policyRevision = 0
  private scopeRevision = 0
  private additionalDirectories: string[] = []

  /**
   * Applies one active-lineage core event and returns the public events it
   * produces (0..2). Redelivered or stale revisions (≤ the highest applied)
   * are dropped without touching state, so re-feeding a prefix is a no-op.
   */
  apply(event: AgentEvent, options?: { readonly skipUnmapped?: boolean }): readonly PublicSessionEvent[] {
    if (event.revision <= this.lastRevision) return []
    this.lastRevision = event.revision
    this.lastTimestamp = event.timestamp
    switch (event.type) {
      case "SessionCreated":
        this.permissionMode = event.payload.permissionMode as PublicPermissionModeValue
        this.policyRevision = event.payload.policyRevision
        this.scopeRevision = event.payload.scopeRevision ?? 0
        this.additionalDirectories = [...(event.payload.additionalDirectories ?? [])]
        return []
      case "SessionTitleSet":
        return [this.titleUpdated(event)]
      case "SessionArchived":
        return [this.sessionArchived(event)]
      case "CommandAccepted":
      case "RunStopRequested":
      case "RunRetryRequested":
      case "ModelAttemptStarted":
      case "ModelAttemptAbandoned":
      case "ModelRetryScheduled":
      case "ToolCallPrepared":
      case "ToolAttemptStarted":
      case "ToolAttemptAbandoned":
      case "HeadMoved":
      case "BranchCreated":
      case "ForkRequested":
      case "ForkCompleted":
      case "ForkRejected":
      case "SessionCheckpointCreated":
      case "PlanGenerationFailed":
        this.lastFailureCode = "plan_generation_failed"
        return []
      case "PlanGenerationCancelled":
        this.lastFailureCode = "plan_generation_cancelled"
        return []
      case "ContextCompacted":
      case "SessionContextCompacted":
      case "SessionContextWindowSet":
      case "SessionContextWindowCleared":
      case "SessionAgentSelected":
      case "SessionGoalUpdated":
      case "BackgroundTaskOutputAppended":
        return []
      case "InputAccepted":
        return this.inputAccepted(event)
      case "InputCancellationRequested":
        return this.inputCancelled(event)
      case "InputConsumed":
        return this.inputConsumed(event)
      case "RunStarted":
        return this.runStarted(event)
      case "ModelResponseCommitted":
        return this.modelResponseCommitted(event)
      case "ToolCallRequested":
        return this.toolCallRequested(event)
      case "ToolApprovalRequested":
        return this.approvalRequested(event)
      case "ToolApprovalResolved":
        return this.approvalResolved(event)
      case "AskUserRequested":
        return this.askRequested(event)
      case "AskUserResolved":
        return this.askResolved(event)
      case "ToolCallExecutionStarted":
        return this.toolExecutionStarted(event)
      case "ToolResultCommitted":
        return this.toolResultCommitted(event)
      case "RunCompleted":
        return this.runTerminal(event, "completed", undefined)
      case "RunFailed":
        return this.runFailed(event)
      case "RunCancelled":
        return this.runCancelled(event)
      case "SessionAdditionalDirectoryAdded":
        this.scopeRevision = event.payload.scopeRevision
        this.policyRevision = event.payload.policyRevision
        this.additionalDirectories = [...(event.payload.additionalDirectories ?? this.additionalDirectories)]
        return event.payload.changed ? [this.securityUpdated(event)] : []
      case "SessionPermissionModeSet":
      case "SessionPermissionRulesSet":
        this.policyRevision = event.payload.policyRevision
        if (event.type === "SessionPermissionModeSet") this.permissionMode = event.payload.mode as PublicPermissionModeValue
        return [this.securityUpdated(event)]
      case "PlanCreated":
        return [this.planUpdated(event)]
      case "BackgroundTaskCreated": {
        const task = this.upsertTask(
          event.payload.task.id,
          event.payload.task.type,
          event.payload.task.title,
          event.payload.task.status,
          event.timestamp,
        )
        return task === undefined ? [] : [this.backgroundTaskUpdated(event, task)]
      }
      case "BackgroundTaskStarted":
        return this.backgroundTaskTransition(event, "running")
      case "BackgroundTaskCompleted":
        return this.backgroundTaskTransition(event, event.payload.nextRunAt === undefined ? "completed" : "queued")
      case "BackgroundTaskFailed":
        return this.backgroundTaskTransition(event, "failed")
      case "BackgroundTaskCancelled":
        return this.backgroundTaskTransition(event, "cancelled")
      default: {
        // Live delivery must survive a core event type this projector version
        // does not map; batch callers keep the strict failure.
        if (options?.skipUnmapped) return []
        const exhaustive: never = event
        throw new Error(`unmapped agent event type: ${(exhaustive as AgentEvent).type}`)
      }
    }
  }

  /**
   * Assembles the public snapshot. Session-level status/security/plan facts come from the
   * internal snapshot (same event stream, authoritative reducer); foreground, mailbox,
   * interactions, runs, tasks and messages come from projector state.
   */
  snapshot(internal: SessionSnapshot, context: ProjectionContext): PublicSessionSnapshot {
    const pending = [...this.openInteractions.values()]
    const run = this.currentRunId === undefined ? undefined : this.runs.get(this.currentRunId)
    const runActive = run?.status === "running"
    const activeTool = run?.activeToolCallId === undefined ? undefined : this.toolCalls.get(run.activeToolCallId)

    let foregroundState: "idle" | "running" | "requires_action" = "idle"
    if (pending.length > 0) foregroundState = "requires_action"
    else if (runActive) foregroundState = "running"

    let phase: PublicRunPhase | undefined
    if (runActive) {
      if (pending.some((interaction) => interaction.kind === "tool_approval")) phase = "waiting_for_approval"
      else if (pending.some((interaction) => interaction.kind === "ask_user")) phase = "waiting_for_user"
      else if (activeTool !== undefined) phase = "tool_execution"
      else phase = run?.lastPhase ?? "thinking"
    }

    const inputLimit = context.inputHistoryLimit ?? DEFAULT_TERMINATED_INPUT_HISTORY
    // Queued inputs are never bounded: every accepted input stays visible
    // until it reaches a terminal state; only terminated inputs are bounded.
    const queuedInputs = [...this.inputs.values()].filter((input) => input.status === "queued")
    const terminatedInputs = [...this.inputs.values()].filter((input) => input.status !== "queued").slice(-inputLimit)

    const currentRun =
      run === undefined
        ? undefined
        : {
            runId: run.runId,
            status: run.status,
            turn: Math.max(1, run.turn),
            startedAt: run.startedAt,
            ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
            ...(run.goal === undefined ? {} : { goal: run.goal }),
            phase: phase ?? run.lastPhase,
            ...(activeTool === undefined
              ? {}
              : {
                  activeTool: {
                    toolCallId: activeTool.toolCallId,
                    toolName: activeTool.toolName,
                    title: activeTool.title,
                    ...(activeTool.startedAt === undefined ? {} : { startedAt: activeTool.startedAt }),
                  },
                }),
            ...(run.usage === undefined ? {} : { usage: run.usage }),
            ...(run.failure === undefined ? {} : { failure: run.failure }),
          }

    return {
      sessionId: internal.sessionId,
      asOfRevision: internal.lastRevision,
      status: internal.status as PublicSessionStatus,
      ...(context.title === undefined ? {} : { title: context.title }),
      updatedAt: this.lastTimestamp ?? "1970-01-01T00:00:00.000Z",
      foreground: {
        state: foregroundState,
        ...(foregroundState === "idle" || run === undefined ? {} : { runId: run.runId }),
        ...(phase === undefined ? {} : { phase }),
      },
      workspace: {
        ...context.workspace,
        ...(this.additionalDirectories.length === 0 ? {} : { additionalDirectories: [...this.additionalDirectories] }),
      },
      security: {
        permissionMode: internal.permissionMode as PublicPermissionModeValue,
        policyRevision: internal.policyRevision,
        hasCustomRules: internal.permissionRules.length > 0,
        selectableModes: [...context.selectableModes],
      },
      ...(currentRun === undefined ? {} : { currentRun }),
      inputs: [...queuedInputs, ...terminatedInputs].map(toPublicInput),
      pendingInteractions: pending.map((interaction) => ({ ...interaction })),
      ...(internal.currentPlan === undefined ? {} : { activePlan: planSummary(internal.currentPlan, internal.currentPlan.createdAt) }),
      activeTasks: [...this.tasks.values()]
        .filter((task) => task.status === "queued" || task.status === "running")
        .map((task) => ({ taskId: task.taskId, kind: task.kind, title: task.title, status: task.status, updatedAt: task.updatedAt })),
      recentMessages: recentMessages(context.recentMessagesLimit, this.messages),
      ...(internal.lastError === undefined
        ? {}
        : {
            lastError: {
              code: this.lastFailureCode ?? "run_failed",
              message: internal.lastError,
              retryable: false,
            } satisfies PublicFailure,
          }),
    }
  }

  private envelope(event: AgentEvent) {
    return { eventId: event.eventId, sessionId: event.sessionId, revision: event.revision, timestamp: event.timestamp }
  }

  /** Highest canonical revision applied; 0 before any event. */
  get currentRevision(): number {
    return this.lastRevision
  }

  /** The run currently executing, if any. */
  get activeRunId(): string | undefined {
    const run = this.currentRunId === undefined ? undefined : this.runs.get(this.currentRunId)
    return run?.status === "running" ? run.runId : undefined
  }

  /** One chronological deep-history page: the `limit` oldest messages before
   * the exclusive `before` anchor (or the newest `limit` when the anchor is
   * absent). `nextBefore` is the page's oldest messageId and appears exactly
   * when older messages remain in the tracked window; an anchor outside the
   * window pages nothing. */
  messagePage(before: string | undefined, limit: number): { messages: PublicMessage[]; nextBefore?: string } {
    const end = before === undefined ? this.messages.length : this.messages.findIndex((message) => message.messageId === before)
    if (end < 0) return { messages: [] }
    const start = Math.max(0, end - limit)
    return {
      messages: this.messages.slice(start, end).map((message) => ({
        ...message,
        content: message.content.map((block) => ({ ...block })),
      })),
      ...(start > 0 ? { nextBefore: this.messages[start]!.messageId } : {}),
    }
  }

  private titleUpdated(event: Extract<AgentEvent, { type: "SessionTitleSet" }>): PublicSessionEvent {
    return { ...this.envelope(event), criticality: "informational", type: "session.title.updated", title: event.payload.title ?? "" }
  }

  private sessionArchived(event: Extract<AgentEvent, { type: "SessionArchived" }>): PublicSessionEvent {
    return { ...this.envelope(event), criticality: "critical", type: "session.archived", archivedAt: event.payload.archivedAt }
  }

  private securityUpdated(
    event: Extract<AgentEvent, { type: "SessionPermissionModeSet" | "SessionPermissionRulesSet" | "SessionAdditionalDirectoryAdded" }>,
  ): PublicSessionEvent {
    return {
      ...this.envelope(event),
      criticality: "critical",
      type: "security.updated",
      permissionMode: event.type === "SessionPermissionModeSet" ? (event.payload.mode as PublicPermissionModeValue) : this.permissionMode,
      policyRevision: event.payload.policyRevision,
    }
  }

  private inputAccepted(event: Extract<AgentEvent, { type: "InputAccepted" }>): readonly PublicSessionEvent[] {
    const kind: PublicInputKind = event.payload.kind === "message" ? "prompt" : event.payload.kind
    const cancelled = this.cancelledBeforeAcceptance.delete(event.payload.inputId)
    const input: TrackedInput = {
      inputId: event.payload.inputId,
      commandId: event.payload.commandId,
      kind,
      status: cancelled ? "cancelled" : "queued",
      acceptedAt: event.timestamp,
      text: event.payload.text,
      ...(event.payload.kind === "steer" && event.payload.targetRunId !== undefined ? { runId: event.payload.targetRunId } : {}),
    }
    this.inputs.set(input.inputId, input)
    const accepted: PublicSessionEvent = {
      ...this.envelope(event),
      criticality: "critical",
      type: "input.accepted",
      input: toPublicInput(input),
    }
    if (kind !== "prompt") return [accepted]
    const messageId = `message:${event.payload.inputId}`
    const message: PublicSessionEvent = {
      eventId: messageId,
      sessionId: event.sessionId,
      revision: event.revision,
      timestamp: event.timestamp,
      criticality: "critical",
      type: "message.upserted",
      message: {
        messageId,
        role: "user",
        createdAt: event.timestamp,
        content: [{ type: "text", text: event.payload.text }],
      },
    }
    this.pushMessage(message.message)
    return [accepted, message]
  }

  private inputCancelled(event: Extract<AgentEvent, { type: "InputCancellationRequested" }>): readonly PublicSessionEvent[] {
    const input = this.inputs.get(event.payload.inputId)
    if (input === undefined) {
      this.cancelledBeforeAcceptance.add(event.payload.inputId)
      return []
    }
    input.status = "cancelled"
    if (event.payload.reason !== undefined) input.cancelReason = event.payload.reason
    this.trimTerminatedInputs()
    return [{ ...this.envelope(event), criticality: "critical", type: "input.updated", input: toPublicInput(input) }]
  }

  private inputConsumed(event: Extract<AgentEvent, { type: "InputConsumed" }>): readonly PublicSessionEvent[] {
    const input = this.inputs.get(event.payload.inputId)
    if (input === undefined) return []
    input.status = "consumed"
    input.runId = event.payload.runId
    this.trimTerminatedInputs()
    return [{ ...this.envelope(event), criticality: "critical", type: "input.updated", input: toPublicInput(input) }]
  }

  private runStarted(event: Extract<AgentEvent, { type: "RunStarted" }>): readonly PublicSessionEvent[] {
    const run: TrackedRun = {
      runId: event.payload.runId,
      status: "running",
      turn: 0,
      startedAt: event.timestamp,
      goal: event.payload.goal,
      lastPhase: "thinking",
    }
    this.trackRun(run)
    this.currentRunId = run.runId
    return [{ ...this.envelope(event), criticality: "critical", type: "run.updated", run: toPublicRun(run, "thinking", undefined) }]
  }

  private modelResponseCommitted(event: Extract<AgentEvent, { type: "ModelResponseCommitted" }>): readonly PublicSessionEvent[] {
    const run = this.runs.get(event.payload.runId)
    if (run !== undefined) {
      run.turn = event.payload.turn
      run.lastPhase = "thinking"
      run.activeToolCallId = undefined
      const model = event.payload.metadata?.model
      const inputTokens = event.payload.metadata?.usage?.inputTokens
      // Derived aggregate, not raw provider metadata: the footer-UX facts
      // only, so no request ids or protocol details ride on the wire.
      if (model !== undefined || inputTokens !== undefined) {
        const usage = event.payload.metadata?.usage
        run.usage = {
          ...(model === undefined ? {} : { model }),
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(usage?.estimated === undefined ? {} : { estimated: usage.estimated }),
        }
      }
    }
    const message: PublicMessage = {
      messageId: `response:${event.eventId}`,
      role: "assistant",
      runId: event.payload.runId,
      createdAt: event.timestamp,
      content: publicContentBlocks(event.payload.content),
      turn: Math.max(1, event.payload.turn),
      ...(event.payload.durationMs === undefined ? {} : { durationMs: event.payload.durationMs }),
    }
    this.pushMessage(message)
    return [{ ...this.envelope(event), criticality: "critical", type: "message.upserted", message }]
  }

  private toolCallRequested(event: Extract<AgentEvent, { type: "ToolCallRequested" }>): readonly PublicSessionEvent[] {
    const toolCall: TrackedToolCall = {
      toolCallId: event.payload.toolUseId,
      runId: event.payload.runId,
      toolName: event.payload.name,
      title: toolTitleFromInput(event.payload.input) ?? event.payload.name,
      status: "requested",
      turn: event.payload.turn,
      input: event.payload.input,
    }
    this.trackToolCall(toolCall)
    const run = this.runs.get(event.payload.runId)
    if (run !== undefined) run.lastPhase = "tool_execution"
    return [{ ...this.envelope(event), criticality: "critical", type: "tool_call.upserted", toolCall: toPublicToolCall(toolCall) }]
  }

  private approvalRequested(event: Extract<AgentEvent, { type: "ToolApprovalRequested" }>): readonly PublicSessionEvent[] {
    const previousInteractionId = this.interactionsByToolUse.get(event.payload.toolUseId)
    const superseded = previousInteractionId === undefined ? undefined : this.openInteractions.get(previousInteractionId)
    if (previousInteractionId !== undefined) this.openInteractions.delete(previousInteractionId)
    const toolCall = this.toolCalls.get(event.payload.toolUseId)
    const command = commandFromToolInput(toolCall?.input)
    const subjectFacts = approvalSubjectFacts(toolCall?.input)
    const primarySubjectText = command ?? subjectFacts.path ?? subjectFacts.pattern ?? subjectFacts.url
    const interaction: PublicToolApprovalInteraction = {
      interactionId: event.eventId,
      sessionId: event.sessionId,
      runId: event.payload.runId,
      turn: Math.max(1, event.payload.turn),
      createdAt: event.timestamp,
      kind: "tool_approval",
      toolCallId: event.payload.toolUseId,
      title: event.payload.name,
      subject: {
        type: "tool_call",
        toolName: event.payload.name,
        summary: primarySubjectText === undefined ? `${event.payload.name} execution` : preview(primarySubjectText),
        ...(command === undefined ? {} : { command }),
        ...(subjectFacts.path === undefined ? {} : { path: subjectFacts.path }),
        ...(subjectFacts.pattern === undefined ? {} : { pattern: subjectFacts.pattern }),
        ...(subjectFacts.url === undefined ? {} : { url: subjectFacts.url }),
        ...(subjectFacts.agentProfile === undefined ? {} : { agentProfile: subjectFacts.agentProfile }),
        ...(subjectFacts.inputExcerpt === undefined ? {} : { inputExcerpt: subjectFacts.inputExcerpt }),
      },
      options: [
        { optionId: "approve_once", label: "Approve once", outcome: "approve_once" },
        { optionId: "deny", label: "Deny", outcome: "deny" },
      ],
      policyRevision: event.payload.policyRevision ?? this.policyRevision,
      scopeRevision: event.payload.scopeRevision ?? this.scopeRevision,
      ownedBy: event.payload.ownedBy === "guardian" ? "guardian" : "user",
    }
    this.openInteractions.set(event.eventId, interaction)
    this.interactionsByToolUse.set(event.payload.toolUseId, event.eventId)
    if (toolCall !== undefined) {
      toolCall.status = "awaiting_approval"
      toolCall.interactionId = event.eventId
    }
    const requested: PublicSessionEvent = { ...this.envelope(event), criticality: "critical", type: "interaction.requested", interaction }
    if (superseded === undefined || previousInteractionId === undefined) return [requested]
    // A re-request for the same tool call supersedes the open card; the old
    // card must converge through a resolution event instead of vanishing.
    const expired: PublicSessionEvent = {
      eventId: `resolution:${previousInteractionId}`,
      sessionId: event.sessionId,
      revision: event.revision,
      timestamp: event.timestamp,
      criticality: "critical",
      type: "interaction.resolved",
      resolution: {
        interactionId: previousInteractionId,
        kind: "tool_approval",
        outcome: "expired",
        resolvedAt: event.timestamp,
      },
    }
    return [expired, requested]
  }

  private approvalResolved(event: Extract<AgentEvent, { type: "ToolApprovalResolved" }>): readonly PublicSessionEvent[] {
    const interactionId = this.interactionsByToolUse.get(event.payload.toolUseId)
    if (interactionId === undefined || !this.openInteractions.has(interactionId)) return []
    this.openInteractions.delete(interactionId)
    this.interactionsByToolUse.delete(event.payload.toolUseId)
    const toolCall = this.toolCalls.get(event.payload.toolUseId)
    if (toolCall !== undefined) toolCall.status = event.payload.decision === "denied" ? "denied" : "requested"
    return [
      {
        ...this.envelope(event),
        criticality: "critical",
        type: "interaction.resolved",
        resolution: {
          interactionId,
          kind: "tool_approval",
          outcome: event.payload.decision,
          resolvedAt: event.timestamp,
          resolver: event.payload.resolvedBy ?? "client",
        },
      },
    ]
  }

  private askRequested(event: Extract<AgentEvent, { type: "AskUserRequested" }>): readonly PublicSessionEvent[] {
    // Question and option ids derive from the durable event id and payload
    // ordering — the same recomputation the resolution handler decodes with,
    // so the ids stay stable across reconnects and never carry a grammar.
    const interaction: PublicAskUserInteraction = {
      interactionId: event.eventId,
      sessionId: event.sessionId,
      runId: event.payload.runId,
      turn: Math.max(1, event.payload.turn),
      createdAt: event.timestamp,
      kind: "ask_user",
      questions: event.payload.questions.map((question, questionIndex) => {
        const questionId = askQuestionId(event.eventId, questionIndex)
        return {
          questionId,
          question: question.question,
          ...(question.header === undefined ? {} : { header: question.header }),
          multiSelect: question.multiSelect ?? false,
          options: question.options.map((option, optionIndex) => ({
            optionId: askOptionId(questionId, optionIndex),
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        }
      }),
    }
    this.openInteractions.set(event.eventId, interaction)
    this.interactionsByToolUse.set(event.payload.toolUseId, event.eventId)
    const toolCall = this.toolCalls.get(event.payload.toolUseId)
    if (toolCall !== undefined) toolCall.interactionId = event.eventId
    return [{ ...this.envelope(event), criticality: "critical", type: "interaction.requested", interaction }]
  }

  private askResolved(event: Extract<AgentEvent, { type: "AskUserResolved" }>): readonly PublicSessionEvent[] {
    const interactionId = this.interactionsByToolUse.get(event.payload.toolUseId)
    if (interactionId === undefined || !this.openInteractions.has(interactionId)) return []
    const interaction = this.openInteractions.get(interactionId)
    this.openInteractions.delete(interactionId)
    this.interactionsByToolUse.delete(event.payload.toolUseId)
    // Internal answers carry option labels; the wire answer set resolves
    // them against the derived ids of the ask card's own option ordering.
    const selections = (rows: readonly { header: string; selected: readonly string[] }[]) =>
      interaction?.kind === "ask_user"
        ? rows
            .map((answer, index) => {
              const question = interaction.questions[index]
              if (question === undefined) return undefined
              const selectedOptionIds = answer.selected
                .map((label) => question.options.find((option) => option.label === label)?.optionId)
                .filter((optionId): optionId is string => optionId !== undefined)
              return { questionId: question.questionId, selectedOptionIds }
            })
            .filter((row): row is { questionId: string; selectedOptionIds: string[] } => row !== undefined)
        : undefined
    const answers =
      event.payload.outcome === "answered" && event.payload.answers !== undefined ? selections(event.payload.answers) : undefined
    const freeText =
      event.payload.outcome === "answered" && event.payload.answers !== undefined && interaction?.kind === "ask_user"
        ? event.payload.answers.flatMap((answer, index) =>
            answer.freeText === undefined || interaction.questions[index] === undefined
              ? []
              : [{ questionId: interaction.questions[index]!.questionId, text: answer.freeText }],
          )
        : undefined
    const contextAnswers =
      event.payload.outcome === "chat" && event.payload.contextAnswers !== undefined && interaction?.kind === "ask_user"
        ? event.payload.contextAnswers.flatMap((answer) => {
            const question = interaction.questions[answer.questionIndex]
            if (question === undefined) return []
            const selectedOptionIds = answer.selected
              .map((label) => question.options.find((option) => option.label === label)?.optionId)
              .filter((optionId): optionId is string => optionId !== undefined)
            return [{ questionId: question.questionId, selectedOptionIds }]
          })
        : undefined
    const contextFreeText =
      event.payload.outcome === "chat" && event.payload.contextAnswers !== undefined && interaction?.kind === "ask_user"
        ? event.payload.contextAnswers.flatMap((answer) => {
            const question = interaction.questions[answer.questionIndex]
            return answer.freeText === undefined || question === undefined
              ? []
              : [{ questionId: question.questionId, text: answer.freeText }]
          })
        : undefined
    return [
      {
        ...this.envelope(event),
        criticality: "critical",
        type: "interaction.resolved",
        resolution: {
          interactionId,
          kind: "ask_user",
          outcome: event.payload.outcome,
          resolvedAt: event.timestamp,
          resolver: event.payload.resolvedBy === "system" ? "system" : "client",
          ...(answers === undefined ? {} : { answers }),
          ...(freeText === undefined ? {} : { freeText }),
          ...(contextAnswers === undefined ? {} : { contextAnswers }),
          ...(contextFreeText === undefined ? {} : { contextFreeText }),
        },
      },
    ]
  }

  private toolExecutionStarted(event: Extract<AgentEvent, { type: "ToolCallExecutionStarted" }>): readonly PublicSessionEvent[] {
    const toolCall = this.toolCalls.get(event.payload.toolUseId)
    if (toolCall !== undefined) {
      toolCall.status = "running"
      toolCall.startedAt = event.timestamp
    }
    const run = this.runs.get(event.payload.runId)
    if (run !== undefined) {
      run.lastPhase = "tool_execution"
      run.activeToolCallId = event.payload.toolUseId
    }
    const projected: PublicToolCall =
      toolCall === undefined
        ? {
            toolCallId: event.payload.toolUseId,
            runId: event.payload.runId,
            toolName: event.payload.name,
            title: event.payload.name,
            status: "running",
            startedAt: event.timestamp,
          }
        : toPublicToolCall(toolCall)
    return [{ ...this.envelope(event), criticality: "critical", type: "tool_call.upserted", toolCall: projected }]
  }

  private toolResultCommitted(event: Extract<AgentEvent, { type: "ToolResultCommitted" }>): readonly PublicSessionEvent[] {
    const result = event.payload.result
    const denied = result.denial !== undefined
    const status = denied ? "denied" : result.isError === true ? "failed" : "completed"
    // Shell task output is only served through paged session.getTaskLogs;
    // publishing it here would leak the full log into the public transcript.
    const redactOutput = isShellToolUseId(event.payload.toolUseId)
    const summary = denied ? `denied: ${result.denial.code}` : result.content === "" ? "ok" : preview(result.content)
    const toolCall = this.toolCalls.get(event.payload.toolUseId)
    if (toolCall !== undefined) {
      toolCall.status = status
      toolCall.completedAt = event.timestamp
      if (!redactOutput) {
        toolCall.resultSummary = summary
        toolCall.result = result.content
      }
      if (result.appliedPatch !== undefined) toolCall.diff = publicDiff(result.appliedPatch)
      if (result.denial !== undefined) {
        toolCall.denial = { code: result.denial.code, ...(result.denial.reason === undefined ? {} : { reason: result.denial.reason }) }
      }
      if (result.isError === true) toolCall.isError = true
      const metadata = result.metadata
      if (typeof metadata?.askUserOutcome === "string") toolCall.questionOutcome = metadata.askUserOutcome
      if (typeof metadata?.childSessionId === "string") toolCall.childSessionId = metadata.childSessionId
      if (typeof metadata?.childRunId === "string") toolCall.childRunId = metadata.childRunId
    }
    const run = this.runs.get(event.payload.runId)
    if (run !== undefined) {
      run.lastPhase = "thinking"
      run.activeToolCallId = undefined
    }
    const projected: PublicToolCall =
      toolCall === undefined
        ? {
            toolCallId: event.payload.toolUseId,
            runId: event.payload.runId,
            toolName: "unknown",
            title: "unknown",
            status,
            completedAt: event.timestamp,
            ...(redactOutput ? {} : { resultSummary: summary }),
            ...(result.isError === true ? { isError: true } : {}),
          }
        : toPublicToolCall(toolCall)
    return [{ ...this.envelope(event), criticality: "critical", type: "tool_call.upserted", toolCall: projected }]
  }

  private runTerminal(
    event: Extract<AgentEvent, { type: "RunCompleted" | "RunFailed" | "RunCancelled" }>,
    status: PublicRunSnapshot["status"],
    failure: PublicFailure | undefined,
  ): readonly PublicSessionEvent[] {
    const existing = this.runs.get(event.payload.runId)
    // A run whose start predates this projector's anchor (a resync
    // re-attach lands at the current head) still owns its terminal: the
    // terminal is the one fact anchor-dependent consumers cannot
    // reconstruct, so the ledger entry is synthesized from the terminal
    // itself, with the observation time standing in for the unknown
    // start — the same tolerance unknown tool calls already get.
    const run: TrackedRun = existing ?? {
      runId: event.payload.runId,
      status: "running",
      turn: 0,
      startedAt: event.timestamp,
      lastPhase: "thinking",
    }
    if (existing === undefined) {
      this.trackRun(run)
      // The terminal run is the session's latest by definition; without
      // this the snapshot's currentRun reads empty while the known-run
      // path reports the terminal run.
      this.currentRunId = run.runId
    }
    run.status = status
    run.turn = event.payload.turns
    run.completedAt = event.timestamp
    run.activeToolCallId = undefined
    run.failure = failure
    const events: PublicSessionEvent[] = [
      { ...this.envelope(event), criticality: "critical", type: "run.updated", run: toPublicRun(run, run.lastPhase, failure) },
    ]
    // The terminal fact discards inputs still targeted at this run (steers;
    // the session-level fifo mailbox survives for the next run). The
    // canonical reducer holds the same boundary; this projection turns it
    // into the broadcast input.updated the protocol promises. The fanout
    // id must differ from the run event's: same-revision siblings share a
    // revision, and downstream dedup disambiguates the fanout by id.
    for (const input of this.inputs.values()) {
      if (input.status === "queued" && input.runId !== undefined && String(input.runId) === String(event.payload.runId)) {
        input.status = "cancelled"
        events.push({
          ...this.envelope(event),
          eventId: `${event.eventId}:cancel:${input.inputId}`,
          criticality: "critical",
          type: "input.updated",
          input: toPublicInput(input),
        })
      }
    }
    return events
  }

  private runFailed(event: Extract<AgentEvent, { type: "RunFailed" }>): readonly PublicSessionEvent[] {
    const failure: PublicFailure = { code: event.payload.code ?? "run_failed", message: event.payload.message, retryable: false }
    this.lastFailureCode = failure.code
    return this.runTerminal(event, "failed", failure)
  }

  private runCancelled(event: Extract<AgentEvent, { type: "RunCancelled" }>): readonly PublicSessionEvent[] {
    if (event.payload.reason !== undefined) this.lastFailureCode = "run_cancelled"
    return this.runTerminal(
      event,
      "cancelled",
      event.payload.reason === undefined ? undefined : { code: "run_cancelled", message: event.payload.reason, retryable: false },
    )
  }

  private planUpdated(event: Extract<AgentEvent, { type: "PlanCreated" }>): PublicSessionEvent {
    return {
      ...this.envelope(event),
      criticality: "informational",
      type: "plan.updated",
      plan: planSummary(event.payload, event.timestamp),
    }
  }

  private upsertTask(
    taskId: string,
    type: "agent" | "shell" | "user_shell" | "loop" | undefined,
    title: string | undefined,
    status: PublicTaskSummary["status"],
    timestamp: string,
  ): TrackedTask | undefined {
    const existing = this.tasks.get(taskId)
    const kind = type === undefined ? existing?.kind : type === "loop" ? "agent" : type
    if (kind === undefined) return undefined
    const task: TrackedTask = { taskId, kind, title: title ?? existing?.title ?? kind, status, updatedAt: timestamp }
    this.tasks.set(taskId, task)
    const finished = [...this.tasks.values()].filter((candidate) => candidate.status !== "queued" && candidate.status !== "running")
    if (finished.length > MAX_TRACKED_TASKS) {
      for (const candidate of finished.slice(0, finished.length - MAX_TRACKED_TASKS)) this.tasks.delete(candidate.taskId)
    }
    return task
  }

  private backgroundTaskTransition(
    event: Extract<
      AgentEvent,
      { type: "BackgroundTaskStarted" | "BackgroundTaskCompleted" | "BackgroundTaskFailed" | "BackgroundTaskCancelled" }
    >,
    status: PublicTaskSummary["status"],
  ): readonly PublicSessionEvent[] {
    const task = this.upsertTask(event.payload.taskId, undefined, undefined, status, event.timestamp)
    if (task === undefined) return []
    return [this.backgroundTaskUpdated(event, task)]
  }

  private backgroundTaskUpdated(event: AgentEvent, task: TrackedTask): PublicSessionEvent {
    return { ...this.envelope(event), criticality: "informational", type: "background_task.updated", task: { ...task } }
  }

  private pushMessage(message: PublicMessage): void {
    this.messages.push(message)
    if (this.messages.length > MAX_TRACKED_MESSAGES) this.messages = this.messages.slice(-MAX_TRACKED_MESSAGES)
  }

  private trimTerminatedInputs(): void {
    const terminated = [...this.inputs.values()].filter((input) => input.status !== "queued")
    if (terminated.length <= MAX_TRACKED_TERMINATED_INPUTS) return
    for (const input of terminated.slice(0, terminated.length - MAX_TRACKED_TERMINATED_INPUTS)) this.inputs.delete(input.inputId)
  }

  private trackRun(run: TrackedRun): void {
    this.runs.set(run.runId, run)
    const finished = [...this.runs.values()].filter((candidate) => candidate.status !== "running")
    if (finished.length > MAX_TRACKED_RUNS) {
      for (const candidate of finished.slice(0, finished.length - MAX_TRACKED_RUNS)) this.runs.delete(candidate.runId)
    }
  }

  private trackToolCall(toolCall: TrackedToolCall): void {
    this.toolCalls.set(toolCall.toolCallId, toolCall)
    const finished = [...this.toolCalls.values()].filter((candidate) => isTerminalToolStatus(candidate.status))
    if (finished.length > MAX_TRACKED_FINISHED_TOOL_CALLS) {
      for (const candidate of finished.slice(0, finished.length - MAX_TRACKED_FINISHED_TOOL_CALLS))
        this.toolCalls.delete(candidate.toolCallId)
    }
  }
}

function isTerminalToolStatus(status: PublicToolCall["status"]): boolean {
  return status === "completed" || status === "failed" || status === "denied"
}

/** A zero limit means "no recent messages at all" — `slice(-0)` would return everything. */
function recentMessages(limit: number | undefined, messages: readonly PublicMessage[]): PublicMessage[] {
  const bounded = limit ?? DEFAULT_RECENT_MESSAGES
  return (bounded <= 0 ? [] : messages.slice(-bounded)).map((message) => ({
    ...message,
    content: message.content.map((block) => ({ ...block })),
  }))
}

function toPublicInput(input: TrackedInput): PublicInputSnapshot {
  return {
    inputId: input.inputId,
    commandId: input.commandId,
    kind: input.kind,
    status: input.status,
    acceptedAt: input.acceptedAt,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    text: input.text,
    ...(input.cancelReason === undefined ? {} : { cancelReason: input.cancelReason }),
  }
}

function toPublicToolCall(toolCall: TrackedToolCall): PublicToolCall {
  return {
    toolCallId: toolCall.toolCallId,
    runId: toolCall.runId,
    toolName: toolCall.toolName,
    title: toolCall.title,
    status: toolCall.status,
    ...(toolCall.turn === undefined ? {} : { turn: Math.max(1, toolCall.turn) }),
    ...(toolCall.startedAt === undefined ? {} : { startedAt: toolCall.startedAt }),
    ...(toolCall.completedAt === undefined ? {} : { completedAt: toolCall.completedAt }),
    ...(toolCall.interactionId === undefined ? {} : { interactionId: toolCall.interactionId }),
    ...(toolCall.input === undefined ? {} : { input: renderToolInput(toolCall.input) }),
    ...(toolCall.resultSummary === undefined ? {} : { resultSummary: toolCall.resultSummary }),
    ...(toolCall.result === undefined ? {} : { result: toolCall.result }),
    ...(toolCall.diff === undefined ? {} : { diff: toolCall.diff }),
    ...(toolCall.denial === undefined ? {} : { denial: toolCall.denial }),
    ...(toolCall.questionOutcome === undefined ? {} : { questionOutcome: toolCall.questionOutcome }),
    ...(toolCall.childSessionId === undefined ? {} : { childSessionId: toolCall.childSessionId }),
    ...(toolCall.childRunId === undefined ? {} : { childRunId: toolCall.childRunId }),
    ...(toolCall.isError === undefined ? {} : { isError: toolCall.isError }),
  }
}

function toPublicRun(run: TrackedRun, phase: PublicRunPhase, failure: PublicFailure | undefined): PublicRunSnapshot {
  return {
    runId: run.runId,
    status: run.status,
    // Wire turn is a positive integer; a run observed before its first
    // completed turn reports turn 1 (the turn in progress).
    turn: Math.max(1, run.turn),
    startedAt: run.startedAt,
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    ...(run.goal === undefined ? {} : { goal: run.goal }),
    phase,
    ...(run.usage === undefined ? {} : { usage: run.usage }),
    ...(failure === undefined ? {} : { failure }),
  }
}

/**
 * The internal plan model has no proposal/acceptance lifecycle, so the
 * current plan is always reported active; step status maps 1:1 from the
 * internal lifecycle (no invented completion states) and completedSteps
 * stays 0 until the runtime grows that fact.
 */
function planSummary(
  plan: {
    readonly id: string
    readonly summary: string
    readonly createdAt: string
    readonly steps: readonly {
      readonly order: number
      readonly title: string
      readonly description: string
      readonly status: "pending" | "blocked" | "ready"
    }[]
  },
  updatedAt: string,
) {
  return {
    planId: plan.id,
    title: plan.summary,
    status: "active" as const,
    totalSteps: plan.steps.length,
    completedSteps: 0,
    steps: plan.steps.map((step) => ({
      order: step.order,
      title: step.title,
      ...(step.description.trim().length > 0 ? { description: step.description } : {}),
      status: step.status,
    })),
    updatedAt,
  }
}

/**
 * Transient projection: field renames only, no cross-event state. The only
 * context needed is the currently running run id for child-agent spawn
 * facts; without one the event is dropped rather than attributed wrongly.
 */
export function projectTransientEvent(event: TransientStreamEvent, currentRunId?: string): PublicTransientEvent | undefined {
  const envelope = { eventId: event.eventId, sessionId: event.sessionId, sequence: event.sequence, timestamp: event.timestamp }
  switch (event.type) {
    case "model_text_delta":
      return {
        ...envelope,
        kind: "model_text_delta",
        runId: event.payload.runId,
        turn: Math.max(1, event.payload.turn),
        text: event.payload.delta,
        ...(event.payload.childSessionId === undefined ? {} : { childSessionId: event.payload.childSessionId }),
      }
    case "model_tool_call_start":
      return {
        ...envelope,
        kind: "model_tool_call_start",
        runId: event.payload.runId,
        toolCallId: event.payload.toolUseId,
        toolName: event.payload.name,
        title: event.payload.name,
        ...(event.payload.childSessionId === undefined ? {} : { childSessionId: event.payload.childSessionId }),
      }
    case "model_tool_call_delta":
      return {
        ...envelope,
        kind: "model_tool_call_delta",
        runId: event.payload.runId,
        toolCallId: event.payload.toolUseId,
        inputDelta: event.payload.delta,
        ...(event.payload.childSessionId === undefined ? {} : { childSessionId: event.payload.childSessionId }),
      }
    case "model_tool_call_end":
      return {
        ...envelope,
        kind: "model_tool_call_end",
        runId: event.payload.runId,
        toolCallId: event.payload.toolUseId,
        ...(event.payload.childSessionId === undefined ? {} : { childSessionId: event.payload.childSessionId }),
      }
    case "tool_output_delta":
      return {
        ...envelope,
        kind: "tool_output_delta",
        runId: event.payload.runId,
        toolCallId: event.payload.toolUseId,
        stream: event.payload.stream,
        text: event.payload.delta,
      }
    case "child_agent_started":
      return currentRunId === undefined
        ? undefined
        : {
            ...envelope,
            kind: "child_agent_started",
            runId: currentRunId,
            childSessionId: event.payload.childSessionId,
            title: event.payload.description,
            ...(event.payload.subagentType === undefined ? {} : { subagentType: event.payload.subagentType }),
            ...(event.payload.toolUseId === undefined ? {} : { toolUseId: event.payload.toolUseId }),
          }
  }
}
