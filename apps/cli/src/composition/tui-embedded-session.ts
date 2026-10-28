/**
 * Embedded session composition: the TUI's business ports and event loop
 * over one process-private public session. Prompt submissions ride the
 * public submit method (mailbox admission; failure and cancellation
 * render through the public events, not the promise). Bang commands
 * ride the facade's foreground user shell, which never enters the run
 * loop. Approval decisions ride the unified interaction resolution with
 * the credentials carried on the ingress fact, captured as facts flow
 * through this module's fact handler. Events apply through the
 * projection ingress; the driver owns attach-before-backlog adoption
 * and resync, and this module observes the same public stream for the
 * footer facts (mode, policy revision, run state) and the rewind
 * window (per-prompt accepted revisions). Ask answers ride the same
 * unified resolution; the card maps its labels onto the interaction's
 * question and option ids.
 */
import { randomUUID } from "node:crypto"
import type { PublicAskUserAnswer } from "@ag2cli/app-server-protocol/dto/interactions.js"
import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicInputSnapshot, PublicPermissionModeValue, PublicPlanSummary } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type { SessionProjectionWriter } from "../ui/tui/sessionprojection/index.js"
import {
  askCardQuestionsFromInteraction,
  createTuiIngress,
  subjectSummaryLines,
  type ChildAgentsSink,
  type TuiAskQuestion,
  type TuiIngress,
  type TuiIngressFact,
} from "./tui-projection-pump.js"
import { createTuiSessionDriver } from "./tui-session-driver.js"
import type { TuiPublicSession } from "./tui-public-session.js"
import { RpcApplicationError } from "./public-session-commands.js"

/** Resolve credentials minted onto the approval fact by the ingress. */
interface ApprovalResolveContext {
  readonly interactionId: string
  readonly policyRevision: number
  readonly scopeRevision: number
}

/** The rewind window facts one accepted prompt keeps. */
interface TrackedPromptInput {
  /** This input's InputAccepted revision; the window's exclusive upper bound. */
  readonly acceptedRevision: number
  /** The previous prompt's accepted revision; the window's inclusive lower bound. */
  readonly previousAcceptedRevision: number
  readonly text: string
}

/** Live rule grammar; the public policy document carries behaviors as plain strings. */
const RULE_BEHAVIORS: readonly string[] = ["allow", "ask", "deny"]

/** One canonical permission rule row (name plus live behavior vocabulary). */
export interface PermissionRule {
  readonly name: string
  readonly behavior: string
}

/** A live approval request as the hooks receive it (summary lines already derived). */
export interface TuiApprovalCardInput {
  readonly requestId: string
  readonly toolName: string
  readonly summary: readonly string[]
  readonly options: readonly { readonly optionId: string; readonly label: string; readonly outcome: "approve_once" | "deny" }[]
  readonly version: number
}

/** A live ask request as the hooks receive it: identity plus its question table. */
export interface TuiAskCardInput {
  readonly requestId: string
  readonly questions: readonly TuiAskQuestion[]
}

/**
 * The business surface one embedded session exposes to the Ink host.
 * After stop() the ports follow one contract: submitInput, executeShell,
 * rewindToInput and compact reject with "The session was stopped"
 * (nothing may mutate an abandoned runtime), setPermissionMode,
 * setPermissionRules, approval.resolve and ask.resolve answer false —
 * the race-lost shape, with the
 * canonical event stream owning every display — addAdditionalDirectory
 * answers ok:false with the reason, and cancelInput and cancelRun stay
 * live so late admissions can still be returned to their port and a
 * settled run's terminal state can still be reported.
 *
 * A degraded session (its replayed history holds an unknown critical
 * event) refuses every mutation instead: submitInput, compact,
 * executeShell, rewindToInput, cancelInput and cancelRun reject with
 * unsupported_event — every caller of those catches — while the
 * boolean-shaped commits answer false, the directory add answers
 * ok:false, and each refusal reports itself through
 * onDegradedAttempt so the surfaced notice is the one place the
 * blocked attempt becomes visible.
 */
export interface TuiEmbeddedSessionPorts {
  readonly session: {
    submitInput(input: {
      readonly text: string
      readonly signal?: AbortSignal
    }): Promise<{ readonly inputId: string; readonly queued: boolean }>
    cancelInput(input: { readonly inputId: string; readonly reason?: string }): Promise<{
      readonly inputId: string
      readonly status: "cancelled" | "cancelled-before-acceptance" | "already-delivered"
    }>
    cancelRun(input: { readonly runId: string }): Promise<{
      readonly requested: boolean
      readonly state: "requested" | "already_terminal" | "not_found"
    }>
    executeShell(input: { readonly command: string; readonly signal?: AbortSignal }): Promise<string>
    rewindToInput(input: { readonly inputId: string }): Promise<{ readonly restoredDraft: string }>
    compact(input: { readonly instructions?: string }): Promise<{
      readonly changed: boolean
      readonly inputMessageCount: number
      readonly outputMessageCount: number
      readonly inputTokens?: number
    }>
    setPermissionMode(input: { readonly mode: string }): Promise<boolean>
    setPermissionRules(input: { readonly rules: readonly PermissionRule[] }): Promise<boolean>
    addAdditionalDirectory(input: {
      readonly directory: string
      readonly signal?: AbortSignal
    }): Promise<
      { readonly ok: true; readonly canonical: string; readonly changed: boolean } | { readonly ok: false; readonly error: string }
    >
  }
  readonly approval: {
    resolve(input: { readonly requestId: string; readonly optionId: string }): Promise<boolean>
  }
  readonly ask: {
    resolve(input: { readonly requestId: string; readonly answer: PublicAskUserAnswer }): Promise<boolean>
  }
}

export interface TuiEmbeddedSessionOptions {
  /** The public session this embedded loop rides: facade plus live attachment. */
  readonly session: TuiPublicSession
  /**
   * Bootstrap workspace root for the directory add: the public contract
   * never carries the absolute root, so the process workspace stands in
   * for the adds of a session whose log holds no directory facts yet.
   */
  readonly workspaceRoot?: string
  /** The session projection's writer half; the ingress drives it directly. */
  readonly writer: SessionProjectionWriter
  /**
   * Delegation-fact sink the ingress routes child facts into; the host
   * owns the object so every session switch shares one sink.
   */
  readonly agents?: ChildAgentsSink
  /** Live approval requests (replayed history never raises cards). */
  readonly onApprovalRequest?: (request: TuiApprovalCardInput) => void
  /** Live ask requests as the decision surface renders them (replayed history never raises cards). */
  readonly onAskRequest?: (request: TuiAskCardInput) => void
  /** The canonical ask resolution echo (any outcome) closed a raised ask. */
  readonly onAskResolved?: (retract: { readonly requestId: string }) => void
  /** Run-state edge for footer rendering: running at issue, terminal at settle. */
  readonly onRunStateChange?: (state: "running" | "completed" | "failed" | "cancelled") => void
  /** Model/context telemetry sniffed from run terminals (footer source). */
  readonly onContextUsage?: (usage: { model?: string; contextTokens?: number; contextEstimated?: boolean }) => void
  /**
   * Converged tool-denial terminals (live and replayed history alike):
   * the Recently denied list accumulates them, so unlike approval
   * cards these facts ride the backlog replay too.
   */
  readonly onToolDenial?: (denial: {
    readonly toolCallId: string
    readonly name: string
    readonly code: string
    readonly reason?: string
  }) => void
  /**
   * Canonical session permission mode (footer source): the snapshot
   * seeds it and every security update lands here. The footer chip and
   * the root rotation probe read the mode only through this feed.
   */
  readonly onPermissionMode?: (mode: string) => void
  /**
   * Canonical session permission rules (rules-panel source): the
   * policy document seeds them and every security update re-fetches
   * them (the public stream carries no rules payload). The panel rows
   * and the slash upsert base read rules only through this canonical
   * feed; malformed rows are dropped, not forwarded.
   */
  readonly onPermissionRules?: (rules: readonly PermissionRule[]) => void
  /**
   * Canonical additional workspace directories (the Workspace tab's
   * rows): the snapshot seeds the set and every directory add replaces
   * it from its own result, so a replay resyncs to the same set.
   */
  readonly onAdditionalDirectories?: (directories: readonly string[]) => void
  /**
   * The projection moved (a durable batch, a transient batch, a resync
   * rebuild); the host re-mirrors content on this signal.
   */
  readonly onApplied?: () => void
  /**
   * Degradation edge: an unknown critical event survived the history
   * rebuild (degraded true) or a clean rebuild recovered the
   * projection (false). The projection keeps rendering either way; the
   * fact only gates mutations.
   */
  readonly onDegradationChange?: (degraded: boolean) => void
  /**
   * One blocked mutation attempt on a degraded session, reported per
   * attempt: the host surfaces the named refusal and hands a blocked
   * submit's text back to the composer.
   */
  readonly onDegradedAttempt?: (attempt: { readonly method: string; readonly input: unknown }) => void
  /** Backlog-read failure surface; the loop keeps running live-only. */
  readonly onAdoptionFailure?: (error: unknown) => void
}

export interface TuiEmbeddedSession {
  /** Business ports for the Ink host's composition root. */
  readonly ports: TuiEmbeddedSessionPorts
  /**
   * Modes this process may commit for the session: the public
   * session's selectable set, so the host's rotation ring and the
   * facade's commit guard read one vocabulary.
   */
  readonly selectableModes: readonly PublicPermissionModeValue[]
  /**
   * Mailbox inputs still queued, in acceptance order, as the session's
   * ingress mirrors them (snapshot-seeded, event-maintained); empty
   * before start and after stop.
   */
  mailboxQueued(): readonly PublicInputSnapshot[]
  /**
   * Plan summaries in first-appearance order, latest state per plan id,
   * as the session's ingress mirrors them (snapshot-seeded,
   * event-maintained); empty before start and after stop.
   */
  planSummaries(): readonly PublicPlanSummary[]
  /** Attach the event loop; adopts the backlog, then flips to live. No-op once stopped. */
  start(): Promise<void>
  /** Detach the event loop; in-flight submissions are signalled elsewhere. Terminal: a stopped session never restarts. */
  stop(): void
}

export function createTuiEmbeddedSession(options: TuiEmbeddedSessionOptions): TuiEmbeddedSession {
  const { session } = options
  const sessionId = session.sessionId
  const approvalContexts = new Map<string, ApprovalResolveContext>()
  // Live ask ids: a resolve is admissible only for an ask this loop
  // raised (or seeded from the snapshot); the canonical resolution echo
  // retires the id, so the card's own answer keeps it re-resolvable
  // until the echo lands.
  const askRequests = new Set<string>()
  let driver: ReturnType<typeof createTuiSessionDriver> | null = null
  let ingress: TuiIngress | null = null
  // Terminal once stop() runs: a switch can tear this session down while
  // its own backlog read is still in flight on its own transport
  // timeline, and the late read's canonical facts must never reach the
  // shared host hooks (the driver discards the result, but observation
  // runs inside the read's promise).
  let stopped = false
  // Set from the driver's degradation edge: the replayed history holds
  // an unknown critical event, so every mutation refuses. Only a clean
  // rebuild clears it — a re-attach of the same lineage degrades again.
  let degraded = false
  // Canonical permission facts: the revision guards rotation commands,
  // observation rides every durable delivery path (live subscription,
  // backlog read, overflow resync) and replays are idempotent because
  // the last event always wins.
  let policyRevision = 0
  // Scope facts the directory add bakes: the revision guards the same
  // optimistic race the policy revision guards. The public snapshot
  // carries no scope revision, so the guard arms only after this
  // process has completed one add; a resumed session's first add rides
  // unguarded rather than failing a CAS it cannot know.
  let scopeRevision = 0
  let scopeRevisionKnown = false
  // Rewind windows: one entry per accepted prompt, keyed by input id.
  let lastPromptAcceptedRevision = 0
  const promptInputs = new Map<string, TrackedPromptInput>()
  // Deliberately hand-rolled: this module consumes the public contract
  // exactly like a remote client, so the runtime package's concurrency
  // primitives stay unreachable here and the serialization chain lives
  // locally. Rule re-fetches serialize on it: concurrent fetches could
  // otherwise resolve out of order and stamp a stale policy document.
  let rulesFetch: Promise<void> = Promise.resolve()

  const validRules = (
    rules: readonly { readonly name: string; readonly behavior: string }[],
  ): readonly { readonly name: string; readonly behavior: "allow" | "ask" | "deny" }[] =>
    rules.flatMap((rule) =>
      rule.name.trim().length > 0 && RULE_BEHAVIORS.includes(rule.behavior)
        ? [{ name: rule.name, behavior: rule.behavior as "allow" | "ask" | "deny" }]
        : [],
    )

  const refetchRules = (): void => {
    rulesFetch = rulesFetch.then(async () => {
      if (stopped) return
      try {
        const { policy } = await session.facade.getPermissionPolicy({ sessionId })
        if (stopped) return
        policyRevision = policy.policyRevision
        options.onPermissionRules?.(validRules(policy.rules))
      } catch {
        // The canonical set keeps displaying; the next security update retries.
      }
    })
  }

  const observeSessionEvents = (events: readonly PublicSessionEvent[]): void => {
    for (const event of events) {
      if (event.type === "security.updated") {
        policyRevision = event.policyRevision
        options.onPermissionMode?.(event.permissionMode)
        refetchRules()
      } else if (event.type === "input.accepted" && event.input.kind === "prompt") {
        promptInputs.set(event.input.inputId, {
          acceptedRevision: event.revision,
          previousAcceptedRevision: lastPromptAcceptedRevision,
          text: event.input.text,
        })
        lastPromptAcceptedRevision = event.revision
      } else if (event.type === "run.updated") {
        if (event.run.status === "completed") options.onRunStateChange?.("completed")
        else if (event.run.status === "failed") options.onRunStateChange?.("failed")
        else if (event.run.status === "cancelled") options.onRunStateChange?.("cancelled")
      }
    }
  }

  /**
   * Seed the host facts the public stream alone cannot rebuild: the
   * snapshot's mode, directory set, and pending approval and ask cards
   * (live surfaces never ride the backlog replay), plus the policy
   * document's rule rows.
   */
  const seedFromSnapshot = async (): Promise<void> => {
    const snapshot = (await session.publicSnapshot()).session
    policyRevision = snapshot.security.policyRevision
    options.onPermissionMode?.(snapshot.security.permissionMode)
    // The mailbox mirror seeds from the snapshot's queued inputs so the
    // preview is correct before any event lands; the backlog replay
    // re-derives the same set idempotently.
    if (ingress !== null && snapshot.inputs !== undefined) ingress.seedMailbox(snapshot.inputs)
    // The snapshot names the one active plan; prior rows clear so a
    // re-attach paints exactly what the snapshot claims, and the
    // backlog replay re-derives every other plan row afterwards.
    if (ingress !== null) ingress.seedPlans(snapshot.activePlan)
    if (snapshot.workspace.additionalDirectories !== undefined) {
      options.onAdditionalDirectories?.(snapshot.workspace.additionalDirectories)
    }
    for (const interaction of snapshot.pendingInteractions) {
      if (interaction.kind === "ask_user") {
        askRequests.add(interaction.interactionId)
        options.onAskRequest?.({
          requestId: interaction.interactionId,
          questions: askCardQuestionsFromInteraction(interaction),
        })
        continue
      }
      // A guardian-owned ask settles with the guardian review, never a card.
      if (interaction.kind !== "tool_approval" || interaction.ownedBy === "guardian") continue
      approvalContexts.set(interaction.interactionId, {
        interactionId: interaction.interactionId,
        policyRevision: interaction.policyRevision,
        scopeRevision: interaction.scopeRevision,
      })
      options.onApprovalRequest?.({
        requestId: interaction.interactionId,
        toolName: interaction.subject.type === "tool_call" ? interaction.subject.toolName : interaction.title,
        summary: subjectSummaryLines(interaction.subject),
        options: interaction.options,
        version: snapshot.asOfRevision,
      })
    }
    refetchRules()
  }

  const handleFacts = (facts: readonly TuiIngressFact[]): void => {
    for (const fact of facts) {
      if (fact.kind === "approval-request") {
        approvalContexts.set(fact.requestId, fact.resolve)
        options.onApprovalRequest?.({
          requestId: fact.requestId,
          toolName: fact.toolName,
          summary: fact.summary,
          options: fact.options,
          version: fact.version,
        })
        continue
      }
      if (fact.kind === "ask-request") {
        askRequests.add(fact.requestId)
        options.onAskRequest?.({ requestId: fact.requestId, questions: fact.questions })
        continue
      }
      if (fact.kind === "ask-resolved") {
        askRequests.delete(fact.requestId)
        options.onAskResolved?.({ requestId: fact.requestId })
        continue
      }
      if (fact.kind === "tool-denial") {
        options.onToolDenial?.({
          toolCallId: fact.toolCallId,
          name: fact.name,
          code: fact.code,
          ...(fact.reason === undefined ? {} : { reason: fact.reason }),
        })
        continue
      }
      options.onContextUsage?.({
        ...(typeof fact.model === "string" ? { model: fact.model } : {}),
        ...(typeof fact.contextTokens === "number" ? { contextTokens: fact.contextTokens } : {}),
        ...(fact.contextEstimated === true ? { contextEstimated: true } : {}),
      })
    }
  }

  /** One refused mutation on a degraded session: named, then rejected. */
  const blockedMutation = (method: string, input: unknown): Promise<never> => {
    options.onDegradedAttempt?.({ method, input })
    throw new RpcApplicationError("unsupported_event", `The session is read-only: ${method} was refused`)
  }

  const ports: TuiEmbeddedSessionPorts = {
    session: {
      submitInput: async (input) => {
        // A stopped session must not admit new runs: the switch already
        // abandoned this runtime, so a late submit would start a run no
        // observer can reconcile — refuse before the command leaves.
        if (stopped) throw new Error("The session was stopped")
        if (degraded) return blockedMutation("submitInput", input)
        try {
          // The signal belongs to the UI admission handle: aborting the
          // transport here could hide a committed receipt before the
          // caller can issue the durable cancellation by inputId.
          const receipt = await session.facade.submit({ sessionId, commandId: randomUUID(), text: input.text })
          // A switch can stop this session while the submit is in
          // flight; the late state must not stamp the live session's
          // footer through the shared hooks.
          if (!stopped) options.onRunStateChange?.("running")
          return { inputId: receipt.inputId, queued: receipt.queued }
        } catch (error) {
          if (!stopped) options.onRunStateChange?.("failed")
          throw error
        }
      },
      cancelInput: async ({ inputId }) => {
        // Stays live after stop(): late admissions can still be returned.
        // A degraded session has no cancellations left to make: every
        // caller of this catches, so the refusal is safe to throw.
        if (degraded) return blockedMutation("cancelInput", { inputId })
        const result = await session.facade.cancelInput({ sessionId, inputId })
        const status =
          result.state === "requested" ? "cancelled" : result.state === "not_found" ? "cancelled-before-acceptance" : "already-delivered"
        return { inputId, status }
      },
      cancelRun: async ({ runId }) => {
        // Stays live after stop(): the facade's precheck owns the
        // terminal answer for a run the stopped loop already ended.
        if (degraded) return blockedMutation("cancelRun", { runId })
        return await session.facade.cancelRun({ sessionId, runId })
      },
      executeShell: async ({ command, signal }) => {
        // A stopped session is off its host loop: a late bang would run
        // detached from every observer, so it is refused outright.
        if (stopped) throw new Error("The session was stopped")
        if (degraded) return blockedMutation("executeShell", { command, signal })
        return await session.facade.executeUserShell({ sessionId, commandId: randomUUID(), command }, { signal })
      },
      rewindToInput: async ({ inputId }) => {
        // A rewind against a stopped session would rewrite the history
        // the switch already abandoned — refuse before any reads.
        if (stopped) throw new Error("The session was stopped")
        if (degraded) return blockedMutation("rewindToInput", { inputId })
        const tracked = promptInputs.get(inputId)
        if (tracked === undefined) throw new Error(`Cannot find consumed input for rewind: ${inputId}`)
        const { checkpoints } = await session.facade.listCheckpoints({ sessionId })
        // The prompt's checkpoint is the batch head born with its
        // acceptance: the window runs from the previous prompt's
        // acceptance (inclusive) up to this one (exclusive), and the
        // highest generation breaks ties toward the newest lineage.
        const candidate = checkpoints
          .filter(
            (checkpoint) =>
              checkpoint.kind === "prompt" &&
              tracked.previousAcceptedRevision <= checkpoint.headRevision &&
              checkpoint.headRevision < tracked.acceptedRevision,
          )
          .reduce<(typeof checkpoints)[number] | undefined>(
            (best, checkpoint) => (best === undefined || checkpoint.generation >= best.generation ? checkpoint : best),
            undefined,
          )
        if (candidate === undefined) throw new Error(`Cannot find the prompt checkpoint for input: ${inputId}`)
        const preview = await session.facade.previewRewind({ sessionId, checkpointId: candidate.checkpointId })
        if (!preview.canCommit) throw new Error("Session cannot rewind to the selected message")
        // The appended head move reaches the driver through the live
        // attachment as a resync, so the projection rebuilds by itself.
        await session.facade.rewind({
          sessionId,
          commandId: randomUUID(),
          checkpointId: candidate.checkpointId,
          expectedRevision: preview.currentRevision,
        })
        return { restoredDraft: tracked.text }
      },
      compact: async (input) => {
        // A stopped session must not compact: rewriting a history the
        // switch already abandoned would leave no observer able to
        // reconcile the resulting lineage.
        if (stopped) throw new Error("The session was stopped")
        if (degraded) return blockedMutation("compact", input)
        const result = await session.facade.compact({
          sessionId,
          commandId: randomUUID(),
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        })
        return {
          changed: result.changed,
          inputMessageCount: result.inputMessageCount,
          outputMessageCount: result.outputMessageCount,
          ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
        }
      },
      setPermissionMode: async ({ mode }) => {
        // A stopped session answers like a lost race: no command leaves,
        // and canonical events own the display anyway.
        if (stopped) return false
        if (degraded) {
          options.onDegradedAttempt?.({ method: "setPermissionMode", input: { mode } })
          return false
        }
        // The selectable set already excludes auto without a Guardian,
        // so one membership check covers both the grammar and the gate.
        if (!(session.selectableModes as readonly string[]).includes(mode)) return false
        try {
          await session.facade.setPermissionMode({
            sessionId,
            mode: mode as PublicPermissionModeValue,
            expectedPolicyRevision: policyRevision,
          })
          return true
        } catch {
          // A stale policy revision or a concurrent mode/rules change lost
          // the race by design: the canonical event stream owns every mode
          // display, so the failed rotation surfaces as "nothing changed".
          return false
        }
      },
      setPermissionRules: async ({ rules }) => {
        // Same stopped-session contract as the mode commit.
        if (stopped) return false
        if (degraded) {
          options.onDegradedAttempt?.({ method: "setPermissionRules", input: { rules } })
          return false
        }
        // Ingest guard mirrors the mode commit: rows outside the live
        // grammar never reach the canonical command; false lands as stale
        // feedback while the canonical set keeps displaying.
        if (!rules.every((rule) => rule.name.trim().length > 0 && RULE_BEHAVIORS.includes(rule.behavior))) {
          return false
        }
        try {
          await session.facade.setPermissionRules({ sessionId, rules: validRules(rules), expectedPolicyRevision: policyRevision })
          return true
        } catch {
          // Same race contract as the mode commit: the full-set command
          // lost a policy-revision race; canonical events own the display,
          // so the failed commit surfaces as "nothing changed".
          return false
        }
      },
      addAdditionalDirectory: async ({ directory }) => {
        // Same stopped-session contract as the permission commits; the
        // reason answers in place of a thrown error so the slash surface
        // can letter it.
        if (stopped) return { ok: false, error: "The session was stopped" }
        if (degraded) {
          options.onDegradedAttempt?.({ method: "addAdditionalDirectory", input: { directory } })
          return { ok: false, error: "The session is read-only (unsupported_event)" }
        }
        try {
          const result = await session.facade.addDirectory({
            sessionId,
            commandId: `add-directory:${randomUUID()}`,
            directory,
            ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
            ...(scopeRevisionKnown ? { expectedScopeRevision: scopeRevision } : {}),
          })
          scopeRevision = result.scopeRevision
          scopeRevisionKnown = true
          options.onAdditionalDirectories?.(result.additionalDirectories)
          return { ok: true, canonical: result.directory, changed: result.changed }
        } catch (error) {
          // A stale scope revision or transport failure keeps the scope
          // unchanged; the canonical event stream owns every display.
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    },
    approval: {
      resolve: async ({ requestId, optionId }) => {
        // A stopped session can no longer settle anything: the durable
        // approval_required terminal owns the abandoned decision on the
        // next resume, so this reads as a lost race and sends nothing.
        if (stopped) return false
        if (degraded) {
          options.onDegradedAttempt?.({ method: "approval.resolve", input: { requestId, optionId } })
          return false
        }
        const context = approvalContexts.get(requestId)
        if (context === undefined) return false
        approvalContexts.delete(requestId)
        try {
          await session.facade.resolveInteraction({
            sessionId,
            // The retry identity; idempotency itself is keyed on the interaction.
            resolutionId: randomUUID(),
            kind: "tool_approval",
            interactionId: context.interactionId,
            optionId,
            expectedPolicyRevision: context.policyRevision,
            expectedScopeRevision: context.scopeRevision,
          })
          return true
        } catch {
          // A stale or racing resolution is a no-op for the UI: the
          // canonical resolution event owns the outcome.
          return false
        }
      },
    },
    ask: {
      resolve: async ({ requestId, answer }) => {
        // Same stopped-session contract as an approval: the abandoned
        // ask stays durably pending for the next resume.
        if (stopped) return false
        if (degraded) {
          options.onDegradedAttempt?.({ method: "ask.resolve", input: { requestId, answer } })
          return false
        }
        if (!askRequests.has(requestId)) return false
        try {
          await session.facade.resolveInteraction({
            sessionId,
            // The retry identity; idempotency itself is keyed on the interaction.
            resolutionId: randomUUID(),
            kind: "ask_user",
            interactionId: requestId,
            answer,
          })
          return true
        } catch {
          // A stale or racing resolution is a no-op for the UI: the
          // canonical resolution event owns the outcome.
          return false
        }
      },
    },
  }

  return {
    ports,
    selectableModes: session.selectableModes,
    mailboxQueued: () => (stopped ? [] : (ingress?.mailboxQueued() ?? [])),
    planSummaries: () => (stopped ? [] : (ingress?.planSummaries() ?? [])),
    async start() {
      if (stopped || driver !== null) return
      ingress = createTuiIngress({
        writer: options.writer,
        replay: true,
        ...(options.agents === undefined ? {} : { agents: options.agents }),
      })
      driver = createTuiSessionDriver({
        ingress,
        onFacts: handleFacts,
        ...(options.onApplied === undefined ? {} : { onApplied: options.onApplied }),
        attach: (callbacks) => session.attachPublicProjection(callbacks),
        readPublicEvents: () => session.readPublicEvents(),
        onEvents: observeSessionEvents,
        onDegradationChange: (value) => {
          degraded = value
          options.onDegradationChange?.(value)
        },
        ...(options.onAdoptionFailure === undefined ? {} : { onAdoptionFailure: options.onAdoptionFailure }),
      })
      // Seed before the backlog: pending approval cards are live-only
      // surfaces, and a seed failure must not kill the loop (the driver
      // keeps running live, exactly like a backlog-read failure).
      try {
        await seedFromSnapshot()
      } catch (error) {
        options.onAdoptionFailure?.(error)
      }
      await driver.start()
    },
    stop() {
      stopped = true
      driver?.stop()
      driver = null
    },
  }
}
