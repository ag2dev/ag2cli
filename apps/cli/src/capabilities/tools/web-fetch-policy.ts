/**
 * Pure target policy for web_fetch (ADR-WEB-FETCH-TOOL-001 §3).
 *
 * URL grammar, deterministic approval normalization, literal address ranges
 * and redirect resolution. No I/O happens here. The tool input contract
 * includes this grammar, so literal violations are invalid input at prepare
 * time; addresses resolved by DNS are re-checked in the transport. These
 * checks sit below the permission layer: no mode, rule or approval bypasses
 * them.
 */

import { isIP } from "node:net"

/** Longest raw URL string accepted by the input contract. */
export const MAX_WEB_FETCH_URL_CHARS = 8192

export type TargetKind = "ipv4" | "ipv6" | "dns"

export type UrlTarget = { ok: true; url: URL; normalized: string; kind: TargetKind } | { ok: false; reason: string }

export type ValidatedTarget = Extract<UrlTarget, { ok: true }>

export type AddressCheck = { ok: true; family: 4 | 6 } | { ok: false; reason: string }

const IPV4_SHAPE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const HTTP_SCHEME = /^https?:/i

/**
 * Reject non-ASCII bytes inside any authority the raw string declares.
 *
 * WHATWG parsing canonicalizes a unicode host to punycode, after which the
 * original form is undetectable, so this check must run before the parser.
 * The parser strips leading/trailing C0-control-or-space and removes every
 * tab/newline before it locates the scheme, so the scan applies the same
 * preprocessing first or those forms smuggle a unicode host past it.
 * Special-scheme parsing treats '\' exactly like '/' when it locates the
 * authority and tolerates any number of separators after the scheme colon
 * (including none), so the authority is located under those same rules;
 * anything that declares no authority (a relative redirect target with at
 * most one leading slash) inherits the already-validated base host.
 */
export function declaresOnlyAsciiAuthority(raw: string): boolean {
  const text = raw.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\n\r]/g, "")
  const scheme = HTTP_SCHEME.exec(text)
  let at: number
  if (scheme !== null) {
    at = scheme[0].length
  } else {
    at = 0
    while (text.charAt(at) === "/" || text.charAt(at) === "\\") at += 1
    if (at < 2) return true
  }
  while (text.charAt(at) === "/" || text.charAt(at) === "\\") at += 1
  let authority = text.slice(at)
  const terminator = authority.search(/[/?#\\]/)
  if (terminator >= 0) authority = authority.slice(0, terminator)
  const userinfo = authority.lastIndexOf("@")
  if (userinfo >= 0) authority = authority.slice(userinfo + 1)
  for (let i = 0; i < authority.length; i += 1) {
    if (authority.charCodeAt(i) > 0x7f) return false
  }
  return true
}

function parseIpv4Literal(text: string): [number, number, number, number] | undefined {
  const shape = IPV4_SHAPE.exec(text)
  if (!shape) return undefined
  const octets: number[] = []
  for (const group of [shape[1], shape[2], shape[3], shape[4]]) {
    const value = Number(group)
    if (!Number.isInteger(value) || value < 0 || value > 255) return undefined
    octets.push(value)
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0]
}

/** Closed reject list for a dotted-decimal IPv4 literal. */
export function disallowedIpv4Range(octets: readonly [number, number, number, number]): string | undefined {
  const [a, b] = octets
  if (a === 0) return "0.0.0.0/8"
  if (a === 10) return "10.0.0.0/8 (private)"
  if (a === 127) return "127.0.0.0/8 (loopback)"
  if (a === 169 && b === 254) return "169.254.0.0/16 (link-local, cloud metadata)"
  if (a === 172 && b >= 16 && b <= 31) return "172.16.0.0/12 (private)"
  if (a === 192 && b === 168) return "192.168.0.0/16 (private)"
  if (a === 100 && b >= 64 && b <= 127) return "100.64.0.0/10 (CG-NAT)"
  if (a >= 224) return "224.0.0.0/3 (multicast, reserved incl. 240/4, broadcast)"
  return undefined
}

/**
 * Parse a bracketless IPv6 literal (lowercase, compressed form or any valid
 * textual form, optionally with a dotted-decimal tail) to a 128-bit value.
 * Zone IDs are not accepted. Returns undefined for anything malformed.
 */
export function parseIpv6Literal(host: string): bigint | undefined {
  if (host.includes("%") || !host.includes(":")) return undefined
  let body = host
  let v4Tail: number | undefined
  const lastColon = host.lastIndexOf(":")
  const lastGroup = lastColon >= 0 ? host.slice(lastColon + 1) : host
  if (lastGroup.includes(".")) {
    const octets = parseIpv4Literal(lastGroup)
    if (octets === undefined) return undefined
    // The two tail groups are counted as zeros; the real bits are OR-ed in
    // at the end so group counting stays independent of the tail notation.
    v4Tail = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
    body = `${host.slice(0, lastColon + 1)}0:0`
  }
  const sections = body.split("::")
  if (sections.length > 2) return undefined
  const parseGroups = (section: string): number[] | undefined => {
    if (section === "") return []
    const groups: number[] = []
    for (const part of section.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined
      groups.push(Number.parseInt(part, 16))
    }
    return groups
  }
  const head = parseGroups(sections[0] ?? "")
  if (head === undefined) return undefined
  let groups: number[]
  if (sections.length === 2) {
    const tail = parseGroups(sections[1] ?? "")
    if (tail === undefined) return undefined
    const missing = 8 - head.length - tail.length
    if (missing < 0) return undefined
    groups = [...head, ...Array.from({ length: missing }, () => 0), ...tail]
  } else {
    if (head.length !== 8) return undefined
    groups = head
  }
  let value = 0n
  for (const group of groups) value = (value << 16n) | BigInt(group)
  if (v4Tail !== undefined) value |= BigInt(v4Tail)
  return value
}

/** Closed reject list for a parsed IPv6 literal (128-bit value). */
export function disallowedIpv6Range(value: bigint): string | undefined {
  if (value === 0n) return ":: (unspecified)"
  if (value === 1n) return "::1 (loopback)"
  if (value >> 32n === 0n) return "::/96 (IPv4-compatible)"
  if (value >> 32n === 0xffffn) return "::ffff:0:0/96 (IPv4-mapped)"
  if (value >> 96n === 0x64ff9bn) return "64:ff9b::/96 (NAT64)"
  if (value >> 120n === 0xffn) return "ff00::/8 (multicast)"
  if (value >> 120n >= 0xfcn && value >> 120n < 0xfen) return "fc00::/7 (unique local)"
  if (value >> 116n >= 0xfe8n && value >> 116n < 0xfecn) return "fe80::/10 (link-local)"
  return undefined
}

/**
 * Check a bare address literal (no brackets) against the closed range list.
 * Also the shared check for resolver-returned addresses.
 */
export function checkAddressLiteral(address: string): AddressCheck {
  const family = isIP(address)
  if (family === 4) {
    const octets = parseIpv4Literal(address)
    if (octets === undefined) return { ok: false, reason: `malformed IPv4 literal: ${address}` }
    const range = disallowedIpv4Range(octets)
    return range === undefined ? { ok: true, family: 4 } : { ok: false, reason: `target policy rejects ${address} (${range})` }
  }
  if (family === 6) {
    if (address.includes("%")) return { ok: false, reason: `zone IDs are not allowed: ${address}` }
    const value = parseIpv6Literal(address)
    if (value === undefined) return { ok: false, reason: `malformed IPv6 literal: ${address}` }
    const range = disallowedIpv6Range(value)
    return range === undefined ? { ok: true, family: 6 } : { ok: false, reason: `target policy rejects ${address} (${range})` }
  }
  return { ok: false, reason: `not an IP literal: ${address}` }
}

/** Classify a parsed (bracketed for IPv6) URL hostname. undefined = malformed. */
export function classifyHostname(hostname: string): TargetKind | undefined {
  if (hostname.startsWith("[")) {
    if (!hostname.endsWith("]") || hostname.length < 4) return undefined
    const inner = hostname.slice(1, -1)
    if (inner.includes("%")) return undefined
    if (isIP(inner) !== 6 || parseIpv6Literal(inner) === undefined) return undefined
    return "ipv6"
  }
  if (IPV4_SHAPE.test(hostname)) {
    return parseIpv4Literal(hostname) === undefined ? undefined : "ipv4"
  }
  if (hostname === "" || hostname === "." || hostname.endsWith("..")) return undefined
  return "dns"
}

/**
 * Deterministic approval normalization (ADR-WEB-FETCH-TOOL-001 §5): the
 * parser's serialization (lowercased scheme/host, default ports 80/443
 * elided, empty path rendered as "/", percent-encoding exactly as emitted,
 * empty query `?` kept distinct from no query) with the fragment dropped and
 * trailing root dots stripped from the host. URL.search cannot carry the
 * empty-vs-absent query distinction on this platform, so the serialization
 * is derived from href. Callers must already have rejected userinfo: this
 * function assumes `url.username` is empty, since a surviving '@' would be
 * reserialized into the approval fingerprint.
 */
export function normalizeTargetUrl(url: URL): string {
  let serialized = url.href
  if (url.hash !== "") serialized = serialized.slice(0, serialized.length - url.hash.length)
  if (url.hostname.length > 1 && url.hostname.endsWith(".")) {
    let host = url.hostname
    while (host.length > 1 && host.endsWith(".")) host = host.slice(0, -1)
    const authorityStart = serialized.indexOf("//") + 2
    let authorityEnd = serialized.length
    for (let i = authorityStart; i < serialized.length; i += 1) {
      const c = serialized[i]
      if (c === "/" || c === "?" || c === "#") {
        authorityEnd = i
        break
      }
    }
    serialized = `${serialized.slice(0, authorityStart)}${host}${url.port === "" ? "" : `:${url.port}`}${serialized.slice(authorityEnd)}`
  }
  return serialized
}

function validateParsedTarget(url: URL): UrlTarget {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme must be http or https, got "${url.protocol.replace(/:$/, "")}"` }
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "userinfo (user:password@) is not allowed" }
  }
  const hostname = url.hostname
  const kind = classifyHostname(hostname)
  if (kind === undefined) return { ok: false, reason: `malformed or unsupported host: "${hostname}"` }
  if (kind === "ipv4") {
    const check = checkAddressLiteral(hostname)
    if (!check.ok) return { ok: false, reason: check.reason }
  } else if (kind === "ipv6") {
    const check = checkAddressLiteral(hostname.slice(1, -1))
    if (!check.ok) return { ok: false, reason: check.reason }
  }
  return { ok: true, url, normalized: normalizeTargetUrl(url), kind }
}

/** Validate an initial fetch target: pre-scan, parse, grammar and ranges. */
export function validateWebFetchUrl(raw: string): UrlTarget {
  if (raw.length === 0) return { ok: false, reason: "url must not be empty" }
  if (raw.length > MAX_WEB_FETCH_URL_CHARS) return { ok: false, reason: `url exceeds ${MAX_WEB_FETCH_URL_CHARS} characters` }
  if (!declaresOnlyAsciiAuthority(raw)) return { ok: false, reason: "non-ASCII host characters are not allowed" }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: `malformed URL: "${raw.slice(0, 100)}"` }
  }
  return validateParsedTarget(url)
}

/**
 * Resolve and validate a redirect target. The raw Location is pre-scanned
 * (it may declare its own authority), parsed against the current URL, then
 * run through the same grammar and range checks; https→http downgrade and
 * non-http(s) schemes are rejected.
 */
export function resolveRedirectTarget(current: URL, location: string): UrlTarget {
  if (location.length > MAX_WEB_FETCH_URL_CHARS)
    return { ok: false, reason: `redirect location exceeds ${MAX_WEB_FETCH_URL_CHARS} characters` }
  if (!declaresOnlyAsciiAuthority(location)) return { ok: false, reason: "non-ASCII redirect host characters are not allowed" }
  let next: URL
  try {
    next = new URL(location, current)
  } catch {
    return { ok: false, reason: `malformed redirect location: "${location.slice(0, 100)}"` }
  }
  if (current.protocol === "https:" && next.protocol === "http:") {
    return { ok: false, reason: "https to http redirect downgrade is not allowed" }
  }
  return validateParsedTarget(next)
}

export type ResolvedAddressCheck = { ok: true; address: string; family: 4 | 6 } | { ok: false; reason: string }

/**
 * Check every address a resolver returned for a DNS host: all of them must
 * be policy-clean literals (anti-rebinding); the caller connects to the
 * first one only.
 */
export function checkResolvedAddresses(host: string, addresses: readonly string[]): ResolvedAddressCheck {
  let chosen: { address: string; family: 4 | 6 } | undefined
  for (const address of addresses) {
    const check = checkAddressLiteral(address)
    if (!check.ok) return { ok: false, reason: `${host} resolution rejected: ${check.reason}` }
    if (chosen === undefined) chosen = { address, family: check.family }
  }
  return chosen === undefined ? { ok: false, reason: `no addresses resolved for ${host}` } : { ok: true, ...chosen }
}
