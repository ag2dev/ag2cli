import {
  APP_SERVER_SCOPES,
  type AppServerClientInfo,
  type AppServerDeviceChallenge,
  type AppServerDeviceRegistration,
  type AppServerPairingClaimInput,
  type AppServerPairingRegistry,
  type AppServerPairingStartInput,
  type AppServerScope,
} from "@ag2cli/app-server-protocol/types.js"
import type { AppServerWebSocketIdentity } from "./app-server-websocket-server.js"
import type { AppServerDeviceChallengeIssuer } from "./app-server-device-proof.js"

const DEFAULT_MAX_BODY_BYTES = 16 * 1024
const MIN_TTL_MS = 30_000
const MAX_TTL_MS = 10 * 60_000
const MAX_NAME_LENGTH = 128
const MAX_PUBLIC_KEY_LENGTH = 16 * 1024
const PAIRABLE_SCOPES: readonly AppServerScope[] = ["session:read", "session:write", "approval:write", "shell:execute"]

export interface AppServerPairingHttpOptions {
  readonly registry: AppServerPairingRegistry
  readonly authenticate: (request: Request) => AppServerWebSocketIdentity | undefined | Promise<AppServerWebSocketIdentity | undefined>
  readonly startPath?: string
  readonly claimPath?: string
  readonly challengePath?: string
  readonly deviceProof?: AppServerDeviceChallengeIssuer
  readonly maxBodyBytes?: number
  /** Exact browser origins allowed to call the pairing control plane. */
  readonly corsOrigins?: readonly string[]
}

/**
 * HTTP control-plane adapter for one-time device pairing.
 *
 * Pairing is deliberately separate from the Session WebSocket: start requires
 * an already-authorized device administrator, while claim consumes only a
 * short-lived ticket and returns a persistent credential once.
 */
export function createAppServerPairingHttpHandler(
  options: AppServerPairingHttpOptions,
): (request: Request) => Promise<Response | undefined> {
  const startPath = options.startPath ?? "/pair"
  const claimPath = options.claimPath ?? "/pair/claim"
  const challengePath = options.challengePath ?? "/pair/challenge"
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new RangeError("maxBodyBytes must be a positive integer")
  const corsOrigins = normalizeCorsOrigins(options.corsOrigins)

  return async (request) => {
    const pathname = new URL(request.url).pathname
    if (pathname !== startPath && pathname !== claimPath && pathname !== challengePath) return undefined
    const corsHeaders = headersForOrigin(request.headers.get("origin"), corsOrigins)
    if (corsHeaders === undefined) {
      return jsonResponse({ error: { code: "origin_not_allowed", message: "Request origin is not in the App Server allowlist" } }, 403)
    }
    if (request.method === "OPTIONS") {
      if (request.headers.get("origin") === null) {
        const method = pathname === challengePath ? "GET" : "POST"
        return jsonResponse({ error: { code: "method_not_allowed", message: `Pairing endpoint only accepts ${method}` } }, 405, {
          Allow: method,
        })
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "Access-Control-Allow-Methods": pathname === challengePath ? "GET, OPTIONS" : "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
          "Cache-Control": "no-store",
        },
      })
    }
    if (pathname === challengePath) {
      if (request.method !== "GET") {
        return withHeaders(
          jsonResponse({ error: { code: "method_not_allowed", message: "Challenge endpoint only accepts GET" } }, 405, { Allow: "GET" }),
          corsHeaders,
        )
      }
      return withHeaders(await issueDeviceChallenge(request, options), corsHeaders)
    }
    if (request.method !== "POST") {
      return withHeaders(
        jsonResponse({ error: { code: "method_not_allowed", message: "Pairing endpoint only accepts POST" } }, 405, { Allow: "POST" }),
        corsHeaders,
      )
    }

    const response =
      pathname === startPath
        ? await startPairing(request, options, maxBodyBytes)
        : await claimPairing(request, options.registry, maxBodyBytes)
    return withHeaders(response, corsHeaders)
  }
}

async function issueDeviceChallenge(request: Request, options: AppServerPairingHttpOptions): Promise<Response> {
  let authentication: AppServerWebSocketIdentity | undefined
  try {
    authentication = await options.authenticate(request)
  } catch {
    return jsonResponse({ error: { code: "authentication_unavailable", message: "Cannot verify the challenge requester" } }, 503)
  }
  if (authentication === undefined) {
    return jsonResponse(
      { error: { code: "authentication_required", message: "A device credential is required to obtain a challenge" } },
      401,
      {
        "WWW-Authenticate": "Bearer",
      },
    )
  }
  if (options.deviceProof === undefined) {
    return jsonResponse({ error: { code: "device_proof_unavailable", message: "Device proof is not enabled on this Host" } }, 503)
  }
  if (authentication.deviceId === undefined || authentication.devicePublicKey === undefined) {
    return jsonResponse(
      {
        error: {
          code: "device_proof_required",
          message: "The current credential does not belong to a device that can provide device proof",
        },
      },
      409,
    )
  }
  try {
    const challenge: AppServerDeviceChallenge = options.deviceProof.issue(authentication.deviceId)
    return jsonResponse(challenge, 200)
  } catch {
    return jsonResponse({ error: { code: "device_proof_unavailable", message: "Cannot create a device challenge" } }, 503)
  }
}

async function startPairing(request: Request, options: AppServerPairingHttpOptions, maxBodyBytes: number): Promise<Response> {
  let authentication: AppServerWebSocketIdentity | undefined
  try {
    authentication = await options.authenticate(request)
  } catch {
    return jsonResponse({ error: { code: "authentication_unavailable", message: "Cannot verify the pairing requester" } }, 503)
  }
  if (!isDeviceAdministrator(authentication)) {
    return jsonResponse(
      { error: { code: "pairing_authorization_required", message: "Creating a pairing request requires device:admin authorization" } },
      authentication === undefined ? 401 : 403,
      authentication === undefined ? { "WWW-Authenticate": "Bearer" } : undefined,
    )
  }

  let input: AppServerPairingStartInput
  try {
    input = parsePairingStart(await readJsonBody(request, maxBodyBytes), authentication)
  } catch (error) {
    return inputError(error)
  }
  try {
    return jsonResponse(await options.registry.start(input), 200)
  } catch {
    return jsonResponse({ error: { code: "pairing_unavailable", message: "Cannot create the pairing request" } }, 503)
  }
}

async function claimPairing(request: Request, registry: AppServerPairingRegistry, maxBodyBytes: number): Promise<Response> {
  let input: AppServerPairingClaimInput
  try {
    input = parsePairingClaim(await readJsonBody(request, maxBodyBytes))
  } catch (error) {
    return inputError(error)
  }
  let registration: AppServerDeviceRegistration | undefined
  try {
    registration = await registry.claim(input)
  } catch {
    return jsonResponse({ error: { code: "pairing_unavailable", message: "Cannot claim the pairing credential" } }, 503)
  }
  if (registration === undefined) {
    return jsonResponse(
      { error: { code: "pairing_expired", message: "The pairing request does not exist, has expired, or has already been used" } },
      410,
    )
  }
  return jsonResponse(registration, 200)
}

function parsePairingStart(value: unknown, authentication: AppServerWebSocketIdentity): AppServerPairingStartInput {
  const record = asRecord(value, "pairing.start")
  if (!Array.isArray(record.scopes) || record.scopes.length === 0) throw new PairingInputError("scopes must be a non-empty array")
  const scopes = [...new Set(record.scopes.map((scope, index) => parseScope(scope, index)))]
  const invalid = scopes.filter((scope) => !PAIRABLE_SCOPES.includes(scope))
  if (invalid.length > 0) throw new PairingInputError(`Scopes are not allowed for device pairing: ${invalid.join(", ")}`)
  const grantedScopes = authentication.grantedScopes ?? []
  const denied = scopes.filter((scope) => !grantedScopes.includes(scope))
  if (denied.length > 0) throw new PairingAuthorizationError(`Pairing requester lacks scope: ${denied.join(", ")}`)
  const ttlMs = record.ttlMs
  if (ttlMs !== undefined && (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS)) {
    throw new PairingInputError(`ttlMs must be between ${MIN_TTL_MS} and ${MAX_TTL_MS} milliseconds`)
  }
  return { scopes, ...(ttlMs === undefined ? {} : { ttlMs: ttlMs as number }) }
}

function parsePairingClaim(value: unknown): AppServerPairingClaimInput {
  const record = asRecord(value, "pairing.claim")
  const pairingToken = boundedString(record.pairingToken, "pairingToken", 256).trim()
  if (!/^ag2cli-pairing\.[A-Za-z0-9_-]{43}$/u.test(pairingToken)) throw new PairingInputError("pairingToken has an invalid format")
  const name = boundedString(record.name, "name", MAX_NAME_LENGTH).trim()
  if (name.length === 0) throw new PairingInputError("name must not be empty")
  const clientKind = parseClientKind(record.clientKind)
  const publicKey = record.publicKey === undefined ? undefined : boundedString(record.publicKey, "publicKey", MAX_PUBLIC_KEY_LENGTH).trim()
  return { pairingToken, name, clientKind, ...(publicKey === undefined ? {} : { publicKey }) }
}

function parseScope(value: unknown, index: number): AppServerScope {
  if (typeof value !== "string" || !(APP_SERVER_SCOPES as readonly string[]).includes(value)) {
    throw new PairingInputError(`scopes[${index}] is invalid`)
  }
  return value as AppServerScope
}

function parseClientKind(value: unknown): AppServerClientInfo["clientKind"] {
  if (
    value !== "tui" &&
    value !== "web" &&
    value !== "mobile" &&
    value !== "desktop" &&
    value !== "acp" &&
    value !== "script" &&
    value !== "unknown"
  ) {
    throw new PairingInputError("clientKind is invalid")
  }
  return value
}

function isDeviceAdministrator(
  value: AppServerWebSocketIdentity | undefined,
): value is { readonly grantedScopes: readonly AppServerScope[] } {
  return value?.grantedScopes?.includes("device:admin") === true
}

async function readJsonBody(request: Request, maxBodyBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") throw new PairingInputError("Content-Type must be application/json")
  const declaredLength = request.headers.get("content-length")
  if (declaredLength !== null) {
    const length = Number(declaredLength)
    if (!Number.isSafeInteger(length) || length < 0) throw new PairingInputError("Content-Length is invalid")
    if (length > maxBodyBytes) throw new PairingBodyTooLargeError()
  }
  const reader = request.body?.getReader()
  if (reader === undefined) return undefined
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBodyBytes) {
        await reader.cancel()
        throw new PairingBodyTooLargeError()
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new PairingInputError("Request body is not valid JSON")
  }
}

function boundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength)
    throw new PairingInputError(`${name} must be a string of at most ${maxLength} characters`)
  return value
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PairingInputError(`${name} must be an object`)
  return value as Record<string, unknown>
}

function inputError(error: unknown): Response {
  if (error instanceof PairingBodyTooLargeError) {
    return jsonResponse({ error: { code: "body_too_large", message: "Pairing request body is too large" } }, 413)
  }
  if (error instanceof PairingAuthorizationError) {
    return jsonResponse({ error: { code: "scope_denied", message: error.message } }, 403)
  }
  return jsonResponse(
    { error: { code: "invalid_params", message: error instanceof Error ? error.message : "Pairing parameters are invalid" } },
    400,
  )
}

function jsonResponse(value: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...(headers ?? {}) },
  })
}

function normalizeCorsOrigins(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined
  return [
    ...new Set(
      value.map((origin, index) => {
        const trimmed = origin.trim()
        if (trimmed.length === 0) throw new RangeError(`corsOrigins[${index}] must not be empty`)
        let url: URL
        try {
          url = new URL(trimmed)
        } catch {
          throw new RangeError(`corsOrigins[${index}] must be a valid HTTP(S) origin`)
        }
        if (
          (url.protocol !== "http:" && url.protocol !== "https:") ||
          url.username.length > 0 ||
          url.password.length > 0 ||
          url.pathname !== "/" ||
          url.search.length > 0 ||
          url.hash.length > 0
        ) {
          throw new RangeError(`corsOrigins[${index}] must be an HTTP(S) origin without a path, query, or credentials`)
        }
        return url.origin
      }),
    ),
  ]
}

function headersForOrigin(origin: string | null, allowedOrigins: readonly string[] | undefined): Record<string, string> | undefined {
  if (origin === null) return {}
  if (allowedOrigins?.includes(origin) !== true) return undefined
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  if (Object.keys(headers).length === 0) return response
  const merged = new Headers(response.headers)
  for (const [name, value] of Object.entries(headers)) merged.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  })
}

class PairingInputError extends Error {}
class PairingAuthorizationError extends Error {}
class PairingBodyTooLargeError extends Error {}
