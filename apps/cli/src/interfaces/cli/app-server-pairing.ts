import { randomUUID } from "node:crypto"
import { APP_SERVER_PROTOCOL_VERSION, type AppServerScope } from "@ag2cli/app-server-protocol/types.js"
import { createAppServerConnectionLink, normalizeAppServerEndpoint } from "@ag2cli/app-server-client/connection-link.js"
import { AppServerPairingClient } from "@ag2cli/app-server-client/pairing.js"
import { VerifiedAppServerConnection } from "@ag2cli/app-server-client/verified-connection.js"
import { connectWebSocketAppServerTransport } from "@ag2cli/app-server-client/websocket.js"
import type { PairingClientKind } from "./agent-cli.js"
import { createBunWebSocket } from "../transport/bun-websocket.js"

const PAIRING_SCOPES: readonly AppServerScope[] = [
  "session:read",
  "session:write",
  "approval:write",
  "shell:execute",
  "session:policy",
  "workspace:read",
]

/** Pairing cannot proceed because the operator credential or its scope is missing. */
export class PairAuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PairAuthenticationError"
  }
}

export interface CreateAppServerConnectionLinkOptions {
  readonly endpoint: string
  readonly expectedHostId: string
  readonly bearerToken?: string
  readonly clientKind?: PairingClientKind
  readonly ttlMs?: number
  readonly clientId?: string
  readonly signal?: AbortSignal
}

export interface AppServerConnectionLinkCommandResult {
  readonly link: string
  readonly hostId: string
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
  const endpoint = normalizeAppServerEndpoint(options.endpoint)
  const bearerToken = options.bearerToken?.trim()
  if (!bearerToken) throw new PairAuthenticationError("authentication required: agent pair requires AG2CLI_SERVER_TOKEN")

  const transport = await connectWebSocketAppServerTransport(endpoint, {
    createWebSocket: (url) => createBunWebSocket(url),
  })
  const connection = await VerifiedAppServerConnection.open(transport, {
    purpose: "admin-pairing",
    expectedHostId: options.expectedHostId,
  })
  try {
    const initialized = await connection.initialize(
      {
        appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
        hostId: connection.hostId,
        client: {
          clientId: options.clientId ?? `ag2cli-pair-${randomUUID()}`,
          clientKind: "script",
          name: "ag2cli-pair",
          version: "dev",
          capabilities: ["device.pairing"],
        },
        auth: { type: "operator", bearerToken },
        requestedScopes: ["device:admin"],
      },
      { signal: options.signal },
    )
    if (!initialized.connection.scopes.includes("device:admin")) {
      throw new PairAuthenticationError("authentication required: agent pair requires the device:admin scope")
    }

    const pairing = new AppServerPairingClient(connection)
    const ticket = await pairing.create({
      scopes: PAIRING_SCOPES,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    })
    const link = createAppServerConnectionLink({
      endpoint,
      hostId: initialized.server.hostId,
      pairingToken: ticket.pairingToken,
      expiresAt: ticket.expiresAt,
      ...(options.clientKind === undefined ? {} : { clientKind: options.clientKind }),
    })
    return {
      link,
      hostId: initialized.server.hostId,
      expiresAt: ticket.expiresAt,
      ...(options.clientKind === undefined ? {} : { clientKind: options.clientKind }),
    }
  } finally {
    connection.close()
  }
}
