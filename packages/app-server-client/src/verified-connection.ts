import { APP_SERVER_DEVICE_CHALLENGE_PREFIX, encodeBase64Url } from "@ag2cli/app-server-protocol/device-proof.js"
import {
  createAppServerHostProofMessage,
  decodeAppServerHostProofSignature,
  decodeAppServerHostPublicKey,
  deriveAppServerHostId,
} from "@ag2cli/app-server-protocol/host-proof.js"
import type {
  AppServerHostProofPurpose,
  AppServerPairClaimParams,
  AppServerPairClaimResult,
  AppServerPairCreateParams,
  AppServerPairCreateResult,
  AppServerPairPreviewResult,
  JsonValue,
  ServerInitializeParams,
  ServerInitializeResult,
  ServerPreflightResult,
} from "@ag2cli/app-server-protocol/types.js"
import {
  assertJsonValue,
  parseAppServerPairClaimResult,
  parseAppServerPairCreateResult,
  parseAppServerPairPreviewResult,
  parseServerInitializeResult,
  parseServerPreflightResult,
} from "@ag2cli/app-server-protocol/validation.js"
import {
  JsonRpcAppServerClient,
  type AppServerCloseListener,
  type AppServerNotificationListener,
  type AppServerTransport,
} from "./client.js"
import {
  callProtocol,
  type ProtocolCallOptions,
  type ProtocolMethod,
  type ProtocolMethodParams,
  type ProtocolMethodResults,
} from "./protocol-methods.js"

export interface VerifiedAppServerConnectionOptions {
  readonly purpose: AppServerHostProofPurpose
  readonly expectedHostId?: string
  readonly crypto?: Crypto
  readonly now?: () => number
  readonly signal?: AbortSignal
  readonly requestTimeoutMs?: number
}

/**
 * A connection whose first RPC was a verified `server.preflight`.
 * The constructor is private so pairing and initialize workflows cannot accept
 * a raw, unverified JSON-RPC client by accident.
 */
export class VerifiedAppServerConnection {
  readonly hostId: string
  readonly purpose: AppServerHostProofPurpose
  readonly preflight: ServerPreflightResult
  private state: "preflight" | "initialized" | "closed" = "preflight"
  private operatorPairCreated = false
  private pairClaimAttempted = false

  private constructor(
    private readonly client: JsonRpcAppServerClient,
    preflight: ServerPreflightResult,
  ) {
    this.preflight = preflight
    this.hostId = preflight.hostId
    this.purpose = preflight.purpose
  }

  static async open(transport: AppServerTransport, options: VerifiedAppServerConnectionOptions): Promise<VerifiedAppServerConnection> {
    const client = new JsonRpcAppServerClient(transport, {
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    })
    const cryptoApi = options.crypto ?? globalThis.crypto
    try {
      if (cryptoApi?.subtle === undefined || cryptoApi.getRandomValues === undefined) {
        throw new Error("Web Crypto is unavailable for App Server Host verification")
      }
      const nonce = `${APP_SERVER_DEVICE_CHALLENGE_PREFIX}${encodeBase64Url(cryptoApi.getRandomValues(new Uint8Array(32)))}`
      const preflight = parseServerPreflightResult(
        await client.request("server.preflight", assertJsonValue({ nonce, purpose: options.purpose }, "server.preflight.params"), {
          signal: options.signal,
        }),
      )
      await verifyPreflight(preflight, {
        nonce,
        purpose: options.purpose,
        expectedHostId: options.expectedHostId,
        crypto: cryptoApi,
        now: options.now?.() ?? Date.now(),
      })
      return new VerifiedAppServerConnection(client, preflight)
    } catch (error) {
      client.close(1008, "Host verification failed")
      throw error
    }
  }

  async initialize(params: ServerInitializeParams, options: { readonly signal?: AbortSignal } = {}): Promise<ServerInitializeResult> {
    this.assertOpen()
    if (this.state !== "preflight") throw new Error("App Server connection is already initialized")
    if (this.purpose === "pairing-link") throw new Error("Pairing-link connections cannot initialize")
    if (params.hostId !== this.hostId) throw new Error("server.initialize Host ID does not match the verified Host")
    if (this.purpose === "device-connect" && params.auth.type !== "device") {
      throw new Error("device-connect requires device authentication")
    }
    if (this.purpose === "admin-pairing" && params.auth.type !== "operator") {
      throw new Error("admin-pairing requires operator authentication")
    }
    if (this.purpose === "admin-pairing" && (params.requestedScopes?.length !== 1 || params.requestedScopes[0] !== "device:admin")) {
      throw new Error("admin-pairing may request only device:admin")
    }
    let result: ServerInitializeResult
    try {
      result = parseServerInitializeResult(
        await this.client.request("server.initialize", assertJsonValue(params, "server.initialize.params"), options),
      )
    } catch (error) {
      this.close(1008, "Initialize failed")
      throw error
    }
    if (result.server.hostId !== this.hostId) {
      this.close(1008, "Initialize Host mismatch")
      throw new Error("server.initialize descriptor Host ID does not match the verified Host")
    }
    this.state = "initialized"
    return result
  }

  async createPairing(params: AppServerPairCreateParams): Promise<AppServerPairCreateResult> {
    this.assertOpen()
    if (this.state !== "initialized" || this.purpose !== "admin-pairing") {
      throw new Error("pair.create requires an initialized admin-pairing connection")
    }
    if (this.operatorPairCreated) throw new Error("admin-pairing connection can create only one ticket")
    this.operatorPairCreated = true
    try {
      const result = parseAppServerPairCreateResult(await this.client.request("pair.create", assertJsonValue(params, "pair.create.params")))
      this.assertResponseHost(result.hostId)
      return result
    } finally {
      this.close(1000, "Pairing ticket created")
    }
  }

  async previewPairing(pairingToken: string): Promise<AppServerPairPreviewResult> {
    this.assertOpen()
    if (this.state !== "preflight" || this.purpose !== "pairing-link") {
      throw new Error("pair.preview requires a verified pairing-link connection")
    }
    const result = parseAppServerPairPreviewResult(await this.client.request("pair.preview", { pairingToken }))
    this.assertResponseHost(result.hostId)
    return result
  }

  async claimPairing(params: AppServerPairClaimParams): Promise<AppServerPairClaimResult> {
    this.assertOpen()
    if (this.state !== "preflight" || this.purpose !== "pairing-link") {
      throw new Error("pair.claim requires a verified pairing-link connection")
    }
    if (this.pairClaimAttempted) throw new Error("pair.claim cannot be retried on the same connection")
    this.pairClaimAttempted = true
    return parseAppServerPairClaimResult(await this.client.request("pair.claim", assertJsonValue(params, "pair.claim.params")))
  }

  request(method: string, params?: JsonValue, options?: { readonly signal?: AbortSignal }): Promise<JsonValue> {
    this.assertOpen()
    if (this.state !== "initialized") throw new Error("App Server connection must be initialized before requests")
    if (this.purpose === "admin-pairing") throw new Error("admin-pairing connections may only create one pairing ticket")
    if (method === "server.preflight" || method === "server.initialize" || method.startsWith("pair.")) {
      throw new Error(`Use the verified App Server workflow for ${method}`)
    }
    return this.client.request(method, params, options)
  }

  /** Typed, registry-validated call surface; verified-connection request guards still apply. */
  callProtocol<M extends ProtocolMethod>(
    method: M,
    params: ProtocolMethodParams[M],
    options?: ProtocolCallOptions,
  ): Promise<ProtocolMethodResults[M]> {
    return callProtocol(this, method, params, options)
  }

  onNotification(listener: AppServerNotificationListener): () => void {
    this.assertOpen()
    return this.client.onNotification(listener)
  }

  onClose(listener: AppServerCloseListener): () => void {
    return this.client.onClose(listener)
  }

  notify(method: string, params?: JsonValue): void {
    this.assertOpen()
    if (this.state !== "initialized") throw new Error("App Server connection must be initialized before notifications")
    if (this.purpose === "admin-pairing") throw new Error("admin-pairing connections do not support notifications")
    this.client.notify(method, params)
  }

  close(code?: number, reason?: string): void {
    if (this.state === "closed") return
    this.state = "closed"
    this.client.close(code, reason)
  }

  private assertOpen(): void {
    if (this.state === "closed") throw new Error("Verified App Server connection is closed")
  }

  private assertResponseHost(hostId: string): void {
    if (hostId !== this.hostId) {
      this.close(1008, "Pairing Host mismatch")
      throw new Error("Pairing response Host ID does not match the verified Host")
    }
  }
}

interface VerifyPreflightOptions {
  readonly nonce: string
  readonly purpose: AppServerHostProofPurpose
  readonly expectedHostId?: string
  readonly crypto: Crypto
  readonly now: number
}

async function verifyPreflight(result: ServerPreflightResult, options: VerifyPreflightOptions): Promise<void> {
  if (result.nonce !== options.nonce) throw new Error("Host proof nonce does not match the request")
  if (result.purpose !== options.purpose) throw new Error("Host proof purpose does not match the request")
  if (options.expectedHostId !== undefined && result.hostId !== options.expectedHostId) {
    throw new Error("Host ID does not match the expected Host")
  }
  if (result.expiresAt <= options.now || result.expiresAt > options.now + 60_000) {
    throw new Error("Host proof is expired or exceeds the permitted lifetime")
  }
  if (
    result.purpose === "device-connect" &&
    (result.deviceChallengeExpiresAt <= options.now || result.deviceChallengeExpiresAt > options.now + 60_000)
  ) {
    throw new Error("Device challenge is expired or exceeds the permitted lifetime")
  }

  const publicKeyBytes = decodeAppServerHostPublicKey(result.hostPublicKey)
  const signatureBytes = decodeAppServerHostProofSignature(result.signature)
  if (publicKeyBytes === undefined || signatureBytes === undefined) throw new Error("Host proof has invalid key material")
  if ((await deriveAppServerHostId(publicKeyBytes)) !== result.hostId)
    throw new Error("Host public key does not derive the advertised Host ID")

  const publicKey = await options.crypto.subtle.importKey(
    "spki",
    toArrayBuffer(publicKeyBytes),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  )
  const canonicalPublicKey = new Uint8Array(await options.crypto.subtle.exportKey("spki", publicKey))
  if (!equalBytes(canonicalPublicKey, publicKeyBytes)) throw new Error("Host public key is not canonical SPKI DER")

  const verified = await options.crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    toArrayBuffer(signatureBytes),
    toArrayBuffer(
      createAppServerHostProofMessage({
        purpose: result.purpose,
        hostId: result.hostId,
        nonce: result.nonce,
        expiresAt: result.expiresAt,
      }),
    ),
  )
  if (!verified) throw new Error("Host proof signature is invalid")
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false
  return true
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer as ArrayBuffer
}
