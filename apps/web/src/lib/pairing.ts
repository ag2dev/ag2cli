import {
  normalizeAppServerEndpoint,
  parseAppServerConnectionLink,
  type AppServerConnectionLink,
} from "@ag2cli/app-server-client/connection-link.js"
import { generateAppServerDeviceKeyPair, type AppServerDeviceKeyPair } from "@ag2cli/app-server-client/device-proof.js"
import { AppServerPairingClient } from "@ag2cli/app-server-client/pairing.js"
import { VerifiedAppServerConnection } from "@ag2cli/app-server-client/verified-connection.js"
import { connectWebSocketAppServerTransport, type WebSocketLike } from "@ag2cli/app-server-client/websocket.js"
import { APP_SERVER_PROTOCOL_VERSION, type AppServerScope } from "@ag2cli/app-server-protocol/types.js"

const BROWSER_PAIRING_TTL_MS = 5 * 60_000

/** The least privilege needed by the current browser composer. */
export const BROWSER_PAIRING_SCOPES: readonly AppServerScope[] = [
  "session:read",
  "session:write",
  "approval:write",
  "shell:execute",
  "session:policy",
  "workspace:read",
]

export interface BrowserPairingOptions {
  /** Required for operator pairing; compare this with the Host ID shown by `agent serve`. */
  readonly expectedHostId?: string
  readonly generateKeyPair?: () => Promise<AppServerDeviceKeyPair>
  readonly createWebSocket?: (url: string) => WebSocketLike
  readonly signal?: AbortSignal
}

export interface BrowserDeviceIdentity {
  readonly credential: string
  readonly deviceId: string
  readonly hostId: string
  readonly publicKey: string
  readonly privateKey: CryptoKey
}

/** Keep browser credentials scoped to the exact configured WebSocket endpoint. */
export function browserDeviceStorageKey(endpoint: string): string {
  return `ag2cli.web.device-credential:${normalizeAppServerEndpoint(endpoint)}`
}

/** Create a device ticket through an authenticated, Host-verified admin connection, then claim it on a fresh verified socket. */
export async function pairBrowserDevice(
  endpoint: string,
  clientId: string,
  bearerToken: string,
  options: BrowserPairingOptions = {},
): Promise<BrowserDeviceIdentity> {
  const token = bearerToken.trim()
  if (token.length === 0) throw new Error("Browser pairing requires an App Server bearer token")
  const expectedHostId = options.expectedHostId?.trim()
  if (!expectedHostId) throw new Error("Browser pairing requires the expected App Server Host ID")
  const keyPair = await (options.generateKeyPair ?? (() => generateAppServerDeviceKeyPair()))()
  const transport = await connectWebSocketAppServerTransport(endpoint, {
    ...(options.createWebSocket === undefined ? {} : { createWebSocket: options.createWebSocket }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const admin = await VerifiedAppServerConnection.open(transport, {
    purpose: "admin-pairing",
    expectedHostId,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  let pairingToken: string
  let expiresAt: string
  try {
    await admin.initialize(
      {
        appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
        hostId: admin.hostId,
        client: { clientId: `${clientId}-pair`, clientKind: "web", name: "ag2cli-web-pairing", version: "dev" },
        auth: { type: "operator", bearerToken: token },
        requestedScopes: ["device:admin"],
      },
      { signal: options.signal },
    )
    const created = await new AppServerPairingClient(admin).create({ scopes: BROWSER_PAIRING_SCOPES, ttlMs: BROWSER_PAIRING_TTL_MS })
    pairingToken = created.pairingToken
    expiresAt = created.expiresAt
  } finally {
    admin.close()
  }
  return claimBrowserDevice(endpoint, admin.hostId, clientId, keyPair, pairingToken, expiresAt, options)
}

/** Verify the Host proof before consuming a ticket from a pasted or scanned connection link. */
export async function pairBrowserDeviceFromLink(
  value: string,
  clientId: string,
  options: BrowserPairingOptions = {},
): Promise<{ readonly identity: BrowserDeviceIdentity; readonly link: AppServerConnectionLink }> {
  const link = parseAppServerConnectionLink(value)
  if (Date.parse(link.expiresAt) <= Date.now()) throw new Error("Connection link has expired")
  if (link.clientKind !== undefined && link.clientKind !== "web") {
    throw new Error(`Connection link is restricted to ${link.clientKind} clients`)
  }
  const keyPair = await (options.generateKeyPair ?? (() => generateAppServerDeviceKeyPair()))()
  const identity = await claimBrowserDevice(link.endpoint, link.hostId, clientId, keyPair, link.pairingToken, link.expiresAt, options)
  return { identity, link }
}

async function claimBrowserDevice(
  endpoint: string,
  hostId: string,
  clientId: string,
  keyPair: AppServerDeviceKeyPair,
  pairingToken: string,
  expiresAt: string,
  options: BrowserPairingOptions,
): Promise<BrowserDeviceIdentity> {
  if (Date.parse(expiresAt) <= Date.now()) throw new Error("Connection link has expired")
  const transport = await connectWebSocketAppServerTransport(endpoint, {
    ...(options.createWebSocket === undefined ? {} : { createWebSocket: options.createWebSocket }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const connection = await VerifiedAppServerConnection.open(transport, {
    purpose: "pairing-link",
    expectedHostId: hostId,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  try {
    const registration = await new AppServerPairingClient(connection).claim({
      pairingToken,
      name: `ag2cli-web-${clientId.slice(0, 8)}`,
      clientKind: "web",
      publicKey: keyPair.publicKey,
    })
    if (registration.device.publicKey !== keyPair.publicKey) {
      throw new Error("App Server returned a different device public key")
    }
    return {
      credential: registration.credential,
      deviceId: registration.device.deviceId,
      hostId,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    }
  } finally {
    connection.close()
  }
}
