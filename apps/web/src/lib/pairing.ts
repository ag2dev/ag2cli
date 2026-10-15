import { parseAppServerConnectionLink, type AppServerConnectionLink } from "@ag2cli/app-server-client/connection-link.js"
import { generateAppServerDeviceKeyPair, type AppServerDeviceKeyPair } from "@ag2cli/app-server-client/device-proof.js"
import { AppServerPairingClient, appServerHttpBaseUrl, type AppServerFetch } from "@ag2cli/app-server-client/pairing.js"
import type { AppServerDeviceRegistration, AppServerScope } from "@ag2cli/app-server-protocol/types.js"

export { appServerHttpBaseUrl }

const BROWSER_PAIRING_TTL_MS = 5 * 60_000

/** The least privilege needed by the current browser composer. */
export const BROWSER_PAIRING_SCOPES: readonly AppServerScope[] = ["session:read", "session:write", "approval:write", "shell:execute"]

export interface BrowserPairingOptions {
  readonly fetch?: AppServerFetch
  readonly requestTimeoutMs?: number
  readonly generateKeyPair?: () => Promise<AppServerDeviceKeyPair>
}

export interface BrowserDeviceIdentity {
  readonly credential: string
  readonly deviceId: string
  readonly publicKey: string
  readonly privateKey: CryptoKey
  readonly serverFingerprint?: string
}

/** Keep browser device credentials separate when the user switches servers. */
export function browserDeviceStorageKey(endpoint: string): string {
  return `ag2cli.web.device-credential:${new URL(appServerHttpBaseUrl(endpoint)).origin}`
}

/** Complete the browser side of the authorized start -> unauthenticated claim flow. */
export async function pairBrowserDevice(
  endpoint: string,
  clientId: string,
  bearerToken: string,
  options: BrowserPairingOptions = {},
): Promise<BrowserDeviceIdentity> {
  const token = bearerToken.trim()
  if (token.length === 0) throw new Error("Browser pairing requires an App Server bearer token")
  const keyPair = await (options.generateKeyPair ?? (() => generateAppServerDeviceKeyPair()))()
  const client = new AppServerPairingClient(appServerHttpBaseUrl(endpoint), {
    bearerToken: token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  })
  const challenge = await client.start({
    scopes: BROWSER_PAIRING_SCOPES,
    ttlMs: BROWSER_PAIRING_TTL_MS,
  })
  return claimBrowserDevice(client, clientId, keyPair, {
    pairingToken: challenge.pairingToken,
    clientKind: "web",
  })
}

/** Claim a pasted or scanned connection link without requiring the admin token. */
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
  const client = new AppServerPairingClient(appServerHttpBaseUrl(link.endpoint), {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  })
  const identity = await claimBrowserDevice(
    client,
    clientId,
    keyPair,
    {
      pairingToken: link.pairingToken,
      clientKind: "web",
    },
    link.serverFingerprint,
  )
  return { identity, link }
}

async function claimBrowserDevice(
  client: AppServerPairingClient,
  clientId: string,
  keyPair: AppServerDeviceKeyPair,
  input: Pick<Parameters<AppServerPairingClient["claim"]>[0], "pairingToken" | "clientKind">,
  serverFingerprint?: string,
): Promise<BrowserDeviceIdentity> {
  const registration: AppServerDeviceRegistration = await client.claim({
    ...input,
    name: `ag2cli-web-${clientId.slice(0, 8)}`,
    publicKey: keyPair.publicKey,
  })
  if (registration.device.publicKey !== keyPair.publicKey) {
    throw new Error("App Server returned a different device public key")
  }
  return {
    credential: registration.credential,
    deviceId: registration.device.deviceId,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    ...(serverFingerprint === undefined ? {} : { serverFingerprint }),
  }
}
