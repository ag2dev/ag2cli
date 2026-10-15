/**
 * TUI Ink host: the composition orchestrator that binds one embedded
 * session, the framework-free store, the slash registry, the run queue,
 * the theme transaction and the Ink frame into a single lifecycle. The
 * host owns every mirror — session content and the queued preview into
 * the store, footer telemetry from the canonical observation feeds —
 * and executes every effect the store bubbles (submissions through the
 * run queue, slash dispatch, card commits, exits). The entrypoint keeps
 * only what cannot live here: config, the model client and runtime
 * build, session selection, signals and process exit; it supplies the
 * session factory and the identity lines, and everything else flows
 * through this seam. Run-slot release reconciles against the
 * projection's canonical rows (the consumed input's run reached its
 * terminal and left the parked set), never against a raw callback edge
 * — bang commands run their own canonical runs and must never free a
 * slot a model run still owns. The host also owns the process-local
 * full-access confirmation facts: submissions on a full-access session
 * this process has not confirmed are gated at the run seam, and the
 * confirmation card's Enter records the session-keyed fact.
 */
import type { TuiThemePreferenceStore } from "../config/config-file.js"
import { SESSION_PERMISSION_MODES } from "@ag2cli/core/session/session-security.js"
import { clipText, type ThemeId } from "../ui/tui/text/index.js"
import type { ScreenPreparation, TerminalScreen } from "../ui/tui/screen/index.js"
import {
  CORE_SLASH_COMMANDS,
  cardSlashCommands,
  ChildAgentsPanel,
  createRunQueue,
  createSlashCommandRegistry,
  createTuiSlashHost,
  isSessionIndependentEffect,
  permissionModeChip,
  permissionModePanelLabel,
  reportSlashCommands,
  resolveSlashBusyPolicy,
  type FooterTelemetry,
  type PermissionModeOption,
  type PermissionRule,
  type ResumeSessionOption,
  type RewindCheckpoint,
  type SlashDispatchStaleReason,
  type SlashInput,
  type SlashNotice,
  type SlashWorkspaceDiffFile,
  type TuiCompletionSources,
  type TuiRunQueueEvent,
  type TuiStateEffect,
  type TuiStateStore,
} from "../ui/tui/state/index.js"

/** The completion items the entrypoint's workspace scan feeds into @. */
export type { CompletionItem } from "../ui/tui/state/index.js"
import { createTuiStateStore } from "../ui/tui/state/index.js"
import type { SessionProjectionWriter, TuiSessionProjection } from "../ui/tui/sessionprojection/index.js"
import { createSessionProjection } from "../ui/tui/sessionprojection/index.js"
import { createInkTuiFrame } from "../ui/tui/bootstrap/ink.js"
import { createAskUserBridge, type AskUserBridge } from "./ask-user-bridge.js"
import type { ChildApprovalBridge } from "./child-approval-bridge.js"
import { createTuiChildApprovals } from "./tui-child-approvals.js"
import { createTuiThemeCoordinator } from "./tui-theme.js"
import type { TuiEmbeddedSession, TuiEmbeddedSessionOptions } from "./tui-embedded-session.js"

/** Observation hooks the host wires into every embedded session it builds. */
export type TuiHostSessionHooks = Omit<TuiEmbeddedSessionOptions, "client" | "writer" | "answers" | "agents">

/** Everything the session factory needs to build one embedded session. */
export interface TuiHostSessionFactoryContext {
  /** Session to adopt; absent mints a fresh one. */
  readonly sessionId?: string
  /** The host's single projection writer (shared across session switches). */
  readonly writer: SessionProjectionWriter
  /** The host's observation hooks (approval raises, telemetry, mirrors). */
  readonly hooks: TuiHostSessionHooks
  /** The ask bridge: askUser rides the runtime build, settle stays host-side. */
  readonly ask: AskUserBridge
  /** The child-agents panel: the store renders it, the ingress feeds it. */
  readonly agents: ChildAgentsPanel
}

/** Identity lines the resting screen carries until the first session row. */
export interface TuiHostIdentity {
  readonly brand: string
  readonly workspace?: string
  readonly model?: string
}

export interface TuiInkHostOptions {
  /** The terminal the frame owns (lifecycle injected by the entrypoint). */
  readonly screen: TerminalScreen
  /** Builds one embedded session; called at start and on every switch. */
  readonly createSession: (context: TuiHostSessionFactoryContext) => TuiEmbeddedSession
  readonly identity: TuiHostIdentity
  /** Theme: the active palette, and the JSONC persistence seam. */
  readonly initialTheme?: ThemeId
  readonly themeConfigPath?: string
  readonly themePreference?: TuiThemePreferenceStore
  /** Open the theme picker once the frame starts (first run, no committed theme). */
  readonly firstRunThemeSelection?: boolean
  /** Static footer and /status facts the entrypoint derives from config. */
  readonly providerName?: string
  readonly modelName?: string
  readonly endpoint?: string
  readonly contextWindow?: number
  readonly effort?: string
  /** Permission rotation ring and card options; defaults to the interactive mode ring, empty disables both. */
  readonly permissionModes?: readonly PermissionModeOption[]
  /** Guardian reviewer availability; auto joins the /permissions card only when a Guardian is configured. */
  readonly guardianAvailable?: boolean
  /** Label mapping for the /status mode line; defaults to the footer chip. */
  readonly modeLabel?: (mode: string) => string
  /** Completion corpora for @ and / tokens. */
  readonly completion?: TuiCompletionSources
  /** Prompt history seed; every prompt and bang submission records back. */
  readonly history?: readonly string[]
  readonly onHistory?: (text: string) => void
  /** Working-tree facts for /diff; absent keeps the command honest. */
  readonly diffFiles?: {
    files(signal?: AbortSignal): Promise<readonly SlashWorkspaceDiffFile[]> | readonly SlashWorkspaceDiffFile[]
  }
  /** Resumable sessions for /resume; the host wires resume to its own switch. */
  readonly sessions?: {
    list(): Promise<readonly ResumeSessionOption[]> | readonly ResumeSessionOption[]
  }
  /** Cancels the focused delegated child; the entrypoint bridges to the child runner. */
  readonly onCancelChild?: (childSessionId: string) => void
  /** Process exit seam; the exit effect tears the host down first. */
  readonly onExit?: () => void
  /**
   * A fatal frame fault the frame restored the terminal for already;
   * the production entrypoint exits the process here.
   */
  readonly onFatal?: (reason: string) => void
}

export interface TuiInkHost {
  /** The store the frame renders (tests drive inputs through it). */
  readonly store: TuiStateStore
  /** The ask bridge the runtime build injects as its ask-user callback. */
  readonly ask: AskUserBridge
  /**
   * The child approval bridge: child sessions' tool approvals and asks
   * park here and raise onto the same card surface; card decisions
   * settle back through it by token before any parent port.
   */
  readonly childApprovals: ChildApprovalBridge
  /**
   * Capability gate, then the session loop over the given session (an
   * absent id leaves the session choice to the factory); returns the
   * screen verdict.
   */
  start(input?: { readonly sessionId?: string }): Promise<ScreenPreparation>
  /** Resolves once pending frame output has flushed; rethrows frame faults. */
  flush(): Promise<void>
  /** Tear the session loop and frame down; idempotent, never exits. */
  stop(options?: { readonly diagnostics?: string }): Promise<void>
  /** Adopt another session: cancels the old inputs, resets, replays. */
  switchSession(sessionId: string): Promise<void>
}

/** Rewind labels fold to one clipped line — the card lists many of them. */
const compactRewindLabel = (body: string): string => clipText(body.replace(/\s+/g, " ").trim(), 72).text

/** The interactive permission modes: auto (Guardian-answered) appears only when a Guardian is configured. */
const interactivePermissionModes = (guardian: boolean): readonly PermissionModeOption[] =>
  SESSION_PERMISSION_MODES.filter((mode) => mode !== "auto" || guardian).map((mode) => ({
    mode,
    label: permissionModeChip(mode),
    description: permissionModePanelLabel(mode),
  }))

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createTuiInkHost(options: TuiInkHostOptions): TuiInkHost {
  const permissionModes = options.permissionModes ?? interactivePermissionModes(options.guardianAvailable === true)
  const projection = createSessionProjection() as TuiSessionProjection & SessionProjectionWriter
  // Revision the store last mirrored: the projection's change log is
  // read incrementally between mirrors, never rescanned.
  let mirroredRevision = 0
  let session: TuiEmbeddedSession | null = null
  let generation = 0
  let activeInputId: string | null = null
  let activeRunId: string | null = null
  // Interrupts free the run slot without a generation bump (switches
  // and teardown bump it), so every in-flight settlement also carries
  // the submission epoch it started under: a late admission receipt, a
  // bang's port settle, or a slash dispatch that outlived the abort
  // must neither adopt run tracking nor free a slot a newer submission
  // owns.
  let submissionEpoch = 0
  // The session the live view owns: adopted at start, replaced by every
  // switch. The host owns this fact because it owns the switches.
  let currentSessionId: string | null = null
  // Sessions whose full-access disclosure this process confirmed: the
  // fact is process-local and session-keyed, never cleared by a switch,
  // so returning to a confirmed session reuses it while a distinct or
  // resumed full-access session re-gates.
  const confirmedFullAccess = new Set<string>()
  const fullAccessConfirmed = (): boolean => currentSessionId !== null && confirmedFullAccess.has(currentSessionId)
  let tornDown = false
  let teardownPromise: Promise<void> | undefined
  let preparation: ScreenPreparation | undefined
  // Late-bound theme seams: the store seeds its card focus from the
  // committed theme and the coordinator swaps the live frame's palette,
  // but the coordinator needs the frame and the frame needs the store.
  let committedThemeSource: () => string | null = () => null
  let applyTheme: (theme: ThemeId) => void = () => {}

  // Canonical observation state: the footer and the report commands
  // read these; the canonical feeds own every value (last event wins).
  let permissionMode: string | null = null
  let permissionRules: readonly PermissionRule[] = []
  // Authorized workspace root mirrored from the canonical SessionCreated
  // feed; the Permissions card's Workspace tab reads only this mirror.
  let workspaceRoot: string | null = null
  // Canonical additional workspace directories mirrored from the
  // SessionAdditionalDirectoryAdded feed; the Workspace tab's view-only
  // rows read only this mirror.
  let additionalDirectories: readonly string[] = []
  const telemetry: {
    providerName?: string
    modelName?: string
    contextTokens?: number
    contextEstimated?: boolean
    contextWindow?: number
    sessionStatus: string
    effort?: string
  } = {
    ...(options.providerName === undefined ? {} : { providerName: options.providerName }),
    ...(options.modelName === undefined ? {} : { modelName: options.modelName }),
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    sessionStatus: "created",
  }
  const modeLabel = options.modeLabel ?? permissionModeChip

  /** Rewindable user rows from the projection; the rewind card lists them. */
  const rewindCheckpoints = (): readonly RewindCheckpoint[] =>
    projection
      .content()
      .transcript.flatMap((block) =>
        block.kind === "user" && block.inputId !== undefined && block.inputId.length > 0
          ? [{ inputId: block.inputId, label: compactRewindLabel(block.body) }]
          : [],
      )

  const registry = createSlashCommandRegistry([
    ...CORE_SLASH_COMMANDS,
    ...reportSlashCommands({
      runtime: () => {
        const reportSessionId = currentSessionId
        return {
          ...(telemetry.providerName === undefined ? {} : { providerName: telemetry.providerName }),
          ...(telemetry.modelName === undefined ? {} : { modelName: telemetry.modelName }),
          ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
          ...(reportSessionId === null || reportSessionId === undefined ? {} : { sessionId: reportSessionId }),
          ...(telemetry.contextTokens === undefined ? {} : { contextTokens: telemetry.contextTokens }),
          ...(telemetry.contextWindow === undefined ? {} : { contextWindow: telemetry.contextWindow }),
          ...(telemetry.contextEstimated === undefined ? {} : { contextEstimated: telemetry.contextEstimated }),
        }
      },
      permissionMode: () => permissionMode,
      modeLabel,
    }),
    ...cardSlashCommands({
      rewind: { checkpoints: rewindCheckpoints },
      ...(options.diffFiles === undefined ? {} : { diff: options.diffFiles }),
      ...(options.sessions === undefined
        ? {}
        : {
            sessions: {
              list: options.sessions.list,
              currentSessionId: () => currentSessionId,
              // A quiet resolution is a superseded switch, not a landed
              // one: only the session still on screen counts as resumed,
              // so a superseded attempt reports its failure instead of
              // painting the destination's success on the newer session.
              resume: (sessionId: string) =>
                switchSession(sessionId).then(
                  // A quiet resolution past teardown still leaves the
                  // target id on record; no client remains to resume.
                  () => !tornDown && currentSessionId === sessionId,
                  () => false,
                ),
            },
          }),
      permissions: {
        modes: () => permissionModes,
        rules: () => permissionRules,
        commitMode: (mode: string) => {
          // A typed full-access commit this process has not confirmed
          // opens the confirmation card instead of the port; the
          // canonical commit rides the card's Enter with the fact.
          // Under an ask/approval card the store drops the open like
          // every other panel open (urgent-card precedence) and the
          // commit resolves false; the command retypes once the
          // urgent card settles.
          if (mode === "full-access" && !fullAccessConfirmed()) {
            if (!tornDown) store.dispatch({ kind: "open-full-access-confirm" })
            return Promise.resolve(false)
          }
          return session?.ports.session.setPermissionMode({ mode }) ?? Promise.resolve(false)
        },
        commitRules: (rules: readonly PermissionRule[]) => session?.ports.session.setPermissionRules({ rules }) ?? Promise.resolve(false),
      },
      workspaceDirectory: {
        // The port owns the canonical add; no session attached means the
        // letter answers in place (the queue drains it the same way).
        add: (directory: string, signal?: AbortSignal) =>
          session?.ports.session.addAdditionalDirectory({ directory, signal }) ??
          Promise.resolve({ ok: false as const, error: "No active session" }),
      },
    }),
  ])

  const runqueue = createRunQueue({
    busyPolicy: (input: SlashInput) => resolveSlashBusyPolicy(registry.resolve(input.name), input),
  })

  // The one child-agents panel: the store mirrors its view state while
  // the live ingress of the attached session feeds it delegation facts.
  const agents = new ChildAgentsPanel()

  const store = createTuiStateStore(options.completion, {
    agents,
    ...(options.history === undefined ? {} : { history: options.history }),
    intro: [
      options.identity.brand,
      ...(options.identity.workspace === undefined ? [] : [`workspace: ${options.identity.workspace}`]),
      ...(options.identity.model === undefined ? [] : [`model: ${options.identity.model}`]),
      "type a message, @ to mention, / for commands",
    ],
    // ADR §3 ring rule: Shift+Tab cycles the three selectable modes only;
    // full-access and auto enter through the explicit /permissions card.
    permissionModes: permissionModes.filter((mode) => mode.mode !== "full-access" && mode.mode !== "auto").map((mode) => mode.mode),
    permissionMode: () => permissionMode,
    // The confirmation facts the store's full-access interception reads:
    // the probe and the session identity both capture the host's live
    // state, so a card opened now names the session the user confirmed.
    fullAccessConfirmed,
    sessionId: () => currentSessionId,
    slash: registry,
    committedTheme: () => committedThemeSource(),
    rewind: { checkpoints: rewindCheckpoints },
    permissions: {
      modes: () => permissionModes,
      currentMode: () => permissionMode,
      rules: () => permissionRules,
      workspace: { root: () => workspaceRoot, additionalDirectories: () => additionalDirectories },
    },
  })

  const ask = createAskUserBridge((request) => {
    if (!tornDown) store.dispatch({ kind: "open-ask-card", request })
  })

  // Child approvals and asks raise onto the same card surface through
  // the bridge; the adapter owns no state, the FIFO discipline stays
  // the bridge's.
  const childApprovals = createTuiChildApprovals((input) => {
    if (!tornDown) store.dispatch(input)
  })

  const pushTelemetry = (): void => {
    if (tornDown) return
    const composed: FooterTelemetry = {
      ...(telemetry.providerName === undefined ? {} : { providerName: telemetry.providerName }),
      ...(telemetry.modelName === undefined ? {} : { modelName: telemetry.modelName }),
      ...(telemetry.contextTokens === undefined ? {} : { contextTokens: telemetry.contextTokens }),
      ...(telemetry.contextEstimated === undefined ? {} : { contextEstimated: telemetry.contextEstimated }),
      ...(telemetry.contextWindow === undefined ? {} : { contextWindow: telemetry.contextWindow }),
      sessionStatus: telemetry.sessionStatus,
      ...(permissionMode === null ? {} : { permissionMode }),
      ...(telemetry.effort === undefined ? {} : { effort: telemetry.effort }),
    }
    store.dispatch({ kind: "footer-telemetry", telemetry: composed })
  }

  const mirrorContent = (): void => {
    if (tornDown) return
    const content = projection.content()
    store.dispatch({
      kind: "session-content",
      content,
      liveTail: projection.liveTail(),
      sourceGeneration: projection.sourceGeneration(),
      changes: projection.changesSince(mirroredRevision),
    })
    mirroredRevision = content.projectionRevision
  }

  const mirrorQueue = (): void => {
    if (tornDown) return
    store.dispatch({ kind: "queue-preview", preview: runqueue.queuedPreview() })
  }

  const notice = (title: string, body: string): SlashNotice => ({ kind: "error", title, body })

  const drain = (events: readonly TuiRunQueueEvent[]): void => {
    mirrorQueue()
    for (const event of events) executeQueueEvent(event)
  }

  const executeQueueEvent = (event: TuiRunQueueEvent): void => {
    if (event.kind === "start-run") return startRun(event.prompt)
    if (event.kind === "execute-slash") return executeSlash(event.input, event.ownsSlot)
    if (event.kind === "abort-run") return abortActiveSubmission()
    const text = event.submission.kind === "prompt" ? event.submission.text : event.submission.input.raw
    store.dispatch({ kind: "load-draft", text })
    store.dispatch({
      kind: "slash-notice",
      notice: notice(
        "Input queue full",
        event.limit === "items" ? "The queue holds at most 100 parked inputs." : "The queue holds at most 8 MiB of parked input.",
      ),
    })
  }

  /**
   * Free the run slot when the submitted input's canonical run settled:
   * its user row names the run, and the terminal row (status or error)
   * with the parked run gone proves the run closed. Until then the slot
   * stays owned — an accepted-but-unconsumed input is still in flight.
   */
  const reconcileRunSlot = (): void => {
    if (activeInputId === null || tornDown) return
    const content = projection.content()
    if (activeRunId === null) {
      const consumed = content.transcript.find(
        (block) => block.kind === "user" && block.inputId === activeInputId && block.runId !== undefined,
      )
      if (consumed === undefined || consumed.kind !== "user") return
      activeRunId = consumed.runId ?? null
      if (activeRunId === null) return
    }
    const runId: string = activeRunId
    if (content.pending.some((run) => run.runId === runId)) return
    const terminal = content.transcript.some((block) => (block.kind === "status" || block.kind === "error") && block.runId === runId)
    if (!terminal) return
    activeInputId = null
    activeRunId = null
    drain(runqueue.runFinished())
  }

  const hooks: TuiHostSessionHooks = {
    onApprovalRequest: (request) => {
      if (!tornDown) store.dispatch({ kind: "approval-request", request })
    },
    onRunStateChange: (state) => {
      telemetry.sessionStatus = state
      pushTelemetry()
    },
    onContextUsage: (usage) => {
      if (usage.model !== undefined) telemetry.modelName = usage.model
      if (usage.contextTokens !== undefined) {
        telemetry.contextTokens = usage.contextTokens
        telemetry.contextEstimated = usage.contextEstimated === true
      }
      pushTelemetry()
    },
    onPermissionMode: (mode) => {
      permissionMode = mode
      pushTelemetry()
    },
    onPermissionRules: (rules) => {
      permissionRules = [...rules]
      // A rules echo moved the mirror the card reads through its probe;
      // the mirrored input reseeds an open card's rows in the same
      // revision — the landing the denial ledger's input performs.
      if (!tornDown) store.dispatch({ kind: "permission-rules-mirrored" })
    },
    onWorkspaceRoot: (root) => {
      workspaceRoot = root
    },
    onAdditionalDirectories: (directories) => {
      additionalDirectories = [...directories]
      // A directories echo moved the mirror the card reads through its
      // probe; the mirrored input reseeds an open card's rows in the
      // same revision the rules echo's input performs.
      if (!tornDown) store.dispatch({ kind: "workspace-directories-mirrored" })
    },
    onToolDenial: (denial) => {
      if (!tornDown) store.dispatch({ kind: "tool-denial", ...denial })
    },
    onApplied: () => {
      mirrorContent()
      reconcileRunSlot()
      // Child-stream facts move the panel without moving the
      // projection; the panel's own revision rides this mirror.
      if (!tornDown) store.dispatch({ kind: "agents-mirrored" })
    },
    onAdoptionFailure: (error) => {
      projection.appendLocal("error", `Session history replay failed: ${errorText(error)}`)
      mirrorContent()
    },
    guardianAvailable: options.guardianAvailable === true,
  }

  /**
   * One started submission. Bang texts ride execute_user_shell — their
   * canonical run renders the whole row (the run start claims it, the
   * tool result settles it) and frees the slot when the port settles;
   * prompts ride start_run and resolve at durable admission, with the
   * slot released by the canonical reconcile above.
   */
  const startRun = (text: string): void => {
    options.onHistory?.(text)
    if (session === null || tornDown) {
      // Nothing to submit to: surface why the text drained away — a
      // failed attach leaves no session, and /resume is the way back
      // in. Teardown drains silently; there is no screen left to tell.
      if (!tornDown) {
        store.dispatch({
          kind: "slash-notice",
          notice: notice("Error · run", "No active session — use /resume to attach one"),
        })
      }
      drain(runqueue.runFinished())
      return
    }
    // Full-access resume gate: a session whose canonical mode is
    // full-access submits nothing new until this process confirmed the
    // disclosure (mode/rules commits and non-submitting commands stay
    // available — they are the recovery path), and an attached session
    // whose permission mirror has not yet seeded fails closed: the
    // switchSession replay window must not be a bypass.
    if (currentSessionId !== null && !fullAccessConfirmed()) {
      if (permissionMode === "full-access" || permissionMode === null) {
        store.dispatch({
          kind: "slash-notice",
          notice:
            permissionMode === "full-access"
              ? notice("Error · run", "This session is in full-access; open /permissions and confirm before submitting")
              : notice("Error · run", "Session permissions are still syncing; retry shortly or use /resume to reattach"),
        })
        drain(runqueue.runFinished())
        return
      }
    }
    const at = generation
    const submittedAt = submissionEpoch
    const displacement = (): "session switch" | "interrupt" | null =>
      at !== generation ? "session switch" : submittedAt !== submissionEpoch ? "interrupt" : null
    const bangCommand = text.startsWith("!") ? text.slice(1).trim() : null
    if (bangCommand !== null) {
      void session.ports.session
        .executeShell({ command: bangCommand })
        .catch((error: unknown) => {
          if (displacement() !== null || tornDown) return
          projection.appendLocal("error", errorText(error))
          mirrorContent()
        })
        .finally(() => {
          if (displacement() === null && !tornDown) drain(runqueue.runFinished())
        })
      return
    }
    const port = session
    void port.ports.session
      .submitInput({ text })
      .then((receipt) => {
        const why = displacement()
        if (why === null) {
          activeInputId = receipt.inputId
          // The canonical rows may have settled past this admission
          // already (the event push and the command reply race): adopt,
          // then reconcile so a finished run frees the slot now instead
          // of waiting for an onApplied that already fired unowned.
          reconcileRunSlot()
          return
        }
        // The receipt landed after its submission was displaced — by a
        // switch, or by an interrupt that never saw the input to
        // cancel: the run never mirrored into the live session, so
        // return it to the port that admitted it. Teardown cannot even
        // do that; there is no session left to talk to.
        if (tornDown) return
        void port.ports.session.cancelInput({ inputId: receipt.inputId, reason: why }).catch(() => {})
      })
      .catch((error: unknown) => {
        if (displacement() !== null || tornDown) return
        projection.appendLocal("error", errorText(error))
        mirrorContent()
        drain(runqueue.runFinished())
      })
  }

  const executeSlash = (input: SlashInput, ownsSlot: boolean): void => {
    // Same races as startRun: a dispatch settling after a switch must
    // neither run its host effects on the new session nor free a run
    // slot the new session's own submission now owns, and a dispatch
    // that outlived an interrupt frees nothing either. The slot fact
    // comes from the queue's event — only a queue-policy command owns
    // the slot, so an immediate settling while a prompt runs must leave
    // that prompt's slot alone, and the digest's view state drops with
    // the same staleness reasons instead of painting the new session.
    const at = generation
    const submittedAt = submissionEpoch
    const staleReason = (): SlashDispatchStaleReason | null => {
      // Teardown outranks displacement: it bumps the generation too, so
      // the generation check alone would misread a torn-down dispatch
      // as switched and let client-scoped text land on the dead store.
      if (tornDown) return "torn-down"
      if (at !== generation) return "switched"
      return ownsSlot && submittedAt !== submissionEpoch ? "interrupted" : null
    }
    void slashHost
      .dispatch(input, undefined, staleReason)
      .then((effects) => {
        // Torn down, nothing may run — exit would even double-fire the
        // exit seam. Past a switch, or past the interrupt that retired
        // this slot-owning dispatch, client-scoped outcomes (exit, a
        // theme commit) still run: they never spoke for the displaced
        // submission. A submission and a transcript clear did — the run
        // would land on the new session, or start on the slot the abort
        // freed, and the clear would wipe freshly replayed rows — so
        // those drop with the displacement. The store's effect-scope
        // taxonomy owns the classification.
        for (const effect of effects) {
          if (tornDown) continue
          if (staleReason() !== null && !isSessionIndependentEffect(effect)) continue
          runEffect(effect)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (ownsSlot && staleReason() === null) drain(runqueue.runFinished())
      })
  }

  const abortActiveSubmission = (): void => {
    // The epoch bump retires every in-flight settlement of the aborted
    // submission before the tracking clears, so their late resolves
    // land as cancelled instead of freeing the slot twice.
    submissionEpoch += 1
    const inputId = activeInputId
    activeInputId = null
    activeRunId = null
    if (inputId !== null && session !== null) {
      void session.ports.session.cancelInput({ inputId, reason: "interrupt" }).catch(() => {})
    }
  }

  // The notice carries the commit's genus: the confirmation card
  // answers only echoes of the mode commit it stands for.
  const stalePermissionNotice = (
    commit: "mode" | "rules",
  ): { readonly kind: "permission-stale"; readonly commit: "mode" | "rules"; readonly message: string } => ({
    kind: "permission-stale",
    commit,
    message: "The permission change lost a race; showing the current canonical state.",
  })

  // A commit racing a session switch must not resolve against the new
  // session's store: the old session's echo can never arrive, so the
  // dispatch (the success card-close or the stale notice) drops with it.
  const commitPermissionMode = async (mode: string, close: boolean): Promise<void> => {
    const at = generation
    const applied = (await session?.ports.session.setPermissionMode({ mode })) === true
    if (tornDown || at !== generation) return
    store.dispatch(applied ? { kind: "permission-applied", commit: "mode", close } : stalePermissionNotice("mode"))
  }

  const commitPermissionRules = async (rules: readonly PermissionRule[]): Promise<void> => {
    const at = generation
    const applied = (await session?.ports.session.setPermissionRules({ rules })) === true
    if (tornDown || at !== generation) return
    store.dispatch(applied ? { kind: "permission-applied", commit: "rules", close: false } : stalePermissionNotice("rules"))
  }

  const commitTheme = async (themeId: string): Promise<void> => {
    const result = await themeCoordinator.port.commit(themeId)
    if (tornDown || result.kind === "confirmed" || result.kind === "stale") return
    store.dispatch({
      kind: "slash-notice",
      notice: notice("Error · theme", `Saving the theme failed: ${errorText(result.error)}`),
    })
  }

  const rewindToInput = async (inputId: string): Promise<void> => {
    // Same switch race as the permission commits: a draft restored from
    // the previous session's history must not land in the new one.
    const at = generation
    try {
      if (session === null) throw new Error("No session to rewind")
      const { restoredDraft } = await session.ports.session.rewindToInput({ inputId })
      if (!tornDown && at === generation) store.dispatch({ kind: "load-draft", text: restoredDraft })
    } catch (error) {
      if (!tornDown && at === generation) {
        store.dispatch({ kind: "slash-notice", notice: notice("Error · rewind", errorText(error)) })
      }
    }
  }

  const teardown = (stopOptions?: { readonly diagnostics?: string }): Promise<void> => {
    if (teardownPromise !== undefined) return teardownPromise
    tornDown = true
    generation += 1
    const inputId = activeInputId
    activeInputId = null
    activeRunId = null
    // The preamble runs before the shared promise exists, so a fault
    // here must be carried into it: otherwise frame.stop never runs and
    // the terminal is stranded in raw mode or the alternate screen.
    let preambleFault: unknown
    try {
      runqueue.interrupt()
      ask.cancelAll()
      childApprovals.cancelAll()
      if (inputId !== null && session !== null) {
        void session.ports.session.cancelInput({ inputId, reason: "exit" }).catch(() => {})
      }
    } catch (fault) {
      preambleFault = fault
    }
    const stoppedSession = session
    session = null
    // Session cleanup may call back into the host; publish the shared
    // promise before invoking it so every exit path joins one teardown.
    teardownPromise = Promise.resolve().then(async () => {
      let firstFault: unknown = preambleFault
      try {
        stoppedSession?.stop()
      } catch (fault) {
        if (firstFault === undefined) firstFault = fault
      }
      try {
        // A broken session cleanup must never strand raw mode or the
        // alternate screen; the frame owns ordered Ink and Screen teardown.
        await frame.stop(stopOptions)
      } catch (fault) {
        if (firstFault === undefined) firstFault = fault
      }
      if (firstFault !== undefined) throw firstFault
    })
    return teardownPromise
  }

  const switchSession = async (sessionId: string): Promise<void> => {
    if (tornDown) return
    currentSessionId = sessionId
    const previous = session
    const inputId = activeInputId
    generation += 1
    activeInputId = null
    activeRunId = null
    ask.cancelAll()
    childApprovals.cancelAll()
    runqueue.interrupt()
    mirrorQueue()
    if (inputId !== null && previous !== null) {
      void previous.ports.session.cancelInput({ inputId, reason: "session switch" }).catch(() => {})
    }
    previous?.stop()
    projection.reset()
    // The previous session's denial ledger, workspace root, permission
    // mirrors and per-session telemetry facts drop before the incoming
    // session's backlog replay re-seeds them through the canonical
    // observation feeds; static config facts survive, sniffed ones reset
    // to that baseline.
    workspaceRoot = null
    additionalDirectories = []
    permissionMode = null
    permissionRules = []
    telemetry.sessionStatus = "created"
    delete telemetry.contextTokens
    delete telemetry.contextEstimated
    if (options.modelName === undefined) delete telemetry.modelName
    else telemetry.modelName = options.modelName
    pushTelemetry()
    store.dispatch({ kind: "session-detached" })
    const at = generation
    try {
      session = options.createSession({ sessionId, writer: projection, hooks, ask, agents })
      await session.start()
    } catch (error) {
      // A superseded switch (torn down, or a newer switch superseded this
      // one mid-flight) no longer owns the outcome — the cleanup below
      // belongs to whoever superseded it, and rethrowing here would map
      // this attempt onto the newer switch's screen.
      if (at !== generation || tornDown) return
      // The failed switch lands mid-flight — the previous session is
      // stopped and the mirrors were reset — so the dead reference must
      // not survive as a port target, and the target id releases too:
      // the dead session becomes resumable again. Reconciling the store
      // to the reset projection first keeps the caller's error notice
      // from composing onto the detached session's rows.
      const failedSession = session
      session = null
      currentSessionId = null
      try {
        failedSession?.stop()
      } catch {
        // Preserve the attach failure; terminal teardown still runs on host stop.
      }
      mirrorContent()
      throw error
    }
    if (at === generation) mirrorContent()
  }

  const runEffect = (effect: TuiStateEffect): void => {
    switch (effect.kind) {
      case "submit":
        drain(runqueue.submitPrompt(effect.text))
        return
      case "shell":
        // Reconstruct the canonical bang grammar; the queue mirror and
        // the ingress both speak it.
        drain(runqueue.submitPrompt(`! ${effect.command}`))
        return
      case "slash":
        drain(runqueue.submitSlash(effect.input))
        return
      case "clear-transcript":
        projection.clear()
        mirrorContent()
        return
      case "interrupt":
        drain(runqueue.interrupt())
        return
      case "exit":
        void teardown().then(
          () => options.onExit?.(),
          (fault: unknown) => {
            options.onFatal?.(`tui shutdown failed: ${errorText(fault)}`)
            options.onExit?.()
          },
        )
        return
      case "open-rewind":
        // A wired rewind source handles the escape chain inside the
        // store; this is the unwired fallback, defensive only.
        store.dispatch({ kind: "open-rewind-card" })
        return
      case "rotate-permission":
        void commitPermissionMode(effect.mode, false)
        return
      case "theme-preview":
        themeCoordinator.port.preview(effect.themeId)
        return
      case "theme-commit":
        void commitTheme(effect.themeId)
        return
      case "theme-cancel":
        themeCoordinator.port.cancel()
        return
      case "rewind":
        void rewindToInput(effect.inputId)
        return
      case "resume":
        // The direct /resume path maps failure to false through its own
        // port seam; the resume-card effect has none, so the failed
        // switch surfaces here as an error line instead of vanishing.
        void switchSession(effect.sessionId).catch((error: unknown) => {
          if (tornDown) return
          store.dispatch({
            kind: "slash-notice",
            notice: notice("Error · resume", `Could not resume session: ${effect.sessionId} (${errorText(error)})`),
          })
        })
        return
      case "permission-mode":
        void commitPermissionMode(effect.mode, true)
        return
      case "full-access-confirm":
        // Payload-keyed, never live-session-keyed: even a displaced
        // execution confirms exactly the session the user confirmed.
        if (effect.sessionId !== null) confirmedFullAccess.add(effect.sessionId)
        return
      case "permission-rules":
        void commitPermissionRules(effect.rules)
        return
      case "ask-answer":
        // A bridged child ask settles through the bridge by token; a
        // parent ask falls through to the ask port.
        if (childApprovals.settleAsk(effect.requestId, { outcome: effect.outcome, selected: effect.selected })) return
        ask.settle({ requestId: effect.requestId, outcome: effect.outcome, selected: effect.selected })
        return
      case "approval-decision":
        // A bridged child approval settles through the bridge by token;
        // a parent approval falls through to the session port.
        if (childApprovals.settleApproval(effect.requestId, effect.decision)) return
        if (session !== null) {
          void session.ports.approval.resolve({ requestId: effect.requestId, decision: effect.decision })
        }
        return
      case "urgent-card-freed":
        childApprovals.notifySurfaceAvailable()
        return
      case "cancel-child":
        options.onCancelChild?.(effect.childSessionId)
        return
    }
  }

  // Register before the frame's own listeners so session observations and
  // queued work are fenced before Ink starts unmounting on a signal.
  options.screen.onTerminationRequest(() => {
    void teardown().catch((fault: unknown) => options.onFatal?.(`tui shutdown failed: ${errorText(fault)}`))
  })
  const frame = createInkTuiFrame({
    screen: options.screen,
    autoStopOnTermination: false,
    store,
    ...(options.initialTheme === undefined ? {} : { theme: options.initialTheme }),
    onEffect: runEffect,
    ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
  })
  const themeCoordinator = createTuiThemeCoordinator({
    initialTheme: options.initialTheme ?? "dark",
    configPath: options.themeConfigPath,
    store: options.themePreference,
    onThemeChange: (theme) => applyTheme(theme),
  })
  applyTheme = (theme) => frame.setTheme(theme)
  committedThemeSource = () => themeCoordinator.committedTheme()
  const slashHost = createTuiSlashHost({ store, registry })

  // The theme transaction opens exactly once per card appearance: the
  // rising edge of the card's visibility arms the scope (a preview that
  // never committed restores on close), and closing it drops the scope.
  let themeScopeOpen = false
  store.subscribe(() => {
    if (tornDown) return
    const visible = store.themeCardVisible()
    if (visible && !themeScopeOpen) {
      themeScopeOpen = true
      themeCoordinator.openScope()
    } else if (!visible) {
      themeScopeOpen = false
    }
  })

  return {
    store,
    ask,
    childApprovals,
    async start(input) {
      if (tornDown) throw new Error("The TUI host was torn down; build a new one")
      if (session !== null) {
        if (preparation === undefined) throw new Error("The TUI host is still starting")
        return preparation
      }
      const startedPreparation = frame.start()
      preparation = startedPreparation
      if (!startedPreparation.ok) return startedPreparation
      currentSessionId = input?.sessionId ?? null
      const at = generation
      try {
        session = options.createSession({ sessionId: currentSessionId ?? undefined, writer: projection, hooks, ask, agents })
        await session.start()
      } catch (error) {
        // A superseded start (torn down, or a switch landed mid-attach)
        // no longer owns the outcome — the cleanup belongs to whoever
        // superseded it, and rethrowing would map this attach onto
        // their screen. The switch path guards its catch the same way.
        if (at !== generation || tornDown) return startedPreparation
        // A failed first attach leaves the same mid-flight shape as a
        // failed switch: release the dead reference so later submissions
        // report no-session instead of talking to a broken port, and
        // the target id releases with it — the dead session stays
        // resumable, which is exactly what the no-session drain points
        // the user at.
        const failedSession = session
        session = null
        currentSessionId = null
        try {
          failedSession?.stop()
        } catch {
          // Preserve the attach failure; terminal teardown still runs on host stop.
        }
        throw error
      }
      // A switch that landed during start owns the mirrors from here on.
      if (at !== generation) return startedPreparation
      mirrorContent()
      pushTelemetry()
      mirrorQueue()
      if (options.firstRunThemeSelection === true) store.dispatch({ kind: "open-theme-card" })
      return startedPreparation
    },
    flush() {
      return frame.flush()
    },
    stop(stopOptions) {
      return teardown(stopOptions)
    },
    switchSession,
  }
}
