/**
 * web_fetch model tool (ADR-WEB-FETCH-TOOL-001 §1): a policy-checked host
 * network read behind the canonical permission judgment.
 *
 * prepare never self-authorizes: a valid target returns decision "ask" with
 * the normalized URL as the approval fingerprint. call re-checks the target
 * policy (defense in depth) and the canonical preparation fences, then runs
 * the bounded transport and converts the response.
 */

import { z } from "zod/v4"
import type { PermissionDenialCode, ToolPreparation, ToolResult } from "@ag2cli/core/tool-facts.js"
import type { Tool, ToolContext } from "@ag2cli/runtime/ports/tool/contract.js"
import { MAX_TOOL_RESULT_CHARS } from "../security/resource-limits.js"
import { convertHtmlToText } from "./web-fetch-html.js"
import { validateWebFetchUrl } from "./web-fetch-policy.js"
import {
  fetchWebDocument,
  firstHeaderValue,
  makeSystemDnsResolver,
  nodeHttpSend,
  realTimerPort,
  type DnsResolver,
  type HttpSend,
  type TimerPort,
} from "./web-fetch-transport.js"

const DEFAULT_MAX_LENGTH = 4000

export const WEB_FETCH_PREPARATION_VERSION = "web-fetch-1"
export const WEB_FETCH_POLICY_VERSION = "web-fetch-target-policy-1"

export const WEB_FETCH_DESCRIPTION =
  "Fetches an http/https URL and returns bounded text: HTML pages are coarsely converted, other text types (including JSON) are returned raw. Follows at most 5 redirects; every redirect target is policy-checked. Each approval binds this exact call only — the same URL is asked again on the next call."

const inputSchema = z.strictObject({
  url: z.string().min(1).describe("Absolute http/https URL to fetch; hosts and redirect targets are policy-checked"),
  max_length: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Maximum characters of returned content, default ${DEFAULT_MAX_LENGTH}, capped at ${MAX_TOOL_RESULT_CHARS}`),
})

type Input = z.infer<typeof inputSchema>

export interface WebFetchDeps {
  readonly httpSend?: HttpSend
  readonly resolveDns?: DnsResolver
  readonly timer?: TimerPort
}

function parseMediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase()
}

function parseCharset(contentType: string): string | undefined {
  const match = /(?:^|[;\s])charset\s*=\s*"?([^;"]*)"?\s*(?:;|$)/i.exec(contentType)
  const value = match?.[1]?.trim()
  return value === undefined || value === "" ? undefined : value.toLowerCase()
}

function isAcceptedMediaType(mediaType: string): boolean {
  // A joined header list ("text/plain, image/svg+xml") is not one media
  // type; reject it outright instead of letting it ride the text/ prefix.
  if (mediaType.includes(",")) return false
  return mediaType === "application/json" || mediaType === "application/xhtml+xml" || mediaType.startsWith("text/")
}

export class WebFetchTool implements Tool<typeof inputSchema> {
  readonly name = "web_fetch"
  readonly description = WEB_FETCH_DESCRIPTION
  readonly inputSchema = inputSchema

  private readonly httpSend: HttpSend
  private readonly resolveDns: DnsResolver
  private readonly timer: TimerPort

  constructor(deps: WebFetchDeps = {}) {
    this.httpSend = deps.httpSend ?? nodeHttpSend
    this.timer = deps.timer ?? realTimerPort
    this.resolveDns = deps.resolveDns ?? makeSystemDnsResolver(this.timer)
  }

  async prepare(args: Input, _context?: ToolContext): Promise<ToolPreparation> {
    const parsed = inputSchema.safeParse(args)
    if (!parsed.success) {
      return {
        status: "invalid",
        decision: "deny",
        preparedInput: args,
        reasons: [`input validation failed: ${parsed.error.message}`],
        analyzerVersion: WEB_FETCH_PREPARATION_VERSION,
        policyVersion: WEB_FETCH_POLICY_VERSION,
        denial: { code: "unknown_tool_or_input" },
      }
    }
    const target = validateWebFetchUrl(parsed.data.url)
    if (!target.ok) {
      return {
        status: "invalid",
        decision: "deny",
        preparedInput: parsed.data,
        reasons: [`url rejected by the target policy: ${target.reason}`],
        analyzerVersion: WEB_FETCH_PREPARATION_VERSION,
        policyVersion: WEB_FETCH_POLICY_VERSION,
        denial: { code: "unknown_tool_or_input", reason: target.reason },
      }
    }
    return {
      status: "ready",
      decision: "ask",
      preparedInput: parsed.data,
      reasons: [],
      analyzerVersion: WEB_FETCH_PREPARATION_VERSION,
      policyVersion: WEB_FETCH_POLICY_VERSION,
      approvalFingerprint: target.normalized,
    }
  }

  async call(args: Input, context?: ToolContext): Promise<ToolResult> {
    const parsed = inputSchema.safeParse(args)
    if (!parsed.success) {
      return this.denied(`input validation failed: ${parsed.error.message}`, "unknown_tool_or_input")
    }
    const target = validateWebFetchUrl(parsed.data.url)
    if (!target.ok) {
      return this.denied(`url rejected by the target policy: ${target.reason}`, "unknown_tool_or_input")
    }
    const preparation = context?.execution?.preparation
    if (!preparation) {
      return this.denied("canonical preparation was not injected, no request started", "denied_by_rule")
    }
    if (preparation.approvalFingerprint !== target.normalized) {
      return this.denied("canonical preparation does not match the requested URL, no request started", "stale_policy")
    }
    // The fingerprint pins the URL; the prepared input pins the rest of the
    // call (max_length), so any divergence is stale policy, not a new ask.
    const preparedInput = preparation.preparedInput as { url?: unknown; max_length?: unknown } | undefined
    if (preparedInput?.url !== parsed.data.url || preparedInput?.max_length !== parsed.data.max_length) {
      return this.denied("canonical preparation does not match the requested input, no request started", "stale_policy")
    }
    if (preparation.analyzerVersion !== WEB_FETCH_PREPARATION_VERSION || preparation.policyVersion !== WEB_FETCH_POLICY_VERSION) {
      return this.denied("canonical preparation was produced under a different tool policy, no request started", "stale_policy")
    }
    if (preparation.status !== "ready" || preparation.decision === "deny") {
      return this.denied("canonical preparation does not permit a network request", preparation.denial?.code ?? "denied_by_rule")
    }
    if (context?.execution?.approvalDecision !== "approved" && context?.execution?.judgmentDecision !== "allow") {
      return this.denied("request requires a canonical approval result, no request started", "approval_required")
    }
    const outcome = await fetchWebDocument(target, {
      httpSend: this.httpSend,
      resolveDns: this.resolveDns,
      timer: this.timer,
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
    })
    if (!outcome.ok) return { content: `web_fetch failed: ${outcome.error}`, isError: true }
    const contentType = firstHeaderValue(outcome.headers, "content-type") ?? ""
    const mediaType = parseMediaType(contentType)
    if (mediaType === "") {
      return {
        content: `web_fetch failed: response carried no content type, only text/*, application/json and application/xhtml+xml are returned`,
        isError: true,
      }
    }
    if (!isAcceptedMediaType(mediaType)) {
      return {
        content: `web_fetch failed: unsupported content type "${mediaType}", only text/*, application/json and application/xhtml+xml are returned`,
        isError: true,
      }
    }
    const encoding = (firstHeaderValue(outcome.headers, "content-encoding") ?? "").trim().toLowerCase()
    if (encoding !== "" && encoding !== "identity") {
      return { content: `web_fetch failed: compressed responses are not supported (Content-Encoding: ${encoding})`, isError: true }
    }
    const charset = parseCharset(contentType) ?? "utf-8"
    let decoded: string
    try {
      decoded = new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0]).decode(outcome.body)
    } catch {
      return { content: `web_fetch failed: unsupported charset "${charset}" in response`, isError: true }
    }
    let text = mediaType === "text/html" || mediaType === "application/xhtml+xml" ? convertHtmlToText(decoded) : decoded
    text = text.replace(/\0/g, "")
    const header = `url: ${outcome.finalUrl}\nstatus: ${outcome.status}\ncontent-type: ${contentType}\n\n`
    // The body budget reserves room for the header so the assembled content
    // never exceeds MAX_TOOL_RESULT_CHARS, truncated or not.
    const requested = Math.max(1, Math.min(parsed.data.max_length ?? DEFAULT_MAX_LENGTH, MAX_TOOL_RESULT_CHARS - header.length))
    let body: string
    if (text.length <= requested) {
      body = text
    } else {
      // The truncation marker also has to fit inside the cap and reports the
      // kept body size. If the header ever crowds the marker out entirely
      // (not reachable with today's URL and header bounds), the cap wins
      // over the marker.
      const room = MAX_TOOL_RESULT_CHARS - header.length
      const marker = (kept: number): string => `\n...(truncated at ${kept} characters)`
      const kept = Math.min(requested, room - marker(Math.min(requested, room)).length)
      body = kept >= 1 ? `${text.slice(0, kept)}${marker(kept)}` : text.slice(0, room)
    }
    return {
      content: `${header}${body}`,
      metadata: { status: String(outcome.status), bytes: String(outcome.body.byteLength) },
    }
  }

  isReadOnly(_args: Input): boolean {
    return false
  }

  isConcurrencySafe(_args: Input): boolean {
    return true
  }

  private denied(message: string, code: PermissionDenialCode): ToolResult {
    return {
      content: `tool web_fetch denied (${code}: ${message})`,
      isError: true,
      denial: { code, reason: message },
    }
  }
}
