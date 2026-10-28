import type { AgentEvent } from "../events/event.js"
import { projectSessionTimeline } from "./session-timeline.js"
import { isModelBashInput } from "../model-bash.js"
import { GUARDIAN_DENIAL_REASON_CODES, isPreparedSecurityFact, MAX_GUARDIAN_ID_LENGTH, MAX_GUARDIAN_REASON_LENGTH } from "../tool-facts.js"
import { assertExplicitSessionCreatedPolicy, assertKnownPermissionMode, assertSessionRevisionField } from "./session-security.js"

type RunFacts = {
  status: "running" | "completed" | "failed" | "cancelled"
  toolCalls: Map<string, ToolFacts>
  modelAttempts: Map<string, "started" | "abandoned" | "committed">
  toolAttempts: Map<string, "started" | "abandoned" | "committed">
}

type ToolFacts = {
  name: string
  preparedEventId?: string
  preparationStatus?: "ready" | "invalid" | "blocked" | "denied" | "reused"
  approvalDecision?: "approved" | "denied"
  preparationCwd?: string
  approvalRequested: boolean
  approvalOwnedBy?: "guardian"
  approvalResolved: boolean
  askRequested: boolean
  askResolved: boolean
  askQuestions?: readonly { header: string; multiSelect: boolean; labels: readonly string[] }[]
  executionStarted: boolean
  executionEventId?: string
}

/**
 * Validate the semantic invariants of one canonical session prefix.
 *
 * A prefix may end while a run or a tool call is still active; crash recovery
 * depends on being able to replay such a prefix. Terminal events, however,
 * must always have a valid preceding lifecycle.
 */
export function validateCanonicalSession(events: readonly AgentEvent[]): void {
  if (events.length === 0) throw new Error("Canonical Session must contain at least one event")

  // Validate the append-only timeline controls before validating run
  // lifecycles. This keeps rewind semantics in one pure projection module.
  projectSessionTimeline(events)

  const sessionId = events[0]!.sessionId
  const eventIds = new Set<string>()
  const runs = new Map<string, RunFacts>()
  const additionalDirectories = new Set<string>()
  let workspaceRoot: string | undefined
  let scopeRevision = 0
  let policyRevision = 0
  let sessionCreated = false

  for (const [index, event] of events.entries()) {
    const expectedRevision = index + 1
    if (event.sessionId !== sessionId) {
      throw new Error(`Canonical Session contains multiple Sessions: event ${index + 1} does not match`)
    }
    if (event.revision !== expectedRevision) {
      throw new Error(`Canonical Session revision gap: expected ${expectedRevision}, received ${event.revision}`)
    }
    if (eventIds.has(event.eventId)) {
      throw new Error(`Canonical Session contains duplicate eventId: ${event.eventId}`)
    }
    eventIds.add(event.eventId)

    if (index === 0 && event.type !== "SessionCreated") {
      throw new Error("SessionCreated must be the first event in the Canonical Session")
    }
    if (event.type === "SessionCreated") {
      if (sessionCreated) throw new Error("Canonical Session may contain only one SessionCreated event")
      sessionCreated = true
      workspaceRoot = event.payload.workspaceRoot
      if (workspaceRoot.trim().length === 0) throw new Error("SessionCreated.workspaceRoot must not be empty")
      for (const directory of event.payload.additionalDirectories ?? []) {
        if (directory.trim().length === 0) throw new Error("SessionCreated.additionalDirectories must not contain an empty path")
        if (directory === workspaceRoot || additionalDirectories.has(directory))
          throw new Error(`Duplicate Session additional directory: ${directory}`)
        additionalDirectories.add(directory)
      }
      scopeRevision = event.payload.scopeRevision ?? 0
      assertExplicitSessionCreatedPolicy(event.payload)
      policyRevision = event.payload.policyRevision
      continue
    }

    switch (event.type) {
      case "SessionAdditionalDirectoryAdded":
        if (!workspaceRoot) throw new Error("SessionAdditionalDirectoryAdded is missing SessionCreated")
        if (event.payload.directory.trim().length === 0) throw new Error("SessionAdditionalDirectoryAdded.directory must not be empty")
        if (event.payload.directory === workspaceRoot)
          throw new Error(`Session additional directory must not equal workspaceRoot: ${event.payload.directory}`)
        additionalDirectories.clear()
        for (const directory of event.payload.additionalDirectories ?? [event.payload.directory]) {
          if (directory === workspaceRoot || additionalDirectories.has(directory))
            throw new Error(`Duplicate Session additional directory: ${directory}`)
          additionalDirectories.add(directory)
        }
        assertSessionRevisionField(event.payload.scopeRevision, "SessionAdditionalDirectoryAdded.scopeRevision")
        assertSessionRevisionField(event.payload.policyRevision, "SessionAdditionalDirectoryAdded.policyRevision")
        if (event.payload.scopeRevision <= scopeRevision) {
          throw new Error("Session scopeRevision must strictly increase on SessionAdditionalDirectoryAdded")
        }
        if (event.payload.policyRevision <= policyRevision) {
          throw new Error("Session policyRevision must strictly increase on SessionAdditionalDirectoryAdded")
        }
        scopeRevision = event.payload.scopeRevision
        policyRevision = event.payload.policyRevision
        break
      case "SessionPermissionModeSet":
        assertKnownPermissionMode(event.payload.mode)
        assertSessionRevisionField(event.payload.policyRevision, "SessionPermissionModeSet.policyRevision")
        if (event.payload.policyRevision <= policyRevision) {
          throw new Error("Session policyRevision must strictly increase on SessionPermissionModeSet")
        }
        policyRevision = event.payload.policyRevision
        break
      case "SessionPermissionRulesSet":
        assertSessionRevisionField(event.payload.policyRevision, "SessionPermissionRulesSet.policyRevision")
        if (event.payload.policyRevision <= policyRevision) {
          throw new Error("Session policyRevision must strictly increase on SessionPermissionRulesSet")
        }
        policyRevision = event.payload.policyRevision
        break
      case "RunStarted": {
        const runKey = String(event.payload.runId)
        if (runs.has(runKey)) throw new Error(`Run must not be started more than once: ${runKey}`)
        if ([...runs.values()].some((run) => run.status === "running")) {
          throw new Error("A Session may have only one running Agent loop")
        }
        runs.set(runKey, {
          status: "running",
          toolCalls: new Map(),
          modelAttempts: new Map(),
          toolAttempts: new Map(),
        })
        break
      }
      case "ContextCompacted":
        requireRunningRun(runs, event.payload.runId, event.type)
        break
      case "ModelRetryScheduled":
        requireRunningRun(runs, event.payload.runId, event.type)
        break
      case "ModelAttemptStarted": {
        const run = requireRunningRun(runs, event.payload.runId, event.type)
        if (run.modelAttempts.has(event.payload.attemptId))
          throw new Error(`ModelAttemptStarted must not be repeated: ${event.payload.attemptId}`)
        run.modelAttempts.set(event.payload.attemptId, "started")
        break
      }
      case "ModelAttemptAbandoned": {
        const run = requireRunningRun(runs, event.payload.runId, event.type)
        const status = run.modelAttempts.get(event.payload.attemptId)
        if (status !== "started") throw new Error(`ModelAttemptAbandoned is missing an active attempt: ${event.payload.attemptId}`)
        run.modelAttempts.set(event.payload.attemptId, "abandoned")
        break
      }
      case "ModelResponseCommitted": {
        const run = requireRunningRun(runs, event.payload.runId, event.type)
        const status = run.modelAttempts.get(event.payload.attemptId)
        if (status !== "started") throw new Error(`ModelResponseCommitted is missing an active attempt: ${event.payload.attemptId}`)
        run.modelAttempts.set(event.payload.attemptId, "committed")
        break
      }
      case "ToolAttemptStarted": {
        const run = requireRunningRun(runs, event.payload.runId, event.type)
        if (run.toolAttempts.has(event.payload.attemptId))
          throw new Error(`ToolAttemptStarted must not be repeated: ${event.payload.attemptId}`)
        run.toolAttempts.set(event.payload.attemptId, "started")
        break
      }
      case "ToolAttemptAbandoned": {
        const run = requireRunningRun(runs, event.payload.runId, event.type)
        const status = run.toolAttempts.get(event.payload.attemptId)
        if (status !== "started") throw new Error(`ToolAttemptAbandoned is missing an active attempt: ${event.payload.attemptId}`)
        run.toolAttempts.set(event.payload.attemptId, "abandoned")
        break
      }
      case "ToolResultCommitted": {
        const run = requireRunningRun(runs, event.payload.runId, event.type)
        const status = run.toolAttempts.get(event.payload.attemptId)
        if (status !== "started") throw new Error(`ToolResultCommitted is missing an active attempt: ${event.payload.attemptId}`)
        run.toolAttempts.set(event.payload.attemptId, "committed")
        break
      }
      case "ToolCallRequested":
      case "ToolCallPrepared":
      case "ToolApprovalRequested":
      case "ToolApprovalResolved":
      case "AskUserRequested":
      case "ToolCallExecutionStarted": {
        const run = requireRunningRun(runs, event.payload.runId, event.type)
        validateRunEvent(run, event)
        break
      }
      case "AskUserResolved": {
        // The restart sweep converges a dangling ask only after its run
        // ended; answerer outcomes stay run-scoped.
        const run = requireRun(runs, event.payload.runId, event.type)
        if (event.payload.outcome === "expired") {
          if (run.status === "running") {
            throw new Error(`AskUserResolved.expired requires an ended run: ${event.payload.runId}`)
          }
        } else if (run.status !== "running") {
          throw new Error(`${event.type} cannot be written to a Run that has already ended: ${event.payload.runId}`)
        }
        validateRunEvent(run, event)
        break
      }
      case "RunCompleted":
      case "RunFailed":
      case "RunCancelled": {
        const run = requireRun(runs, event.payload.runId, event.type)
        if (run.status !== "running") throw new Error(`${event.type} cannot end a Run that has already ended: ${event.payload.runId}`)
        run.status = event.type === "RunCompleted" ? "completed" : event.type === "RunFailed" ? "failed" : "cancelled"
        break
      }
      default:
        break
    }
  }
}

function requireRun(runs: Map<string, RunFacts>, runId: string, eventType: string): RunFacts {
  const run = runs.get(String(runId))
  if (!run) throw new Error(`Session is missing RunStarted (${eventType}): ${runId}`)
  return run
}

function requireRunningRun(runs: Map<string, RunFacts>, runId: string, eventType: string): RunFacts {
  const run = requireRun(runs, String(runId), eventType)
  if (run.status !== "running") throw new Error(`${eventType} cannot be written to a Run that has already ended: ${runId}`)
  return run
}

function validateRunEvent(
  run: RunFacts,
  event: Extract<
    AgentEvent,
    {
      type:
        | "ToolCallRequested"
        | "ToolCallPrepared"
        | "ToolApprovalRequested"
        | "ToolApprovalResolved"
        | "AskUserRequested"
        | "AskUserResolved"
        | "ToolCallExecutionStarted"
    }
  >,
): void {
  switch (event.type) {
    case "ToolCallRequested": {
      if (run.toolCalls.has(event.payload.toolUseId)) {
        throw new Error(`ToolCallRequested must not be repeated: ${event.payload.toolUseId}`)
      }
      run.toolCalls.set(event.payload.toolUseId, {
        name: event.payload.name,
        approvalRequested: false,
        approvalResolved: false,
        askRequested: false,
        askResolved: false,
        executionStarted: false,
      })
      break
    }
    case "ToolCallPrepared": {
      const tool = requireTool(run, event.payload.toolUseId, event.type)
      if (tool.preparedEventId !== undefined) {
        throw new Error(`ToolCallPrepared must not be repeated: ${event.payload.toolUseId}`)
      }
      if (event.payload.name !== tool.name) {
        throw new Error(`ToolCallPrepared tool name does not match: ${event.payload.toolUseId}`)
      }
      if (event.payload.status === "ready" && event.payload.decision === undefined) {
        throw new Error(`ToolCallPrepared.ready must include decision: ${event.payload.toolUseId}`)
      }
      if (event.payload.status === "ready" && event.payload.decision === "deny") {
        throw new Error(`ToolCallPrepared.ready must not use decision=deny: ${event.payload.toolUseId}`)
      }
      if (event.payload.status !== "ready" && event.payload.status !== "reused" && event.payload.decision !== "deny") {
        throw new Error(`ToolCallPrepared rejected states must use decision=deny: ${event.payload.toolUseId}`)
      }
      if (event.payload.status === "reused" && event.payload.decision !== undefined) {
        throw new Error(`ToolCallPrepared.reused must not include decision: ${event.payload.toolUseId}`)
      }
      if (
        event.payload.name === "bash" &&
        event.payload.policyVersion !== "user-owned" &&
        event.payload.status === "ready" &&
        !event.payload.approvalFingerprint
      ) {
        throw new Error(`Model Bash ToolCallPrepared.ready must include approvalFingerprint: ${event.payload.toolUseId}`)
      }
      if (
        event.payload.name === "bash" &&
        event.payload.policyVersion !== "user-owned" &&
        event.payload.status === "ready" &&
        !isModelBashInput(event.payload.preparedInput)
      ) {
        throw new Error(`Model Bash ToolCallPrepared.ready must include a strict command input: ${event.payload.toolUseId}`)
      }
      if (
        event.payload.scopeRevision !== undefined &&
        (!Number.isInteger(event.payload.scopeRevision) || event.payload.scopeRevision < 0)
      ) {
        throw new Error(`ToolCallPrepared.scopeRevision must be a non-negative integer: ${event.payload.toolUseId}`)
      }
      if (
        event.payload.policyRevision !== undefined &&
        (!Number.isInteger(event.payload.policyRevision) || event.payload.policyRevision < 0)
      ) {
        throw new Error(`ToolCallPrepared.policyRevision must be a non-negative integer: ${event.payload.toolUseId}`)
      }
      // Security facts bind to one name class: the read-only template to
      // model Bash, the write facts to the structured writers. A fact riding
      // the wrong tool could mint an allow for a different effect class.
      if (event.payload.securityFact !== undefined && !isPreparedSecurityFact(event.payload.securityFact)) {
        throw new Error(`ToolCallPrepared.securityFact kind is invalid: ${event.payload.toolUseId}`)
      }
      if (event.payload.securityFact?.kind === "bash-read-only-template" && event.payload.name !== "bash") {
        throw new Error(`ToolCallPrepared.securityFact bash template requires name=bash: ${event.payload.toolUseId}`)
      }
      if (
        (event.payload.securityFact?.kind === "scratch-write" || event.payload.securityFact?.kind === "dangerous-write") &&
        event.payload.name !== "write_file" &&
        event.payload.name !== "file_edit"
      ) {
        throw new Error(`ToolCallPrepared.securityFact write fact requires write_file/file_edit: ${event.payload.toolUseId}`)
      }
      tool.preparedEventId = event.eventId
      tool.preparationStatus = event.payload.status
      tool.preparationCwd = event.payload.cwd
      break
    }
    case "ToolApprovalRequested": {
      const tool = requireTool(run, event.payload.toolUseId, event.type)
      if (tool.approvalRequested) throw new Error(`ToolApprovalRequested must not be repeated: ${event.payload.toolUseId}`)
      if (event.payload.name !== tool.name) throw new Error(`ToolApprovalRequested tool name does not match: ${event.payload.toolUseId}`)
      if (tool.preparedEventId !== event.payload.preparedEventId) {
        throw new Error(`ToolApprovalRequested preparedEventId does not match: ${event.payload.toolUseId}`)
      }
      if (tool.preparationStatus !== "ready" && tool.preparationStatus !== "reused") {
        throw new Error(`ToolApprovalRequested is missing executable preparation facts: ${event.payload.toolUseId}`)
      }
      if (event.payload.ownedBy !== undefined && event.payload.ownedBy !== "guardian") {
        throw new Error(`ToolApprovalRequested.ownedBy is invalid: ${event.payload.toolUseId}`)
      }
      tool.approvalRequested = true
      tool.approvalOwnedBy = event.payload.ownedBy
      break
    }
    case "ToolApprovalResolved": {
      const tool = requireTool(run, event.payload.toolUseId, event.type)
      if (!tool.approvalRequested) throw new Error(`ToolApprovalResolved is missing ToolApprovalRequested: ${event.payload.toolUseId}`)
      if (tool.approvalResolved) throw new Error(`ToolApprovalResolved must not be repeated: ${event.payload.toolUseId}`)
      if (tool.preparedEventId !== event.payload.preparedEventId) {
        throw new Error(`ToolApprovalResolved preparedEventId does not match: ${event.payload.toolUseId}`)
      }
      if (event.payload.resolvedBy !== undefined && event.payload.resolvedBy !== "guardian" && event.payload.resolvedBy !== "system") {
        throw new Error(`ToolApprovalResolved.resolvedBy is invalid: ${event.payload.toolUseId}`)
      }
      // Ownership is decided once, at ask time: a guardian-owned ask is never
      // answered by the user (the absent encoding cannot launder authority),
      // and a guardian resolution only answers a guardian-owned ask. System
      // outcomes may supersede either owner — they only ever force denials.
      if (tool.approvalOwnedBy === "guardian" && event.payload.resolvedBy === undefined) {
        throw new Error(`ToolApprovalResolved: an approval owned by guardian cannot be resolved by the user: ${event.payload.toolUseId}`)
      }
      if (event.payload.resolvedBy === "guardian" && tool.approvalOwnedBy !== "guardian") {
        throw new Error(`ToolApprovalResolved: a guardian decision requires an approval owned by guardian: ${event.payload.toolUseId}`)
      }
      // System outcomes only ever force denials.
      if (event.payload.resolvedBy === "system" && event.payload.decision !== "denied") {
        throw new Error(`ToolApprovalResolved must be denied when resolved by the system: ${event.payload.toolUseId}`)
      }
      // Guardian attribution exists iff the guardian resolved the ask; a
      // guardian block on any other source misattributes authority.
      if (event.payload.guardian !== undefined && event.payload.resolvedBy !== "guardian") {
        throw new Error(`ToolApprovalResolved.guardian must only be set when resolvedBy=guardian: ${event.payload.toolUseId}`)
      }
      if (event.payload.resolvedBy === "guardian" && event.payload.guardian === undefined) {
        throw new Error(`ToolApprovalResolved with resolvedBy=guardian must include guardian ownership: ${event.payload.toolUseId}`)
      }
      if (event.payload.guardian !== undefined) {
        assertGuardianIdentityBlock("ToolApprovalResolved.guardian", event.payload.guardian, event.payload.toolUseId)
        if (event.payload.guardian.reasonCode !== undefined) {
          if (!(GUARDIAN_DENIAL_REASON_CODES as readonly string[]).includes(event.payload.guardian.reasonCode)) {
            throw new Error(`ToolApprovalResolved.guardian.reasonCode is invalid: ${event.payload.toolUseId}`)
          }
          if (event.payload.decision !== "denied") {
            throw new Error(`ToolApprovalResolved.guardian.reasonCode may only appear in denied decisions: ${event.payload.toolUseId}`)
          }
        }
      }
      // A superseded approval records the guardian verdict a system denial
      // blocked; it never rides guardian/user resolutions or approvals.
      if (event.payload.supersededApproval !== undefined) {
        if (event.payload.resolvedBy !== "system" || event.payload.decision !== "denied" || tool.approvalOwnedBy !== "guardian") {
          throw new Error(
            `ToolApprovalResolved.supersededApproval requires a system decision denying a guardian approval: ${event.payload.toolUseId}`,
          )
        }
        assertGuardianIdentityBlock("ToolApprovalResolved.supersededApproval", event.payload.supersededApproval, event.payload.toolUseId)
      }
      tool.approvalResolved = true
      tool.approvalDecision = event.payload.decision
      break
    }
    case "AskUserRequested": {
      const tool = requireTool(run, event.payload.toolUseId, event.type)
      if (tool.askRequested) throw new Error(`AskUserRequested must not be repeated: ${event.payload.toolUseId}`)
      if (event.payload.name !== tool.name) throw new Error(`AskUserRequested tool name does not match: ${event.payload.toolUseId}`)
      if (event.payload.questions.length === 0) {
        throw new Error(`AskUserRequested must include at least one question: ${event.payload.toolUseId}`)
      }
      const askQuestions: { header: string; multiSelect: boolean; labels: readonly string[] }[] = []
      for (const question of event.payload.questions) {
        if (question.question.trim().length === 0) {
          throw new Error(`AskUserRequested question text must not be empty: ${event.payload.toolUseId}`)
        }
        if (question.options.length === 0) {
          throw new Error(`AskUserRequested question must include at least one option: ${event.payload.toolUseId}`)
        }
        const labels = new Set<string>()
        for (const option of question.options) {
          if (option.label.trim().length === 0) {
            throw new Error(`AskUserRequested option labels must not be empty: ${event.payload.toolUseId}`)
          }
          if (labels.has(option.label)) {
            throw new Error(`AskUserRequested option labels must be unique per question: ${event.payload.toolUseId}`)
          }
          labels.add(option.label)
        }
        askQuestions.push({
          header: question.header ?? question.question.slice(0, 12),
          multiSelect: question.multiSelect ?? false,
          labels: [...labels],
        })
      }
      tool.askRequested = true
      tool.askQuestions = askQuestions
      break
    }
    case "AskUserResolved": {
      const tool = requireTool(run, event.payload.toolUseId, event.type)
      if (!tool.askRequested) throw new Error(`AskUserResolved is missing AskUserRequested: ${event.payload.toolUseId}`)
      if (tool.askResolved) throw new Error(`AskUserResolved must not be repeated: ${event.payload.toolUseId}`)
      if (event.payload.resolvedBy !== undefined && event.payload.resolvedBy !== "system") {
        throw new Error(`AskUserResolved.resolvedBy is invalid: ${event.payload.toolUseId}`)
      }
      // Only the restart-expiry sweep answers as the system; every human
      // outcome arrives without attribution.
      if ((event.payload.resolvedBy === "system") !== (event.payload.outcome === "expired")) {
        throw new Error(`AskUserResolved.resolvedBy=system and outcome=expired must appear together: ${event.payload.toolUseId}`)
      }
      if (event.payload.outcome === "answered") {
        if (event.payload.answers === undefined) {
          throw new Error(`AskUserResolved.answered must include answers: ${event.payload.toolUseId}`)
        }
        if (event.payload.answers.length !== tool.askQuestions?.length) {
          throw new Error(`AskUserResolved answers must cover every question exactly once: ${event.payload.toolUseId}`)
        }
        for (const [index, row] of event.payload.answers.entries()) {
          const question = tool.askQuestions[index]!
          if (row.questionIndex !== undefined && row.questionIndex !== index) {
            throw new Error(`AskUserResolved answer question index does not match the question: ${event.payload.toolUseId}`)
          }
          if (row.header !== question.header) {
            throw new Error(`AskUserResolved answer header does not match the question: ${event.payload.toolUseId}`)
          }
          const hasText = row.freeText?.trim().length !== undefined && row.freeText.trim().length > 0
          if (row.selected.length === 0 && !hasText) {
            throw new Error(`AskUserResolved answers must not be empty: ${event.payload.toolUseId}`)
          }
          if (!question.multiSelect && ((hasText && row.selected.length > 0) || (!hasText && row.selected.length !== 1))) {
            throw new Error(`AskUserResolved single-select answers must pick one option or freeText: ${event.payload.toolUseId}`)
          }
          if (row.selected.some((label) => !question.labels.includes(label))) {
            throw new Error(`AskUserResolved selected labels must be offered options: ${event.payload.toolUseId}`)
          }
          if (new Set(row.selected).size !== row.selected.length) {
            throw new Error(`AskUserResolved selected labels must not repeat: ${event.payload.toolUseId}`)
          }
        }
      } else if (event.payload.answers !== undefined) {
        throw new Error(`AskUserResolved.answers requires outcome=answered: ${event.payload.toolUseId}`)
      }
      if (event.payload.outcome === "chat" && event.payload.contextAnswers !== undefined) {
        const seen = new Set<number>()
        for (const row of event.payload.contextAnswers) {
          const question = tool.askQuestions?.[row.questionIndex]
          if (question === undefined || seen.has(row.questionIndex)) {
            throw new Error(`AskUserResolved chat context has an unknown or repeated question index: ${event.payload.toolUseId}`)
          }
          if (row.header !== question.header)
            throw new Error(`AskUserResolved chat context header does not match question: ${event.payload.toolUseId}`)
          if (row.selected.some((label) => !question.labels.includes(label)) || new Set(row.selected).size !== row.selected.length) {
            throw new Error(`AskUserResolved chat context has an invalid selection: ${event.payload.toolUseId}`)
          }
          const hasText = row.freeText?.trim().length !== undefined && row.freeText.trim().length > 0
          if (row.selected.length === 0 && !hasText)
            throw new Error(`AskUserResolved chat context row is empty: ${event.payload.toolUseId}`)
          if (!question.multiSelect && (row.selected.length > 1 || (hasText && row.selected.length > 0))) {
            throw new Error(`AskUserResolved chat context violates single-select rules: ${event.payload.toolUseId}`)
          }
          seen.add(row.questionIndex)
        }
      } else if (event.payload.contextAnswers !== undefined) {
        throw new Error(`AskUserResolved.contextAnswers requires outcome=chat: ${event.payload.toolUseId}`)
      }
      tool.askResolved = true
      break
    }
    case "ToolCallExecutionStarted": {
      const tool = requireTool(run, event.payload.toolUseId, event.type)
      if (event.payload.dispatchId.trim().length === 0 || event.payload.requestFingerprint.trim().length === 0) {
        throw new Error(`ToolCallExecutionStarted is missing a dispatch identity: ${event.payload.toolUseId}`)
      }
      if (event.payload.replayPolicy !== "never" && event.payload.replayPolicy !== "retry-safe") {
        throw new Error(`ToolCallExecutionStarted replayPolicy is invalid: ${event.payload.toolUseId}`)
      }
      if (event.payload.name !== tool.name) throw new Error(`ToolCallExecutionStarted tool name does not match: ${event.payload.toolUseId}`)
      if (tool.preparedEventId === undefined || event.payload.preparedEventId === undefined) {
        throw new Error(`ToolCallExecutionStarted is missing ToolCallPrepared: ${event.payload.toolUseId}`)
      }
      if (tool.preparedEventId !== event.payload.preparedEventId) {
        throw new Error(`ToolCallExecutionStarted preparedEventId does not match: ${event.payload.toolUseId}`)
      }
      if (tool.preparationStatus !== "ready" && tool.preparationStatus !== "reused") {
        throw new Error(`ToolCallExecutionStarted is missing executable preparation facts: ${event.payload.toolUseId}`)
      }
      if (tool.executionStarted) {
        throw new Error(`ToolCallExecutionStarted must not be repeated: ${event.payload.toolUseId}`)
      }
      // Authorization is decided by the canonical permission judgment, never
      // by the persisted preparation decision. Once an approval was actually
      // requested, execution requires an approved resolution.
      if (tool.approvalRequested && (!tool.approvalResolved || tool.approvalDecision !== "approved")) {
        throw new Error(`ToolCallExecutionStarted requires an approved approval result: ${event.payload.toolUseId}`)
      }
      // A durable ask binds the answers the tool executes with; execution
      // only starts once the interaction has a canonical outcome.
      if (tool.askRequested && !tool.askResolved) {
        throw new Error(`ToolCallExecutionStarted requires a resolved ask result: ${event.payload.toolUseId}`)
      }
      if (tool.name === "bash") {
        if (event.payload.execution === undefined) {
          throw new Error(`ToolCallExecutionStarted is missing Bash execution: ${event.payload.toolUseId}`)
        }
        if (tool.preparationCwd !== undefined && event.payload.execution.cwd !== tool.preparationCwd) {
          throw new Error(`ToolCallExecutionStarted.cwd does not match the preparation facts: ${event.payload.toolUseId}`)
        }
      } else if (event.payload.execution !== undefined) {
        throw new Error(`A non-Bash ToolCallExecutionStarted must not include shell execution: ${event.payload.toolUseId}`)
      }
      tool.executionStarted = true
      tool.executionEventId = event.eventId
      break
    }
  }
}

function requireTool(run: RunFacts, toolUseId: string, eventType: string): ToolFacts {
  const tool = run.toolCalls.get(toolUseId)
  if (!tool) throw new Error(`${eventType} is missing ToolCallRequested: ${toolUseId}`)
  return tool
}

/**
 * Guardian identity blocks are durable audit facts from an untrusted model
 * channel: non-empty, bounded, and free of control characters a human cannot
 * read. The same rules apply to superseded approvals.
 */
function assertGuardianIdentityBlock(field: string, block: { guardianId: string; reason?: string }, toolUseId: string): void {
  if (block.guardianId.length === 0 || block.guardianId.length > MAX_GUARDIAN_ID_LENGTH) {
    throw new Error(`${field}.guardianId has an invalid length: ${toolUseId}`)
  }
  if (block.reason === undefined) return
  if (block.reason.length === 0 || block.reason.length > MAX_GUARDIAN_REASON_LENGTH) {
    throw new Error(`${field}.reason has an invalid length: ${toolUseId}`)
  }
  if (hasUnreadableControlCharacter(block.reason)) {
    throw new Error(`${field}.reason must not contain control characters: ${toolUseId}`)
  }
}

function hasUnreadableControlCharacter(text: string): boolean {
  for (const character of text) {
    if (character === "\t" || character === "\n" || character === "\r") continue
    const code = character.codePointAt(0)!
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}
