/**
 * Embedded session composition: the TUI's business ports and event loop
 * over one process-private session client. Prompt submissions ride the
 * canonical start_run command (the host appends the user row and drives
 * the agent loop; the port resolves at durable admission — failure and
 * cancellation render through the canonical events, not the promise).
 * Bang commands ride execute_user_shell, which never enters the run
 * loop. Approval decisions ride resolve_approval with the credentials
 * carried on the ingress fact, captured as facts flow through this
 * module's fact handler. Events apply through the projection ingress;
 * the driver owns attach-before-backlog adoption and overflow resync.
 */
import { randomUUID } from "node:crypto"
import { runId as mintRunId } from "@ag2cli/core/ids.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import { sameHistoryCursor } from "@ag2cli/core/session/canonical-session.js"
import {
  SESSION_PERMISSION_MODES,
  SESSION_PERMISSION_RULE_BEHAVIORS,
  assertExplicitSessionCreatedPolicy,
  type SessionPermissionMode,
  type SessionPermissionRule,
} from "@ag2cli/core/session/session-security.js"
import { createSessionActions } from "@ag2cli/client/session-actions.js"
import type { SessionClient } from "@ag2cli/client/session-client.js"
import {
  addAdditionalDirectoryCommand,
  executeUserShellCommand,
  listCheckpointsCommand,
  previewRewindCommand,
  readEventsCommand,
  rewindCommand,
  resolveApprovalCommand,
  setPermissionModeCommand,
  setPermissionRulesCommand,
} from "@ag2cli/protocol/session-command.js"
import type { ApprovalRequestInput, ChildAgentsPanel, PermissionRule } from "../ui/tui/state/index.js"
import type { SessionProjectionWriter } from "../ui/tui/sessionprojection/index.js"
import type { AskUserBridge } from "./ask-user-bridge.js"
import { createTuiIngress, type TuiIngressFact } from "./tui-ingress.js"
import { createTuiSessionDriver } from "./tui-session-driver.js"

/** Credentials minted onto the approval fact by the ingress. */
interface ApprovalResolveContext {
  readonly runId: string
  readonly turn: number
  readonly preparedEventId: string
  readonly scopeRevision: number
  readonly policyRevision: number
}

/**
 * The business surface one embedded session exposes to the Ink host.
 * After stop() the ports follow one contract: submitInput, executeShell
 * and rewindToInput reject with "The session was stopped" (nothing may
 * mutate an abandoned runtime), setPermissionMode, setPermissionRules
 * and approval.resolve answer false — the race-lost shape, with the
 * canonical event stream owning every display — addAdditionalDirectory
 * answers ok:false with the reason, and cancelInput stays
 * live so late admissions can still be returned to their port.
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
    executeShell(input: { readonly command: string; readonly signal?: AbortSignal }): Promise<string>
    rewindToInput(input: { readonly inputId: string }): Promise<{ readonly restoredDraft: string }>
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
    resolve(input: { readonly requestId: string; readonly decision: "approved" | "denied" }): Promise<boolean>
  }
  readonly answers?: Pick<AskUserBridge, "settle">
}

export interface TuiEmbeddedSessionOptions {
  readonly client: SessionClient
  /**
   * Bootstrap workspace root for the directory add against a log that
   * holds no SessionCreated yet; the canonical feed overrides it the
   * moment a SessionCreated is observed.
   */
  readonly workspaceRoot?: string
  /** The session projection's writer half; the ingress drives it directly. */
  readonly writer: SessionProjectionWriter
  /**
   * Child-agents panel the ingress routes delegation facts into; the
   * host owns the object so the store it mirrors and the ingress that
   * feeds it share one panel.
   */
  readonly agents?: ChildAgentsPanel
  /** Live approval requests (replayed history never raises cards). */
  readonly onApprovalRequest?: (request: ApprovalRequestInput) => void
  /** Run-state edge for footer rendering: running at issue, terminal at settle. */
  readonly onRunStateChange?: (state: "running" | "completed" | "failed" | "cancelled") => void
  /** Model/context telemetry sniffed from assistant turns (footer source). */
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
   * Canonical session permission mode (footer source): SessionCreated seeds
   * it and SessionPermissionModeSet updates it. The footer chip and the
   * root rotation probe read the mode only through this canonical feed.
   */
  readonly onPermissionMode?: (mode: string) => void
  /**
   * Canonical session permission rules (rules-panel source): the
   * SessionCreated seed and every SessionPermissionRulesSet land here. The
   * panel rows and the slash upsert base read rules only through this
   * canonical feed; malformed replayed rows are dropped, not forwarded.
   */
  readonly onPermissionRules?: (rules: readonly PermissionRule[]) => void
  /**
   * Authorized workspace root (the Permissions card's Workspace tab
   * source): SessionCreated seeds it on every delivery path, so a
   * resumed session's root overrides whatever the host held before.
   */
  readonly onWorkspaceRoot?: (root: string) => void
  /**
   * Canonical additional workspace directories (the Workspace tab's
   * rows): the SessionCreated seed and every
   * SessionAdditionalDirectoryAdded land here — each add carries its
   * directory list, or the directory it named when durable history
   * predates the list — so a replay resyncs to the same set.
   */
  readonly onAdditionalDirectories?: (directories: readonly string[]) => void
  /**
   * The projection moved (a durable batch, a transient batch, a resync
   * rebuild); the host re-mirrors content on this signal.
   */
  readonly onApplied?: () => void
  /** Backlog-read failure surface; the loop keeps running live-only. */
  readonly onAdoptionFailure?: (error: unknown) => void
  /** Guardian reviewer availability; auto is committable only when a Guardian answers asks. */
  readonly guardianAvailable?: boolean
  /** Ask-user answer port, passed through to the host build. */
  readonly answers?: AskUserBridge
}

export interface TuiEmbeddedSession {
  /** Business ports for the Ink host's composition root. */
  readonly ports: TuiEmbeddedSessionPorts
  /** Attach the event loop; adopts the backlog, then flips to live. No-op once stopped. */
  start(): Promise<void>
  /** Detach the event loop; in-flight submissions are signalled elsewhere. Terminal: a stopped session never restarts. */
  stop(): void
}

export function createTuiEmbeddedSession(options: TuiEmbeddedSessionOptions): TuiEmbeddedSession {
  const { client } = options
  const approvalContexts = new Map<string, ApprovalResolveContext>()
  const sessionActions = createSessionActions(client, { commandId: randomUUID })
  let driver: ReturnType<typeof createTuiSessionDriver> | null = null
  // Terminal once stop() runs: a switch can tear this session down while
  // its own backlog read is still in flight on its own transport
  // timeline, and the late read's canonical facts must never reach the
  // shared host hooks (the driver discards the result, but observation
  // runs inside the read's promise).
  let stopped = false
  // Canonical permission facts observed from the event stream: the mode
  // feeds the footer through the callback, the policy revision guards
  // rotation commands. Observation rides every durable delivery path
  // (live subscription, backlog read, overflow resync); replays are
  // idempotent because the last event always wins.
  let policyRevision = 0
  // Scope facts the directory add bakes: the revision guards the same
  // optimistic race the policy revision guards, and the root
  // bootstraps an add before any SessionCreated is observed.
  let scopeRevision = 0
  let activeWorkspaceRoot = options.workspaceRoot
  // Replay tolerance (R1/R7): durable history may predate today's ingest
  // bounds, so observed rows are filtered to the live grammar (non-empty
  // name after trim, known behavior) before they reach the TUI feed.
  const validObservedRules = (rules: readonly SessionPermissionRule[]): readonly PermissionRule[] =>
    rules.filter(
      (rule) =>
        typeof rule?.name === "string" &&
        rule.name.trim().length > 0 &&
        (SESSION_PERMISSION_RULE_BEHAVIORS as readonly string[]).includes(rule.behavior),
    )
  const observeSessionEvents = (events: readonly AgentEvent[]): void => {
    for (const event of events) {
      if (event.type === "SessionCreated") {
        // Pre-policy history carries no explicit mode/rules/revision; the
        // observer fails closed with the canonical error instead of
        // tolerating it — every authoritative use case already rejects
        // such sessions, so mirroring defaults would diverge from replay.
        assertExplicitSessionCreatedPolicy(event.payload)
        policyRevision = event.payload.policyRevision
        scopeRevision = event.payload.scopeRevision ?? 0
        activeWorkspaceRoot = event.payload.workspaceRoot
        options.onPermissionMode?.(event.payload.permissionMode)
        options.onPermissionRules?.(validObservedRules(event.payload.permissionRules))
        options.onWorkspaceRoot?.(event.payload.workspaceRoot)
        // Canonical replay accepts the creation payload's directory set
        // as a seed; every creation path today mints it empty, but the
        // mirror stays symmetric with the canonical derivation.
        options.onAdditionalDirectories?.(event.payload.additionalDirectories ?? [])
      } else if (event.type === "SessionPermissionModeSet") {
        policyRevision = event.payload.policyRevision
        options.onPermissionMode?.(event.payload.mode)
      } else if (event.type === "SessionPermissionRulesSet") {
        policyRevision = event.payload.policyRevision
        options.onPermissionRules?.(validObservedRules(event.payload.rules))
      } else if (event.type === "SessionAdditionalDirectoryAdded") {
        // The add moves both revisions: without tracking the policy one
        // the next permission commit would bake a stale revision and
        // lose, and the scope one would make the next add's guard stale.
        // The set replaces on every event — canonical replay clears and
        // rebuilds per event, so the last event wins even when its list
        // is absent and only the named directory survives.
        policyRevision = event.payload.policyRevision
        scopeRevision = event.payload.scopeRevision
        options.onAdditionalDirectories?.(event.payload.additionalDirectories ?? [event.payload.directory])
      } else if (event.type === "RunCompleted") {
        options.onRunStateChange?.("completed")
      } else if (event.type === "RunFailed") {
        options.onRunStateChange?.("failed")
      } else if (event.type === "RunCancelled") {
        options.onRunStateChange?.("cancelled")
      }
    }
  }

  const readEvents = async (fromRevision: number): Promise<readonly AgentEvent[]> => {
    const result = await client.execute(readEventsCommand(fromRevision))
    return result.type === "events" ? result.events : []
  }

  const handleFacts = (facts: readonly TuiIngressFact[]): void => {
    for (const fact of facts) {
      if (fact.kind === "approval-request") {
        approvalContexts.set(fact.requestId, fact.resolve)
        options.onApprovalRequest?.({ requestId: fact.requestId, toolName: fact.toolName, summary: fact.summary, version: fact.version })
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

  const ports: TuiEmbeddedSessionPorts = {
    session: {
      submitInput: async (input) => {
        // A stopped session must not admit new runs: the switch already
        // abandoned this runtime, so a late submit would start a run no
        // observer can reconcile — refuse before the command leaves.
        if (stopped) throw new Error("The session was stopped")
        try {
          const receipt = await sessionActions.submitInput(input)
          // A switch can stop this session while the submit is in
          // flight; the late state must not stamp the live session's
          // footer through the shared hooks.
          if (!stopped) options.onRunStateChange?.("running")
          return receipt
        } catch (error) {
          if (!stopped) options.onRunStateChange?.("failed")
          throw error
        }
      },
      cancelInput: sessionActions.cancelInput,
      executeShell: async ({ command, signal }) => {
        // A stopped session is off its host loop: a late bang would run
        // detached from every observer, so it is refused outright.
        if (stopped) throw new Error("The session was stopped")
        const result = await client.execute(executeUserShellCommand({ commandId: randomUUID(), command }), { signal })
        if (result.type !== "shell_result") throw new Error("Session did not return shell_result")
        return result.result.content
      },
      rewindToInput: async ({ inputId }) => {
        // A rewind against a stopped session would rewrite the history
        // the switch already abandoned — refuse before any reads.
        if (stopped) throw new Error("The session was stopped")
        const events = await readEvents(0)
        const consumed = events.find(
          (event): event is Extract<AgentEvent, { type: "InputConsumed" }> =>
            event.type === "InputConsumed" && event.payload.inputId === inputId,
        )
        if (consumed === undefined) throw new Error(`Cannot find consumed input for rewind: ${inputId}`)

        const listed = await client.execute(listCheckpointsCommand())
        if (listed.type !== "checkpoints") throw new Error("Session did not return checkpoints")
        const checkpoint = listed.checkpoints.find(
          (candidate) => candidate.kind === "prompt" && sameHistoryCursor(candidate.head, consumed.payload.parent),
        )
        if (checkpoint === undefined) throw new Error(`Cannot find the prompt checkpoint for input: ${inputId}`)

        const preview = await client.execute(previewRewindCommand({ checkpointId: checkpoint.checkpointId }))
        if (preview.type !== "rewind_preview" || !preview.preview.canCommit) {
          throw new Error("Session cannot rewind to the selected message")
        }
        const result = await client.execute(
          rewindCommand({
            commandId: randomUUID(),
            checkpointId: checkpoint.checkpointId,
            expectedRevision: preview.preview.currentRevision,
          }),
        )
        if (result.type !== "rewind_result") throw new Error("Session did not complete the rewind")
        return { restoredDraft: consumed.payload.text }
      },
      setPermissionMode: async ({ mode }) => {
        // A stopped session answers like a lost race: no command leaves,
        // and canonical events own the display anyway.
        if (stopped) return false
        if (!(SESSION_PERMISSION_MODES as readonly string[]).includes(mode)) return false
        // auto is committable only behind a configured Guardian reviewer.
        if (mode === "auto" && !options.guardianAvailable) return false
        try {
          await client.execute(
            setPermissionModeCommand({
              commandId: `permission-mode:${randomUUID()}`,
              mode: mode as SessionPermissionMode,
              expectedPolicyRevision: policyRevision,
            }),
          )
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
        // Ingest guard mirrors the mode commit: rows outside the live
        // grammar never reach the canonical command; false lands as stale
        // feedback while the canonical set keeps displaying.
        if (
          !rules.every(
            (rule) => rule.name.trim().length > 0 && (SESSION_PERMISSION_RULE_BEHAVIORS as readonly string[]).includes(rule.behavior),
          )
        ) {
          return false
        }
        try {
          await client.execute(
            setPermissionRulesCommand({
              commandId: `permission-rules:${randomUUID()}`,
              rules: rules as readonly SessionPermissionRule[],
              expectedPolicyRevision: policyRevision,
            }),
          )
          return true
        } catch {
          // Same race contract as the mode commit: the full-set command
          // lost a policy-revision race; canonical events own the display,
          // so the failed commit surfaces as "nothing changed".
          return false
        }
      },
      addAdditionalDirectory: async ({ directory, signal }) => {
        // Same stopped-session contract as the permission commits; the
        // reason answers in place of a thrown error so the slash surface
        // can letter it.
        if (stopped) return { ok: false, error: "The session was stopped" }
        try {
          const result = await client.execute(
            addAdditionalDirectoryCommand({
              commandId: `add-directory:${randomUUID()}`,
              directory,
              ...(activeWorkspaceRoot === undefined ? {} : { workspaceRoot: activeWorkspaceRoot }),
              expectedScopeRevision: scopeRevision,
            }),
            { signal },
          )
          if (result.type !== "additional_directory_added") {
            return { ok: false, error: "Session did not complete the directory add" }
          }
          return { ok: true, canonical: result.directory, changed: result.changed }
        } catch (error) {
          // A stale scope revision or transport failure keeps the scope
          // unchanged; the canonical event stream owns every display.
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    },
    approval: {
      resolve: async ({ requestId, decision }) => {
        // A stopped session can no longer settle anything: the durable
        // approval_required terminal owns the abandoned decision on the
        // next resume, so this reads as a lost race and sends nothing.
        if (stopped) return false
        const context = approvalContexts.get(requestId)
        if (context === undefined) return false
        approvalContexts.delete(requestId)
        try {
          await client.execute(
            resolveApprovalCommand({
              runId: mintRunId(context.runId),
              turn: context.turn,
              toolUseId: requestId,
              preparedEventId: context.preparedEventId,
              expectedScopeRevision: context.scopeRevision,
              expectedPolicyRevision: context.policyRevision,
              decision,
            }),
          )
          return true
        } catch {
          // A stale or racing resolution is a no-op for the UI: the
          // canonical ToolApprovalResolved event owns the outcome.
          return false
        }
      },
    },
    ...(options.answers === undefined ? {} : { answers: options.answers }),
  }

  return {
    ports,
    async start() {
      if (stopped || driver !== null) return
      driver = createTuiSessionDriver({
        ingress: createTuiIngress({
          writer: options.writer,
          replay: true,
          ...(options.agents === undefined ? {} : { agents: options.agents }),
        }),
        onFacts: handleFacts,
        ...(options.onApplied === undefined ? {} : { onApplied: options.onApplied }),
        readEvents: async (fromRevision) => {
          const events = await readEvents(fromRevision)
          if (stopped) return events
          observeSessionEvents(events)
          return events
        },
        subscribe: (listener) =>
          client.subscribe(
            0,
            (events) => {
              // stop() detaches this subscription; the guard covers a
              // transport whose unsubscribe settles late.
              if (stopped) return
              observeSessionEvents(events)
              listener(events)
            },
            {
              onOverflow: () => {
                void driver?.resync()
              },
            },
          ),
        ...(client.subscribeTransient === undefined
          ? {}
          : {
              subscribeTransient: (listener) => client.subscribeTransient!((event) => listener(event)),
            }),
        ...(options.onAdoptionFailure === undefined ? {} : { onAdoptionFailure: options.onAdoptionFailure }),
      })
      await driver.start()
    },
    stop() {
      stopped = true
      driver?.stop()
      driver = null
    },
  }
}
