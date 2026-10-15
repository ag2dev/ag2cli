import { JsonRpcAppServerClient, type AppServerTransport } from "@ag2cli/app-server-client/client.js"
import { APP_SERVER_PROTOCOL_VERSION, type JsonRpcMessage, type JsonValue } from "@ag2cli/app-server-protocol/types.js"
import type { BrowserConnector } from "./browser-client"

type RecordValue = { [key: string]: JsonValue }
type DemoSession = { sessionId: string; title: string; workspaceId: string; createdAt: string; events: RecordValue[] }

class DemoRpcError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message)
  }
}

const timestamp = "2026-10-05T08:00:00.000Z"
const workspace = { workspaceId: "demo-workspace", workspaceRoot: "/projects/ag2cli", availability: "available" }
const reply =
  "Here is a practical starting point:\n\n- Keep the conversation focused on one task.\n- Review changes before applying them.\n- Verify the result with a targeted test.\n\n```ts\nconst result = await client.send(message)\n```\n\nWhat would you like to explore next?"

/** Exercise the public RPC client and its validators without requiring a running host. */
export function createMockAppServer(): { connector: BrowserConnector } {
  let runCounter = 0
  const sessions = new Map<string, DemoSession>()
  const seeded: DemoSession = {
    sessionId: "demo-conversation",
    title: "Explore your workspace",
    workspaceId: workspace.workspaceId,
    createdAt: timestamp,
    events: [],
  }
  function append(session: DemoSession, type: string, payload: RecordValue): RecordValue {
    const revision = session.events.length + 1
    const event = { eventId: `${session.sessionId}:${revision}`, sessionId: session.sessionId, revision, timestamp, type, payload }
    session.events.push(event)
    return event
  }
  append(seeded, "RunStarted", { commandId: "demo-command", runId: "demo-run" })
  append(seeded, "InputConsumed", {
    commandId: "demo-command",
    runId: "demo-run",
    inputId: "demo-input",
    text: "How should we approach a new task?",
  })
  append(seeded, "ModelResponseCommitted", { runId: "demo-run", turn: 1, content: [{ type: "text", text: reply }] })
  append(seeded, "RunCompleted", { runId: "demo-run" })
  append(seeded, "ToolApprovalRequested", {
    runId: "demo-run",
    turn: 2,
    toolUseId: "demo-tool",
    name: "Bash",
    preparedEventId: "demo-prepared",
    inputFingerprint: "demo-fingerprint",
    scopeRevision: 3,
    policyRevision: 1,
  })
  sessions.set(seeded.sessionId, seeded)
  const resolvedApprovals = new Set<string>()
  const record = (session: DemoSession): RecordValue => ({
    sessionId: session.sessionId,
    title: session.title,
    workspaceId: session.workspaceId,
    createdAt: session.createdAt,
    snapshot: { workspaceRoot: workspace.workspaceRoot, lastRevision: session.events.length },
  })

  const connector: BrowserConnector = async (_endpoint, clientId, options = {}) => {
    options.signal?.throwIfAborted()
    const messages = new Set<(message: JsonRpcMessage) => void>()
    const closes = new Set<(error?: Error) => void>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const activeRuns = new Map<string, { session: DemoSession; runId: string }>()
    const connectionId = `demo-${clientId}`
    const holder = { connectionId, deviceId: "demo-device", clientId, clientKind: "web", name: "Demo browser" }
    let closed = false
    let generation = 0
    const leases = () => ({ composer: { status: "available", generation }, "session-control": { status: "available", generation } })
    const emit = (message: JsonRpcMessage): void => {
      if (!closed) for (const listener of messages) listener(message)
    }
    const event = (session: DemoSession, type: string, payload: RecordValue): void => {
      emit({ jsonrpc: "2.0", method: "session.event", params: { sessionId: session.sessionId, event: append(session, type, payload) } })
    }
    function handle(method: string, params: RecordValue): JsonValue {
      if (method === "server.initialize")
        return {
          appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
          server: { name: "ag2cli demo", version: "demo", fingerprint: "demo-fingerprint", protocolVersion: APP_SERVER_PROTOCOL_VERSION },
          connection: { connectionId, deviceId: "demo-device", scopes: ["session:read", "session:write"] },
          capabilities: [
            "session.list",
            "session.create",
            "session.attach",
            "session.replay",
            "session.submit",
            "session.cancel",
            "session.resolveApproval",
          ],
          host: { profile: "durable", workspaces: [workspace] },
        }
      if (method === "session.list") return [...sessions.values()].map(record)
      if (method === "session.create") {
        const session: DemoSession = {
          sessionId: String(params.sessionId),
          title: String(params.title),
          workspaceId: String(params.workspaceId),
          createdAt: timestamp,
          events: [],
        }
        sessions.set(session.sessionId, session)
        return record(session)
      }
      const session = sessions.get(String(params.sessionId))
      if (!session) throw new Error("Session does not exist")
      if (method === "session.attach")
        return {
          sessionId: session.sessionId,
          snapshot: record(session).snapshot!,
          workspace,
          events: session.events.filter((item) => Number(item.revision) > Number(params.afterRevision ?? 0)),
          transientEvents: [],
          presence: { sessionId: session.sessionId, clients: [{ ...holder, version: "demo" }], leases: leases() },
        }
      if (method === "session.replay")
        return {
          sessionId: session.sessionId,
          complete: true,
          events: session.events.filter((item) => Number(item.revision) > Number(params.afterRevision ?? 0)),
        }
      if (method === "session.detach") return { sessionId: session.sessionId, detached: true }
      if (method === "session.delete") {
        sessions.delete(session.sessionId)
        return { sessionId: session.sessionId, deleted: true }
      }
      if (method.startsWith("interaction."))
        return {
          sessionId: session.sessionId,
          lease:
            method === "interaction.release" ? { status: "available", generation } : { status: "held", generation: ++generation, holder },
        }
      if (method === "session.submit") {
        const commandId = String(params.commandId)
        const runId = `demo-run-${++runCounter}`
        event(session, "RunStarted", { commandId, runId })
        event(session, "InputConsumed", { commandId, runId, inputId: commandId, text: String(params.text) })
        emit({
          jsonrpc: "2.0",
          method: "session.transient",
          params: {
            sessionId: session.sessionId,
            event: {
              eventId: `${runId}:live`,
              sessionId: session.sessionId,
              sequence: runCounter,
              type: "model_text_delta",
              timestamp,
              payload: { runId, turn: 1, delta: "Let me think through this…" },
            },
          },
        })
        activeRuns.set(commandId, { session, runId })
        timers.set(
          commandId,
          setTimeout(() => {
            event(session, "ModelResponseCommitted", { runId, turn: 1, content: [{ type: "text", text: reply }] })
            event(session, "RunCompleted", { runId })
            timers.delete(commandId)
            activeRuns.delete(commandId)
          }, 300),
        )
        return { sessionId: session.sessionId, commandId, accepted: true, intent: "prompt" }
      }
      if (method === "session.cancel") {
        const commandId = String(params.commandId)
        clearTimeout(timers.get(commandId))
        timers.delete(commandId)
        const run = activeRuns.get(commandId)
        if (run) {
          event(run.session, "RunCancelled", { runId: run.runId, reason: "Stopped by you" })
          activeRuns.delete(commandId)
        }
        return { sessionId: session.sessionId, commandId, cancelled: true }
      }
      if (method === "session.resolveApproval") {
        const preparedEventId = String(params.preparedEventId)
        if (resolvedApprovals.has(preparedEventId)) throw new DemoRpcError("approval_already_resolved", "Approval was already resolved")
        resolvedApprovals.add(preparedEventId)
        event(session, "ToolApprovalResolved", {
          runId: String(params.runId),
          turn: Number(params.turn),
          toolUseId: String(params.toolUseId),
          preparedEventId,
          decision: String(params.decision),
        })
        return { sessionId: session.sessionId, resolved: true }
      }
      throw new Error(`Unsupported demo method: ${method}`)
    }
    const transport: AppServerTransport = {
      send(message) {
        if (!("method" in message) || !("id" in message)) return
        const params = (message.params ?? {}) as RecordValue
        try {
          emit({ jsonrpc: "2.0", id: message.id, result: handle(message.method, params) })
        } catch (error) {
          emit({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32602,
              message: error instanceof Error ? error.message : String(error),
              ...(error instanceof DemoRpcError ? { data: { code: error.kind } } : {}),
            },
          })
        }
      },
      onMessage(listener) {
        messages.add(listener)
        return () => messages.delete(listener)
      },
      onClose(listener) {
        closes.add(listener)
        return () => closes.delete(listener)
      },
      close() {
        if (closed) return
        closed = true
        for (const timer of timers.values()) clearTimeout(timer)
        timers.clear()
        activeRuns.clear()
        for (const listener of closes) listener()
        closes.clear()
        messages.clear()
      },
    }
    const rpc = new JsonRpcAppServerClient(transport)
    const abort = () => rpc.close()
    options.signal?.addEventListener("abort", abort, { once: true })
    const initialize = await rpc.initialize({
      appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
      client: { clientId, clientKind: "web", name: "Demo browser", version: "demo", capabilities: [] },
    })
    return {
      rpc,
      initialize,
      onClose: (listener) => transport.onClose(listener),
      close: () => {
        options.signal?.removeEventListener("abort", abort)
        rpc.close()
      },
    }
  }
  return { connector }
}
