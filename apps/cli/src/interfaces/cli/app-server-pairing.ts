import { randomUUID } from "node:crypto"
import { APP_SERVER_PROTOCOL_VERSION, type AppServerScope } from "@ag2cli/app-server-protocol/types.js"
import { createAppServerConnectionLink } from "@ag2cli/app-server-client/connection-link.js"
import { AppServerPairingClient, appServerHttpBaseUrl } from "@ag2cli/app-server-client/pairing.js"
import { connectWebSocketAppServer } from "@ag2cli/app-server-client/websocket.js"
import type { PairingClientKind } from "./agent-cli.js"
import { createBunWebSocket } from "../transport/bun-websocket.js"

const PAIRING_SCOPES: readonly AppServerScope[] = ["session:read", "session:write", "approval:write", "shell:execute"]

export interface CreateAppServerConnectionLinkOptions {
  readonly endpoint: string
  readonly bearerToken?: string
  readonly clientKind?: PairingClientKind
  readonly ttlMs?: number
  readonly clientId?: string
  readonly signal?: AbortSignal
}

export interface AppServerConnectionLinkCommandResult {
  readonly link: string
  readonly serverFingerprint: string
  readonly expiresAt: string
  readonly clientKind?: PairingClientKind
}

/**
 * Create a short-lived link for an already running service Host.
 *
 * This command is deliberately a client-side orchestration boundary: it uses
 * the operator's server token to start pairing, but never builds a local Host
 * or touches a Session store.
 */
export async function createAppServerConnectionLinkForEndpoint(
  options: CreateAppServerConnectionLinkOptions,
): Promise<AppServerConnectionLinkCommandResult> {
  const endpoint = normalizeEndpoint(options.endpoint)
  const bearerToken = options.bearerToken?.trim()
  if (!bearerToken) throw new Error("authentication required: agent pair requires AG2CLI_SERVER_TOKEN")

  const rpc = await connectWebSocketAppServer(endpoint, {
    requestTimeoutMs: 30_000,
    createWebSocket: (url) => createBunWebSocket(url, bearerToken),
  })
  try {
    const initialized = await rpc.initialize(
      {
        appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
        client: {
          clientId: options.clientId ?? `ag2cli-pair-${randomUUID()}`,
          clientKind: "script",
          name: "ag2cli-pair",
          version: "dev",
          capabilities: ["device.pairing"],
        },
        requestedScopes: ["device:admin"],
      },
      { signal: options.signal },
    )
    if (!initialized.connection.scopes.includes("device:admin")) {
      throw new Error("authentication required: agent pair requires the device:admin scope")
    }

    const pairing = new AppServerPairingClient(appServerHttpBaseUrl(endpoint), {
      bearerToken,
    })
    const challenge = await pairing.start(
      {
        scopes: PAIRING_SCOPES,
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      },
      { signal: options.signal },
    )
    const link = createAppServerConnectionLink({
      endpoint,
      serverFingerprint: initialized.server.fingerprint,
      pairingToken: challenge.pairingToken,
      expiresAt: challenge.expiresAt,
      ...(options.clientKind === undefined ? {} : { clientKind: options.clientKind }),
    })
    return {
      link,
      serverFingerprint: initialized.server.fingerprint,
      expiresAt: challenge.expiresAt,
      ...(options.clientKind === undefined ? {} : { clientKind: options.clientKind }),
    }
  } finally {
    rpc.close()
  }
}

function normalizeEndpoint(value: string): string {
  let endpoint: URL
  try {
    endpoint = new URL(value.trim())
  } catch {
    throw new Error("App Server endpoint is not a valid URL")
  }
  if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
    throw new Error("App Server endpoint must use ws:// or wss://")
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.hash.length > 0) {
    throw new Error("App Server endpoint must not include credentials or a fragment")
  }
  return endpoint.toString()
}
