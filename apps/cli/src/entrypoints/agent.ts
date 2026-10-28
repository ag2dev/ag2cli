#!/usr/bin/env bun

import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { PublicPendingInteraction } from "@ag2cli/app-server-protocol/dto/interactions.js"
import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicSessionSnapshot } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import { buildPublicHeadlessSession, type PublicHeadlessSession } from "../composition/headless-public-session.js"
import { ModelConfigurationError } from "../composition/model-client.js"
import { RpcApplicationError } from "../interfaces/transport/public-session-command-mapping.js"
import { agentHelp, parseAgentArgs, publicCommandHelp, type AgentCliCommand } from "../interfaces/cli/agent-cli.js"
import type { InvocationName } from "../interfaces/cli/unified-cli.js"
import { isGuardianConfigured, loadRuntimeConfig, type RuntimeConfig } from "../config/runtime.js"
import type { HeadlessOutputFormat } from "../config/output-format.js"
import {
  errorEnvelope,
  exitCodeForError,
  HEADLESS_CAPABILITIES,
  successEnvelope,
  type HeadlessCommand,
  type HeadlessErrorCode,
  type HeadlessMeta,
} from "../interfaces/cli/headless-contract.js"
import {
  createHeadlessJsonlEventWriter,
  createHeadlessRunTracker,
  runText,
  serializeHeadless,
  serializeHeadlessEvent,
  type HeadlessJsonlEventWriter,
  type HeadlessRunOutcome,
  type HeadlessRunTracker,
} from "../interfaces/cli/headless-output.js"
import { readHeadlessPrompt, readStdinLines } from "../interfaces/cli/headless-input.js"
import {
  createHeadlessOperation,
  createTtyInteractionSurface,
  createTtyLineReader,
  type HeadlessAbortKind,
  type HeadlessLineReader,
} from "../interfaces/cli/headless-operation.js"
import { MAX_STDIN_BYTES } from "../capabilities/security/resource-limits.js"
import { readAg2cliVersion } from "../public/version.js"
import { createAppServerConnectionLinkForEndpoint, PairAuthenticationError } from "../interfaces/cli/app-server-pairing.js"
import type { ChildAgentRunner } from "../capabilities/execution/child-agent-runner.js"
import { canonicalizeExistingDirectory } from "../capabilities/security/workspace.js"
import { cleanupScratchRoots } from "../capabilities/security/scratch.js"

/** Whole-process budget for async children to settle after the main run before cancels. */
export const HEADLESS_ASYNC_DRAIN_TIMEOUT_MS = 300_000

/** Grace for budget-cancelled children to land their cancelled terminals in durable history. */
export const HEADLESS_CHILD_CANCEL_GRACE_MS = 1_000

/** A continuation's non-completed terminal surfaces as a throw so the existing error classification maps it. */
function settleContinuation(result: HeadlessRunOutcome): void {
  if (result.status === "failed") throw new Error(result.error ?? "continuation run failed")
  if (result.status === "cancelled") throw new DOMException("continuation run cancelled", "AbortError")
}

export interface AsyncChildrenOrchestration {
  /** The process-local child runner handle captured at composition. */
  readonly runner: Pick<ChildAgentRunner, "drain" | "cancelChild">
  /** True while an unconsumed task notification is pending on the session. */
  readonly pendingNotifications: () => Promise<boolean>
  /** Starts one continuation run that consumes the pending notifications. */
  readonly continueRun: () => Promise<HeadlessRunOutcome>
  readonly budgetMs?: number
  readonly cancelGraceMs?: number
  readonly signal?: AbortSignal
}

/**
 * Headless orchestration loop: the process stays while process-local
 * async children run. A drained running map implies each settle's
 * projection — durable task terminal plus notification — already landed,
 * so a pending notification admits a continuation run immediately; the
 * loop repeats because a continuation may itself spawn more children.
 * Budget or abort exhaustion cancels each remaining child (their
 * terminals and notifications still land), allows at most one final
 * continuation, and returns; an aborted operation skips continuations
 * entirely so the main run's exit code keeps its own cancellation
 * semantics.
 */
export async function orchestrateAsyncChildren(options: AsyncChildrenOrchestration): Promise<void> {
  const budgetMs = options.budgetMs ?? HEADLESS_ASYNC_DRAIN_TIMEOUT_MS
  const cancelGraceMs = options.cancelGraceMs ?? HEADLESS_CHILD_CANCEL_GRACE_MS
  const deadline = Date.now() + budgetMs
  for (;;) {
    const aborted = options.signal?.aborted === true
    const remainingBudget = aborted ? 0 : Math.max(deadline - Date.now(), 0)
    const remaining = await options.runner.drain(remainingBudget)
    // Non-empty drain answers exist only at the deadline, and an aborted
    // operation leaves now: both wrap up after cancelling the stragglers.
    if (remaining.length > 0 || aborted) {
      for (const childSessionId of remaining) options.runner.cancelChild(childSessionId)
      await options.runner.drain(cancelGraceMs)
      if (!aborted && (await options.pendingNotifications())) settleContinuation(await options.continueRun())
      return
    }
    if (!(await options.pendingNotifications())) return
    settleContinuation(await options.continueRun())
  }
}

export interface HeadlessAttachment {
  readonly tracker: HeadlessRunTracker
  readonly writer: HeadlessJsonlEventWriter | undefined
  currentSnapshot(): Promise<PublicSessionSnapshot>
  /** Re-reads the live snapshot into the tracker; catches replayed or already-terminal runs. */
  refresh(): Promise<PublicSessionSnapshot>
  awaitOutcome(commandId: string, signal?: AbortSignal): Promise<HeadlessRunOutcome>
  /** Resolves once no run is active and no input is queued. */
  awaitIdle(signal?: AbortSignal): Promise<void>
  /** Waits for the next event batch (or the given signal). */
  waitOnce(signal?: AbortSignal): Promise<void>
  stop(): void
}

/**
 * Live attachment over the public projection: durable events fan out to the
 * run tracker, the JSONL writer and the interaction surface. Resyncs
 * rebuild the attachment from canonical history instead of guessing.
 */
async function attachPublicSession(
  session: PublicHeadlessSession,
  options: {
    readonly requestId: string
    readonly jsonlCommand?: HeadlessCommand
    readonly onInteraction?: (interaction: PublicPendingInteraction) => Promise<void>
  },
): Promise<{ readonly snapshot: PublicSessionSnapshot; readonly barrierRevision: number; readonly attachment: HeadlessAttachment }> {
  const tracker = createHeadlessRunTracker()
  const waiters: (() => void)[] = []
  const wake = (): void => {
    const pending = waiters.splice(0, waiters.length)
    for (const waiter of pending) waiter()
  }
  let writer: HeadlessJsonlEventWriter | undefined
  let pending: PublicSessionEvent[] = []
  let collectPending = options.jsonlCommand !== undefined
  // Deliberately hand-rolled: the chain keeps no drained tail, so a failed
  // rebuild poisons every later rebuild and its rejection is never consumed.
  // A per-key lane isolates failures instead; adopting it would silently
  // change what a dead attachment does after its first resync failure.
  let rebuildChain: Promise<void> = Promise.resolve()

  function onEvent(events: readonly PublicSessionEvent[]): void {
    tracker.apply(events)
    if (writer !== undefined) writer.apply(events)
    else if (collectPending) pending.push(...events)
    if (options.onInteraction !== undefined) {
      for (const event of events) {
        if (event.type === "interaction.requested") void options.onInteraction(event.interaction).catch(() => {})
      }
    }
    wake()
  }

  function onResyncRequired(): void {
    rebuildChain = rebuildChain.then(async () => {
      const previous = adapter
      adapter = session.attach({ onEvent, onResyncRequired })
      await previous.stop()
      const started = await adapter.start()
      tracker.refresh(started.snapshot)
      writer?.apply(await session.readPublicEvents())
      wake()
    })
  }

  const callbacks = { onEvent, onResyncRequired }
  let adapter = session.attach(callbacks)
  const started = await adapter.start()
  tracker.refresh(started.snapshot)
  if (options.jsonlCommand !== undefined) {
    writer = createHeadlessJsonlEventWriter(options.jsonlCommand, options.requestId, started.barrierRevision)
    if (pending.length > 0) writer.apply(pending)
  }
  collectPending = false
  pending = []

  const waitOnce = (signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolveWait, reject) => {
      const waiter = (): void => {
        cleanup()
        resolveWait()
      }
      const onAbort = (): void => {
        cleanup()
        const reason = signal?.reason
        reject(reason instanceof Error ? reason : new DOMException("headless operation cancelled", "AbortError"))
      }
      const cleanup = (): void => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        signal?.removeEventListener("abort", onAbort)
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      waiters.push(waiter)
    })

  return {
    snapshot: started.snapshot,
    barrierRevision: started.barrierRevision,
    attachment: {
      tracker,
      writer,
      currentSnapshot: () => adapter.currentSnapshot(),
      refresh: async () => {
        const snapshot = await adapter.currentSnapshot()
        tracker.refresh(snapshot)
        return snapshot
      },
      async awaitOutcome(commandId, signal) {
        for (;;) {
          const outcome = tracker.outcomeFor(commandId)
          if (outcome !== undefined) return outcome
          await waitOnce(signal)
        }
      },
      async awaitIdle(signal) {
        while (tracker.activeRunId() !== undefined || tracker.queuedInputCount() > 0) await waitOnce(signal)
      },
      waitOnce,
      stop() {
        adapter.stop()
      },
    },
  }
}

async function main(argv: readonly string[] = process.argv.slice(2), options?: { invocationName?: InvocationName }): Promise<void> {
  const invocationName = options?.invocationName ?? "agent"
  let command: AgentCliCommand
  try {
    command = parseAgentArgs(argv, { invocationName })
  } catch (error) {
    writeError("help", randomUUID(), error, "USAGE_ERROR", requestedOutputFormat(argv))
    process.exitCode = 2
    return
  }
  if (command.type === "help") {
    // Public run/serve get branded help; every hidden topic stays byte-identical.
    if (invocationName === "ag2cli" && (command.topic === "run" || command.topic === "serve")) {
      console.log(publicCommandHelp(command.topic))
    } else {
      console.log(agentHelp(command.topic))
    }
    return
  }
  if (command.type === "serve") {
    try {
      const server = await import("./server.js")
      const serverArgs = [
        ...(command.configPath === undefined ? [] : ["--config", command.configPath]),
        ...(command.workspaceRoots?.flatMap((root) => ["--workspace", root]) ?? []),
      ]
      await server.main(serverArgs)
    } catch (error) {
      const requestId = randomUUID()
      const code = classifyHeadlessError(error)
      writeError("serve", requestId, error, code, requestedOutputFormat(argv))
      process.exitCode = exitCodeForError(code)
    }
    return
  }

  const requestId = command.requestId ?? randomUUID()
  if (command.type === "version") {
    const version = await readAg2cliVersion()
    writeSuccess("version", requestId, { version }, command.format ?? requestedOutputFormat(argv), version)
    return
  }
  if (command.type === "capabilities") {
    writeSuccess(
      "capabilities",
      requestId,
      HEADLESS_CAPABILITIES,
      command.format ?? requestedOutputFormat(argv),
      JSON.stringify(HEADLESS_CAPABILITIES),
    )
    return
  }

  let config: RuntimeConfig
  try {
    const configPath = "configPath" in command ? command.configPath : undefined
    config = loadRuntimeConfig(process.env, {
      mode: "headless",
      ...(configPath === undefined ? {} : { configPath }),
    })
  } catch (error) {
    const errorCommand = command.type === "session" ? "session" : command.type
    writeError(errorCommand, requestId, error, "CONFIG_ERROR", command.format ?? requestedOutputFormat(argv))
    process.exitCode = exitCodeForError("CONFIG_ERROR")
    return
  }

  try {
    if (command.type === "pair") {
      const operation = createHeadlessOperation({ timeoutMs: command.timeoutMs })
      try {
        const result = await createAppServerConnectionLinkForEndpoint({
          endpoint: command.endpoint,
          expectedHostId: command.hostId,
          bearerToken: config.server.token,
          ...(command.clientKind === undefined ? {} : { clientKind: command.clientKind }),
          ...(command.ttlMs === undefined ? {} : { ttlMs: command.ttlMs }),
          signal: operation.signal,
        })
        writeSuccess("pair", requestId, result, command.format ?? config.outputFormat, result.link)
        return
      } finally {
        operation.close()
      }
    }

    if (command.type === "session" && command.action !== "events" && command.action !== "resume") {
      const operation = createHeadlessOperation({ timeoutMs: command.timeoutMs })
      let catalogSession: PublicHeadlessSession | undefined
      try {
        const catalogWorkspaceRoot = "cwd" in command && command.cwd !== undefined ? command.cwd : process.cwd()
        const targetSessionId = command.sessionId ?? randomUUID()
        // The catalog and event root must follow --cwd for session create/
        // resume; otherwise a target workspace would write into the caller's
        // project and disappear from that workspace's /resume list.
        catalogSession = await buildPublicHeadlessSession({
          runtimeConfig: config,
          sessionId: targetSessionId,
          mode: "read",
          workspaceRoot: catalogWorkspaceRoot,
          signal: operation.signal,
        })
        const records = catalogSession.records
        const outputFormat = command.format ?? config.outputFormat
        if (command.action === "list") {
          const listed = await records.list()
          writeSuccess("session", requestId, listed, outputFormat, JSON.stringify(listed))
          return
        }
        if (command.action === "create") {
          await records.create(targetSessionId, await canonicalizeExistingDirectory(command.cwd ?? process.cwd()))
          const record = await records.get()
          if (record === undefined) throw new Error(`Session is unreadable after creation: ${targetSessionId}`)
          writeSuccess("session", requestId, record, outputFormat, JSON.stringify(record), targetSessionId)
          return
        }
        if (!command.sessionId) throw new Error(`session ${command.action} requires session-id`)
        if (command.action === "get") {
          const record = await records.get()
          if (record === undefined) throw new Error(`Session does not exist: ${command.sessionId}`)
          writeSuccess("session", requestId, record, outputFormat, JSON.stringify(record), command.sessionId)
          return
        }
        if (command.action === "fork") {
          const target = command.targetSessionId ?? randomUUID()
          const record = await records.fork(target)
          writeSuccess("session", requestId, record, outputFormat, JSON.stringify(record), target)
          return
        }
        if (command.action === "archive") {
          const record = await records.archive()
          writeSuccess("session", requestId, record, outputFormat, JSON.stringify(record), command.sessionId)
          return
        }
        if (command.action === "delete") {
          await records.delete()
          writeSuccess(
            "session",
            requestId,
            { sessionId: command.sessionId, deleted: true },
            outputFormat,
            JSON.stringify({ sessionId: command.sessionId, deleted: true }),
            command.sessionId,
          )
          return
        }
      } finally {
        operation.close()
        await catalogSession?.close().catch(() => {})
      }
    }

    if (command.type === "session" && command.action === "resume") {
      if (!command.sessionId) throw new Error("session resume requires session-id")
      let graceful: ((kind: HeadlessAbortKind, hardAbort: () => void) => Promise<void>) | undefined
      const operation = createHeadlessOperation({
        timeoutMs: command.timeoutMs,
        onGracefulCancel: (kind, hardAbort) => {
          if (graceful === undefined) {
            hardAbort()
            return Promise.resolve()
          }
          return graceful(kind, hardAbort)
        },
      })
      let resumedSession: PublicHeadlessSession | undefined
      let attachment: HeadlessAttachment | undefined
      try {
        resumedSession = await buildPublicHeadlessSession({
          runtimeConfig: config,
          sessionId: command.sessionId,
          mode: "resume",
          ...(command.cwd === undefined ? {} : { workspaceRoot: command.cwd }),
          ...(command.skillDir === undefined ? {} : { skillDir: command.skillDir }),
          signal: operation.signal,
        })
        const facade = resumedSession.facade
        const recordedRoot = await resumedSession.recordWorkspaceRoot()
        if (recordedRoot !== undefined && command.cwd !== undefined && resolve(command.cwd) !== resolve(recordedRoot)) {
          throw new Error("Session workspaceRoot does not match --cwd; the workspace cannot be changed during a run")
        }
        const outputFormat = command.format ?? config.outputFormat
        const attached = await attachPublicSession(resumedSession, {
          requestId,
          ...(outputFormat === "jsonl" ? { jsonlCommand: "session" } : {}),
        })
        attachment = attached.attachment
        const { tracker, writer } = attached.attachment
        graceful = async (_kind, hardAbort) => {
          const runId = tracker.activeRunId()
          if (runId === undefined) {
            hardAbort()
            return
          }
          await facade.cancelRun({ sessionId: command.sessionId!, runId }).catch(() => undefined)
          while (tracker.activeRunId() !== undefined) await attached.attachment.waitOnce(operation.signal)
        }
        const seed = await facade.resumableSubmit(resumedSession.sessionId)
        await facade.submit(
          {
            sessionId: command.sessionId,
            commandId: seed.commandId,
            text: seed.goal,
            ...(seed.context === undefined ? {} : { context: [...seed.context] }),
            ...(seed.fileReferences === undefined
              ? {}
              : { fileReferences: seed.fileReferences.map((path) => ({ workspaceId: attached.snapshot.workspace.workspaceId, path })) }),
            ...(seed.maxTurns === undefined ? {} : { maxTurns: seed.maxTurns }),
          },
          {
            ...(seed.permissionMode === undefined ? {} : { permissionMode: seed.permissionMode }),
            ...(seed.permissionRules === undefined ? {} : { permissionRules: seed.permissionRules }),
          },
        )
        await attachment.refresh()
        const outcome = await attachment.awaitOutcome(seed.commandId, operation.signal)
        writeRunOutcome(
          requestId,
          outcome,
          outputFormat,
          command.sessionId,
          operation.abortKind,
          writer ? { revision: writer.revision, terminal: true } : undefined,
          "session",
        )
        return
      } finally {
        attachment?.stop()
        operation.close()
        await resumedSession?.close().catch(() => {})
      }
    }

    if (command.type === "run") {
      const streaming = command.promptFromStdin === true
      const interactive = !streaming && process.stdin.isTTY === true
      let graceful: ((kind: HeadlessAbortKind, hardAbort: () => void) => Promise<void>) | undefined
      const operation = createHeadlessOperation({
        timeoutMs: command.timeoutMs,
        onGracefulCancel: (kind, hardAbort) => {
          if (graceful === undefined) {
            hardAbort()
            return Promise.resolve()
          }
          return graceful(kind, hardAbort)
        },
      })
      let runSession: PublicHeadlessSession | undefined
      let attachment: HeadlessAttachment | undefined
      let lineReader: HeadlessLineReader | undefined
      try {
        // Auto mode routes every side-effect ask to the guardian reviewer;
        // without a resolved reviewer there is no answerer at all, so the
        // explicit flag is rejected before stdin is drained or any session
        // work starts.
        if (command.permissionMode === "auto" && !isGuardianConfigured(config)) {
          writeError(
            command.type,
            requestId,
            new Error(
              "--permission-mode auto requires a configured guardian reviewer (guardian.implementation plus AG2CLI_GUARDIAN_API_KEY)",
            ),
            "USAGE_ERROR",
            command.format ?? config.outputFormat,
            { details: { permissionMode: "auto" } },
          )
          process.exitCode = exitCodeForError("USAGE_ERROR")
          return
        }
        const stdinStream = (): ReadableStream<Uint8Array> => Bun.stdin.stream()
        let prompt: Awaited<ReturnType<typeof readHeadlessPrompt>> | undefined
        if (!streaming) {
          prompt = await readHeadlessPrompt(
            {
              goal: command.goal,
              stdin: stdinStream(),
              stdinIsTTY: process.stdin.isTTY,
              signal: operation.signal,
            },
            MAX_STDIN_BYTES,
          )
        }
        const workspaceRoot = await canonicalizeExistingDirectory(command.cwd ?? process.cwd())
        const sessionIdValue = command.sessionId ?? config.sessionId ?? randomUUID()
        // Async children are process-local: the orchestration loop below
        // needs the runner handle the composition assembles for `run`.
        let childRunner: ChildAgentRunner | null = null
        runSession = await buildPublicHeadlessSession({
          runtimeConfig: config,
          sessionId: sessionIdValue,
          mode: "run",
          workspaceRoot,
          ...(command.skillDir === undefined ? {} : { skillDir: command.skillDir }),
          ...(interactive ? { interactive: true } : {}),
          signal: operation.signal,
          onChildRunner: (runner) => {
            childRunner = runner
          },
        })
        const facade = runSession.facade
        const outputFormat = command.format ?? config.outputFormat
        const onInteraction = interactive
          ? (interaction: PublicPendingInteraction): Promise<void> => {
              lineReader ??= createTtyLineReader()
              const surface = createTtyInteractionSurface(lineReader)
              if (interaction.kind === "tool_approval") {
                return surface
                  .resolveToolApproval(interaction)
                  .then((optionId) =>
                    facade.resolveInteraction({
                      kind: "tool_approval",
                      sessionId: sessionIdValue,
                      resolutionId: randomUUID(),
                      interactionId: interaction.interactionId,
                      optionId,
                      expectedPolicyRevision: interaction.policyRevision,
                      expectedScopeRevision: interaction.scopeRevision,
                    }),
                  )
                  .then(() => undefined)
              }
              return surface
                .answerAskUser(interaction)
                .then((answer) =>
                  facade.resolveInteraction({
                    kind: "ask_user",
                    sessionId: sessionIdValue,
                    resolutionId: randomUUID(),
                    interactionId: interaction.interactionId,
                    answer,
                  }),
                )
                .then(() => undefined)
            }
          : undefined
        const attached = await attachPublicSession(runSession, {
          requestId,
          ...(outputFormat === "jsonl" ? { jsonlCommand: "run" } : {}),
          ...(onInteraction === undefined ? {} : { onInteraction }),
        })
        attachment = attached.attachment
        const { tracker, writer } = attached.attachment
        const snapshot = attached.snapshot
        // An existing full-access session refuses an unflagged resume: the
        // confirmation semantics have no interactive approver here, so the
        // explicit mode must ride every command (and the TUI cannot see
        // local-run history).
        if (snapshot.asOfRevision > 0 && snapshot.security.permissionMode === "full-access" && command.permissionMode === undefined) {
          writeError(
            command.type,
            requestId,
            new Error(
              `session ${sessionIdValue} is in full-access mode; resume it with an explicit mode (${invocationName} run --permission-mode <mode>)`,
            ),
            "USAGE_ERROR",
            outputFormat,
            { sessionId: sessionIdValue, details: { permissionMode: "full-access" } },
          )
          process.exitCode = exitCodeForError("USAGE_ERROR")
          return
        }
        // A session the catalog has never seen must exist before submit can
        // admit any input; create is idempotent per (sessionId, payload).
        if (snapshot.asOfRevision === 0) {
          await facade.createSession({ sessionId: sessionIdValue, workspaceId: snapshot.workspace.workspaceId })
        }
        // --permission-mode only applies when explicitly provided; the CAS
        // revision comes from the attachment's barrier snapshot. Omission
        // leaves canonical state unchanged.
        if (command.permissionMode !== undefined) {
          await facade.setPermissionMode({
            sessionId: sessionIdValue,
            mode: command.permissionMode,
            expectedPolicyRevision: snapshot.security.policyRevision,
          })
        }
        graceful = async (_kind, hardAbort) => {
          const runId = tracker.activeRunId()
          if (runId === undefined) {
            hardAbort()
            return
          }
          await facade.cancelRun({ sessionId: sessionIdValue, runId }).catch(() => undefined)
          while (tracker.activeRunId() !== undefined) await attached.attachment.waitOnce(operation.signal)
        }

        const submit = async (commandId: string, text: string, extensions?: { readonly maxTurns?: number }): Promise<void> => {
          await facade.submit({
            sessionId: sessionIdValue,
            commandId,
            text,
            ...(extensions?.maxTurns === undefined ? {} : { maxTurns: extensions.maxTurns }),
          })
          await attached.attachment.refresh()
        }

        let outcome: HeadlessRunOutcome
        if (streaming) {
          // `-` streams stdin line by line: the first line is the goal,
          // later lines steer the active run or start a new one when idle.
          let stopRequested = false
          let stopWaiter: (() => void) | undefined
          const stopReader = (): void => {
            stopRequested = true
            stopWaiter?.()
          }
          const previousGraceful = graceful
          graceful = async (kind, hardAbort) => {
            stopReader()
            await previousGraceful?.(kind, hardAbort)
          }
          const stopped = new Promise<void>((resolveStop) => {
            stopWaiter = resolveStop
          })
          const iterator = readStdinLines(stdinStream(), MAX_STDIN_BYTES, operation.signal)[Symbol.asyncIterator]()
          let lastCommandId: string | undefined
          let goalSubmitted = false
          try {
            for (;;) {
              const next = await Promise.race([
                iterator.next(),
                stopped.then((): IteratorResult<string> => ({ done: true, value: undefined })),
              ])
              if (stopRequested || next.done) break
              const text = next.value.trim()
              if (text === "") continue
              if (!goalSubmitted) {
                goalSubmitted = true
                lastCommandId = requestId
                await submit(lastCommandId, text, command.maxTurns === undefined ? undefined : { maxTurns: command.maxTurns })
                continue
              }
              const runId = tracker.activeRunId()
              if (runId === undefined) {
                const commandId = randomUUID()
                lastCommandId = commandId
                await submit(commandId, text)
                continue
              }
              try {
                await facade.steer({ sessionId: sessionIdValue, runId, commandId: randomUUID(), text })
              } catch (error) {
                if (!(error instanceof RpcApplicationError) || error.kind !== "run_not_active") throw error
                const commandId = randomUUID()
                lastCommandId = commandId
                await submit(commandId, text)
              }
            }
          } finally {
            await iterator.return?.(undefined).catch(() => undefined)
          }
          if (!goalSubmitted) throw new Error("stdin did not contain a non-empty prompt")
          // Exit only when stdin is exhausted, no run is active and no
          // input is waiting in the mailbox.
          await attached.attachment.awaitIdle(operation.signal)
          const streamed = tracker.outcomeFor(lastCommandId!)
          if (streamed === undefined) throw new Error("streaming dispatch produced no run outcome")
          outcome = streamed
        } else {
          if (prompt === undefined) throw new Error("run requires a goal")
          await submit(requestId, prompt.goal, command.maxTurns === undefined ? undefined : { maxTurns: command.maxTurns })
          outcome = await attached.attachment.awaitOutcome(requestId, operation.signal)
        }
        if (childRunner !== null) {
          // Hold-back before the final round: the process stays while
          // async children run, consuming their notifications through
          // bounded continuation runs; exit codes keep mapping the main
          // run because a continuation failure throws into the existing
          // error classification.
          await orchestrateAsyncChildren({
            runner: childRunner,
            signal: operation.signal,
            pendingNotifications: async () => {
              const current = await attached.attachment.currentSnapshot()
              return current.inputs.some((input) => input.kind === "notification" && input.status === "queued")
            },
            continueRun: async () => {
              const commandId = randomUUID()
              await submit(commandId, "background children settled; consume notifications and wrap up")
              return await attached.attachment.awaitOutcome(commandId, operation.signal)
            },
          })
        }
        writeRunOutcome(
          requestId,
          outcome,
          outputFormat,
          sessionIdValue,
          operation.abortKind,
          writer ? { revision: writer.revision, terminal: true } : undefined,
        )
        return
      } finally {
        attachment?.stop()
        lineReader?.close()
        operation.close()
        await runSession?.close().catch(() => {})
      }
    }

    const sessionIdValue = command.sessionId
    if (!sessionIdValue) throw new Error("This command requires session-id")
    const operation = createHeadlessOperation({ timeoutMs: command.timeoutMs })
    let readSession: PublicHeadlessSession | undefined
    try {
      readSession = await buildPublicHeadlessSession({
        runtimeConfig: config,
        sessionId: sessionIdValue,
        mode: "read",
        ...("cwd" in command && command.cwd !== undefined ? { workspaceRoot: command.cwd } : {}),
        signal: operation.signal,
      })
      const facade = readSession.facade
      const recordedRoot = await readSession.recordWorkspaceRoot()
      const commandCwd = "cwd" in command ? command.cwd : undefined
      if (recordedRoot !== undefined && commandCwd !== undefined && resolve(commandCwd) !== resolve(recordedRoot)) {
        throw new Error("Session workspaceRoot does not match --cwd; the workspace cannot be changed during a run")
      }
      const outputFormat = command.format ?? config.outputFormat
      if (command.type === "inspect") {
        const snapshot = await readSession.publicSnapshot()
        writeSuccess("inspect", requestId, snapshot, outputFormat, JSON.stringify(snapshot), sessionIdValue)
        return
      }
      if (command.type === "observe") {
        const records = (
          await facade.modelCalls({ sessionId: sessionIdValue, ...(config.observability.includePayload ? { includePayload: true } : {}) })
        ).records
        writeSuccess("observe", requestId, records, outputFormat, JSON.stringify(records), sessionIdValue)
        return
      }
      if (command.type === "trace") {
        const records = (await facade.trace({ sessionId: sessionIdValue })).records
        writeSuccess("trace", requestId, records, outputFormat, JSON.stringify(records), sessionIdValue)
        return
      }
      if (command.type === "session" && command.action === "checkpoints") {
        const result = await facade.listCheckpoints({ sessionId: sessionIdValue })
        const text = result.checkpoints
          .map((checkpoint) => `${checkpoint.checkpointId} · ${checkpoint.kind} · revision ${checkpoint.headRevision}`)
          .join("\n")
        const snapshot = await readSession.publicSnapshot()
        writeSuccess("session", requestId, result.checkpoints, outputFormat, text, sessionIdValue, undefined, {
          revision: snapshot.asOfRevision,
        })
        return
      }
      if (command.type === "session" && (command.action === "preview-rewind" || command.action === "rewind")) {
        if (command.action === "preview-rewind") {
          const result = await facade.previewRewind({
            sessionId: sessionIdValue,
            checkpointId: command.checkpointId!,
            ...(command.expectedRevision === undefined ? {} : { expectedRevision: command.expectedRevision }),
          })
          writeSuccess("session", requestId, result, outputFormat, JSON.stringify(result), sessionIdValue, undefined, {
            revision: result.currentRevision,
          })
          return
        }
        const result = await facade.rewind({
          sessionId: sessionIdValue,
          commandId: requestId,
          checkpointId: command.checkpointId!,
          ...(command.expectedRevision === undefined ? {} : { expectedRevision: command.expectedRevision }),
        })
        if (result.status === "failed" || result.status === "already_failed") {
          writeError("session", requestId, result.error ?? new Error(`rewind ${result.status}`), "RUNTIME_ERROR", outputFormat, {
            sessionId: sessionIdValue,
            details: { result },
          })
          process.exitCode = exitCodeForError("RUNTIME_ERROR")
          return
        }
        const snapshot = await readSession.publicSnapshot()
        writeSuccess("session", requestId, result, outputFormat, result.status, sessionIdValue, undefined, {
          revision: snapshot.asOfRevision,
        })
        return
      }
      if (command.type === "session" && command.action === "events") {
        const events = await readSession.readPublicEvents()
        if (outputFormat === "jsonl") {
          for (const event of events) process.stdout.write(serializeHeadlessEvent("session", requestId, event))
        } else {
          writeSuccess("session", requestId, events, outputFormat, JSON.stringify(events), sessionIdValue)
        }
        return
      }
      throw new Error(`session ${command.type === "session" ? command.action : ""} is not implemented`)
    } finally {
      operation.close()
      await readSession?.close().catch(() => {})
    }
  } catch (error) {
    const errorCommand = command.type === "session" ? "session" : command.type
    const code = classifyHeadlessError(error)
    writeError(errorCommand, requestId, error, code, command.format ?? config.outputFormat)
    process.exitCode = exitCodeForError(code)
  } finally {
    await cleanupScratchRoots()
  }
}

function writeSuccess<T>(
  command: "version" | "capabilities" | "pair" | "run" | "inspect" | "observe" | "trace" | "session",
  requestId: string,
  data: T,
  format: HeadlessOutputFormat,
  text: string,
  sessionId?: string,
  runId?: string,
  meta?: HeadlessMeta,
): void {
  process.stdout.write(serializeHeadless(successEnvelope(command, requestId, data, { sessionId, runId, meta }), format, text))
}

function writeError(
  command: "version" | "capabilities" | "pair" | "run" | "inspect" | "observe" | "trace" | "session" | "help" | "serve",
  requestId: string,
  error: unknown,
  code: HeadlessErrorCode,
  format: HeadlessOutputFormat,
  options: {
    readonly sessionId?: string
    readonly runId?: string
    readonly meta?: HeadlessMeta
    readonly details?: Readonly<Record<string, unknown>>
  } = {},
): void {
  const message = error instanceof Error ? error.message : String(error)
  if (format === "text") {
    process.stderr.write(`${message}\n`)
    return
  }
  process.stdout.write(
    serializeHeadless(
      errorEnvelope(
        command,
        requestId,
        {
          code,
          message,
          ...(options.details ? { details: options.details } : {}),
        },
        {
          ...options,
          ...(format === "jsonl" ? { meta: { ...options.meta, terminal: true } } : {}),
        },
      ),
      format,
      message,
    ),
  )
}

function writeRunOutcome(
  requestId: string,
  result: HeadlessRunOutcome,
  format: HeadlessOutputFormat,
  sessionId: string,
  abortKind: "timeout" | "signal" | undefined,
  meta?: HeadlessMeta,
  command: "run" | "session" = "run",
): void {
  if (result.status === "completed") {
    writeSuccess(command, requestId, result, format, runText(result), sessionId, result.runId, meta)
    return
  }
  // A durable approval_required terminal classifies identically to a live
  // refusal, so same-id retries stay exit 5.
  const code: HeadlessErrorCode =
    result.status === "cancelled"
      ? abortKind === "timeout"
        ? "TIMEOUT"
        : "CANCELLED"
      : result.failureCode === "approval_required"
        ? "APPROVAL_REQUIRED"
        : "RUNTIME_ERROR"
  writeError(command, requestId, result.error ?? result.status, code, format, {
    sessionId,
    runId: result.runId,
    ...(meta ? { meta } : {}),
    details: { status: result.status, turns: result.turns },
  })
  process.exitCode = exitCodeForError(code)
}

function requestedOutputFormat(argv: readonly string[]): HeadlessOutputFormat {
  let format: HeadlessOutputFormat | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--json") format = "json"
    else if (arg === "--format" && argv[index + 1]) {
      const value = argv[++index]
      if (value === "text" || value === "json" || value === "jsonl") format = value
    } else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length)
      if (value === "text" || value === "json" || value === "jsonl") format = value
    }
  }
  if (format) return format
  const configured = process.env.AG2CLI_OUTPUT_FORMAT
  return configured === "text" || configured === "jsonl" ? configured : "json"
}

/** Public §16 codes mapped onto the headless envelope codes. */
const RPC_ERROR_CODES: Readonly<Record<string, HeadlessErrorCode>> = {
  invalid_params: "USAGE_ERROR",
  invalid_intent: "USAGE_ERROR",
  invalid_result: "PROTOCOL_ERROR",
  method_not_found: "PROTOCOL_ERROR",
  protocol_version_mismatch: "PROTOCOL_ERROR",
  scope_denied: "PROTOCOL_ERROR",
  session_not_found: "RUNTIME_ERROR",
  run_not_active: "RUNTIME_ERROR",
  revision_conflict: "PERSISTENCE_ERROR",
  revision_ahead: "PERSISTENCE_ERROR",
  policy_revision_conflict: "PERSISTENCE_ERROR",
  reservation_conflict: "PERSISTENCE_ERROR",
  command_idempotency_conflict: "PERSISTENCE_ERROR",
  interaction_already_resolved: "RUNTIME_ERROR",
  stale_approval: "RUNTIME_ERROR",
  interaction_expired: "RUNTIME_ERROR",
  unsupported_event: "PROTOCOL_ERROR",
  capability_unavailable: "RUNTIME_ERROR",
  capability_denied: "PERMISSION_DENIED",
  workspace_access_denied: "PERMISSION_DENIED",
  workspace_unavailable: "PERMISSION_DENIED",
  workspace_path_denied: "PERMISSION_DENIED",
  workspace_changed: "PERSISTENCE_ERROR",
  interaction_lease_required: "PROTOCOL_ERROR",
  interaction_lease_scope_mismatch: "PROTOCOL_ERROR",
  interaction_lease_held: "PROTOCOL_ERROR",
  interaction_lease_stale: "PROTOCOL_ERROR",
  interaction_scope_unclassified: "PROTOCOL_ERROR",
  interaction_unavailable: "PROTOCOL_ERROR",
  invalid_lease_ttl: "PROTOCOL_ERROR",
  connection_not_registered: "PROTOCOL_ERROR",
  invalid_host_result: "PROTOCOL_ERROR",
}

/**
 * Two error layers only: public contract failures arrive as typed
 * RpcApplicationError codes, local lifecycle failures as typed error
 * classes. Message regexes are deliberately absent.
 */
function classifyHeadlessError(error: unknown): HeadlessErrorCode {
  if (error instanceof RpcApplicationError) return RPC_ERROR_CODES[error.kind] ?? "RUNTIME_ERROR"
  if (error instanceof PairAuthenticationError) return "AUTH_ERROR"
  if (error instanceof ModelConfigurationError) return "PROVIDER_ERROR"
  if (error instanceof DOMException && error.name === "TimeoutError") return "TIMEOUT"
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT"
  if (error instanceof DOMException && error.name === "AbortError") return "CANCELLED"
  if (error instanceof Error && error.name === "AbortError") return "CANCELLED"
  return "RUNTIME_ERROR"
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const code = error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "RUNTIME_ERROR"
    writeError("help", randomUUID(), error, code, "json")
    process.exitCode = exitCodeForError(code)
  })
}

export { main, classifyHeadlessError }
