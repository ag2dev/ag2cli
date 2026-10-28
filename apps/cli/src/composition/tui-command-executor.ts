/**
 * The command executor: the kernel's single outbound consumer. Every
 * emitted TuiCommand lands here and maps onto the embedded session's
 * ports, the theme transaction, the workspace diff source or the exit
 * seam. Two rules govern every await: the session reference and origin
 * are captured once, before any suspension, and late results are
 * stamped with the captured values — a result that arrives after its
 * session was displaced is dropped instead of landing on the next
 * session. The executor never reads the kernel snapshot; the run id
 * rides an injected getter so the kernel stays its only owner.
 *
 * Three windows own the in-flight submit receipts — interrupt, resume
 * and exit. Each takes a snapshot of the still-pending submits at
 * entry (the first observer owns them; later windows see only later
 * admits), awaits each under one bounded budget, and returns the
 * settled receipts through cancelInput on the session the submit was
 * captured under, statuses ignored. Resume and exit abandon the
 * session, so every settled receipt returns; the interrupt window
 * keeps receipts the session accepted as queued — the retained queue
 * drains those into the next run — and returns only receipts that
 * attached to the cancelled run. The exit window additionally awaits
 * its in-flight cancel snapshot under the same budget so the durable
 * cancels reach the session before the process leaves.
 */
import type { PublicAskUserAnswer } from "@ag2cli/app-server-protocol/dto/interactions.js"
import { OrderedLane } from "@ag2cli/runtime/concurrency/ordered-lane.js"
import type { SessionOrigin, TuiCommand, TuiInput } from "../ui/tui/kernel/index.js"
import type { TuiChildDecisionSeam } from "./child-decision-surface.js"
import type { TuiEmbeddedSessionPorts } from "./tui-embedded-session.js"
import type { TuiThemePort } from "./tui-preferences.js"

/** The mirror's file view: presentation-only facts, mapped by the entry adapter. */
export interface TuiMirrorFileView {
  readonly path: string
  readonly description?: string
  readonly detail?: readonly string[]
}

/** The mirror's resumable-session row, mapped by the entry adapter from the catalog. */
export interface TuiResumeSessionView {
  readonly sessionId: string
  readonly title?: string
  readonly lastRevision: number
  readonly createdAt: string
}

export interface TuiCommandExecutorOptions {
  readonly session: () => TuiEmbeddedSessionPorts | null
  readonly origin: () => SessionOrigin | null
  /** The live run id, read from the kernel snapshot by the entry adapter. */
  readonly activeRun: () => string | null
  /** The host's degradation mirror: a degraded refusal sent nothing, a live race lost. */
  readonly degraded: () => boolean
  readonly theme: TuiThemePort
  readonly diffFiles: (signal?: AbortSignal) => Promise<readonly TuiMirrorFileView[]> | readonly TuiMirrorFileView[]
  /** Adopt another session through the host's switch seam. */
  readonly switchSession: (sessionId: string) => Promise<void>
  readonly resumeSessions: (query: {
    readonly excludeSessionId: string | null
    readonly signal?: AbortSignal
  }) => Promise<readonly TuiResumeSessionView[]> | readonly TuiResumeSessionView[]
  /** Persist the first accepted prompt as a title when the session has none. */
  readonly setSessionTitleIfAbsent?: (sessionId: string, title: string) => Promise<void>
  /** Child card seam: bridged child tokens settle here, ahead of the session guard. */
  readonly childDecisions?: Pick<TuiChildDecisionSeam, "settle" | "notifyIfFree">
  /** Child cancel lever over the process-scoped registry; absent or false reports a failed command. */
  readonly cancelChild?: (childId: string) => boolean
  /** Add a prompt to the local history after acceptance or explicit rewind-to-clear. */
  readonly onPromptHistory?: (text: string) => void
  readonly dispatch: (input: TuiInput) => void
  readonly onExit: () => void
  /** The one bounded budget every drain window races its awaits against. */
  readonly drainBudgetMs?: number
}

export interface TuiCommandExecutor {
  execute(command: TuiCommand): void
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const DEFAULT_DRAIN_BUDGET_MS = 500

/** One in-flight submit: the ports it was issued on plus its raw promise. */
interface TrackedSubmit {
  readonly session: TuiEmbeddedSessionPorts
  readonly promise: Promise<{ readonly inputId: string; readonly queued: boolean }>
}

interface BudgetSettle<T> {
  readonly settled: boolean
  readonly value?: T
}

export function createTuiCommandExecutor(options: TuiCommandExecutorOptions): TuiCommandExecutor {
  const budgetMs = options.drainBudgetMs ?? DEFAULT_DRAIN_BUDGET_MS
  const pendingSubmits = new Set<TrackedSubmit>()
  const trackedCancels = new Set<Promise<unknown>>()
  const titleWrites = new OrderedLane<string>()

  const saveSessionTitle = (sessionId: string, prompt: string): void => {
    const normalized = prompt.replaceAll(/\s+/gu, " ").trim()
    if (normalized.length === 0 || normalized.startsWith("/") || options.setSessionTitleIfAbsent === undefined) return
    const title = normalized.length > 160 ? `${normalized.slice(0, 159).trimEnd()}…` : normalized
    const pending = titleWrites.run(sessionId, () => options.setSessionTitleIfAbsent!(sessionId, title))
    void pending.catch(() => undefined)
  }

  const trackCancel = (promise: Promise<unknown>): void => {
    trackedCancels.add(promise)
    void promise.then(
      () => {
        trackedCancels.delete(promise)
      },
      () => {
        trackedCancels.delete(promise)
      },
    )
  }

  /** One await raced against the window's single deadline; a rejection settles as not-settled. */
  const raceBudget = <T>(work: Promise<T>, deadline: number): Promise<BudgetSettle<T>> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ settled: false }), Math.max(0, deadline - Date.now()))
      work.then(
        (value) => {
          clearTimeout(timer)
          resolve({ settled: true, value })
        },
        () => {
          clearTimeout(timer)
          resolve({ settled: false })
        },
      )
    })

  /**
   * One drain window over the in-flight submits: the snapshot leaves
   * the tracked set at entry, the returned receipts are cancelled by
   * cancelInput on their own captured session (statuses ignored — the
   * goal is the durable return, not a second outcome), and the minted
   * cancels are awaited under the same deadline. The interrupt window
   * keeps queued receipts: it does not abandon the session, so a
   * submit the session accepted into its FIFO mailbox belongs to the
   * retained queue and drains into the next run; only a receipt that
   * attached to the cancelled run comes back. The resume and exit
   * windows abandon the session, so every settled receipt returns.
   */
  const drainSubmits = async (deadline: number, keepQueuedReceipts: boolean): Promise<void> => {
    const snapshot = [...pendingSubmits]
    for (const entry of snapshot) pendingSubmits.delete(entry)
    const mints: Promise<unknown>[] = []
    for (const entry of snapshot) {
      const raced = await raceBudget(entry.promise, deadline)
      if (!raced.settled || raced.value === undefined) continue
      if (keepQueuedReceipts && raced.value.queued) continue
      const receiptCancel = entry.session.session.cancelInput({ inputId: raced.value.inputId })
      trackCancel(receiptCancel)
      mints.push(receiptCancel)
    }
    await Promise.all(mints.map((promise) => raceBudget(promise, deadline)))
  }

  return {
    execute(command: TuiCommand): void {
      // One synchronous capture before any await: late results carry the
      // origin the command left under, never the live one.
      const session = options.session()
      const captured = options.origin()
      const displaced = (): boolean => captured !== null && options.origin() !== captured
      const operationOrigin =
        captured === null ? null : { scope: "session" as const, sessionId: captured.sessionId, generation: captured.generation }
      const failed = (error: unknown): void => {
        if (displaced()) return
        options.dispatch({ kind: "command-failed", command: command.kind, message: errorText(error) })
      }

      switch (command.kind) {
        case "remember-prompt": {
          try {
            options.onPromptHistory?.(command.text)
          } catch {
            // Local history is best-effort and cannot change the composer action.
          }
          return
        }
        case "submit": {
          if (session === null || captured === null || operationOrigin === null) return
          const tracked: TrackedSubmit = { session, promise: session.session.submitInput({ text: command.text }) }
          pendingSubmits.add(tracked)
          void tracked.promise
            .then((receipt) => {
              pendingSubmits.delete(tracked)
              saveSessionTitle(captured.sessionId, command.text)
              if (displaced()) return
              try {
                options.onPromptHistory?.(command.text)
              } catch {
                // Local history is best-effort and cannot change a session receipt.
              }
              options.dispatch({
                kind: "operation-result",
                operationId: command.operationId,
                origin: operationOrigin,
                outcome: { op: "submit", status: "accepted", inputId: receipt.inputId },
              })
            })
            .catch(() => {
              pendingSubmits.delete(tracked)
              // A submit exception keeps its receipt shape: the kernel's
              // notice and the draft disposition ride the rejected settle.
              if (displaced()) return
              options.dispatch({
                kind: "operation-result",
                operationId: command.operationId,
                origin: operationOrigin,
                outcome: { op: "submit", status: "rejected" },
              })
            })
          return
        }
        case "shell": {
          if (session === null) return
          // Success output never surfaces here: the bang text rides the
          // canonical stream and returns through the projection feed.
          void session.session.executeShell({ command: command.command }).catch(failed)
          return
        }
        case "compact": {
          if (session === null) return
          void session.session.compact(command.instructions === undefined ? {} : { instructions: command.instructions }).catch(failed)
          return
        }
        case "interrupt":
        case "cancel-run": {
          if (session === null) return
          const runId = options.activeRun()
          // No run in flight: the durable cancel has nothing to address.
          if (runId === null) return
          void session.session.cancelRun({ runId }).catch(failed)
          // The interrupt window: the durable cancel leaves first, then
          // a submit that attached to the cancelled run is returned by
          // its receipt — a queued receipt stays: the retained queue
          // owns it and drains it into the next run.
          void drainSubmits(Date.now() + budgetMs, true)
          return
        }
        case "cancel-child": {
          // The registry is process-scoped, not session-bound: no
          // session guard. A false or absent lever reports back — the
          // finalise fact, not the return value, closes the panel row.
          const childId = command.target === "current-run" ? null : command.target.childId
          const cancelled = childId !== null && (options.cancelChild?.(childId) ?? false)
          if (!cancelled) {
            options.dispatch({ kind: "command-failed", command: "cancel-child", message: `cannot cancel ${childId ?? "run"}` })
          }
          return
        }
        case "cancel-queued": {
          if (session === null || operationOrigin === null) return
          const promise = session.session.cancelInput({ inputId: command.inputId })
          trackCancel(promise)
          void promise
            .then((result) => {
              if (displaced()) return
              options.dispatch({
                kind: "operation-result",
                operationId: command.operationId,
                origin: operationOrigin,
                outcome: { op: "cancel-queued", inputId: result.inputId, status: result.status },
              })
            })
            .catch(failed)
          return
        }
        case "resolve-ask": {
          const childSettled = options.childDecisions?.settle(command.request.id, command.value)
          if (childSettled !== undefined) {
            // A child card has no canonical echo: the bridge's boolean is
            // its only closure, and a settle frees the child queue's head.
            options.dispatch({
              kind: "decision-status",
              request: command.request,
              event: childSettled ? "authority-confirmed" : "reconcile-undecidable",
            })
            if (childSettled) options.childDecisions?.notifyIfFree()
            return
          }
          if (session === null) return
          const answer: PublicAskUserAnswer =
            command.value.kind === "answered"
              ? {
                  outcome: "answered",
                  answers: command.value.answers.map((row) => ({
                    questionId: row.questionId,
                    selectedOptionIds: [...row.selectedOptionIds],
                  })),
                  ...(command.value.freeText === undefined
                    ? {}
                    : { freeText: command.value.freeText.map((row) => ({ questionId: row.questionId, text: row.text })) }),
                }
              : command.value.kind === "chat"
                ? {
                    outcome: "chat",
                    ...(command.value.contextAnswers === undefined
                      ? {}
                      : {
                          answers: command.value.contextAnswers.map((row) => ({
                            questionId: row.questionId,
                            selectedOptionIds: [...row.selectedOptionIds],
                          })),
                        }),
                    ...(command.value.contextFreeText === undefined
                      ? {}
                      : { freeText: command.value.contextFreeText.map((row) => ({ questionId: row.questionId, text: row.text })) }),
                  }
                : { outcome: "declined" }
          void session.ask
            .resolve({ requestId: command.request.id, answer })
            .then((resolved) => {
              if (displaced()) return
              if (!resolved && options.degraded()) {
                // A degraded refusal sent nothing and the canonical side is
                // still pending; the lease's only exit from resolving is a
                // reconcile read, and recovery re-presents the ask.
                options.dispatch({ kind: "decision-status", request: command.request, event: "reconcile-still-pending" })
                return
              }
              // Either way the boolean itself dispatches nothing: the
              // canonical resolution echo owns every ask outcome.
            })
            .catch(failed)
          return
        }
        case "resolve-approval": {
          const childSettled = options.childDecisions?.settle(command.request.id, command.value)
          if (childSettled !== undefined) {
            // Same closure shape as a child ask: the bridge's boolean ends
            // the round, and a settle frees the child queue's head.
            options.dispatch({
              kind: "decision-status",
              request: command.request,
              event: childSettled ? "authority-confirmed" : "reconcile-undecidable",
            })
            if (childSettled) options.childDecisions?.notifyIfFree()
            return
          }
          if (session === null) return
          void session.approval
            .resolve({ requestId: command.request.id, optionId: command.value.optionId })
            .then((resolved) => {
              if (displaced()) return
              if (!resolved && options.degraded()) {
                options.dispatch({ kind: "decision-status", request: command.request, event: "reconcile-still-pending" })
                return
              }
              // No echo hook exists for approvals: the boolean is the
              // outcome. A live false lost the race to another client, and
              // mapping it still-pending would re-present the same lease
              // forever; unknown ends the round without claiming a result.
              options.dispatch({
                kind: "decision-status",
                request: command.request,
                event: resolved ? "authority-confirmed" : "reconcile-undecidable",
              })
            })
            .catch(failed)
          return
        }
        case "theme": {
          if (command.op !== "commit") {
            // Preview and cancel are immediate, stateless port calls; the
            // transaction scope they ride belongs to the theme card.
            if (command.op === "preview") options.theme.preview(command.themeId)
            else options.theme.cancel()
            return
          }
          void options.theme.commit(command.themeId).then((result) => {
            // A stale commit may already sit on disk; there is no fact to
            // converge on, and the theme probe reports the persisted truth.
            if (result.kind === "stale") return
            options.dispatch({
              kind: "operation-result",
              operationId: command.operationId,
              origin: { scope: "client" },
              outcome: { op: "theme-commit", status: result.kind },
            })
          })
          return
        }
        case "rewind": {
          if (session === null || operationOrigin === null) return
          void session.session
            .rewindToInput({ inputId: command.checkpoint })
            .then((result) => {
              if (displaced()) return
              options.dispatch({
                kind: "operation-result",
                operationId: command.operationId,
                origin: operationOrigin,
                outcome: { op: "rewind", status: "ok", restoredDraft: result.restoredDraft },
              })
            })
            .catch(() => {
              if (displaced()) return
              options.dispatch({
                kind: "operation-result",
                operationId: command.operationId,
                origin: operationOrigin,
                outcome: { op: "rewind", status: "failed" },
              })
            })
          return
        }
        case "resume": {
          // The resume window drains before the switch: every in-flight
          // submit is returned on the session it was captured under, so
          // an accepted prompt never leaks into the abandoned binding.
          // A successful switch displaces the captured origin by design;
          // the outcome rides the client scope so the displacement guard
          // never eats it.
          void drainSubmits(Date.now() + budgetMs, false)
            .then(() => options.switchSession(command.sessionId))
            .then(() => {
              options.dispatch({
                kind: "operation-result",
                operationId: command.operationId,
                origin: { scope: "client" },
                outcome: { op: "resume", status: "attached", sessionId: command.sessionId },
              })
            })
            .catch(() => {
              // The failure detail rides the session-detached event the
              // host dispatches; this outcome only settles the operation.
              options.dispatch({
                kind: "operation-result",
                operationId: command.operationId,
                origin: { scope: "client" },
                outcome: { op: "resume", status: "attach-failed", sessionId: command.sessionId },
              })
            })
          return
        }
        case "query": {
          if (command.target === "diff-files") {
            void Promise.resolve(options.diffFiles())
              .then((files) => {
                options.dispatch({
                  kind: "mirror",
                  fact: { source: "query-result", requestId: command.requestId, files, scope: command.scope },
                })
              })
              .catch(() => {
                // A failed read leaves the browser empty and honest; the
                // retry surface arrives with the task refresh.
              })
            return
          }
          void Promise.resolve(options.resumeSessions({ excludeSessionId: captured?.sessionId ?? null }))
            .then((rows) => {
              options.dispatch({
                kind: "mirror",
                fact: { source: "resume-sessions", requestId: command.requestId, rows, scope: command.scope },
              })
            })
            .catch(() => {
              // A failed listing settles no row cache; the resume task
              // surfaces the miss and a retry re-queries.
            })
          return
        }
        case "permission": {
          if (session === null || operationOrigin === null) return
          // The boolean contract: true committed canonically, false lost
          // a race or was refused by a stopped/degraded session — both
          // surface as stale while canonical events own every display.
          const commit =
            command.op === "mode"
              ? session.session.setPermissionMode({ mode: command.mode })
              : session.session.setPermissionRules({ rules: command.rules })
          void commit
            .then((applied) => {
              if (displaced()) return
              options.dispatch({
                kind: "operation-result",
                operationId: command.operationId,
                origin: operationOrigin,
                outcome: { op: "permission", status: applied ? "applied" : "stale" },
              })
            })
            .catch(() => {
              if (displaced()) return
              options.dispatch({
                kind: "operation-result",
                operationId: command.operationId,
                origin: operationOrigin,
                outcome: { op: "permission", status: "failed" },
              })
            })
          return
        }
        case "add-dir": {
          if (session === null || operationOrigin === null) return
          void session.session
            .addAdditionalDirectory({ directory: command.directory })
            .then((result) => {
              if (displaced()) return
              options.dispatch({
                kind: "operation-result",
                operationId: command.operationId,
                origin: operationOrigin,
                outcome:
                  result.ok === true
                    ? { op: "add-dir", status: "ok", canonical: result.canonical, changed: result.changed }
                    : { op: "add-dir", status: "error", message: result.error },
              })
            })
            .catch((error: unknown) => {
              if (displaced()) return
              options.dispatch({
                kind: "operation-result",
                operationId: command.operationId,
                origin: operationOrigin,
                outcome: { op: "add-dir", status: "error", message: errorText(error) },
              })
            })
          return
        }
        case "exit": {
          // The exit window: the displacement cancels the kernel already
          // emitted are in flight, this window drains the submits still
          // pending, and both its cancel snapshot and its own per-receipt
          // mints are awaited under the one budget before the seam fires
          // — budget expiry still leaves.
          const deadline = Date.now() + budgetMs
          const cancelsAtEntry = [...trackedCancels]
          void (async () => {
            await drainSubmits(deadline, false)
            await Promise.all(cancelsAtEntry.map((promise) => raceBudget(promise, deadline)))
            options.onExit()
          })()
          return
        }
      }
    },
  }
}
