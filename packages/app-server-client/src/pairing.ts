import {
  type AppServerDeviceChallenge,
  type AppServerDeviceRegistration,
  type AppServerPairingChallenge,
  type AppServerPairingClaimInput,
  type AppServerPairingStartInput,
  type JsonValue,
} from "@ag2cli/app-server-protocol/types.js"
import {
  parseAppServerDeviceRegistration,
  parseAppServerDeviceChallenge,
  parseAppServerPairingChallenge,
} from "@ag2cli/app-server-protocol/validation.js"

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024

export type AppServerFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface AppServerPairingClientOptions {
  /** Credential of an already-authorized device administrator for `start`. */
  readonly bearerToken?: string
  readonly fetch?: AppServerFetch
  readonly requestTimeoutMs?: number
  readonly maxResponseBytes?: number
  readonly startPath?: string
  readonly claimPath?: string
  readonly challengePath?: string
}

export interface AppServerPairingRequestOptions {
  readonly signal?: AbortSignal
}

/** Convert an App Server WebSocket endpoint to the HTTP pairing origin. */
export function appServerHttpBaseUrl(endpoint: string): string {
  const url = new URL(endpoint)
  if (url.protocol === "ws:") url.protocol = "http:"
  else if (url.protocol === "wss:") url.protocol = "https:"
  else throw new TypeError("App Server endpoint must use ws:// or wss://")
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url.toString()
}

export class AppServerPairingHttpError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: JsonValue

  constructor(status: number, code: string, message: string, details?: JsonValue) {
    super(message)
    this.name = "AppServerPairingHttpError"
    this.status = status
    this.code = code
    this.details = details
  }
}

/** Public HTTP client for device pairing; it does not depend on CLI internals. */
export class AppServerPairingClient {
  private readonly baseUrl: URL
  private readonly fetchImpl: AppServerFetch
  private readonly bearerToken?: string
  private readonly requestTimeoutMs: number
  private readonly maxResponseBytes: number
  private readonly startPath: string
  private readonly claimPath: string
  private readonly challengePath: string

  constructor(baseUrl: string, options: AppServerPairingClientOptions = {}) {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError("App Server pairing URL must use http:// or https://")
    }
    parsed.search = ""
    parsed.hash = ""
    if (!parsed.pathname.endsWith("/")) parsed.pathname += "/"
    this.baseUrl = parsed
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.bearerToken = options.bearerToken?.trim() || undefined
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    this.startPath = normalizePath(options.startPath ?? "pair")
    this.claimPath = normalizePath(options.claimPath ?? "pair/claim")
    this.challengePath = normalizePath(options.challengePath ?? "pair/challenge")
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new RangeError("requestTimeoutMs must be a positive integer")
    }
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new RangeError("maxResponseBytes must be a positive integer")
    }
  }

  async start(input: AppServerPairingStartInput, options: AppServerPairingRequestOptions = {}): Promise<AppServerPairingChallenge> {
    const value = await this.request(this.startPath, input, true, options)
    return parseAppServerPairingChallenge(value)
  }

  async claim(input: AppServerPairingClaimInput, options: AppServerPairingRequestOptions = {}): Promise<AppServerDeviceRegistration> {
    const value = await this.request(this.claimPath, input, false, options)
    return parseAppServerDeviceRegistration(value)
  }

  /** Fetch a fresh challenge for an already registered proof-capable device. */
  async challenge(options: AppServerPairingRequestOptions = {}): Promise<AppServerDeviceChallenge> {
    const value = await this.request(this.challengePath, undefined, true, options, "GET")
    return parseAppServerDeviceChallenge(value)
  }

  private async request(
    path: string,
    input: AppServerPairingStartInput | AppServerPairingClaimInput | undefined,
    authenticate: boolean,
    options: AppServerPairingRequestOptions,
    method: "GET" | "POST" = "POST",
  ): Promise<unknown> {
    const controller = new AbortController()
    const externalSignal = options.signal
    if (externalSignal?.aborted) throw abortError()
    const onAbort = (): void => controller.abort()
    externalSignal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      const headers = new Headers(method === "POST" ? { "Content-Type": "application/json" } : undefined)
      if (authenticate && this.bearerToken !== undefined) headers.set("Authorization", `Bearer ${this.bearerToken}`)
      let response: Response
      try {
        response = await this.fetchImpl(this.resolve(path), {
          method,
          headers,
          ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) {
          if (externalSignal?.aborted) throw abortError()
          throw new AppServerPairingHttpError(0, "request_timeout", "App Server pairing HTTP request timed out")
        }
        throw error
      }
      const body = await readJsonBody(response, this.maxResponseBytes)
      if (!response.ok) throw httpError(response.status, body)
      return body
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener("abort", onAbort)
    }
  }

  private resolve(path: string): string {
    return new URL(path, this.baseUrl).toString()
  }
}

async function readJsonBody(response: Response, maxResponseBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length")
  if (declaredLength !== null) {
    const length = Number(declaredLength)
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new AppServerPairingHttpError(response.status, "invalid_response", "Pairing HTTP response has an invalid Content-Length")
    }
    if (length > maxResponseBytes) {
      throw new AppServerPairingHttpError(response.status, "response_too_large", "Pairing HTTP response is too large")
    }
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    return parseJsonText(await response.text(), response.status)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxResponseBytes) {
        await reader.cancel()
        throw new AppServerPairingHttpError(response.status, "response_too_large", "Pairing HTTP response is too large")
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
  return parseJsonText(new TextDecoder().decode(bytes), response.status)
}

function parseJsonText(text: string, status: number): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AppServerPairingHttpError(status, "invalid_response", "Pairing HTTP response is not valid JSON")
  }
}

function httpError(status: number, value: unknown): AppServerPairingHttpError {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  const error =
    record?.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : `http_${status}`
  const message =
    typeof error?.message === "string" && error.message.length > 0 ? error.message : `Pairing HTTP request failed: HTTP ${status}`
  return new AppServerPairingHttpError(status, code, message)
}

function normalizePath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/gu, "")
  if (normalized.length === 0) throw new TypeError("pairing endpoint path must not be empty")
  return normalized
}

function abortError(): DOMException {
  return new DOMException("Request was cancelled", "AbortError")
}
