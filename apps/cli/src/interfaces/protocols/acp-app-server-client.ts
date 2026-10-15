import type { AppServerRpcClient } from "@ag2cli/app-server-client/client.js"
import { isAppServerErrorCode, type AppServerErrorCode } from "@ag2cli/app-server-protocol/error-codes.js"
import {
  type JsonRpcNotification,
  type JsonValue,
  type SessionResolveApprovalParams,
  type SessionSubmitResult,
} from "@ag2cli/app-server-protocol/types.js"
import { asRecord, assertJsonValue, parseNonEmptyString, parseNonNegativeInteger } from "@ag2cli/app-server-protocol/validation.js"

export interface AcpAppServerSnapshot {
  readonly sessionId: string
  readonly lastRevision: number
}

export interface AcpAppServerEvent {
  readonly eventId: string
  readonly sessionId: string
  readonly revision: number
  readonly type: string
  readonly payload: Record<string, unknown>
}

export type AcpAppServerSessionMessage =
  | { readonly type: "event"; readonly event: AcpAppServerEvent }
  | {
      readonly type: "operation_failed"
      readonly sessionId: string
      readonly commandId: string
      readonly intent: "prompt" | "mention" | "shell"
      readonly message: string
      readonly code?: AppServerErrorCode
    }

export interface AcpAppServerSessionClient {
  createSession(sessionId: string, workspaceId: string, signal?: AbortSignal): Promise<void>
  snapshot(sessionId: string, signal?: AbortSignal): Promise<AcpAppServerSnapshot>
  attach(sessionId: string, afterRevision: number, signal?: AbortSignal): Promise<readonly AcpAppServerEvent[]>
  plan(
    sessionId: string,
    commandId: string,
    text: string,
    context: readonly string[],
    workspace: string,
    signal?: AbortSignal,
  ): Promise<JsonValue>
  submit(
    sessionId: string,
    commandId: string,
    text: string,
    context: readonly string[],
    workspace: string,
    signal?: AbortSignal,
  ): Promise<SessionSubmitResult>
  resolveApproval(params: SessionResolveApprovalParams, signal?: AbortSignal): Promise<void>
  cancel(sessionId: string, commandId: string, signal?: AbortSignal): Promise<void>
  subscribe(sessionId: string, listener: (message: AcpAppServerSessionMessage) => void): () => void
  dispose(): void
}

/**
 * The ACP edge's only view of a Host. It deliberately exposes protocol DTOs,
 * not the internal SessionClient, SessionServer, event union or command codec.
 */
export function createAcpAppServerSessionClient(rpc: AppServerRpcClient): AcpAppServerSessionClient {
  const listeners = new Map<string, Set<(message: AcpAppServerSessionMessage) => void>>()
  const removeNotification = rpc.onNotification((notification) => dispatchNotification(notification))
  let disposed = false

  return {
    createSession: async (sessionId, workspaceId, signal) => {
      await request(rpc, "session.create", { sessionId, workspaceId }, signal)
    },

    snapshot: async (sessionId, signal) => {
      const result = asRecord(await request(rpc, "session.snapshot", { sessionId }, signal), "session.snapshot.result")
      assertSessionId(result, sessionId, "session.snapshot.result")
      const snapshot = asRecord(result.snapshot, "session.snapshot.result.snapshot")
      assertSessionId(snapshot, sessionId, "session.snapshot.result.snapshot")
      return {
        sessionId,
        lastRevision: parseNonNegativeInteger(snapshot.lastRevision, "session.snapshot.result.snapshot.lastRevision"),
      }
    },

    attach: async (sessionId, afterRevision, signal) => {
      const result = asRecord(
        await request(rpc, "session.attach", { sessionId, afterRevision, includeTransient: false }, signal),
        "session.attach.result",
      )
      assertSessionId(result, sessionId, "session.attach.result")
      if (!Array.isArray(result.events)) throw new Error("session.attach.result.events must be an array")
      return result.events.map((event, index) => parseEvent(event, sessionId, `session.attach.result.events[${index}]`))
    },

    plan: async (sessionId, commandId, text, context, workspace, signal) => {
      const result = asRecord(
        await request(
          rpc,
          "session.plan",
          {
            sessionId,
            commandId,
            text,
            ...(context.length === 0 ? {} : { context }),
            workspace,
          },
          signal,
        ),
        "session.plan.result",
      )
      assertAccepted(result, sessionId, commandId, "plan")
      if (result.result === undefined) throw new Error("session.plan.result.result is missing")
      return assertJsonValue(result.result, "session.plan.result.result")
    },

    submit: async (sessionId, commandId, text, context, workspace, signal) => {
      const result = asRecord(
        await request(
          rpc,
          "session.submit",
          {
            sessionId,
            commandId,
            text,
            ...(context.length === 0 ? {} : { context }),
            workspace,
          },
          signal,
        ),
        "session.submit.result",
      )
      assertAccepted(result, sessionId, commandId, "submit")
      const intent = result.intent
      if (intent !== "prompt" && intent !== "mention" && intent !== "shell") {
        throw new Error(`Cannot map session.submit.result.intent: ${String(intent)}`)
      }
      return {
        accepted: true,
        sessionId,
        commandId,
        intent,
        ...(result.runId === undefined ? {} : { runId: parseNonEmptyString(result.runId, "session.submit.result.runId") }),
        ...(result.result === undefined ? {} : { result: assertJsonValue(result.result, "session.submit.result.result") }),
        ...(result.snapshot === undefined ? {} : { snapshot: assertJsonValue(result.snapshot, "session.submit.result.snapshot") }),
      }
    },

    resolveApproval: async (params, signal) => {
      const result = asRecord(
        await request(rpc, "session.resolveApproval", params as unknown as Record<string, unknown>, signal),
        "session.resolveApproval.result",
      )
      assertSessionId(result, params.sessionId, "session.resolveApproval.result")
    },

    cancel: async (sessionId, commandId, signal) => {
      const result = asRecord(await request(rpc, "session.cancel", { sessionId, commandId }, signal), "session.cancel.result")
      assertSessionId(result, sessionId, "session.cancel.result")
    },

    subscribe: (sessionId, listener) => {
      const sessionListeners = listeners.get(sessionId) ?? new Set()
      sessionListeners.add(listener)
      listeners.set(sessionId, sessionListeners)
      return () => {
        sessionListeners.delete(listener)
        if (sessionListeners.size === 0) listeners.delete(sessionId)
      }
    },

    dispose: () => {
      if (disposed) return
      disposed = true
      removeNotification()
      listeners.clear()
    },
  }

  function dispatchNotification(notification: JsonRpcNotification): void {
    try {
      if (notification.method === "session.event") {
        const params = asRecord(notification.params, "session.event.params")
        const sessionId = parseNonEmptyString(params.sessionId, "session.event.params.sessionId")
        dispatch(sessionId, { type: "event", event: parseEvent(params.event, sessionId, "session.event.params.event", params.revision) })
        return
      }
      if (notification.method === "session.operation.failed") {
        const params = asRecord(notification.params, "session.operation.failed.params")
        const sessionId = parseNonEmptyString(params.sessionId, "session.operation.failed.params.sessionId")
        const intent = params.intent
        if (intent !== "prompt" && intent !== "mention" && intent !== "shell") return
        const code = params.code
        if (code !== undefined && !isAppServerErrorCode(code)) return
        dispatch(sessionId, {
          type: "operation_failed",
          sessionId,
          commandId: parseNonEmptyString(params.commandId, "session.operation.failed.params.commandId"),
          intent,
          message: parseNonEmptyString(params.message, "session.operation.failed.params.message"),
          ...(code === undefined ? {} : { code }),
        })
      }
    } catch {
      // A malformed notification must not break the ACP transport. The next
      // snapshot/replay remains the recovery source of truth.
    }
  }

  function dispatch(sessionId: string, message: AcpAppServerSessionMessage): void {
    for (const listener of [...(listeners.get(sessionId) ?? [])]) {
      try {
        listener(message)
      } catch {
        // One ACP projection listener must not stop the other listeners.
      }
    }
  }
}

async function request(rpc: AppServerRpcClient, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<JsonValue> {
  return rpc.request(method, assertJsonValue(params, `${method}.params`), signal === undefined ? {} : { signal })
}

function assertAccepted(result: Record<string, unknown>, sessionId: string, commandId: string, name: string): void {
  if (result.accepted !== true) throw new Error(`session.${name}.result.accepted must be true`)
  assertSessionId(result, sessionId, `session.${name}.result`)
  if (parseNonEmptyString(result.commandId, `session.${name}.result.commandId`) !== commandId) {
    throw new Error(`session.${name}.result.commandId does not match the request`)
  }
}

function assertSessionId(result: Record<string, unknown>, sessionId: string, name: string): void {
  if (parseNonEmptyString(result.sessionId, `${name}.sessionId`) !== sessionId) {
    throw new Error(`${name}.sessionId does not match the target Session`)
  }
}

function parseEvent(value: unknown, sessionId: string, name: string, expectedRevision?: unknown): AcpAppServerEvent {
  const event = asRecord(value, name)
  assertSessionId(event, sessionId, name)
  const revision = parseNonNegativeInteger(event.revision, `${name}.revision`)
  if (expectedRevision !== undefined && revision !== expectedRevision) throw new Error(`${name}.revision does not match`)
  return {
    eventId: parseNonEmptyString(event.eventId, `${name}.eventId`),
    sessionId,
    revision,
    type: parseNonEmptyString(event.type, `${name}.type`),
    payload: asRecord(event.payload, `${name}.payload`),
  }
}
