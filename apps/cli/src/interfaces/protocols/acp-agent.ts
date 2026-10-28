import * as acp from "@agentclientprotocol/sdk"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { type JsonValue } from "@ag2cli/app-server-protocol/types.js"
import { asRecord, parseNonEmptyString } from "@ag2cli/app-server-protocol/validation.js"
import type { AppServerRpcClient } from "@ag2cli/app-server-client/client.js"
import { randomUUID } from "node:crypto"
import { createAcpAppServerSessionClient, type AcpAppServerEvent, type AcpAppServerSessionClient } from "./acp-app-server-client.js"

export interface AcpPlanAgentOptions {
  /** Public App Server JSON-RPC client; no runtime object crosses this edge. */
  readonly client: AppServerRpcClient
  readonly name?: string
  readonly version?: string
  /** Resolve ACP's filesystem cwd to the App Server registry identity. */
  readonly workspaceIdForRoot?: (workspaceRoot: string) => string | undefined
}

export interface AcpRunAgentOptions {
  /** Public App Server JSON-RPC client; no runtime object crosses this edge. */
  readonly client: AppServerRpcClient
  readonly name?: string
  readonly version?: string
  /** Resolve ACP's filesystem cwd to the App Server registry identity. */
  readonly workspaceIdForRoot?: (workspaceRoot: string) => string | undefined
  /**
   * Invocation-end hook awaited in the prompt handler's finally block: the
   * ACP contract scopes async children to one turn, so the adapter drains
   * (then cancels) whatever the turn spawned before answering the client.
   */
  readonly onInvocationEnd?: () => void | Promise<void>
}

interface AcpSessionState {
  readonly workspace: string
  abortController?: AbortController
}

/** Official ACP v1 plan adapter over the public App Server protocol. */
export function createAcpPlanAgent(options: AcpPlanAgentOptions): acp.AgentApp {
  return createAcpAgent({ ...options, mode: "plan" })
}

/** Official ACP v1 execution adapter over the public App Server protocol. */
export function createAcpRunAgent(options: AcpRunAgentOptions): acp.AgentApp {
  return createAcpAgent({ ...options, mode: "run" })
}

function createAcpAgent(
  options: (AcpPlanAgentOptions | AcpRunAgentOptions) & {
    readonly mode: "plan" | "run"
    /** Normalized from AcpRunAgentOptions; plan mode never carries it. */
    readonly onInvocationEnd?: () => void | Promise<void>
  },
): acp.AgentApp {
  const appServer = createAcpAppServerSessionClient(options.client)
  const sessions = new Map<string, AcpSessionState>()
  const app = acp.agent({ name: options.name ?? "ag2cli" })

  app.onRequest(acp.methods.agent.initialize, ({ params: _params }) => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { promptCapabilities: {}, sessionCapabilities: {} },
    agentInfo: {
      name: options.name ?? "ag2cli",
      version: options.version ?? "0.1.0",
    },
  }))

  app.onRequest(acp.methods.agent.session.new, async ({ params, signal }) => {
    const id = randomUUID()
    const workspaceId = options.workspaceIdForRoot?.(params.cwd) ?? deriveWorkspaceId(params.cwd)
    await appServer.createSession(id, workspaceId, signal)
    sessions.set(id, { workspace: params.cwd })
    return { sessionId: id }
  })

  app.onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.abortController?.abort()
  })

  app.onRequest(acp.methods.agent.session.prompt, async ({ params, signal, client }) => {
    const state = sessions.get(params.sessionId)
    if (!state) throw new Error(`ACP session does not exist: ${params.sessionId}`)
    if (state.abortController) throw new Error(`ACP session is already processing a prompt: ${params.sessionId}`)
    const prompt = extractPrompt(params.prompt)
    const commandId = randomUUID()
    const controller = new AbortController()
    let inputId: string | undefined
    let runId: string | undefined
    // The ACP edge cancels whatever the turn currently owns: the queued
    // input before a run admits it, the run itself once it started.
    const cancel = () => {
      const target =
        runId !== undefined
          ? appServer.cancelRun(params.sessionId, runId)
          : inputId !== undefined
            ? appServer.cancelInput(params.sessionId, inputId)
            : undefined
      void target?.catch(() => undefined)
    }
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason)
      cancel()
    }
    signal.addEventListener("abort", abort, { once: true })
    controller.signal.addEventListener("abort", cancel, { once: true })
    state.abortController = controller
    let terminalEvent: AcpAppServerEvent | undefined
    // Deliberately hand-rolled: a failed send rejects the turn's terminal
    // and rethrows into the chain, so later queued sends short-circuit into
    // the same failure — fail-fast inside one invocation rather than
    // per-entry isolation, and this adapter stays on the public contract.
    let updateChain = Promise.resolve()
    let unsubscribe = (): void => {}
    try {
      const before = await appServer.snapshot(params.sessionId, controller.signal)
      // Multiple public events may share one revision; identity dedup is by eventId.
      const seenEventIds = new Set<string>()
      const introducedToolCallIds = new Set<string>()
      let resolveTerminal!: (event: AcpAppServerEvent) => void
      let rejectTerminal!: (error: unknown) => void
      const terminalPromise = new Promise<AcpAppServerEvent>((resolvePromise, rejectPromise) => {
        resolveTerminal = resolvePromise
        rejectTerminal = rejectPromise
      })

      const queueEvent = (event: AcpAppServerEvent): void => {
        if (event.revision <= before.asOfRevision || seenEventIds.has(event.eventId)) return
        seenEventIds.add(event.eventId)
        if (isInputEvent(event) && commandIdForEvent(event) !== commandId) return
        if (options.mode === "run") {
          const startedRunId = runStartedForCommand(event, commandId)
          if (startedRunId !== undefined) runId = startedRunId
          if (!isInputEvent(event) && !belongsToRun(event, runId)) return
        } else if (!isPlanEvent(event)) {
          return
        }
        if (event.type === "input.failed") {
          rejectTerminal(new Error(inputFailureMessage(event)))
          return
        }
        updateChain = updateChain
          .then(() =>
            sendAgentEvent({
              client,
              sessionId: params.sessionId,
              appServer,
              event,
              signal: controller.signal,
              introducedToolCallIds,
            }),
          )
          .then(() => {
            if (options.mode === "run" && isTerminalEvent(event)) {
              terminalEvent = event
              resolveTerminal(event)
            }
          })
          .catch((error: unknown) => {
            rejectTerminal(error)
            throw error
          })
      }

      unsubscribe = appServer.subscribe(params.sessionId, queueEvent)
      for (const event of await appServer.attach(params.sessionId, before.asOfRevision, controller.signal)) queueEvent(event)

      if (options.mode === "plan") {
        const plan = await appServer.plan(params.sessionId, commandId, prompt.goal, prompt.context, state.workspace, controller.signal)
        await updateChain
        await sendPlan(client, params.sessionId, plan)
        await sendText(client, params.sessionId, renderPlan(plan))
        return { stopReason: "end_turn" as const }
      }

      inputId = (await appServer.submit(params.sessionId, commandId, prompt.goal, prompt.context, controller.signal)).inputId

      const completed = await terminalPromise
      await updateChain
      const status = runStatusForEvent(completed)
      if (status === "failed") return { stopReason: "refusal" as const }
      if (status === "cancelled") return { stopReason: "cancelled" as const }
      return { stopReason: "end_turn" as const }
    } catch (error) {
      const cancelled = controller.signal.aborted || signal.aborted
      await updateChain.catch(() => undefined)
      if (!terminalEvent) {
        await sendText(
          client,
          params.sessionId,
          cancelled ? "Execution cancelled" : `Execution failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return { stopReason: cancelled ? ("cancelled" as const) : ("refusal" as const) }
    } finally {
      unsubscribe()
      signal.removeEventListener("abort", abort)
      controller.signal.removeEventListener("abort", cancel)
      if (state.abortController === controller) state.abortController = undefined
      await options.onInvocationEnd?.()
    }
  })

  return app
}

/** Ephemeral App Server fallback; serve callers should pass registry resolution. */
function deriveWorkspaceId(workspaceRoot: string): string {
  return `ws_${createHash("sha256").update(resolve(workspaceRoot), "utf8").digest("hex").slice(0, 32)}`
}

function extractPrompt(blocks: readonly acp.ContentBlock[]): { goal: string; context: string[] } {
  const goals: string[] = []
  const context: string[] = []
  for (const block of blocks) {
    if (block.type === "text") {
      goals.push(block.text)
    } else if (block.type === "resource_link") {
      context.push(`${block.name}: ${block.uri}`)
    } else if (block.type === "resource" && "text" in block.resource) {
      context.push(`${block.resource.uri}: ${block.resource.text}`)
    } else {
      throw new Error(`ACP prompt does not support content type: ${block.type}`)
    }
  }
  const goal = goals.join("\n").trim()
  if (goal.length === 0) throw new Error("ACP prompt must contain text")
  return { goal, context }
}

function isPlanEvent(event: AcpAppServerEvent): boolean {
  return event.type === "plan.updated"
}

function isInputEvent(event: AcpAppServerEvent): boolean {
  return event.type === "input.accepted" || event.type === "input.updated" || event.type === "input.failed"
}

function commandIdForEvent(event: AcpAppServerEvent): string | undefined {
  if (event.type === "input.failed") return optionalString(event.payload.commandId)
  const input = asRecord(event.payload.input, `${event.type}.input`)
  return input === undefined ? undefined : optionalString(input.commandId)
}

function inputFailureMessage(event: AcpAppServerEvent): string {
  const failure = asRecord(event.payload.failure, "input.failed.failure")
  const message = failure === undefined ? undefined : optionalString(failure.message)
  return message ?? "Input failed"
}

function runStartedForCommand(event: AcpAppServerEvent, commandId: string): string | undefined {
  if (event.type !== "input.updated") return undefined
  const input = asRecord(event.payload.input, "input.updated.input")
  if (input === undefined || optionalString(input.commandId) !== commandId) return undefined
  return optionalString(input.runId)
}

function runIdForEvent(event: AcpAppServerEvent): string | undefined {
  switch (event.type) {
    case "run.updated":
      return optionalString(asRecord(event.payload.run, "run.updated.run")?.runId)
    case "message.upserted":
      return optionalString(asRecord(event.payload.message, "message.upserted.message")?.runId)
    case "tool_call.upserted":
      return optionalString(asRecord(event.payload.toolCall, "tool_call.upserted.toolCall")?.runId)
    case "interaction.requested":
      return optionalString(asRecord(event.payload.interaction, "interaction.requested.interaction")?.runId)
    default:
      return undefined
  }
}

function belongsToRun(event: AcpAppServerEvent, runId: string | undefined): boolean {
  const eventRunId = runIdForEvent(event)
  return runId !== undefined && eventRunId === runId
}

function isTerminalEvent(event: AcpAppServerEvent): boolean {
  const status = runStatusForEvent(event)
  return status === "completed" || status === "failed" || status === "cancelled"
}

function runStatusForEvent(event: AcpAppServerEvent): "completed" | "failed" | "cancelled" | undefined {
  if (event.type !== "run.updated") return undefined
  const status = optionalString(asRecord(event.payload.run, "run.updated.run")?.status)
  return status === "completed" || status === "failed" || status === "cancelled" ? status : undefined
}

async function sendText(client: acp.AgentContext, sessionId: string, text: string, messageId: string = randomUUID()): Promise<void> {
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text },
    },
  })
}

async function sendPlan(client: acp.AgentContext, sessionId: string, value: JsonValue): Promise<void> {
  const plan = asRecord(value, "ACP plan")
  const steps = Array.isArray(plan.steps) ? plan.steps : []
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "plan",
      entries: steps.map((step, index) => {
        const record = asRecord(step, `ACP plan.steps[${index}]`)
        const title = parseNonEmptyString(record.title, `ACP plan.steps[${index}].title`)
        const description = parseNonEmptyString(record.description, `ACP plan.steps[${index}].description`)
        return {
          content: `${index + 1}. ${title}: ${description}`,
          priority: "medium" as const,
          status: "pending" as const,
        }
      }),
    },
  })
}

function renderPlan(plan: JsonValue): string {
  return JSON.stringify(plan)
}

async function sendAgentEvent(input: {
  readonly client: acp.AgentContext
  readonly sessionId: string
  readonly appServer: AcpAppServerSessionClient
  readonly event: AcpAppServerEvent
  readonly signal: AbortSignal
  readonly introducedToolCallIds: Set<string>
}): Promise<void> {
  const { client, sessionId, appServer, event, signal, introducedToolCallIds } = input
  switch (event.type) {
    case "plan.updated": {
      // The public event carries a summary only; the full plan rides the
      // session.plan result, so this is a progress line, not the plan itself.
      const plan = asRecord(event.payload.plan, "plan.updated.plan")
      const status = optionalString(plan.status) ?? "unknown"
      const completed = typeof plan.completedSteps === "number" ? plan.completedSteps : 0
      const total = typeof plan.totalSteps === "number" ? plan.totalSteps : 0
      await sendText(client, sessionId, `Plan ${status}: ${completed}/${total} steps`, event.eventId)
      return
    }
    case "message.upserted": {
      const message = asRecord(event.payload.message, "message.upserted.message")
      if (optionalString(message.role) !== "assistant") return
      const text = contentText(message.content)
      // The public projection flattens non-text model content into placeholder
      // text; a tool-use turn must not surface as an ACP agent message.
      if (text.length > 0 && !UNSUPPORTED_CONTENT_PLACEHOLDER.test(text)) {
        await sendText(client, sessionId, text, event.eventId)
      }
      return
    }
    case "tool_call.upserted": {
      const toolCall = asRecord(event.payload.toolCall, "tool_call.upserted.toolCall")
      const toolCallId = parseNonEmptyString(toolCall.toolCallId, "tool_call.upserted.toolCall.toolCallId")
      const name = parseNonEmptyString(toolCall.toolName, "tool_call.upserted.toolCall.toolName")
      const status = optionalString(toolCall.status)
      if (status === "completed" || status === "failed" || status === "denied") {
        const summary = optionalString(toolCall.resultSummary) ?? ""
        await client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: status === "completed" ? "completed" : "failed",
            rawOutput: summary,
            content: [{ type: "content", content: { type: "text", text: summary } }],
          },
        })
        return
      }
      // Public upserts repeat the same tool call across non-terminal statuses;
      // ACP clients read tool_call as creation, so introduce each call once.
      if (introducedToolCallIds.has(toolCallId)) return
      introducedToolCallIds.add(toolCallId)
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: optionalString(toolCall.title) ?? name,
          name,
          status: "in_progress",
          rawInput: {},
        },
      })
      return
    }
    case "interaction.requested": {
      const interaction = asRecord(event.payload.interaction, "interaction.requested.interaction")
      if (optionalString(interaction.kind) !== "tool_approval") return
      const interactionId = parseNonEmptyString(interaction.interactionId, "interaction.requested.interaction.interactionId")
      const toolCallId = parseNonEmptyString(interaction.toolCallId, "interaction.requested.interaction.toolCallId")
      const title = parseNonEmptyString(interaction.title, "interaction.requested.interaction.title")
      const subject = asRecord(interaction.subject, "interaction.requested.interaction.subject")
      const toolName = optionalString(subject?.toolName) ?? title
      let decision: "approved" | "denied" = "denied"
      try {
        const permission = await client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
            toolCallId,
            title,
            name: toolName,
            status: "pending",
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
          ],
        })
        if (permission.outcome.outcome === "selected" && permission.outcome.optionId === "allow-once") decision = "approved"
      } catch {
        decision = "denied"
      }
      try {
        await appServer.resolveToolApproval(
          {
            sessionId,
            interactionId,
            expectedScopeRevision: typeof interaction.scopeRevision === "number" ? interaction.scopeRevision : 0,
            expectedPolicyRevision: typeof interaction.policyRevision === "number" ? interaction.policyRevision : 0,
            decision,
          },
          signal,
        )
      } catch {
        // The interaction may already be resolved by another writer (a
        // guardian or a racing client); the run's own events stay
        // authoritative for the prompt outcome.
      }
      return
    }
    case "run.updated": {
      const run = asRecord(event.payload.run, "run.updated.run")
      const status = optionalString(run.status)
      if (status === "failed") {
        const failure = asRecord(run.failure, "run.updated.run.failure")
        await sendText(client, sessionId, `Execution failed: ${optionalString(failure?.message) ?? "run failed"}`, event.eventId)
      } else if (status === "cancelled") {
        await sendText(client, sessionId, "Execution cancelled", event.eventId)
      }
      return
    }
    default:
      return
  }
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ""
  return value
    .map((block, index) => {
      const record = asRecord(block, `message.content[${index}]`)
      return record.type === "text" && typeof record.text === "string" ? record.text : ""
    })
    .join("")
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

const UNSUPPORTED_CONTENT_PLACEHOLDER = /^(?:unsupported content block: \w+)+$/
