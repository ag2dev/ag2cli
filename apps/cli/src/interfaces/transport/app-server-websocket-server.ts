import { randomUUID, timingSafeEqual } from "node:crypto"
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_PARSE_ERROR,
  createFailure,
  createSuccess,
  encodeMessage,
  parseEncodedMessage,
  isRequest,
} from "@ag2cli/app-server-protocol/json-rpc.js"
import {
  APP_SERVER_PROTOCOL_VERSION,
  type AppServerDeviceRegistry,
  type AppServerHostIdentitySigner,
  type AppServerPairingRegistry,
  type AppServerScope,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ServerPreflightResult,
} from "@ag2cli/app-server-protocol/types.js"
import {
  AppServerProtocolError,
  assertJsonValue,
  parsePairClaimParams,
  parsePairCreateParams,
  parsePairPreviewParams,
  parseServerInitializeParams,
  parseServerPreflightParams,
} from "@ag2cli/app-server-protocol/validation.js"
import { createAppServerHostProofMessage, encodeAppServerHostProofSignature } from "@ag2cli/app-server-protocol/host-proof.js"
import type { AppServerDeviceChallengeIssuer, AppServerDeviceProofVerifier } from "./app-server-device-proof.js"
import type { AppServerRpcConnection } from "./app-server-rpc.js"

const DEFAULT_MAX_PENDING_CONNECTIONS = 256
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 15_000
const HOST_PROOF_TTL_MS = 60_000

export interface AppServerWebSocketIdentity {
  readonly deviceId?: string
  readonly devicePublicKey?: string
  readonly grantedScopes: readonly AppServerScope[]
  readonly operator?: true
}

export interface AppServerWebSocketConnection {
  readonly rpc: Pick<AppServerRpcConnection, "handle">
  close(): void
}

export interface AppServerWebSocketServerOptions {
  readonly createConnection: (
    onNotification: (notification: JsonRpcNotification) => void,
    identity: AppServerWebSocketIdentity,
  ) => AppServerWebSocketConnection
  readonly hostIdentity: AppServerHostIdentitySigner
  readonly deviceRegistry: AppServerDeviceRegistry
  readonly pairingRegistry: AppServerPairingRegistry
  readonly deviceProof: AppServerDeviceChallengeIssuer & AppServerDeviceProofVerifier
  readonly operatorToken?: string
  /** Browser origins are exact; native clients may omit Origin. */
  readonly corsOrigins?: readonly string[]
  readonly hostname: string
  readonly port: number
  readonly path?: string
  readonly healthPath?: string
  readonly maxPendingConnections?: number
  readonly maxMessageBytes?: number
  readonly tls?: Bun.TLSOptions
}

interface AppServerWebSocketData {
  readonly connection: AppServerWebSocketProtocolConnection
  socket?: Bun.ServerWebSocket<AppServerWebSocketData>
  handshakeTimer?: ReturnType<typeof setTimeout>
}

export interface AppServerWebSocketNetwork {
  readonly port: number
  stop(closeActiveConnections?: boolean): Promise<void>
}

const STOP_TIMEOUT_MS = 500

/** Bun adapter for the public App Server boundary and its one-socket auth state machine. */
export function createAppServerWebSocketServer(options: AppServerWebSocketServerOptions): AppServerWebSocketNetwork {
  validateListenerOptions(options)
  const path = options.path ?? "/app-server"
  const healthPath = options.healthPath ?? "/health"
  const maxPendingConnections = options.maxPendingConnections ?? DEFAULT_MAX_PENDING_CONNECTIONS
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
  if (!Number.isSafeInteger(maxPendingConnections) || maxPendingConnections < 1) {
    throw new Error("maxPendingConnections must be a positive integer")
  }
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
    throw new Error("maxMessageBytes must be a positive integer")
  }
  let pendingConnections = 0
  const sockets = new Set<Bun.ServerWebSocket<AppServerWebSocketData>>()

  const fetchHandler = (request: Request, server: Bun.Server<AppServerWebSocketData>): Response | undefined => {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === healthPath) {
      return Response.json({ ok: true, status: "ready", protocolVersion: APP_SERVER_PROTOCOL_VERSION })
    }
    if (url.pathname !== path) return new Response("Not found", { status: 404 })
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
    if (!isAllowedOrigin(request.headers.get("origin"), options.corsOrigins ?? [])) {
      return new Response("Origin is not allowed", { status: 403 })
    }
    if (pendingConnections >= maxPendingConnections) return new Response("Too many pending connections", { status: 503 })
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426, headers: { Upgrade: "websocket" } })
    }

    pendingConnections++
    let pendingCounted = true
    const releasePending = (): void => {
      if (!pendingCounted) return
      pendingCounted = false
      pendingConnections--
    }
    const data = {
      connection: new AppServerWebSocketProtocolConnection(options, (notification) => sendNotification(data, notification), releasePending),
    } satisfies AppServerWebSocketData
    if (!server.upgrade(request, { data })) {
      data.connection.close()
      return new Response("WebSocket upgrade failed", { status: 400 })
    }
    return undefined
  }

  const websocket: Bun.WebSocketHandler<AppServerWebSocketData> = {
    data: {} as AppServerWebSocketData,
    open(socket) {
      sockets.add(socket)
      socket.data.socket = socket
      socket.data.handshakeTimer = setTimeout(() => socket.close(1008, "Handshake timed out"), HANDSHAKE_TIMEOUT_MS)
    },
    async message(socket, value) {
      const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8")
      if (Buffer.byteLength(text) > maxMessageBytes) {
        socket.send(
          encodeMessage(
            createFailure(null, JSON_RPC_INVALID_PARAMS, "JSON-RPC message exceeds the size limit", { code: "message_too_large" }),
          ),
        )
        socket.close(1009, "message too large")
        return
      }
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
      if (!isRequest(message)) {
        socket.close(1002, "only JSON-RPC requests are accepted")
        return
      }
      const response = await socket.data.connection.handle(message)
      if (response !== undefined) socket.send(encodeMessage(response))
      if (socket.data.connection.initialized || socket.data.connection.closed) {
        clearTimeout(socket.data.handshakeTimer)
        socket.data.handshakeTimer = undefined
      }
      if (socket.data.connection.closeAfterResponse) socket.close(1008, "connection protocol complete")
    },
    close(socket) {
      sockets.delete(socket)
      clearTimeout(socket.data.handshakeTimer)
      socket.data.connection.close()
    },
  }
  const server = Bun.serve<AppServerWebSocketData>({
    hostname: options.hostname,
    port: options.port,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    fetch: fetchHandler,
    websocket,
  })
  const port = server.port
  if (port === undefined) throw new Error("App Server TCP listener did not return a port")
  return {
    port,
    stop: async (closeActiveConnections = true) => {
      if (closeActiveConnections) {
        for (const socket of sockets) socket.close(1001, "App Server is shutting down")
        sockets.clear()
      }
      // Bun's stop() promise never resolves once a WebSocket was closed
      // server-side, even though the listener itself does stop; bound the wait
      // so shutdown always proceeds.
      await Promise.race([server.stop(closeActiveConnections), new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))])
    },
  }
}

export class AppServerWebSocketProtocolConnection {
  private phase: "first-request" | "preflight" | "initialized" | "closed" = "first-request"
  private purpose?: ServerPreflightResult["purpose"]
  private connectionId?: string
  private pairClaimAttempted = false
  private pairCreateAttempted = false
  private identity?: AppServerWebSocketIdentity
  private sessionConnection?: AppServerWebSocketConnection
  private readonly now: () => number
  closeAfterResponse = false

  constructor(
    private readonly options: AppServerWebSocketServerOptions,
    private readonly onNotification: (notification: JsonRpcNotification) => void,
    private readonly onClose: () => void,
    now: () => number = Date.now,
  ) {
    this.now = now
  }

  get initialized(): boolean {
    return this.phase === "initialized"
  }

  get closed(): boolean {
    return this.phase === "closed"
  }

  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    if (this.phase === "closed") return undefined
    try {
      if (this.phase === "first-request") {
        if (request.method !== "server.preflight")
          throw new HandshakeError("preflight_required", "server.preflight must be the first request")
        return this.handlePreflight(request)
      }
      if (this.phase === "preflight") {
        if (this.purpose === "pairing-link") return await this.handlePairingLinkRequest(request)
        if (request.method !== "server.initialize") {
          throw new HandshakeError("initialize_required", "server.initialize must follow Host preflight")
        }
        return await this.handleInitialize(request)
      }
      if (this.purpose === "admin-pairing") {
        if (request.method !== "pair.create")
          throw new HandshakeError("method_not_allowed", "admin-pairing connections may only call pair.create")
        return await this.handlePairCreate(request)
      }
      if (request.method === "pair.create") return await this.handlePairCreate(request)
      if (request.method === "server.preflight" || request.method === "server.initialize" || request.method.startsWith("pair.")) {
        throw new HandshakeError("method_not_allowed", `Method is not allowed after initialization: ${request.method}`)
      }
      return await this.sessionConnection?.rpc.handle(request)
    } catch (error) {
      const failure = failureFor(request, error)
      if (error instanceof HandshakeError && error.close) this.closeAfterResponse = true
      if (this.phase === "first-request") this.closeAfterResponse = true
      return failure
    }
  }

  close(): void {
    if (this.phase === "closed") return
    this.phase = "closed"
    this.sessionConnection?.close()
    this.sessionConnection = undefined
    this.onClose()
  }

  private handlePreflight(request: JsonRpcRequest): JsonRpcResponse {
    const params = parseServerPreflightParams(request.params)
    const now = this.now()
    const expiresAt = now + HOST_PROOF_TTL_MS
    const base = {
      hostId: this.options.hostIdentity.hostId,
      hostPublicKey: this.options.hostIdentity.hostPublicKey,
      nonce: params.nonce,
      expiresAt,
      signature: encodeAppServerHostProofSignature(
        this.options.hostIdentity.sign(
          createAppServerHostProofMessage({
            purpose: params.purpose,
            hostId: this.options.hostIdentity.hostId,
            nonce: params.nonce,
            expiresAt,
          }),
        ),
      ),
    }
    this.connectionId = `connection-${randomUUID()}`
    let result: ServerPreflightResult
    if (params.purpose === "device-connect") {
      const challenge = this.options.deviceProof.issue(this.connectionId, this.options.hostIdentity.hostId)
      result = {
        ...base,
        purpose: "device-connect",
        deviceChallenge: challenge.challenge,
        deviceChallengeExpiresAt: challenge.expiresAt,
      }
    } else {
      result = { ...base, purpose: params.purpose }
    }
    this.purpose = params.purpose
    this.phase = "preflight"
    return createSuccess(request.id, assertJsonValue(result, "server.preflight.result"))
  }

  private async handleInitialize(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = parseServerInitializeParams(request.params)
    if (params.hostId !== this.options.hostIdentity.hostId) {
      throw new HandshakeError("host_identity_mismatch", "server.initialize Host ID does not match this connection")
    }
    let identity: AppServerWebSocketIdentity
    if (params.auth.type === "device") {
      if (this.purpose !== "device-connect")
        throw new HandshakeError("authentication_required", "Device auth requires device-connect preflight")
      const principal = await this.options.deviceRegistry.authenticate(params.auth.device.credential)
      if (principal === undefined) throw new HandshakeError("authentication_required", "Device credential is invalid or revoked")
      if (principal.deviceId !== params.auth.device.deviceId) {
        throw new HandshakeError("device_auth_mismatch", "Device ID does not match its credential")
      }
      if (principal.publicKey === undefined) throw new HandshakeError("device_proof_required", "This device has no registered proof key")
      const verified = await this.options.deviceProof.verify({
        connectionId: this.connectionId!,
        hostId: this.options.hostIdentity.hostId,
        deviceId: principal.deviceId,
        publicKey: principal.publicKey,
        clientId: params.client.clientId,
        proof: params.auth.device,
      })
      if (!verified) throw new HandshakeError("device_proof_invalid", "Device challenge proof is invalid or expired")
      identity = { deviceId: principal.deviceId, devicePublicKey: principal.publicKey, grantedScopes: principal.scopes }
    } else {
      if (this.purpose !== "admin-pairing")
        throw new HandshakeError("authentication_required", "Operator auth requires admin-pairing preflight")
      if (!matchesToken(params.auth.bearerToken, this.options.operatorToken)) {
        throw new HandshakeError("authentication_required", "Operator credential is invalid")
      }
      if (params.requestedScopes?.length !== 1 || params.requestedScopes[0] !== "device:admin") {
        throw new HandshakeError("scope_denied", "Operator initialization must request only device:admin")
      }
      identity = { grantedScopes: ["device:admin"], operator: true }
    }

    this.identity = identity
    const connection = this.options.createConnection(this.onNotification, identity)
    this.sessionConnection = connection
    const response = await connection.rpc.handle(request)
    if (response === undefined || "error" in response) {
      this.closeAfterResponse = true
      connection.close()
      this.sessionConnection = undefined
      return response ?? createFailure(request.id, -32603, "Initialize did not return a response", { code: "internal_error" })
    }
    this.phase = "initialized"
    this.onClose()
    return response
  }

  private async handlePairingLinkRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (request.method === "pair.preview") {
      const params = parsePairPreviewParams(request.params)
      const result = await this.options.pairingRegistry.preview(params.pairingToken)
      if (result === undefined) throw new HandshakeError("pairing_expired", "Pairing ticket is invalid, expired, or already consumed")
      this.closeAfterResponse = true
      return createSuccess(request.id, assertJsonValue(result, "pair.preview.result"))
    }
    if (request.method === "pair.claim") {
      if (this.pairClaimAttempted) throw new HandshakeError("pairing_expired", "Pairing claim has already been attempted")
      this.pairClaimAttempted = true
      const params = parsePairClaimParams(request.params)
      const result = await this.options.pairingRegistry.claim(params)
      this.closeAfterResponse = true
      if (result === undefined) throw new HandshakeError("pairing_expired", "Pairing ticket is invalid, expired, or already consumed")
      return createSuccess(request.id, assertJsonValue(result, "pair.claim.result"))
    }
    throw new HandshakeError("method_not_allowed", "Pairing-link connections may only call pair.preview or pair.claim")
  }

  private async handlePairCreate(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.identity?.grantedScopes.includes("device:admin")) {
      throw new HandshakeError("scope_denied", "pair.create requires device:admin")
    }
    if (this.identity.operator && this.pairCreateAttempted) {
      throw new HandshakeError("pairing_authorization_required", "Only one pairing ticket may be created per operator connection")
    }
    this.pairCreateAttempted = true
    try {
      const params = parsePairCreateParams(request.params)
      if (!this.identity.operator) {
        const denied = params.scopes.filter((scope) => !this.identity!.grantedScopes.includes(scope))
        if (denied.length > 0) throw new HandshakeError("scope_denied", `Pairing scopes are not authorized: ${denied.join(", ")}`)
      }
      const result = await this.options.pairingRegistry.create(params)
      if (result.hostId !== this.options.hostIdentity.hostId) {
        throw new HandshakeError("host_identity_mismatch", "Pairing ticket Host ID does not match this server")
      }
      return createSuccess(request.id, assertJsonValue(result, "pair.create.result"))
    } finally {
      if (this.identity.operator) this.closeAfterResponse = true
    }
  }
}

class HandshakeError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly close = true,
  ) {
    super(message)
  }
}

function failureFor(request: JsonRpcRequest, error: unknown): JsonRpcResponse {
  if (error instanceof AppServerProtocolError) {
    return createFailure(request.id, JSON_RPC_INVALID_PARAMS, error.message, { code: error.kind })
  }
  if (error instanceof HandshakeError) {
    return createFailure(request.id, -32000, error.message, { code: error.kind })
  }
  return createFailure(request.id, -32603, "App Server handshake failed", { code: "internal_error" })
}

function matchesToken(candidate: string, expected: string | undefined): boolean {
  if (expected === undefined || candidate.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(expected, "utf8"))
}

function isAllowedOrigin(origin: string | null, allowedOrigins: readonly string[]): boolean {
  return origin === null || allowedOrigins.includes(origin)
}

function validateListenerOptions(options: AppServerWebSocketServerOptions): void {
  if (options.hostname.trim().length === 0 || !Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("App Server TCP listener must set a valid hostname and port")
  }
  if (options.hostIdentity.hostId.trim().length === 0 || options.hostIdentity.hostPublicKey.trim().length === 0) {
    throw new Error("App Server Host identity is incomplete")
  }
}

function sendNotification(data: AppServerWebSocketData, notification: JsonRpcNotification): void {
  data.socket?.send(encodeMessage(notification))
}
