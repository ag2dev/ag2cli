import { APP_SERVER_PROTOCOL_VERSION, type ServerInitializeResult } from "@ag2cli/app-server-protocol/types.js"
import type { AppServerRpcClient } from "@ag2cli/app-server-client/client.js"
import { signAppServerDeviceChallenge } from "@ag2cli/app-server-client/device-proof.js"
import { VerifiedAppServerConnection } from "@ag2cli/app-server-client/verified-connection.js"
import { callProtocol } from "@ag2cli/app-server-client/protocol-methods.js"
import { WebSocketAppServerTransport, WEBSOCKET_OPEN, type WebSocketLike } from "@ag2cli/app-server-client/websocket.js"
import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicSessionSnapshot } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import { type BrowserDeviceIdentity } from "./pairing"

export interface BrowserAppServerConnection {
  readonly rpc: AppServerRpcClient
  readonly initialize: ServerInitializeResult
  onClose(listener: (error?: Error) => void): () => void
  close(): void
}

export interface BrowserSessionRecord {
  readonly sessionId: string
  readonly title?: string
  readonly status: string
  readonly workspace: { readonly workspaceId: string; readonly displayName: string; readonly availability: "available" | "unavailable" }
  readonly updatedAt: string
  readonly archivedAt?: string
}

export interface BrowserWorkspace {
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly availability: "available" | "unavailable"
}

export function serverWorkspaces(initialize: ServerInitializeResult): readonly BrowserWorkspace[] {
  return initialize.host?.workspaces ?? []
}

export interface SessionAttachState {
  readonly snapshot: PublicSessionSnapshot
  /** Snapshot cursor the live delivery barrier was aligned to; equals `snapshot.asOfRevision`. */
  readonly barrierRevision: number
  readonly events: readonly PublicSessionEvent[]
}

export async function connectBrowserAppServer(
  endpoint: string,
  clientId: string,
  options: {
    readonly deviceIdentity?: BrowserDeviceIdentity
    readonly createWebSocket?: (url: string) => WebSocketLike
    readonly signal?: AbortSignal
  } = {},
): Promise<BrowserAppServerConnection> {
  options.signal?.throwIfAborted()
  const identity = options.deviceIdentity
  if (identity === undefined) throw new Error("A paired browser device identity is required to connect")
  const socket = options.createWebSocket?.(endpoint) ?? (new WebSocket(endpoint) as unknown as WebSocketLike)
  await waitForOpen(socket, endpoint, options.signal)
  const transport = new WebSocketAppServerTransport(socket as unknown as WebSocketLike)
  const rpc = await VerifiedAppServerConnection.open(transport, {
    purpose: "device-connect",
    expectedHostId: identity.hostId,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    requestTimeoutMs: 60_000,
  })
  const abort = (): void => rpc.close()
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    options.signal?.throwIfAborted()
    const challenge = rpc.preflight.deviceChallenge
    const challengeExpiresAt = rpc.preflight.deviceChallengeExpiresAt
    if (challenge === undefined || challengeExpiresAt === undefined) {
      throw new Error("App Server device preflight did not include a device challenge")
    }
    const proof = await signAppServerDeviceChallenge(
      { hostId: rpc.hostId, challenge, expiresAt: challengeExpiresAt },
      identity.deviceId,
      clientId,
      { privateKey: identity.privateKey, publicKey: identity.publicKey },
    )
    const initialize = await rpc.initialize(
      {
        appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
        hostId: rpc.hostId,
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
            "session.steer",
            "session.cancelRun",
            "session.cancelInput",
            "session.replay",
            "session.setPermissionMode",
            "session.getPermissionPolicy",
            "interaction.acquire",
            "interaction.renew",
            "interaction.release",
            "interaction.takeover",
          ],
        },
        auth: {
          type: "device",
          device: {
            ...proof,
            credential: identity.credential,
          },
        },
      },
      { signal: options.signal },
    )
    return {
      rpc,
      initialize,
      onClose: (listener) => rpc.onClose(listener),
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

export async function listBrowserSessions(rpc: AppServerRpcClient): Promise<readonly BrowserSessionRecord[]> {
  return callProtocol(rpc, "session.list", {})
}

export async function createBrowserSession(
  rpc: AppServerRpcClient,
  workspaceId: string,
  title = "New conversation",
): Promise<BrowserSessionRecord> {
  const result = await callProtocol(rpc, "session.create", {
    sessionId: crypto.randomUUID(),
    workspaceId,
    title,
  })
  return result.session
}

export async function detachBrowserSession(rpc: AppServerRpcClient, sessionId: string): Promise<void> {
  const result = await callProtocol(rpc, "session.detach", { sessionId })
  if (result.sessionId !== sessionId) throw new Error("session.detach returned a different sessionId")
}

export async function deleteBrowserSession(rpc: AppServerRpcClient, sessionId: string, leaseGeneration: number): Promise<void> {
  const result = await callProtocol(rpc, "session.delete", {
    sessionId,
    lease: { scope: "session-control", generation: leaseGeneration },
  })
  if (result.sessionId !== sessionId) throw new Error("session.delete returned a different sessionId")
}

/** Attaches with the snapshot-first face: the result carries the barrier-aligned
 * snapshot only; catchup history comes from `session.replay` pages. */
export async function attachBrowserSession(rpc: AppServerRpcClient, sessionId: string): Promise<SessionAttachState> {
  const attached = await attachLiveBrowserSession(rpc, sessionId)
  const replayed = await replayBrowserSession(rpc, sessionId, 0)
  return {
    snapshot: attached.snapshot,
    barrierRevision: attached.barrierRevision,
    events: replayed.events,
  }
}

/** Registers the live subscription without catchup history; reconnect
 * recovery supplies its own cursor instead of replaying from zero. */
export async function attachLiveBrowserSession(
  rpc: AppServerRpcClient,
  sessionId: string,
): Promise<{ readonly snapshot: PublicSessionSnapshot; readonly barrierRevision: number }> {
  const attached = await callProtocol(rpc, "session.attach", { sessionId })
  if (attached.snapshot.sessionId !== sessionId) throw new Error("session.attach returned a different sessionId")
  if (attached.barrierRevision !== attached.snapshot.asOfRevision) {
    throw new Error("session.attach barrier diverges from the snapshot cursor")
  }
  return { snapshot: attached.snapshot, barrierRevision: attached.barrierRevision }
}

/** The server's continuation cursor cannot be advanced safely; the held
 * projection is not extendable and the caller must resync. */
export class ReplayContinuationError extends Error {}

/** Wholesale rebuild: the resync snapshot replaces the held state and
 * `replay(0)` restores the full durable history behind it. */
export async function resyncBrowserSession(
  rpc: AppServerRpcClient,
  sessionId: string,
): Promise<{ readonly snapshot: PublicSessionSnapshot; readonly events: readonly PublicSessionEvent[] }> {
  const result = await callProtocol(rpc, "session.resync", { sessionId })
  if (result.snapshot.sessionId !== sessionId) throw new Error("session.resync returned a different sessionId")
  const replayed = await replayBrowserSession(rpc, sessionId, 0)
  return { snapshot: result.snapshot, events: replayed.events }
}

/** Pages `session.replay` from `afterRevision` until the server reports the head.
 * A `revision_ahead` cursor means the held cursor is stale; the caller must resync. */
export async function replayBrowserSession(
  rpc: AppServerRpcClient,
  sessionId: string,
  afterRevision: number,
): Promise<{ readonly events: readonly PublicSessionEvent[]; readonly scannedThroughRevision: number }> {
  const events: PublicSessionEvent[] = []
  let cursor = afterRevision
  for (;;) {
    const page = await callProtocol(rpc, "session.replay", { sessionId, afterRevision: cursor })
    events.push(...page.events)
    if (!page.hasMore) return { events, scannedThroughRevision: page.scannedThroughRevision }
    const next = page.nextAfterRevision
    if (next === undefined || next > page.scannedThroughRevision || next <= cursor) {
      throw new ReplayContinuationError("session.replay returned an invalid continuation cursor")
    }
    cursor = next
  }
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
