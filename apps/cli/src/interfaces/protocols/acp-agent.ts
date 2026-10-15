import * as acp from "@agentclientprotocol/sdk"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { type JsonValue } from "@ag2cli/app-server-protocol/types.js"
import { asRecord, assertJsonValue, parseNonEmptyString, parseNonNegativeInteger } from "@ag2cli/app-server-protocol/validation.js"
import type { AppServerRpcClient } from "@ag2cli/app-server-client/client.js"
import { randomUUID } from "node:crypto"
import {
  createAcpAppServerSessionClient,
  type AcpAppServerEvent,
  type AcpAppServerSessionClient,
  type AcpAppServerSessionMessage,
} from "./acp-app-server-client.js"

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
    const cancel = () => {
      void appServer.cancel(params.sessionId, commandId).catch(() => undefined)
    }
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason)
      cancel()
    }
    signal.addEventListener("abort", abort, { once: true })
    controller.signal.addEventListener("abort", cancel, { once: true })
    state.abortController = controller
    let terminalEvent: AcpAppServerEvent | undefined
    let updateChain = Promise.resolve()
    let unsubscribe = (): void => {}
    try {
      const before = await appServer.snapshot(params.sessionId, controller.signal)
      const seenRevisions = new Set<number>()
      let planEmitted = false
      let runTextEmitted = false
      let runId: string | undefined
      let resolveTerminal!: (event: AcpAppServerEvent) => void
      let rejectTerminal!: (error: unknown) => void
      const terminalPromise = new Promise<AcpAppServerEvent>((resolvePromise, rejectPromise) => {
        resolveTerminal = resolvePromise
        rejectTerminal = rejectPromise
      })

      const queueMessage = (message: AcpAppServerSessionMessage): void => {
        if (message.type === "operation_failed") {
          if (message.commandId === commandId) rejectTerminal(new Error(message.message))
          return
        }
        const event = message.event
        if (event.revision <= before.lastRevision || seenRevisions.has(event.revision)) return
        seenRevisions.add(event.revision)
        if (options.mode === "run") {
          const startedRunId = runStartedForCommand(event, commandId)
          if (startedRunId !== undefined) runId = startedRunId
          if (!belongsToRun(event, runId)) return
        } else if (!isPlanEvent(event)) {
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
              onPlan: () => {
                planEmitted = true
              },
              onRunText: () => {
                runTextEmitted = true
              },
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

      unsubscribe = appServer.subscribe(params.sessionId, queueMessage)
      for (const event of await appServer.attach(params.sessionId, before.lastRevision, controller.signal))
        queueMessage({ type: "event", event })

      if (options.mode === "plan") {
        const plan = await appServer.plan(params.sessionId, commandId, prompt.goal, prompt.context, state.workspace, controller.signal)
        await updateChain
        if (!planEmitted) {
          await sendPlan(client, params.sessionId, plan)
          await sendText(client, params.sessionId, renderPlan(plan))
        }
        return { stopReason: "end_turn" as const }
      }

      const submitted = await appServer.submit(params.sessionId, commandId, prompt.goal, prompt.context, state.workspace, controller.signal)
      runId = submitted.runId ?? runId
      if (submitted.result !== undefined) {
        await updateChain
        if (!runTextEmitted) await sendText(client, params.sessionId, renderRun(submitted.result))
        const status = runStatus(submitted.result)
        if (status === "cancelled") return { stopReason: "cancelled" as const }
        if (status === "failed") return { stopReason: "refusal" as const }
        return { stopReason: "end_turn" as const }
      }

      const completed = await terminalPromise
      await updateChain
      if (!runTextEmitted && completed.type === "RunCompleted") {
        await sendText(client, params.sessionId, payloadString(completed, "finalText"))
      }
      if (completed.type === "RunFailed") return { stopReason: "refusal" as const }
      if (completed.type === "RunCancelled") return { stopReason: "cancelled" as const }
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
  return event.type === "PlanCreated" || event.type === "PlanGenerationFailed" || event.type === "PlanGenerationCancelled"
}

function runStartedForCommand(event: AcpAppServerEvent, commandId: string): string | undefined {
  if (event.type !== "RunStarted") return undefined
  return payloadString(event, "commandId") === commandId ? payloadString(event, "runId") : undefined
}

function belongsToRun(event: AcpAppServerEvent, runId: string | undefined): boolean {
  if (event.type === "RunStarted") return runId !== undefined
  if (runId === undefined) return false
  return (
    [
      "ModelResponseCommitted",
      "ToolCallRequested",
      "ToolApprovalRequested",
      "ToolApprovalResolved",
      "ToolResultCommitted",
      "RunCompleted",
      "RunFailed",
      "RunCancelled",
    ].includes(event.type) && payloadString(event, "runId") === runId
  )
}

function isTerminalEvent(event: AcpAppServerEvent): boolean {
  return event.type === "RunCompleted" || event.type === "RunFailed" || event.type === "RunCancelled"
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

function renderRun(result: JsonValue): string {
  const record = asRecord(result, "ACP run result")
  return typeof record.finalText === "string" ? record.finalText : ""
}

function runStatus(result: JsonValue): "completed" | "failed" | "cancelled" | undefined {
  const record = asRecord(result, "ACP run result")
  return record.status === "completed" || record.status === "failed" || record.status === "cancelled" ? record.status : undefined
}

async function sendAgentEvent(input: {
  readonly client: acp.AgentContext
  readonly sessionId: string
  readonly appServer: AcpAppServerSessionClient
  readonly event: AcpAppServerEvent
  readonly signal: AbortSignal
  readonly onPlan: () => void
  readonly onRunText: () => void
}): Promise<void> {
  const { client, sessionId, appServer, event, signal } = input
  switch (event.type) {
    case "PlanCreated":
      input.onPlan()
      await sendPlan(client, sessionId, assertJsonValue(event.payload, "PlanCreated.payload"))
      await sendText(client, sessionId, renderPlan(assertJsonValue(event.payload, "PlanCreated.payload")), event.eventId)
      return
    case "PlanGenerationFailed":
      await sendText(client, sessionId, `Plan generation failed: ${payloadString(event, "message")}`, event.eventId)
      return
    case "PlanGenerationCancelled":
      await sendText(
        client,
        sessionId,
        `Plan generation cancelled: ${payloadOptionalString(event, "reason") ?? "User cancelled"}`,
        event.eventId,
      )
      return
    case "ModelResponseCommitted": {
      const text = responseText(event)
      if (text.length > 0) {
        input.onRunText()
        await sendText(client, sessionId, text, event.eventId)
      }
      return
    }
    case "ToolCallRequested":
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: payloadString(event, "toolUseId"),
          title: payloadString(event, "name"),
          name: payloadString(event, "name"),
          status: "in_progress",
          rawInput: assertJsonValue(event.payload.input, "ToolCallRequested.input"),
        },
      })
      return
    case "ToolApprovalRequested": {
      const toolUseId = payloadString(event, "toolUseId")
      // A guardian-owned ask is answered by the guardian review alone;
      // offering it to the human would race the reviewer and the server
      // fence rejects a user resolution anyway. The resolved event below
      // renders the outcome.
      if (payloadOptionalString(event, "ownedBy") === "guardian") return
      let decision: "approved" | "denied" = "denied"
      try {
        const permission = await client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
            toolCallId: toolUseId,
            title: payloadString(event, "name"),
            name: payloadString(event, "name"),
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
      await appServer.resolveApproval(
        {
          sessionId,
          runId: payloadString(event, "runId"),
          turn: payloadNumber(event, "turn"),
          toolUseId,
          preparedEventId: payloadOptionalString(event, "preparedEventId") ?? event.eventId,
          expectedScopeRevision: payloadOptionalNumber(event, "scopeRevision") ?? 0,
          expectedPolicyRevision: payloadOptionalNumber(event, "policyRevision") ?? 0,
          decision,
        },
        signal,
      )
      return
    }
    case "ToolApprovalResolved":
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: payloadString(event, "toolUseId"),
          status: payloadString(event, "decision") === "approved" ? "in_progress" : "failed",
        },
      })
      return
    case "ToolResultCommitted": {
      const result = asRecord(event.payload.result, "ToolResultCommitted.result")
      const content = parseNonEmptyString(result.content, "ToolResultCommitted.result.content")
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: payloadString(event, "toolUseId"),
          status: result.isError === true ? "failed" : "completed",
          rawOutput: content,
          content: [{ type: "content", content: { type: "text", text: content } }],
        },
      })
      return
    }
    case "RunFailed":
      await sendText(client, sessionId, `Execution failed: ${payloadString(event, "message")}`, event.eventId)
      return
    case "RunCancelled":
      await sendText(client, sessionId, `Execution cancelled: ${payloadOptionalString(event, "reason") ?? "User cancelled"}`, event.eventId)
      return
    default:
      return
  }
}

function responseText(event: AcpAppServerEvent): string {
  if (!Array.isArray(event.payload.content)) return ""
  return event.payload.content
    .map((block, index) => {
      const record = asRecord(block, `ModelResponseCommitted.content[${index}]`)
      return record.type === "text" && typeof record.text === "string" ? record.text : ""
    })
    .join("")
}

function payloadString(event: AcpAppServerEvent, key: string): string {
  return parseNonEmptyString(event.payload[key], `${event.type}.payload.${key}`)
}

function payloadOptionalString(event: AcpAppServerEvent, key: string): string | undefined {
  return event.payload[key] === undefined ? undefined : parseNonEmptyString(event.payload[key], `${event.type}.payload.${key}`)
}

function payloadNumber(event: AcpAppServerEvent, key: string): number {
  return parseNonNegativeInteger(event.payload[key], `${event.type}.payload.${key}`)
}

function payloadOptionalNumber(event: AcpAppServerEvent, key: string): number | undefined {
  return event.payload[key] === undefined ? undefined : parseNonNegativeInteger(event.payload[key], `${event.type}.payload.${key}`)
}
