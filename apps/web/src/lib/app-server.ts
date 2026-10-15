import {
  APP_SERVER_PROTOCOL_VERSION,
  isAppServerTransientEventKind,
  type AppServerDeviceProof,
  type AppServerInteractionLeases,
  type AppServerPresenceClient,
  type InteractionLeaseScope,
  type JsonValue,
  type JsonRpcNotification,
  type ServerInitializeResult,
} from "@ag2cli/app-server-protocol/types.js"
import { asRecord, parseNonEmptyString, parseNonNegativeInteger } from "@ag2cli/app-server-protocol/validation.js"
import { JsonRpcAppServerClient } from "@ag2cli/app-server-client/client.js"
import { signAppServerDeviceChallenge } from "@ag2cli/app-server-client/device-proof.js"
import { parseInteractionLeases } from "@ag2cli/app-server-client/interaction.js"
import { AppServerPairingClient, type AppServerFetch } from "@ag2cli/app-server-client/pairing.js"
import { WebSocketAppServerTransport, WEBSOCKET_OPEN, type WebSocketLike } from "@ag2cli/app-server-client/websocket.js"
import { mergeWireEvents, parseWireEvent, type WireEvent, type WireTransientEvent } from "./conversation"
import { appServerHttpBaseUrl, type BrowserDeviceIdentity } from "./pairing"

export interface BrowserAppServerConnection {
  readonly rpc: JsonRpcAppServerClient
  readonly initialize: ServerInitializeResult
  onClose(listener: (error?: Error) => void): () => void
  close(): void
}

export interface BrowserSessionRecord {
  readonly sessionId: string
  readonly title?: string
  readonly workspaceRoot?: string
  readonly workspaceId?: string
  readonly createdAt?: string
  readonly lastRevision: number
}

export interface BrowserWorkspace {
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly availability: "available" | "unavailable"
}

export function parseWorkspace(value: unknown): BrowserWorkspace {
  const record = asRecord(value, "workspace")
  if (record.availability !== "available" && record.availability !== "unavailable") throw new Error("Invalid workspace availability")
  return {
    workspaceId: parseNonEmptyString(record.workspaceId, "workspace.workspaceId"),
    workspaceRoot: parseNonEmptyString(record.workspaceRoot, "workspace.workspaceRoot"),
    availability: record.availability,
  }
}

export function serverWorkspaces(initialize: ServerInitializeResult): readonly BrowserWorkspace[] {
  return (initialize.host?.workspaces ?? []).map(parseWorkspace)
}

export interface SessionAttachState {
  readonly snapshot: Record<string, unknown>
  readonly workspace?: BrowserWorkspace
  readonly presence: readonly AppServerPresenceClient[]
  /** Both independently-generationed interaction scopes returned by the attach snapshot. */
  readonly leases: AppServerInteractionLeases
  readonly events: readonly WireEvent[]
  readonly transientEvents: readonly WireTransientEvent[]
}

export async function connectBrowserAppServer(
  endpoint: string,
  clientId: string,
  options: {
    readonly bearerToken?: string
    readonly deviceIdentity?: BrowserDeviceIdentity
    readonly expectedServerFingerprint?: string
    readonly fetch?: AppServerFetch
    readonly createWebSocket?: (url: string, protocols?: readonly string[]) => WebSocketLike
    readonly signal?: AbortSignal
  } = {},
): Promise<BrowserAppServerConnection> {
  options.signal?.throwIfAborted()
  appServerHttpBaseUrl(endpoint)
  const credential = options.deviceIdentity?.credential ?? options.bearerToken?.trim()
  const deviceProof =
    options.deviceIdentity === undefined
      ? undefined
      : await createBrowserDeviceProof(endpoint, clientId, options.deviceIdentity, options.fetch)
  const protocols = credential === undefined ? undefined : [encodeBearerTokenProtocol(credential)]
  const socket = options.createWebSocket?.(endpoint, protocols) ?? (new WebSocket(endpoint, protocols) as unknown as WebSocketLike)
  await waitForOpen(socket, endpoint, options.signal)
  const transport = new WebSocketAppServerTransport(socket as unknown as WebSocketLike)
  const rpc = new JsonRpcAppServerClient(transport, {
    requestTimeoutMs: 60_000,
  })
  const abort = (): void => rpc.close()
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    options.signal?.throwIfAborted()
    const initialize = await rpc.initialize({
      appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
      client: {
        clientId,
        clientKind: "web",
        name: "ag2cli-web",
        version: "dev",
        capabilities: [
          "session.list",
          "session.create",
          "session.delete",
          "session.attach",
          "session.detach",
          "session.submit",
          "session.cancel",
          "session.replay",
          "interaction.acquire",
          "interaction.renew",
          "interaction.release",
          "interaction.takeover",
        ],
      },
      ...(options.expectedServerFingerprint === undefined ? {} : { serverFingerprint: options.expectedServerFingerprint }),
      ...(deviceProof === undefined ? {} : { device: deviceProof.proof, serverFingerprint: deviceProof.serverFingerprint }),
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
  } catch (error) {
    options.signal?.removeEventListener("abort", abort)
    rpc.close()
    throw error
  }
}

async function createBrowserDeviceProof(
  endpoint: string,
  clientId: string,
  identity: BrowserDeviceIdentity,
  fetchImpl?: AppServerFetch,
): Promise<{ readonly proof: AppServerDeviceProof; readonly serverFingerprint: string }> {
  const pairing = new AppServerPairingClient(appServerHttpBaseUrl(endpoint), {
    bearerToken: identity.credential,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  })
  const challenge = await pairing.challenge()
  if (challenge.deviceId !== identity.deviceId) throw new Error("App Server challenge does not match the browser device identity")
  const expectedServerFingerprint = identity.serverFingerprint
  if (expectedServerFingerprint !== undefined && challenge.serverFingerprint !== expectedServerFingerprint) {
    throw new Error("App Server challenge does not match the expected server fingerprint")
  }
  return {
    proof: await signAppServerDeviceChallenge(challenge, clientId, identity),
    serverFingerprint: challenge.serverFingerprint,
  }
}

export async function listBrowserSessions(rpc: JsonRpcAppServerClient): Promise<readonly BrowserSessionRecord[]> {
  const result = await rpc.request("session.list", {})
  if (!Array.isArray(result)) throw new Error("session.list result must be an array")
  return result.map((value, index) => parseSessionRecord(value, index))
}

export async function createBrowserSession(
  rpc: JsonRpcAppServerClient,
  workspaceId: string,
  title = "New conversation",
): Promise<BrowserSessionRecord> {
  const result = asRecord(
    await rpc.request("session.create", {
      sessionId: crypto.randomUUID(),
      workspaceId,
      title,
    }),
    "session.create.result",
  )
  return parseSessionRecord(result, 0)
}

export async function detachBrowserSession(rpc: JsonRpcAppServerClient, sessionId: string): Promise<void> {
  const result = asRecord(await rpc.request("session.detach", { sessionId }), "session.detach.result")
  if (parseNonEmptyString(result.sessionId, "session.detach.result.sessionId") !== sessionId) {
    throw new Error("session.detach returned a different sessionId")
  }
  if (typeof result.detached !== "boolean") throw new Error("session.detach.result.detached must be a boolean")
}

export async function deleteBrowserSession(rpc: JsonRpcAppServerClient, sessionId: string, leaseGeneration: number): Promise<void> {
  const result = asRecord(
    await rpc.request("session.delete", {
      sessionId,
      lease: { scope: "session-control", generation: leaseGeneration },
    }),
    "session.delete.result",
  )
  if (parseNonEmptyString(result.sessionId, "session.delete.result.sessionId") !== sessionId || result.deleted !== true) {
    throw new Error("Invalid session.delete result")
  }
}

/** Build the strict per-scope lease envelope used by the Web submit path. */
export function createBrowserSessionSubmitParams(
  sessionId: string,
  commandId: string,
  text: string,
  scope: InteractionLeaseScope,
  generation: number,
): JsonValue {
  return {
    sessionId,
    commandId,
    text,
    lease: { [scope]: generation },
  }
}

export async function attachBrowserSession(
  rpc: JsonRpcAppServerClient,
  sessionId: string,
  afterRevision: number,
): Promise<SessionAttachState> {
  const attached = asRecord(
    await rpc.request("session.attach", {
      sessionId,
      afterRevision,
      includeTransient: true,
    }),
    "session.attach.result",
  )
  if (attached.sessionId !== sessionId) throw new Error("session.attach returned a different sessionId")
  const snapshot = asRecord(attached.snapshot, "session.attach.result.snapshot")
  const presenceValue = asRecord(attached.presence, "session.attach.result.presence")
  const presence = parsePresence(presenceValue.clients)
  const leases = parseInteractionLeases(presenceValue.leases)
  const attachedEvents = parseEvents(attached.events, sessionId)
  const attachedTransientEvents = parseTransientEvents(attached.transientEvents, sessionId)
  const replay = asRecord(await rpc.request("session.replay", { sessionId, afterRevision }), "session.replay.result")
  if (replay.sessionId !== sessionId || replay.complete !== true) throw new Error("Incomplete or mismatched session replay")
  const replayEvents = parseEvents(replay.events, sessionId)
  return {
    snapshot,
    ...(attached.workspace === undefined ? {} : { workspace: parseWorkspace(attached.workspace) }),
    presence,
    leases,
    events: mergeWireEvents(attachedEvents, replayEvents),
    transientEvents: attachedTransientEvents,
  }
}

export function parsePresence(value: unknown): readonly AppServerPresenceClient[] {
  if (!Array.isArray(value)) throw new Error("presence.clients must be an array")
  return value.map((client, index) => {
    const record = asRecord(client, `presence.clients[${index}]`)
    const clientKind = parseNonEmptyString(record.clientKind, `presence.clients[${index}].clientKind`)
    if (!["tui", "web", "mobile", "desktop", "acp", "script", "unknown"].includes(clientKind)) {
      throw new Error(`Invalid presence.clients[${index}].clientKind`)
    }
    return {
      connectionId: parseNonEmptyString(record.connectionId, `presence.clients[${index}].connectionId`),
      deviceId: parseNonEmptyString(record.deviceId, `presence.clients[${index}].deviceId`),
      clientId: parseNonEmptyString(record.clientId, `presence.clients[${index}].clientId`),
      clientKind: clientKind as AppServerPresenceClient["clientKind"],
      name: parseNonEmptyString(record.name, `presence.clients[${index}].name`),
      version: parseNonEmptyString(record.version, `presence.clients[${index}].version`),
    }
  })
}

/**
 * Unknown transient kinds parse to undefined: an older client meeting a newer
 * server vocabulary loses that live detail, never the stream itself (D10).
 * Envelope violations remain protocol errors.
 */
export function parseTransientEvent(value: unknown, expectedSessionId?: string): WireTransientEvent | undefined {
  const record = asRecord(value, "session.transient.event")
  const sessionId = parseNonEmptyString(record.sessionId, "session.transient.event.sessionId")
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) throw new Error("Transient event belongs to a different session")
  const sequence = parseNonNegativeInteger(record.sequence, "session.transient.event.sequence")
  if (sequence < 1) throw new Error("Transient sequence must be a positive integer")
  const type = parseNonEmptyString(record.type, "session.transient.event.type")
  if (!isAppServerTransientEventKind(type)) {
    return undefined
  }
  return {
    eventId: parseNonEmptyString(record.eventId, "session.transient.event.eventId"),
    sessionId,
    sequence,
    type,
    timestamp: parseNonEmptyString(record.timestamp, "session.transient.event.timestamp"),
    payload: asRecord(record.payload, "session.transient.event.payload"),
  }
}

export function parseNotificationEvents(notification: JsonRpcNotification):
  | { readonly kind: "event"; readonly event: WireEvent }
  | { readonly kind: "transient"; readonly event: WireTransientEvent }
  | {
      readonly kind: "presence"
      readonly sessionId: string
      readonly clients: readonly AppServerPresenceClient[]
    }
  | {
      readonly kind: "lease"
      readonly sessionId: string
      readonly leases: AppServerInteractionLeases
    }
  | { readonly kind: "resync"; readonly sessionId: string }
  | {
      readonly kind: "operationFailed"
      readonly sessionId: string
      readonly commandId: string
      readonly message: string
    }
  | undefined {
  if (notification.method === "session.event") {
    const params = asRecord(notification.params, "session.event.params")
    const event = parseWireEvent(params.event, typeof params.sessionId === "string" ? params.sessionId : undefined)
    return event === undefined ? undefined : { kind: "event", event }
  }
  if (notification.method === "session.transient") {
    const params = asRecord(notification.params, "session.transient.params")
    const sessionId = parseNonEmptyString(params.sessionId, "session.transient.sessionId")
    const event = parseTransientEvent(params.event, sessionId)
    return event === undefined ? undefined : { kind: "transient", event }
  }
  if (notification.method === "presence.updated") {
    const params = asRecord(notification.params, "presence.updated.params")
    return {
      kind: "presence",
      sessionId: parseNonEmptyString(params.sessionId, "presence.updated.sessionId"),
      clients: parsePresence(params.clients),
    }
  }
  if (notification.method === "interaction.lease.updated") {
    const params = asRecord(notification.params, "interaction.lease.updated.params")
    return {
      kind: "lease",
      sessionId: parseNonEmptyString(params.sessionId, "interaction.lease.updated.sessionId"),
      leases: parseInteractionLeases(params.leases),
    }
  }
  if (notification.method === "session.resyncRequired") {
    const params = asRecord(notification.params, "session.resyncRequired.params")
    return {
      kind: "resync",
      sessionId: parseNonEmptyString(params.sessionId, "sessionId"),
    }
  }
  if (notification.method === "session.operation.failed") {
    const params = asRecord(notification.params, "session.operation.failed.params")
    return {
      kind: "operationFailed",
      sessionId: parseNonEmptyString(params.sessionId, "sessionId"),
      commandId: parseNonEmptyString(params.commandId, "commandId"),
      message: parseNonEmptyString(params.message, "message"),
    }
  }
  return undefined
}

function parseSessionRecord(value: unknown, index: number): BrowserSessionRecord {
  const record = asRecord(value, `session.list.result[${index}]`)
  const snapshot = asRecord(record.snapshot, `session.list.result[${index}].snapshot`)
  return {
    sessionId: parseNonEmptyString(record.sessionId, `session.list.result[${index}].sessionId`),
    ...(record.title === undefined
      ? {}
      : {
          title: parseNonEmptyString(record.title, `session.list.result[${index}].title`),
        }),
    ...(snapshot.workspaceRoot === undefined
      ? {}
      : {
          workspaceRoot: parseNonEmptyString(snapshot.workspaceRoot, `session.list.result[${index}].snapshot.workspaceRoot`),
        }),
    ...(record.workspaceId === undefined ? {} : { workspaceId: parseNonEmptyString(record.workspaceId, "session.workspaceId") }),
    ...(record.createdAt === undefined ? {} : { createdAt: parseNonEmptyString(record.createdAt, "session.createdAt") }),
    lastRevision: parseNonNegativeInteger(snapshot.lastRevision, `session.list.result[${index}].snapshot.lastRevision`),
  }
}

function parseEvents(value: unknown, sessionId: string): readonly WireEvent[] {
  if (!Array.isArray(value)) throw new Error("Session events must be an array")
  return value.flatMap((item) => {
    const event = parseWireEvent(item, sessionId)
    return event === undefined ? [] : [event]
  })
}

function parseTransientEvents(value: unknown, sessionId: string): readonly WireTransientEvent[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("Transient events must be an array")
  return value.flatMap((item) => {
    const event = parseTransientEvent(item, sessionId)
    return event === undefined ? [] : [event]
  })
}

function waitForOpen(socket: WebSocketLike, endpoint: string, signal?: AbortSignal): Promise<void> {
  if (socket.readyState === WEBSOCKET_OPEN) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onClose)
      signal?.removeEventListener("abort", onAbort)
      clearTimeout(timer)
    }
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new Error(`Cannot connect to App Server: ${endpoint}`))
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error(`App Server closed before the handshake: ${endpoint}`))
    }
    const onAbort = (): void => {
      cleanup()
      socket.close()
      reject(new Error("Connection was cancelled"))
    }
    const timer = setTimeout(() => {
      cleanup()
      socket.close()
      reject(new Error("App Server connection timed out"))
    }, 10_000)
    socket.addEventListener("open", onOpen)
    socket.addEventListener("error", onError)
    socket.addEventListener("close", onClose)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function encodeBearerTokenProtocol(token: string): string {
  const bytes = new TextEncoder().encode(token)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
  return `ag2cli-bearer.${encoded}`
}
