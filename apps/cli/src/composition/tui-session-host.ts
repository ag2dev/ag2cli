/**
 * The kernel's session host: one embedded session's lifecycle, hooks
 * and host-side probes, translated into kernel inputs. The host owns
 * the session projection (it hands the writer half to every session it
 * builds and the reader half to the entry through onProjection), keeps
 * the generation that fences every observation an abandoned session
 * still fires, and mirrors the footer probes the kernel reads through
 * its ports. Decision facts, statuses, draft restores and degradation
 * edges all leave as kernel inputs; nothing here renders or adjudicates.
 */
import type { SessionOrigin, TuiInput } from "../ui/tui/kernel/index.js"
import type { TuiEmbeddedSession, TuiEmbeddedSessionOptions, TuiEmbeddedSessionPorts } from "./tui-embedded-session.js"
import type { PermissionRule, TuiAskCardInput } from "./tui-embedded-session.js"
import type { PublicInputSnapshot, PublicPlanSummary } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type { SessionProjectionWriter, TuiSessionProjection } from "../ui/tui/sessionprojection/index.js"
import { createSessionProjection } from "../ui/tui/sessionprojection/index.js"
import type { ChildAgentsSink, TuiAskQuestion } from "./tui-projection-pump.js"

/** Observation hooks the host wires into every embedded session it builds. */
export type TuiKernelSessionHooks = Omit<TuiEmbeddedSessionOptions, "session" | "writer" | "agents">

/** Everything the session factory needs to build one embedded session. */
export interface TuiKernelSessionFactoryContext {
  /** Session to adopt; absent mints a fresh one. */
  readonly sessionId?: string
  /** The host's single projection writer (shared across session switches). */
  readonly writer: SessionProjectionWriter
  /** Hooks bound to this session's generation. */
  readonly hooks: TuiKernelSessionHooks
  /** Delegation-fact sink the session's ingress feeds; it outlives switches. */
  readonly agents: ChildAgentsSink
}

/**
 * The factory's answer: the built session plus the id it landed on.
 * Only the factory knows whether it adopted the requested id or minted
 * a fresh session, so the host's binding truth comes from here.
 */
export interface TuiKernelSessionFactoryResult {
  readonly session: TuiEmbeddedSession
  readonly sessionId: string
}

export interface TuiSessionHostOptions {
  readonly createSession: (context: TuiKernelSessionFactoryContext) => TuiKernelSessionFactoryResult
  readonly dispatch: (input: TuiInput) => void
  /**
   * Child decision seam, swept before a switch abandons the previous
   * session and released once the new binding settled: the child cards
   * outlive any parent session and must not be orphaned by one.
   */
  readonly childDecisions?: { sweep(): void; release(): void }
  /**
   * Pre-attach refusal seam: rejects a switch whose target must not be
   * adopted. Without it the embedded factory silently mints a fresh
   * session for an unknown id instead of failing the resume.
   */
  readonly resumeGate?: (sessionId: string) => Promise<void>
  /** Fires after every successful attach and switch with the projection's reader half. */
  readonly onProjection: (reader: TuiSessionProjection) => void
  /** The projection moved; the entry binds this to the pump's push. */
  readonly onApplied?: () => void
  /** Terminal cleanup faults the host recovered from; the process decides severity. */
  readonly onFatal?: (reason: string) => void
}

export interface TuiSessionHostProbes {
  permissionMode(): string | null
  permissionRules(): readonly PermissionRule[]
  additionalDirectories(): readonly string[]
  /** The modes the live session may commit; empty while nothing is attached. */
  selectableModes(): readonly string[]
  /** Newest first; every session switch clears the ledger. */
  deniedLedger(): readonly { readonly toolName: string; readonly code: string; readonly reason?: string }[]
  runState(): "running" | "completed" | "failed" | "cancelled" | null
  context(): { model?: string; contextTokens?: number; contextEstimated?: boolean } | null
  /** The degradation mirror: false answers on a degraded refusal mean "sent nothing". */
  degraded(): boolean
}

export interface TuiSessionHost {
  /** Build and start the first session; rejects on attach failure. */
  attach(input?: { readonly sessionId?: string }): Promise<void>
  /** Abandon the current session and adopt another. */
  switchSession(sessionId: string): Promise<void>
  /** Stop the session loop; idempotent, never dispatches again. */
  teardown(): Promise<void>
  /** The live binding; null before the first attach and after teardown. */
  origin(): SessionOrigin | null
  readonly probes: TuiSessionHostProbes
  /** The attached session's ports; null when nothing is attached. */
  session(): TuiEmbeddedSessionPorts | null
  /** The attached session's queued mailbox inputs, in acceptance order; empty when nothing is attached. */
  mailboxQueued(): readonly PublicInputSnapshot[]
  /** The attached session's plan summaries, latest state per plan id; empty when nothing is attached. */
  planSummaries(): readonly PublicPlanSummary[]
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Bounded prefix of converged tool-denial terminals the Recently denied face reads. */
const DENIED_LEDGER_CAPACITY = 50

/**
 * Deterministic 53-bit content digest over the disclosure's semantic
 * parts. The lease disclosure and the binding epoch are plain numbers,
 * so the hash folds two 26-bit lanes into the safe-integer range; the
 * collision odds over interaction-sized payloads are negligible.
 */
export const decisionDisclosureDigest = (parts: readonly string[]): number => {
  let hi = 5381
  let lo = 52711
  for (const part of [...parts, ""]) {
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index)
      hi = (hi * 33 + code) % 67108859
      lo = (lo * 33 + code) % 67108859
    }
    hi = (hi * 33 + 0) % 67108859
    lo = (lo * 33 + 1) % 67108859
  }
  return hi * 67108859 + lo
}

/**
 * Map the hook's questions onto the kernel's ask facts. The public ask
 * surface always carries per-question and per-option identity; the
 * index fallback keeps the fact total for a payload that lacks ids
 * instead of silently dropping content.
 */
export const askFactsFromQuestions = (
  questions: readonly TuiAskQuestion[],
): readonly {
  questionId: string
  question: string
  header?: string
  multiSelect: boolean
  options: readonly { optionId: string; label: string; description?: string }[]
}[] =>
  questions.map((question, index) => ({
    questionId: question.questionId ?? `question-${index}`,
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    multiSelect: question.multiSelect === true,
    options: question.options.map((option, optionIndex) => ({
      optionId: option.optionId ?? `question-${index}-option-${optionIndex}`,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
  }))

export function createTuiSessionHost(options: TuiSessionHostOptions): TuiSessionHost {
  const projection = createSessionProjection() as TuiSessionProjection & SessionProjectionWriter
  let session: TuiEmbeddedSession | null = null
  let generation = 0
  let origin: SessionOrigin | null = null
  let tornDown = false
  // Deliberately hand-rolled: teardown memoizes forever, failure
  // included — a run-once primitive that evicts on failure would newly
  // allow re-running the synchronous preamble (generation bump, agent
  // reset) after a failed stop.
  let teardownPromise: Promise<void> | undefined

  let permissionMode: string | null = null
  let permissionRules: readonly PermissionRule[] = []
  let additionalDirectories: readonly string[] = []
  let deniedLedger: readonly { readonly toolName: string; readonly code: string; readonly reason?: string }[] = []
  let runState: "running" | "completed" | "failed" | "cancelled" | null = null
  let contextUsage: { model?: string; contextTokens?: number; contextEstimated?: boolean } | null = null
  let degradedNow = false

  // The one delegation-fact sink: it outlives session switches and the
  // attached session's ingress feeds it. The fact shapes are the
  // kernel's children vocabulary structurally, so the bridge is a
  // verbatim dispatch with no host-side state.
  const agents: ChildAgentsSink = {
    applySpawn: (fact) => options.dispatch({ kind: "children", fact: { type: "spawn", ...fact } }),
    applyToolUse: (toolUseId, fact) => options.dispatch({ kind: "children", fact: { type: "tool-use", toolUseId, ...fact } }),
    appendLine: (childSessionId, text) => options.dispatch({ kind: "children", fact: { type: "line", childSessionId, text } }),
    finalize: (fact) => options.dispatch({ kind: "children", fact: { type: "finalize", ...fact } }),
    reset: () => options.dispatch({ kind: "children", fact: { type: "reset" } }),
  }

  const resetProbes = (): void => {
    permissionMode = null
    permissionRules = []
    additionalDirectories = []
    deniedLedger = []
    runState = null
    contextUsage = null
    degradedNow = false
  }

  /**
   * Hooks are minted per session build and close over the generation
   * they were born under: an abandoned session's in-flight backlog
   * read can still fire observations inside its own promise, and the
   * generation check keeps them off the new session's kernel.
   */
  const buildHooks = (at: number): TuiKernelSessionHooks => {
    const stale = (): boolean => tornDown || at !== generation
    return {
      onApprovalRequest: (request) => {
        if (stale()) return
        const summary = request.summary.join("\n")
        options.dispatch({
          kind: "decision",
          fact: {
            kind: "approval",
            fact: {
              request: { id: request.requestId },
              toolName: request.toolName,
              summary,
              options: request.options,
            },
            disclosure: decisionDisclosureDigest([
              request.toolName,
              summary,
              ...request.options.flatMap((option) => [option.optionId, option.label, option.outcome]),
            ]),
          },
        })
      },
      onAskRequest: (request: TuiAskCardInput) => {
        if (stale()) return
        const questions = askFactsFromQuestions(request.questions)
        options.dispatch({
          kind: "decision",
          fact: {
            kind: "ask",
            fact: { request: { id: request.requestId }, questions },
            disclosure: decisionDisclosureDigest(
              questions.flatMap((question) => [
                question.questionId,
                question.question,
                question.header ?? "",
                String(question.multiSelect),
                ...question.options.flatMap((option) => [option.optionId, option.label, option.description ?? ""]),
              ]),
            ),
          },
        })
      },
      onAskResolved: (retract) => {
        if (stale()) return
        options.dispatch({ kind: "decision-status", request: { id: retract.requestId }, event: "authority-confirmed" })
      },
      onRunStateChange: (state) => {
        if (stale()) return
        runState = state
      },
      onContextUsage: (usage) => {
        if (stale()) return
        contextUsage = {
          ...(usage.model === undefined ? {} : { model: usage.model }),
          ...(usage.contextTokens === undefined ? {} : { contextTokens: usage.contextTokens }),
          ...(usage.contextEstimated === undefined ? {} : { contextEstimated: usage.contextEstimated }),
        }
      },
      onPermissionMode: (mode) => {
        if (stale()) return
        permissionMode = mode
        // Observation plus fact: the footer's permission chip rides the
        // telemetry the host-event writes, so the hook reports the mode
        // change as a fact too.
        options.dispatch({ kind: "host-event", event: { type: "permission-mode", value: mode } })
      },
      onPermissionRules: (rules) => {
        if (stale()) return
        permissionRules = [...rules]
      },
      onAdditionalDirectories: (directories) => {
        if (stale()) return
        additionalDirectories = [...directories]
      },
      onToolDenial: (denial) => {
        if (stale()) return
        // Converged denial terminals ride the backlog replay too, so the
        // ledger keeps a bounded newest-first prefix, not an unbounded log.
        deniedLedger = [
          {
            toolName: denial.name,
            code: denial.code,
            ...(denial.reason === undefined ? {} : { reason: denial.reason }),
          },
          ...deniedLedger,
        ].slice(0, DENIED_LEDGER_CAPACITY)
      },
      onApplied: () => {
        if (stale()) return
        options.onApplied?.()
      },
      onDegradationChange: (value) => {
        if (stale()) return
        degradedNow = value
        options.dispatch({ kind: "host-event", event: { type: "degraded", value } })
      },
      // Tool denials land in the host-side ledger above; adoption
      // failures and degraded attempts have no kernel surface yet;
      // they join with their dedicated views.
    }
  }

  const startSession = (at: number, sessionId: string | undefined): Promise<void> => {
    const built = options.createSession({
      ...(sessionId === undefined ? {} : { sessionId }),
      writer: projection,
      hooks: buildHooks(at),
      agents,
    })
    session = built.session
    origin = { sessionId: built.sessionId, generation: at }
    return built.session.start()
  }

  const abandonOnFailure = (at: number): void => {
    if (at !== generation || tornDown) return
    const failed = session
    session = null
    origin = null
    // A dead binding's delegation facts die with it; the board must
    // not keep rendering entries no replay will ever finalize.
    agents.reset()
    try {
      failed?.stop()
    } catch {
      // Preserve the attach failure; the dead reference must not survive.
    }
  }

  return {
    async attach(input) {
      if (tornDown) throw new Error("The TUI session host was torn down; build a new one")
      if (session !== null) throw new Error("The TUI session host already holds a session")
      const at = generation
      try {
        await startSession(at, input?.sessionId)
      } catch (error) {
        abandonOnFailure(at)
        throw error
      }
      // A teardown that landed mid-attach owns the outcome; the entry's
      // onProjection must not fire onto a torn-down assembly.
      if (at !== generation || tornDown) return
      options.onProjection(projection)
    },
    async switchSession(sessionId) {
      if (tornDown) return
      const previous = session
      const previousOrigin = origin
      const at = generation + 1
      generation = at
      session = null
      // The sweep lands before anything the switch touches can fire:
      // the presenting child card retracts off the kernel and the
      // adapter holds every raise the switch window produces.
      options.childDecisions?.sweep()
      // The board clears ahead of the new session's backlog replay,
      // which re-delivers every delegation fact before its first push.
      agents.reset()
      try {
        // In-flight admissions are reconciled by the origin displacement:
        // their late results arrive stamped with the abandoned origin and
        // the executor drops them. stop() owns everything else; per-input
        // best-effort cancellation returns with input tracking.
        try {
          previous?.stop()
        } catch {
          // The switch must proceed onto the new session regardless.
        }
        projection.reset()
        resetProbes()
        try {
          // The gate runs after the old binding dies and inside the same
          // try as the start: a refused target must land as a detach, not
          // as a resurrected previous session.
          await options.resumeGate?.(sessionId)
          await startSession(at, sessionId)
        } catch (error) {
          abandonOnFailure(at)
          if (previousOrigin !== null) {
            options.dispatch({
              kind: "host-event",
              event: {
                type: "session-detached",
                sessionId: previousOrigin.sessionId,
                generation: previousOrigin.generation,
              },
            })
          }
          throw error
        }
        if (at !== generation || tornDown) return
        options.onProjection(projection)
      } finally {
        // The release re-raises the surviving child head onto whatever
        // state the switch landed on — the cards belong to the child
        // sessions, not to either parent binding.
        options.childDecisions?.release()
      }
    },
    teardown() {
      if (teardownPromise !== undefined) return teardownPromise
      tornDown = true
      generation += 1
      const stoppedSession = session
      session = null
      origin = null
      // The process is leaving: the presenting child card retracts, and
      // no release follows — the kernel will not render again.
      options.childDecisions?.sweep()
      agents.reset()
      resetProbes()
      teardownPromise = Promise.resolve().then(() => {
        try {
          stoppedSession?.stop()
        } catch (fault) {
          options.onFatal?.(`tui session teardown failed: ${errorText(fault)}`)
        }
      })
      return teardownPromise
    },
    origin: () => origin,
    probes: {
      permissionMode: () => permissionMode,
      permissionRules: () => permissionRules,
      additionalDirectories: () => additionalDirectories,
      selectableModes: () => (session === null ? [] : [...session.selectableModes]),
      deniedLedger: () => deniedLedger,
      runState: () => runState,
      context: () => contextUsage,
      degraded: () => degradedNow,
    },
    session: () => (tornDown || session === null ? null : session.ports),
    mailboxQueued: () => (tornDown || session === null ? [] : session.mailboxQueued()),
    planSummaries: () => (tornDown || session === null ? [] : session.planSummaries()),
  }
}
