import type { AppServerClientInfo } from "@ag2cli/app-server-protocol/types.js"

export const APP_SERVER_CONNECTION_LINK_VERSION = 1 as const
export const APP_SERVER_CONNECTION_LINK_SCHEME = "ag2cli:"

export interface AppServerConnectionLink {
  readonly endpoint: string
  readonly serverFingerprint: string
  readonly pairingToken: string
  readonly expiresAt: string
  readonly clientKind?: AppServerClientInfo["clientKind"]
}

export class AppServerConnectionLinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AppServerConnectionLinkError"
  }
}

/** Encode the public, short-lived pairing handoff shared by Web, mobile and TUI. */
export function createAppServerConnectionLink(input: AppServerConnectionLink): string {
  const normalized = normalizeConnectionLink(input)
  const url = new URL("ag2cli://connect/v1")
  url.searchParams.set("endpoint", normalized.endpoint)
  url.searchParams.set("server", normalized.serverFingerprint)
  url.searchParams.set("ticket", normalized.pairingToken)
  url.searchParams.set("expires", normalized.expiresAt)
  if (normalized.clientKind !== undefined) url.searchParams.set("client", normalized.clientKind)
  return url.toString()
}

/** Parse a connection link without contacting the server or consuming its ticket. */
export function parseAppServerConnectionLink(value: string): AppServerConnectionLink {
  const source = value.trim()
  if (source.length === 0) throw new AppServerConnectionLinkError("connection link must not be empty")
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new AppServerConnectionLinkError("connection link must be a valid URL")
  }
  if (url.protocol !== APP_SERVER_CONNECTION_LINK_SCHEME || url.hostname !== "connect" || url.pathname !== "/v1") {
    throw new AppServerConnectionLinkError("connection link must use ag2cli://connect/v1")
  }
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new AppServerConnectionLinkError("connection link must not contain credentials or a fragment")
  }
  const allowedKeys = new Set(["endpoint", "server", "ticket", "expires", "client"])
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) throw new AppServerConnectionLinkError(`connection link contains an unknown field: ${key}`)
  }
  const endpoint = requiredValue(url.searchParams, "endpoint")
  const serverFingerprint = requiredValue(url.searchParams, "server")
  const pairingToken = requiredValue(url.searchParams, "ticket")
  const expiresAt = requiredValue(url.searchParams, "expires")
  const clientKind = optionalValue(url.searchParams, "client")
  return normalizeConnectionLink({
    endpoint,
    serverFingerprint,
    pairingToken,
    expiresAt,
    ...(clientKind === undefined ? {} : { clientKind: parseClientKind(clientKind) }),
  })
}

function normalizeConnectionLink(input: AppServerConnectionLink): AppServerConnectionLink {
  const endpoint = normalizeEndpoint(input.endpoint)
  const serverFingerprint = normalizeSafeToken(input.serverFingerprint, "server fingerprint", 256)
  const pairingToken = normalizeSafeToken(input.pairingToken, "pairing token", 256)
  if (!/^ag2cli-pairing\.[A-Za-z0-9_-]{43}$/u.test(pairingToken)) {
    throw new AppServerConnectionLinkError("connection link has an invalid pairing token format")
  }
  const expiresAt = normalizeExpiry(input.expiresAt)
  const clientKind = input.clientKind === undefined ? undefined : parseClientKind(input.clientKind)
  return {
    endpoint,
    serverFingerprint,
    pairingToken,
    expiresAt,
    ...(clientKind === undefined ? {} : { clientKind }),
  }
}

function normalizeEndpoint(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new AppServerConnectionLinkError("connection link endpoint must not be empty")
  let endpoint: URL
  try {
    endpoint = new URL(value.trim())
  } catch {
    throw new AppServerConnectionLinkError("connection link endpoint must be a valid URL")
  }
  if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
    throw new AppServerConnectionLinkError("connection link endpoint must use ws:// or wss://")
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.hash.length > 0) {
    throw new AppServerConnectionLinkError("connection link endpoint must not contain credentials or a fragment")
  }
  return endpoint.toString()
}

function normalizeSafeToken(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new AppServerConnectionLinkError(`${label} must be a string`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength || /\s/u.test(normalized)) {
    throw new AppServerConnectionLinkError(`${label} has an invalid format`)
  }
  return normalized
}

function normalizeExpiry(value: string): string {
  const normalized = normalizeSafeToken(value, "connection link expiry", 128)
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp)) throw new AppServerConnectionLinkError("connection link expiry must be a valid ISO-8601 timestamp")
  return new Date(timestamp).toISOString()
}

function parseClientKind(value: AppServerClientInfo["clientKind"] | string): AppServerClientInfo["clientKind"] {
  if (
    value !== "tui" &&
    value !== "web" &&
    value !== "mobile" &&
    value !== "desktop" &&
    value !== "acp" &&
    value !== "script" &&
    value !== "unknown"
  ) {
    throw new AppServerConnectionLinkError("connection link has an invalid client kind")
  }
  return value
}

function requiredValue(params: URLSearchParams, key: string): string {
  const values = params.getAll(key)
  if (values.length > 1) throw new AppServerConnectionLinkError(`connection link must not contain duplicate ${key} values`)
  if (values.length !== 1 || values[0] === undefined || values[0].length === 0) {
    throw new AppServerConnectionLinkError(`connection link must contain exactly one ${key}`)
  }
  return values[0]
}

function optionalValue(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key)
  if (values.length > 1) throw new AppServerConnectionLinkError(`connection link must not contain duplicate ${key} values`)
  return values[0]
}
