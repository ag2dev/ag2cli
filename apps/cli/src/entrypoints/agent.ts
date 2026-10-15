#!/usr/bin/env bun

import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { buildAgentRunRuntime } from "../composition/agent-run-runtime.js"
import { guardianReviewDeadlineMs, pickGuardian, pickModelClient } from "../composition/model-client.js"
import { ModelPlanProvider } from "../infrastructure/model/model-plan-provider.js"
import type { PlanProvider } from "@ag2cli/runtime/ports/model-provider.js"
import { connectSession, createPlan, getSessionSnapshot, readSessionModelCalls, readSessionTrace, runAgent } from "../public/sdk.js"
import type { SessionClient } from "@ag2cli/client/session-client.js"
import {
  listCheckpointsCommand,
  previewRewindCommand,
  readEventsCommand,
  rewindCommand,
  setPermissionModeCommand,
} from "@ag2cli/protocol/session-command.js"
import { isSessionPermissionMode, type SessionPermissionMode } from "@ag2cli/core/session/session-security.js"
import { agentHelp, parseAgentArgs, publicCommandHelp, type AgentCliCommand } from "../interfaces/cli/agent-cli.js"
import type { InvocationName } from "../interfaces/cli/unified-cli.js"
import { isGuardianConfigured, loadRuntimeConfig, type RuntimeConfig } from "../config/runtime.js"
import { type HeadlessOutputFormat } from "../config/output-format.js"
import {
  errorEnvelope,
  exitCodeForError,
  HEADLESS_CAPABILITIES,
  successEnvelope,
  type HeadlessErrorCode,
  type HeadlessMeta,
} from "../interfaces/cli/headless-contract.js"
import { createHeadlessJsonlEventWriter, serializeHeadless, serializeHeadlessEvent } from "../interfaces/cli/headless-output.js"
import { planText, runText } from "../interfaces/cli/headless-output.js"
import { sessionId as parseSessionId } from "@ag2cli/core/ids.js"
import { findResumableRun } from "@ag2cli/runtime/application/session/resumable-run.js"
import { readHeadlessPrompt } from "../interfaces/cli/headless-input.js"
import { MAX_STDIN_BYTES } from "../capabilities/security/resource-limits.js"
import { readAg2cliVersion } from "../public/version.js"
import { createHeadlessOperation } from "../interfaces/cli/headless-operation.js"
import { createAppServerConnectionLinkForEndpoint } from "../interfaces/cli/app-server-pairing.js"
import type { RunResult } from "@ag2cli/core/execution/run.js"
import type { ChildAgentRunner } from "../capabilities/execution/child-agent-runner.js"
import { canonicalizeExistingDirectory } from "../capabilities/security/workspace.js"
import { cleanupScratchRoots } from "../capabilities/security/scratch.js"

/** Read-only commands inject this provider: reaching plan generation there is a programming error. */
const readOnlyPlanProvider: PlanProvider = {
  async generatePlan() {
    throw new Error("This read-only command must not call PlanProvider")
  },
}

/** Whole-process budget for async children to settle after the main run before cancels. */
export const HEADLESS_ASYNC_DRAIN_TIMEOUT_MS = 300_000

/** Grace for budget-cancelled children to land their cancelled terminals in durable history. */
export const HEADLESS_CHILD_CANCEL_GRACE_MS = 1_000

/** A continuation's non-completed terminal surfaces as a throw so the existing error classification maps it. */
function settleContinuation(result: RunResult): void {
  if (result.status === "failed") throw new Error(result.error ?? "continuation run failed")
  if (result.status === "cancelled") throw new DOMException("continuation run cancelled", "AbortError")
}

export interface AsyncChildrenOrchestration {
  /** The process-local child runner handle captured at composition. */
  readonly runner: Pick<ChildAgentRunner, "drain" | "cancelChild">
  /** True while an unconsumed task notification is pending on the session. */
  readonly pendingNotifications: () => Promise<boolean>
  /** Starts one continuation run that consumes the pending notifications. */
  readonly continueRun: () => Promise<RunResult>
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
import { SessionExecutionReservationConflictError } from "@ag2cli/runtime/ports/session-execution-reservation.js"
import { SessionPolicyRevisionConflictError } from "@ag2cli/runtime/application/session/permission-state.js"
import { ApprovalRequiredError } from "@ag2cli/runtime/application/execution/approval-required-error.js"

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
      const operation = createHeadlessOperation(command.timeoutMs)
      try {
        const result = await createAppServerConnectionLinkForEndpoint({
          endpoint: command.endpoint,
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
    if (command.type === "plan" || command.type === "run") {
      const operation = createHeadlessOperation(command.timeoutMs)
      let connection: Awaited<ReturnType<typeof connectClient>> | undefined
      let eventWriter: ReturnType<typeof createHeadlessJsonlEventWriter> | undefined
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
        const prompt = await readHeadlessPrompt(
          {
            goal: command.goal,
            ...(command.promptFromStdin ? { promptFromStdin: true } : {}),
            stdin: Bun.stdin.stream(),
            stdinIsTTY: process.stdin.isTTY,
            signal: operation.signal,
          },
          MAX_STDIN_BYTES,
        )
        const workspaceRoot = await canonicalizeExistingDirectory(command.cwd ?? process.cwd())
        const sessionId = command.sessionId ?? config.sessionId ?? randomUUID()
        const correlationTrace =
          config.correlation.traceId && config.correlation.operationId
            ? { traceId: config.correlation.traceId, operationId: config.correlation.operationId, causationId: requestId }
            : undefined
        // Async children are process-local: the orchestration loop below
        // needs the runner handle the composition assembles for `run`.
        let childRunner: ChildAgentRunner | null = null
        connection = await connectClient(command, sessionId, config, operation.signal, {
          onChildRunner: (runner) => {
            childRunner = runner
          },
        })
        const client = connection.client
        const outputFormat = command.format ?? config.outputFormat
        const snapshot = await getSessionSnapshot(client, { signal: operation.signal })
        // An existing full-access session refuses an unflagged resume: the
        // confirmation semantics have no interactive approver here, so the
        // explicit mode must ride every command (plan cannot carry the
        // flag, and the TUI cannot see local-run history).
        if (snapshot.lastRevision > 0 && snapshot.permissionMode === "full-access" && command.permissionMode === undefined) {
          writeError(
            command.type,
            requestId,
            new Error(
              `session ${sessionId} is in full-access mode; resume it with an explicit mode (${invocationName} run --permission-mode <mode>)`,
            ),
            "USAGE_ERROR",
            outputFormat,
            { sessionId, details: { permissionMode: "full-access" } },
          )
          process.exitCode = exitCodeForError("USAGE_ERROR")
          return
        }
        // --permission-mode only applies when explicitly provided. New sessions
        // store it in the start_run seed; existing sessions record it through
        // set_permission_mode before the run. Omission leaves canonical state unchanged.
        let freshPermissionMode: SessionPermissionMode | undefined
        if (command.permissionMode !== undefined) {
          if (snapshot.lastRevision > 0) {
            const result = await client.execute(
              setPermissionModeCommand({
                commandId: randomUUID(),
                mode: command.permissionMode,
                expectedPolicyRevision: snapshot.policyRevision,
              }),
              { signal: operation.signal },
            )
            if (result.type !== "permission_updated") throw new Error("Session did not return permission_updated")
          } else {
            freshPermissionMode = command.permissionMode
          }
        }
        eventWriter = outputFormat === "jsonl" ? createHeadlessJsonlEventWriter(client, command.type, requestId) : undefined
        if (eventWriter) await eventWriter.start(operation.signal)
        if (command.type === "plan") {
          const plan = await createPlan(
            client,
            {
              commandId: requestId,
              goal: prompt.goal,
              ...(prompt.context ? { context: prompt.context } : {}),
              workspace: workspaceRoot,
              ...(correlationTrace ? { trace: correlationTrace } : {}),
            },
            { signal: operation.signal },
          )
          await eventWriter?.flush(operation.signal)
          writeSuccess(
            "plan",
            requestId,
            plan,
            outputFormat,
            planText(plan),
            sessionId,
            undefined,
            eventWriter ? { revision: eventWriter.revision, terminal: true } : undefined,
          )
          return
        }
        const result = await runAgent(
          client,
          {
            commandId: requestId,
            goal: prompt.goal,
            ...(prompt.context ? { context: prompt.context } : {}),
            workspace: workspaceRoot,
            ...(command.maxTurns ? { maxTurns: command.maxTurns } : {}),
            ...(freshPermissionMode ? { permissionMode: freshPermissionMode } : {}),
            ...(correlationTrace ? { trace: correlationTrace } : {}),
          },
          { signal: operation.signal },
        )
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
              const snapshot = await getSessionSnapshot(client, { signal: operation.signal })
              return snapshot.inputs.some((input) => input.kind === "notification" && input.status === "pending")
            },
            continueRun: () =>
              runAgent(
                client,
                {
                  commandId: randomUUID(),
                  goal: "background children settled; consume notifications and wrap up",
                  workspace: workspaceRoot,
                  ...(correlationTrace ? { trace: correlationTrace } : {}),
                },
                { signal: operation.signal },
              ),
          })
        }
        await eventWriter?.flush(operation.signal)
        writeRunOutcome(
          requestId,
          result,
          outputFormat,
          sessionId,
          operation.abortKind,
          eventWriter ? { revision: eventWriter.revision, terminal: true } : undefined,
        )
        return
      } finally {
        eventWriter?.close()
        operation.close()
        await connection?.close().catch(() => {})
      }
    }

    if (command.type === "session" && command.action !== "events") {
      const operation = createHeadlessOperation(command.timeoutMs)
      let localHost: Awaited<ReturnType<typeof buildAgentRunRuntime>> | undefined
      try {
        const catalogWorkspaceRoot = "cwd" in command && command.cwd !== undefined ? command.cwd : process.cwd()
        localHost = await buildAgentRunRuntime({
          signal: operation.signal,
          runtimeConfig: config,
          // The catalog and event root must follow --cwd for session create/
          // resume; otherwise a target workspace would write into the caller's
          // project and disappear from that workspace's /resume list.
          workspaceRoot: catalogWorkspaceRoot,
          provider: readOnlyPlanProvider,
        })
        const catalog = localHost.catalog
        if (!catalog) throw new Error("Session catalog is unavailable")
        const options = { signal: operation.signal }
        if (command.action === "list") {
          const records = await catalog.list(options)
          writeSuccess("session", requestId, records, command.format ?? config.outputFormat, JSON.stringify(records))
          return
        }
        if (command.action === "create") {
          const createdId = parseSessionId(command.sessionId ?? randomUUID())
          const workspaceRoot = await canonicalizeExistingDirectory(command.cwd ?? process.cwd())
          await catalog.create(createdId, workspaceRoot, options)
          const record = await catalog.get(createdId, options)
          if (!record) throw new Error(`Session is unreadable after creation: ${createdId}`)
          writeSuccess("session", requestId, record, command.format ?? config.outputFormat, JSON.stringify(record), record.sessionId)
          return
        }
        if (!command.sessionId) throw new Error(`session ${command.action} requires session-id`)
        const id = parseSessionId(command.sessionId)
        if (command.action === "get") {
          const record = await catalog.get(id, options)
          if (!record) throw new Error(`Session does not exist: ${id}`)
          writeSuccess("session", requestId, record, command.format ?? config.outputFormat, JSON.stringify(record), id)
          return
        }
        if (command.action === "fork") {
          const target = parseSessionId(command.targetSessionId ?? randomUUID())
          const record = await catalog.fork(id, target, undefined, options)
          writeSuccess("session", requestId, record, command.format ?? config.outputFormat, JSON.stringify(record), target)
          return
        }
        if (command.action === "archive") {
          const record = await catalog.archive(id, options)
          writeSuccess("session", requestId, record, command.format ?? config.outputFormat, JSON.stringify(record), id)
          return
        }
        if (command.action === "delete") {
          await catalog.delete(id, options)
          writeSuccess(
            "session",
            requestId,
            { sessionId: id, deleted: true },
            command.format ?? config.outputFormat,
            JSON.stringify({ sessionId: id, deleted: true }),
            id,
          )
          return
        }
      } finally {
        operation.close()
        await localHost?.close()
      }
    }

    if (command.type === "session" && command.action === "resume") {
      if (!command.sessionId) throw new Error("session resume requires session-id")
      const id = parseSessionId(command.sessionId)
      const operation = createHeadlessOperation(command.timeoutMs)
      let connection: Awaited<ReturnType<typeof connectClient>> | undefined
      let eventWriter: ReturnType<typeof createHeadlessJsonlEventWriter> | undefined
      try {
        connection = await connectClient(command, id, config, operation.signal)
        const client = connection.client
        const eventResult = await client.execute(readEventsCommand(), { signal: operation.signal })
        if (eventResult.type !== "events") throw new Error("Session did not return events")
        const resumable = findResumableRun(eventResult.events)
        if (!resumable) throw new Error(`Session has no unfinished run to resume: ${id}`)
        // The retry must repeat the recorded start_run input exactly: a
        // fresh-seeded run carries its permissionMode in the fingerprint, so
        // resubmitting without it is an idempotency conflict. Reuse the
        // recorded seed — the same reuse-recovery the host applies to
        // interrupted runs — instead of dropping it. The anchor matches the
        // runtime's start_run family so a foreign family's CommandAccepted
        // sharing the commandId never feeds this retry.
        const anchor = eventResult.events.find(
          (event) =>
            event.type === "CommandAccepted" &&
            event.payload.family === "start_run" &&
            event.payload.commandId === resumable.payload.commandId,
        )
        const recordedMode = anchor?.type === "CommandAccepted" ? anchor.payload.inputFingerprint.permissionMode : undefined
        const resumeMode = isSessionPermissionMode(recordedMode) ? recordedMode : undefined
        const outputFormat = command.format ?? config.outputFormat
        eventWriter = outputFormat === "jsonl" ? createHeadlessJsonlEventWriter(client, "session", requestId) : undefined
        if (eventWriter) await eventWriter.start(operation.signal)
        const result = await runAgent(
          client,
          {
            commandId: resumable.payload.commandId,
            goal: resumable.payload.goal,
            maxTurns: resumable.payload.maxTurns,
            ...(resumeMode ? { permissionMode: resumeMode } : {}),
            ...(command.cwd ? { workspace: command.cwd } : {}),
          },
          { signal: operation.signal },
        )
        await eventWriter?.flush(operation.signal)
        writeRunOutcome(
          requestId,
          result,
          outputFormat,
          id,
          operation.abortKind,
          eventWriter ? { revision: eventWriter.revision, terminal: true } : undefined,
          "session",
        )
        return
      } finally {
        eventWriter?.close()
        operation.close()
        await connection?.close().catch(() => {})
      }
    }

    const sessionId = command.sessionId
    if (!sessionId) throw new Error("This command requires session-id")
    const operation = createHeadlessOperation(command.timeoutMs)
    let connection: Awaited<ReturnType<typeof connectClient>> | undefined
    try {
      connection = await connectClient(command, sessionId, config, operation.signal)
      const client = connection.client
      if (command.type === "inspect") {
        const snapshot = await getSessionSnapshot(client, { signal: operation.signal })
        writeSuccess("inspect", requestId, snapshot, command.format ?? config.outputFormat, JSON.stringify(snapshot), sessionId)
        return
      }
      if (command.type === "observe") {
        const records = await readSessionModelCalls(client, config.observability.includePayload, { signal: operation.signal })
        writeSuccess("observe", requestId, records, command.format ?? config.outputFormat, JSON.stringify(records), sessionId)
        return
      }
      if (command.type === "trace") {
        const records = await readSessionTrace(client, { signal: operation.signal })
        writeSuccess("trace", requestId, records, command.format ?? config.outputFormat, JSON.stringify(records), sessionId)
        return
      }
      if (command.type === "session" && command.action === "checkpoints") {
        const result = await client.execute(listCheckpointsCommand(), { signal: operation.signal })
        if (result.type !== "checkpoints") throw new Error("Session did not return checkpoints")
        const outputFormat = command.format ?? config.outputFormat
        const text = result.checkpoints
          .map((checkpoint) => `${checkpoint.checkpointId} · ${checkpoint.kind} · revision ${checkpoint.headRevision}`)
          .join("\n")
        writeSuccess("session", requestId, result.checkpoints, outputFormat, text, sessionId, undefined, {
          revision: result.snapshot.lastRevision,
        })
        return
      }
      if (command.type === "session" && (command.action === "preview-rewind" || command.action === "rewind")) {
        const request =
          command.action === "preview-rewind"
            ? previewRewindCommand({
                checkpointId: command.checkpointId!,
                expectedRevision: command.expectedRevision,
              })
            : rewindCommand({
                commandId: requestId,
                checkpointId: command.checkpointId!,
                expectedRevision: command.expectedRevision,
              })
        const result = await client.execute(request, { signal: operation.signal })
        const outputFormat = command.format ?? config.outputFormat
        if (command.action === "preview-rewind") {
          if (result.type !== "rewind_preview") throw new Error("Session did not return rewind_preview")
          writeSuccess("session", requestId, result.preview, outputFormat, JSON.stringify(result.preview), sessionId, undefined, {
            revision: result.snapshot.lastRevision,
          })
          return
        }
        if (result.type !== "rewind_result") throw new Error("Session did not return rewind_result")
        if (result.result.status === "failed" || result.result.status === "already_failed") {
          writeError("session", requestId, result.result.error, "RUNTIME_ERROR", outputFormat, {
            sessionId,
            details: { result: result.result },
          })
          process.exitCode = exitCodeForError("RUNTIME_ERROR")
          return
        }
        writeSuccess("session", requestId, result.result, outputFormat, result.result.status, sessionId, undefined, {
          revision: result.snapshot.lastRevision,
        })
        return
      }
      if (command.type === "session" && command.action === "events") {
        const result = await client.execute(readEventsCommand(), { signal: operation.signal })
        if (result.type !== "events") throw new Error("Session did not return events")
        const outputFormat = command.format ?? config.outputFormat
        if (outputFormat === "jsonl") {
          for (const event of result.events) process.stdout.write(serializeHeadlessEvent("session", requestId, event))
        } else {
          writeSuccess("session", requestId, result.events, outputFormat, JSON.stringify(result.events), sessionId)
        }
        return
      }
      throw new Error(`session ${command.type === "session" ? command.action : ""} is not implemented`)
    } finally {
      operation.close()
      await connection?.close().catch(() => {})
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

async function connectClient(
  command: Exclude<AgentCliCommand, { readonly type: "help" | "serve" | "pair" }>,
  sessionId: string,
  config: RuntimeConfig,
  signal?: AbortSignal,
  edges?: { readonly onChildRunner?: (runner: ChildAgentRunner) => void },
): Promise<{
  readonly client: SessionClient
  readonly catalog: import("@ag2cli/runtime/ports/session-catalog.js").SessionCatalog
  readonly close: () => Promise<void>
}> {
  const commandCwd = "cwd" in command ? command.cwd : undefined
  if (command.type === "plan" || command.type === "run") {
    if (signal?.aborted)
      throw signal.reason instanceof Error ? signal.reason : new DOMException("headless operation cancelled", "AbortError")
    const host = await buildAgentRunRuntime({
      signal,
      runtimeConfig: config,
      workspaceRoot: commandCwd ?? process.cwd(),
      strictCapabilities: command.skillDir !== undefined,
      ...(edges?.onChildRunner === undefined ? {} : { onChildRunner: edges.onChildRunner }),
      ...(command.type === "plan"
        ? { provider: new ModelPlanProvider(await pickModelClient(config)) }
        : {
            client: await pickModelClient(config),
            // The guardian answers auto-mode asks; a run seeded with auto (or
            // resuming one) converges approval_required without it.
            guardian: await pickGuardian(config),
            guardianDeadlineMs: guardianReviewDeadlineMs(config),
            ...(command.skillDir ? { skillRoot: command.skillDir } : {}),
          }),
    })
    return {
      client: connectSession(host.sessionServer, sessionId),
      catalog: host.catalog,
      close: () => host.close(),
    }
  }
  // The personal local CLI is intentionally non-interactive at this boundary;
  // a future TUI approval broker can be injected without changing the runtime.
  const needsExecution = command.type === "session" && command.action === "resume"
  const explicitCapabilities =
    command.type === "session" && command.action === "resume"
      ? {
          ...(command.skillDir ? { skillRoot: command.skillDir } : {}),
        }
      : {}
  const host = await buildAgentRunRuntime({
    signal,
    strictCapabilities: command.type === "session" && command.action === "resume" ? command.skillDir !== undefined : false,
    runtimeConfig: config,
    sessionId: parseSessionId(sessionId),
    workspaceRoot: commandCwd,
    ...explicitCapabilities,
    ...(needsExecution
      ? {
          client: await pickModelClient(config),
          // A resumed run keeps its auto mode: the configured guardian, if
          // any, stays its only ask answerer.
          guardian: await pickGuardian(config),
          guardianDeadlineMs: guardianReviewDeadlineMs(config),
        }
      : { provider: readOnlyPlanProvider }),
  })
  try {
    const current = await host.catalog?.get(parseSessionId(sessionId))
    if (current?.snapshot.workspaceRoot && commandCwd !== undefined && resolve(commandCwd) !== resolve(current.snapshot.workspaceRoot)) {
      throw new Error("Session workspaceRoot does not match --cwd; the workspace cannot be changed during a run")
    }
    return { client: connectSession(host.sessionServer, sessionId), catalog: host.catalog, close: () => host.close() }
  } catch (error) {
    await host.close().catch(() => {})
    throw error
  }
}

function writeSuccess<T>(
  command: "version" | "capabilities" | "pair" | "plan" | "run" | "inspect" | "observe" | "trace" | "session",
  requestId: string,
  data: T,
  format: import("../config/output-format.js").HeadlessOutputFormat,
  text: string,
  sessionId?: string,
  runId?: string,
  meta?: HeadlessMeta,
): void {
  process.stdout.write(serializeHeadless(successEnvelope(command, requestId, data, { sessionId, runId, meta }), format, text))
}

function writeError(
  command: "version" | "capabilities" | "pair" | "plan" | "run" | "inspect" | "observe" | "trace" | "session" | "help" | "serve",
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
  result: RunResult,
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
  // Replay of a durable approval_required terminal classifies identically to
  // the live ApprovalRequiredError throw, so same-id retries stay exit 5.
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

function classifyHeadlessError(error: unknown): HeadlessErrorCode {
  if (error instanceof ApprovalRequiredError) return "APPROVAL_REQUIRED"
  if (error instanceof SessionExecutionReservationConflictError) return "RUNTIME_ERROR"
  if (error instanceof SessionPolicyRevisionConflictError) return "PERSISTENCE_ERROR"
  if (error instanceof DOMException && error.name === "AbortError") return "CANCELLED"
  if (error instanceof Error && error.name === "AbortError") return "CANCELLED"
  if (error instanceof DOMException && error.name === "TimeoutError") return "TIMEOUT"
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT"
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|timed out|\u8d85\u65f6/i.test(message)) return "TIMEOUT"
  if (/approval|approve|\u6279\u51c6|\u5ba1\u6279|\u9700\u786e\u8ba4/i.test(message)) return "APPROVAL_REQUIRED"
  if (/permission denied|\u6743\u9650\u62d2\u7edd|\u88ab\u7b56\u7565\u62d2\u7edd|workspace.*\u7981\u6b62/i.test(message))
    return "PERMISSION_DENIED"
  if (/authentication|unauthorized|forbidden|api key|\u51ed\u8bc1|401|403/i.test(message)) return "AUTH_ERROR"
  if (
    /EventStore|Session metadata|\u6301\u4e45\u5316|JSONL \u635f\u574f|JSONL.*corrupted|revision conflict|revision \u51b2\u7a81|reservation_conflict/i.test(
      message,
    )
  )
    return "PERSISTENCE_ERROR"
  if (/configuration is missing|missing LLM configuration|\u914d\u7f6e\u7f3a\u5931|\u7f3a\u5c11 LLM \u914d\u7f6e/i.test(message))
    return "PROVIDER_ERROR"
  if (
    /explicit skills|skills director(?:y|ies)|skills files?|skill-dir|unsupported (?:OpenAI compatibility|thinking mode|reasoning effort)|remote configuration is not supported|\u663e\u5f0f skills|skills \u76ee\u5f55|skills \u6587\u4ef6|\u8fdc\u7a0b\u914d\u7f6e\u4e0d\u652f\u6301/i.test(
      message,
    )
  )
    return "CONFIG_ERROR"
  if (/transport|HTTP.*failed|request body|\u8bf7\u6c42\u4f53|protocol/i.test(message)) return "TRANSPORT_ERROR"
  if (/\u5de5\u5177|tool/i.test(message)) return "TOOL_ERROR"
  if (/AG2CLI_|configuration|unsupported|\u914d\u7f6e|profile|\u4e0d\u652f\u6301\u7684/i.test(message)) return "CONFIG_ERROR"
  if (/provider|model|\u6a21\u578b|\u6a21\u578b\u8c03\u7528/i.test(message)) return "PROVIDER_ERROR"
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
