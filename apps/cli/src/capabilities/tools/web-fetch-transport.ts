/**
 * web_fetch transport (ADR-WEB-FETCH-TOOL-001 §2): a manual redirect loop
 * over node:http/https with a pinned DNS lookup.
 *
 * The HTTP primitive is an injected port (`HttpSend`) so tests can prove the
 * port contract — only policy-verified address literals are ever handed to
 * the platform, and the platform's honoring of the pinned lookup is the
 * Bun 1.3.14 spike recorded in the ADR. Time is read from an injected timer
 * port so timeout tests never sleep.
 */

import http from "node:http"
import https from "node:https"
import { lookup as dnsLookup } from "node:dns/promises"
import { MAX_WEB_FETCH_RESPONSE_BYTES } from "../security/resource-limits.js"
import { checkResolvedAddresses, resolveRedirectTarget, type ValidatedTarget } from "./web-fetch-policy.js"

export const WEB_FETCH_MAX_REDIRECTS = 5
export const WEB_FETCH_DEADLINE_MS = 15_000
export const WEB_FETCH_INACTIVITY_MS = 5_000
export const WEB_FETCH_DNS_TIMEOUT_MS = 5_000

export const WEB_FETCH_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  Accept: "text/*, application/json, application/xhtml+xml",
  "Accept-Encoding": "identity",
  Connection: "close",
}

export interface TimerPort {
  now(): number
  setTimeout(ms: number, fn: () => void): unknown
  clearTimeout(handle: unknown): void
}

export const realTimerPort: TimerPort = {
  now: () => Date.now(),
  setTimeout: (ms, fn) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
}

export type DnsResolver = (host: string) => Promise<string[]>

const systemDnsLookup: (host: string) => Promise<string[]> = async (host) =>
  (await dnsLookup(host, { all: true })).map((entry) => entry.address)

/** Production resolver: DNS with a timer-port-bounded 5s timeout. */
export function makeSystemDnsResolver(timer: TimerPort, lookup: (host: string) => Promise<string[]> = systemDnsLookup): DnsResolver {
  return async (host) => {
    let handle: unknown
    try {
      return await Promise.race([
        lookup(host),
        new Promise<never>((_, reject) => {
          handle = timer.setTimeout(WEB_FETCH_DNS_TIMEOUT_MS, () =>
            reject(new Error(`DNS lookup timed out after ${WEB_FETCH_DNS_TIMEOUT_MS}ms: ${host}`)),
          )
        }),
      ])
    } finally {
      if (handle !== undefined) timer.clearTimeout(handle)
    }
  }
}

/**
 * Pinned lookup handed to the platform: resolve once via the DNS port,
 * require every address to pass the target policy, then answer with exactly
 * one verified literal — never a hostname. Array form per the spike.
 */
export type PinnedLookup = (
  hostname: string,
  options: { family?: number },
  callback: (err: Error | null, addresses: ReadonlyArray<{ address: string; family: number }>) => void,
) => void

export function makePinnedLookup(host: string, resolveDns: DnsResolver): PinnedLookup {
  return (hostname, _options, callback) => {
    if (hostname !== host) {
      callback(new Error(`lookup hostname mismatch: expected ${host}, platform asked for ${hostname}`), [])
      return
    }
    resolveDns(host).then(
      (addresses) => {
        const checked = checkResolvedAddresses(host, addresses)
        if (!checked.ok) {
          callback(new Error(`target policy rejected ${host}: ${checked.reason}`), [])
          return
        }
        callback(null, [{ address: checked.address, family: checked.family }])
      },
      (error) => callback(error instanceof Error ? error : new Error(String(error)), []),
    )
  }
}

export type ResponseHeaders = Record<string, string | string[] | undefined>

export function firstHeaderValue(headers: ResponseHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

export interface HttpSendResult {
  readonly status: number
  readonly headers: ResponseHeaders
  readonly body: Buffer
}

export interface HttpSendParams {
  readonly url: URL
  readonly headers: Readonly<Record<string, string>>
  readonly lookup?: PinnedLookup
  readonly ipLiteral: boolean
  /** "stop" means the byte cap was exceeded: the sender must fail the request. */
  readonly onBodyChunk: (chunk: Buffer) => "continue" | "stop"
}

export interface HttpSendInvocation {
  readonly promise: Promise<HttpSendResult>
  /** Must cause `promise` to reject; used by deadline, inactivity and cancel. */
  readonly abort: (reason: Error) => void
}

export type HttpSend = (params: HttpSendParams) => HttpSendInvocation

/** Production HTTP primitive: node:http/https over the verified target. */
export const nodeHttpSend: HttpSend = (params) => {
  const url = params.url
  const isHttps = url.protocol === "https:"
  const chunks: Buffer[] = []
  let request: http.ClientRequest | undefined
  let response: http.IncomingMessage | undefined
  // The first failure wins: cap trips and aborts carry their real cause, so
  // a racing "aborted" or "end" event never masks it. Failures settle the
  // promise directly — the platform's destroy events are only a backstop.
  let failure: Error | undefined
  let rejectFailure!: (error: Error) => void
  const options = {
    method: "GET",
    headers: { ...params.headers },
    agent: false,
    ...(params.lookup === undefined ? {} : { lookup: params.lookup }),
    ...(isHttps && !params.ipLiteral ? { servername: url.hostname } : {}),
  } as http.RequestOptions
  const promise = new Promise<HttpSendResult>((resolve, reject) => {
    rejectFailure = (error) => {
      failure = failure ?? error
      reject(failure)
    }
    const req = (isHttps ? https : http).request(url, options, (incoming) => {
      response = incoming
      incoming.on("data", (chunk: Buffer) => {
        if (params.onBodyChunk(chunk) === "stop") {
          rejectFailure(new Error(`response exceeded ${MAX_WEB_FETCH_RESPONSE_BYTES} bytes`))
          req.destroy(failure)
          return
        }
        chunks.push(chunk)
      })
      incoming.on("aborted", () => rejectFailure(new Error("response connection aborted")))
      incoming.on("error", (error) => rejectFailure(error))
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) }))
    })
    request = req
    req.on("error", (error) => rejectFailure(error))
    req.end()
  })
  return {
    promise,
    abort: (reason) => {
      rejectFailure(reason)
      try {
        // The request carries the reason so a backstop destroy event names
        // the real cause (deadline, inactivity, cancel) too.
        request?.destroy(reason)
        response?.destroy(reason)
      } catch {
        /* already settled */
      }
    },
  }
}

export type FetchOutcome =
  { ok: true; status: number; headers: ResponseHeaders; body: Buffer; finalUrl: string; redirects: number } | { ok: false; error: string }

export interface FetchDeps {
  readonly httpSend: HttpSend
  readonly resolveDns: DnsResolver
  readonly timer: TimerPort
  readonly signal?: AbortSignal
}

/**
 * Fetch one target, following at most WEB_FETCH_MAX_REDIRECTS redirects.
 * Every hop is re-validated against the target policy with a fresh pinned
 * lookup; one absolute deadline and an inactivity sub-timeout bound the
 * whole call.
 */
export async function fetchWebDocument(initial: ValidatedTarget, deps: FetchDeps): Promise<FetchOutcome> {
  if (deps.signal?.aborted) return { ok: false, error: "web_fetch was cancelled before any request started" }
  const deadlineAt = deps.timer.now() + WEB_FETCH_DEADLINE_MS
  let current = initial
  let redirects = 0
  while (true) {
    if (deps.signal?.aborted) return { ok: false, error: "web_fetch was cancelled" }
    if (deps.timer.now() >= deadlineAt) {
      return { ok: false, error: `deadline of ${WEB_FETCH_DEADLINE_MS}ms exceeded` }
    }
    const url = current.url
    const ipLiteral = current.kind !== "dns"
    const lookup = ipLiteral ? undefined : makePinnedLookup(url.hostname, deps.resolveDns)
    let received = 0
    let settled = false
    let invocation: HttpSendInvocation | undefined
    let inactivityHandle: unknown
    const clearInactivity = (): void => {
      if (inactivityHandle !== undefined) {
        deps.timer.clearTimeout(inactivityHandle)
        inactivityHandle = undefined
      }
    }
    const armInactivity = (): void => {
      // A data event delivered after settlement must not re-arm a timer
      // nothing will clear.
      if (settled) return
      clearInactivity()
      inactivityHandle = deps.timer.setTimeout(WEB_FETCH_INACTIVITY_MS, () => {
        invocation?.abort(new Error(`no body bytes received for ${WEB_FETCH_INACTIVITY_MS}ms`))
      })
    }
    const onBodyChunk = (chunk: Buffer): "continue" | "stop" => {
      armInactivity()
      received += chunk.length
      return received > MAX_WEB_FETCH_RESPONSE_BYTES ? "stop" : "continue"
    }
    // Arm timers only after the send port exists: a port that throws
    // synchronously must surface as a failed outcome, not a leaked timer.
    try {
      invocation = deps.httpSend({
        url,
        headers: WEB_FETCH_REQUEST_HEADERS,
        ipLiteral,
        ...(lookup === undefined ? {} : { lookup }),
        onBodyChunk,
      })
    } catch (error) {
      return { ok: false, error: `http send failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    armInactivity()
    const deadlineHandle = deps.timer.setTimeout(Math.max(deadlineAt - deps.timer.now(), 0), () => {
      invocation?.abort(new Error(`deadline of ${WEB_FETCH_DEADLINE_MS}ms exceeded`))
    })
    const onAbort = (): void => invocation?.abort(new Error("web_fetch was cancelled"))
    deps.signal?.addEventListener("abort", onAbort, { once: true })
    let result: HttpSendResult
    try {
      result = await invocation.promise
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    } finally {
      settled = true
      clearInactivity()
      deps.timer.clearTimeout(deadlineHandle)
      deps.signal?.removeEventListener("abort", onAbort)
    }
    if (result.status >= 200 && result.status < 300) {
      return { ok: true, status: result.status, headers: result.headers, body: result.body, finalUrl: current.normalized, redirects }
    }
    if (result.status >= 300 && result.status < 400) {
      const location = firstHeaderValue(result.headers, "location")
      if (location === undefined) {
        return { ok: false, error: `redirect status ${result.status} from ${current.normalized} carried no Location header` }
      }
      if (location.trim() === "") {
        return { ok: false, error: `redirect status ${result.status} from ${current.normalized} carried an empty Location header` }
      }
      if (redirects >= WEB_FETCH_MAX_REDIRECTS) {
        return { ok: false, error: `too many redirects (more than ${WEB_FETCH_MAX_REDIRECTS})` }
      }
      const next = resolveRedirectTarget(current.url, location)
      if (!next.ok) return { ok: false, error: `redirect from ${current.normalized} rejected: ${next.reason}` }
      current = next
      redirects += 1
      continue
    }
    return { ok: false, error: `HTTP ${result.status} at ${current.normalized}` }
  }
}
