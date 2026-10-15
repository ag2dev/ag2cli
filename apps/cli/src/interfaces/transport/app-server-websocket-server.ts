import { JSON_RPC_PARSE_ERROR, createFailure, encodeMessage, parseEncodedMessage } from "@ag2cli/app-server-protocol/json-rpc.js"
import {
  APP_SERVER_SCOPES,
  APP_SERVER_PROTOCOL_VERSION,
  type AppServerScope,
  type AppServerDeviceRegistry,
  type AppServerPairingRegistry,
  type JsonRpcMessage,
  type JsonRpcNotification,
} from "@ag2cli/app-server-protocol/types.js"
import { createAppServerPairingHttpHandler } from "./app-server-pairing-http.js"
import type { AppServerDeviceChallengeIssuer } from "./app-server-device-proof.js"
import type { AppServerRpcConnection } from "./app-server-rpc.js"

export interface AppServerWebSocketIdentity {
  /** Device identity established by the HTTP upgrade authenticator. */
  readonly deviceId?: string
  /** Registered device public key, when the credential belongs to a proof-capable device. */
  readonly devicePublicKey?: string
  /** Maximum scopes granted by the transport credential. */
  readonly grantedScopes?: readonly AppServerScope[]
}

export type AppServerWebSocketAuthentication = boolean | AppServerWebSocketIdentity

export interface AppServerWebSocketConnection {
  readonly rpc: Pick<AppServerRpcConnection, "handle">
  close(): void
}

export interface AppServerWebSocketServerOptions {
  readonly createConnection: (
    onNotification: (notification: JsonRpcNotification) => void,
    identity?: AppServerWebSocketIdentity,
  ) => AppServerWebSocketConnection
  /** TCP listener settings. */
  readonly hostname?: string
  readonly port?: number
  readonly path?: string
  readonly healthPath?: string
  /** Simple local deployment auth for callers that do not need identity mapping. */
  readonly bearerToken?: string
  readonly authenticate?: (request: Request) => AppServerWebSocketAuthentication | Promise<AppServerWebSocketAuthentication>
  readonly pairing?: {
    readonly registry: AppServerPairingRegistry
    readonly startPath?: string
    readonly claimPath?: string
    readonly challengePath?: string
    readonly deviceProof?: AppServerDeviceChallengeIssuer
    readonly maxBodyBytes?: number
    readonly corsOrigins?: readonly string[]
  }
  readonly tls?: Bun.TLSOptions
}

export interface AppServerWebSocketAuthenticatorOptions {
  /** Full server credential used by the local operator or service manager. */
  readonly serverToken?: string
  /** Persistent device credentials are resolved without touching Session state. */
  readonly deviceRegistry?: AppServerDeviceRegistry
  /** Scopes granted to the server credential. */
  readonly serverScopes?: readonly AppServerScope[]
  /** Preserve the loopback, no-auth development mode when no credential is supplied. */
  readonly allowAnonymous?: boolean
}

interface AppServerWebSocketData {
  readonly connection: AppServerWebSocketConnection
  socket?: Bun.ServerWebSocket<AppServerWebSocketData>
}

/**
 * Bun adapter for the public App Server wire boundary. The Host and RPC
 * dispatcher remain transport-neutral; this module owns only HTTP upgrade,
 * authentication and socket lifecycle.
 */
export function createAppServerWebSocketServer(options: AppServerWebSocketServerOptions): Bun.Server<AppServerWebSocketData> {
  validateListenerOptions(options)
  const path = options.path ?? "/app-server"
  const healthPath = options.healthPath ?? "/health"
  const pairingHandler =
    options.pairing === undefined
      ? undefined
      : createAppServerPairingHttpHandler({
          registry: options.pairing.registry,
          authenticate: (request) => authenticateRequest(request, options),
          ...(options.pairing.startPath === undefined ? {} : { startPath: options.pairing.startPath }),
          ...(options.pairing.claimPath === undefined ? {} : { claimPath: options.pairing.claimPath }),
          ...(options.pairing.challengePath === undefined ? {} : { challengePath: options.pairing.challengePath }),
          ...(options.pairing.deviceProof === undefined ? {} : { deviceProof: options.pairing.deviceProof }),
          ...(options.pairing.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.pairing.maxBodyBytes }),
          ...(options.pairing.corsOrigins === undefined ? {} : { corsOrigins: options.pairing.corsOrigins }),
        })
  const fetchHandler = async (request: Request, server: Bun.Server<AppServerWebSocketData>): Promise<Response | undefined> => {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === healthPath) {
      return Response.json({ ok: true, status: "ready", protocolVersion: APP_SERVER_PROTOCOL_VERSION })
    }
    const pairingResponse = await pairingHandler?.(request)
    if (pairingResponse !== undefined) return pairingResponse
    if (url.pathname !== path) return new Response("Not found", { status: 404 })
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
    const identity = await authenticateRequest(request, options)
    if (identity === undefined) {
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } })
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426, headers: { Upgrade: "websocket" } })
    }
    let data: AppServerWebSocketData
    data = {
      connection: options.createConnection((notification) => sendNotification(data, notification), identity),
    }
    if (!server.upgrade(request, { data })) {
      data.connection.close()
      return new Response("WebSocket upgrade failed", { status: 400 })
    }
    return undefined
  }
  const websocket: Bun.WebSocketHandler<AppServerWebSocketData> = {
    data: {} as AppServerWebSocketData,
    open(socket) {
      socket.data.socket = socket
    },
    async message(socket, value) {
      const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8")
      let message: JsonRpcMessage
      try {
        message = parseEncodedMessage(text)
      } catch (error) {
        socket.send(
          encodeMessage(
            createFailure(null, JSON_RPC_PARSE_ERROR, error instanceof Error ? error.message : String(error), { code: "parse_error" }),
          ),
        )
        socket.close(1002, "invalid JSON-RPC message")
        return
      }
      const response = await socket.data.connection.rpc.handle(message)
      if (response !== undefined) socket.send(encodeMessage(response))
    },
    close(socket) {
      socket.data.connection.close()
    },
  }
  return Bun.serve<AppServerWebSocketData>({
    hostname: options.hostname!,
    port: options.port!,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    fetch: fetchHandler,
    websocket,
  })
}

function validateListenerOptions(options: AppServerWebSocketServerOptions): void {
  if (options.hostname === undefined || options.port === undefined) {
    throw new Error("App Server TCP listener must set both hostname and port")
  }
}

function sendNotification(data: AppServerWebSocketData, notification: JsonRpcNotification): void {
  data.socket?.send(encodeMessage(notification))
}

async function authenticateRequest(
  request: Request,
  options: AppServerWebSocketServerOptions,
): Promise<AppServerWebSocketIdentity | undefined> {
  if (options.authenticate) {
    const result = await options.authenticate(request)
    if (result === false) return undefined
    return result === true ? {} : result
  }
  const expected = options.bearerToken?.trim()
  if (!expected) return {}
  return readAppServerBearerCredential(request) === expected ? {} : undefined
}

/**
 * Resolve the credential from the two WebSocket-compatible Bearer channels.
 * Browser WebSocket cannot set Authorization, so it sends the credential as a
 * base64url-encoded `ag2cli-bearer.*` subprotocol.
 */
export function readAppServerBearerCredential(request: Request): string | undefined {
  const authorization = request.headers.get("authorization")?.trim()
  const match = authorization === undefined ? undefined : /^Bearer\s+(\S+)$/iu.exec(authorization)
  if (match?.[1] !== undefined) return match[1]
  return decodeBearerTokenProtocol(request.headers.get("sec-websocket-protocol"))
}

/** Compose server-token and revocable device-token authentication for `serve`. */
export function createAppServerWebSocketAuthenticator(
  options: AppServerWebSocketAuthenticatorOptions,
): (request: Request) => Promise<AppServerWebSocketAuthentication> {
  const serverToken = options.serverToken?.trim()
  const serverScopes = options.serverScopes ?? APP_SERVER_SCOPES
  return async (request) => {
    const credential = readAppServerBearerCredential(request)
    if (credential === undefined) return options.allowAnonymous === true
    if (serverToken !== undefined && credential === serverToken) return { grantedScopes: serverScopes }
    const principal = await options.deviceRegistry?.authenticate(credential)
    if (principal === undefined) return false
    return {
      deviceId: principal.deviceId,
      grantedScopes: principal.scopes,
      ...(principal.publicKey === undefined ? {} : { devicePublicKey: principal.publicKey }),
    }
  }
}

function decodeBearerTokenProtocol(value: string | null): string | undefined {
  if (value === null) return undefined
  const prefix = "ag2cli-bearer."
  for (const candidate of value.split(",").map((item) => item.trim())) {
    if (!candidate.startsWith(prefix)) continue
    const encoded = candidate.slice(prefix.length)
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (encoded.length % 4)) % 4)
    return Buffer.from(padded, "base64").toString("utf8")
  }
  return undefined
}
