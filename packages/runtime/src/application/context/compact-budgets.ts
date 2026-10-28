import type { ContentBlock, Message } from "@ag2cli/core/message.js"
import type { CompactThresholds } from "@ag2cli/core/model/limits.js"
import { isCompactionBoundaryMessage, preservedUsersLinesFromBoundary } from "./compact-boundary.js"

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokensMessage(message: Message): number {
  const content = message.message.content
  const text =
    typeof content === "string"
      ? content
      : content
          .map((block: ContentBlock) => {
            if (block.type === "text") return block.text
            if (block.type === "thinking") return block.thinking
            if (block.type === "tool_use") return JSON.stringify(block.input)
            if (block.type === "tool_result") return block.content
            return ""
          })
          .join("")
  return Math.ceil(text.length / 4) + 4
}

export function estimateTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + estimateTokensMessage(message), 0)
}

// ---------------------------------------------------------------------------
// Floors, watermark and derived budgets
// ---------------------------------------------------------------------------

/**
 * The smallest workable auto threshold. A compact product's minimal
 * construction costs roughly 1K tokens, so an auto threshold below this
 * floor makes the blocking-bound invariant unreachable and would re-compact
 * on every message.
 */
export const AUTO_FLOOR_TOKENS = 2_000

export function resolveAutoFloor(autoCompactTokens: number): number {
  if (autoCompactTokens < AUTO_FLOOR_TOKENS) {
    throw new Error(`Compaction auto threshold ${autoCompactTokens} is below the floor ${AUTO_FLOOR_TOKENS}`)
  }
  return autoCompactTokens
}

/** The shrink-ladder target: products aim to land at or below this size. */
export function watermarkFor(autoCompactTokens: number): number {
  return Math.floor(autoCompactTokens * 0.6)
}

/**
 * Notes admission floor for consumers (assembly predicate and refresh gate);
 * the notesCap derivation itself stays floorless to preserve the caps sum.
 */
export const MIN_NOTES_CAP_TOKENS = 500

export interface CompactBudgets {
  readonly tailBudget: number
  readonly usersBudget: number
  readonly notesCap: number
  readonly summaryCap: number
}

/**
 * All budgets derive from the watermark so their caps sum to strictly less
 * than the watermark on every real window tier; the caps keep products
 * bounded on very large windows.
 */
export function budgetsFor(watermark: number): CompactBudgets {
  return {
    tailBudget: Math.min(40_000, Math.floor(watermark * 0.4)),
    usersBudget: Math.min(20_000, Math.max(200, Math.floor(watermark * 0.2))),
    // No floor: flooring here could push the caps sum past the watermark on
    // low window tiers; consumers gate admission on MIN_NOTES_CAP_TOKENS.
    notesCap: Math.min(12_000, Math.floor(watermark * 0.08)),
    summaryCap: Math.min(4_000, Math.max(250, Math.floor(watermark * 0.03))),
  }
}

/** 0 = no action, 1 = model summary, 2 = deterministic structural fallback. */
export function compactTierFor(tokens: number, thresholds: CompactThresholds): 0 | 1 | 2 {
  if (tokens <= thresholds.autoCompactTokens) return 0
  if (tokens <= thresholds.blockingLimitTokens) return 1
  return 2
}

// ---------------------------------------------------------------------------
// Text-anchored groups
// ---------------------------------------------------------------------------

/** A user row carrying plain text (string or text blocks only, no tool_result). */
export function isTextUserRow(message: Message): boolean {
  if (message.type !== "user") return false
  const content = message.message.content
  if (typeof content === "string") return true
  return content.every((block) => block.type === "text")
}

/** The row's text, or null unless it is a text-user row. */
export function textUserRowText(message: Message): string | null {
  if (!isTextUserRow(message)) return null
  const content = message.message.content
  return typeof content === "string"
    ? content
    : content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n")
}

export interface MessageRange {
  readonly start: number
  readonly end: number
}

export interface ConversationGrouping {
  /** Leading rows before the first text-user anchor; always summarized. */
  readonly head: MessageRange | null
  /** Consecutive ranges, each starting at a text-user row and running to the next. */
  readonly groups: readonly MessageRange[]
}

/**
 * Group rows by text-user anchors. Tool results sit between their assistant
 * call and the next anchor, so each group holds complete tool pairs.
 */
export function partitionGroups(messages: readonly Message[]): ConversationGrouping {
  const groups: MessageRange[] = []
  let head: MessageRange | null = null
  let anchor = -1
  for (let index = 0; index < messages.length; index += 1) {
    if (!isTextUserRow(messages[index]!)) continue
    if (anchor === -1) {
      if (index > 0) head = { start: 0, end: index }
      anchor = index
    } else {
      groups.push({ start: anchor, end: index })
      anchor = index
    }
  }
  if (anchor !== -1) {
    groups.push({ start: anchor, end: messages.length })
  } else if (messages.length > 0) {
    // No anchor anywhere: every row is head residue and summarizes.
    head = { start: 0, end: messages.length }
  }
  return { head, groups }
}

// ---------------------------------------------------------------------------
// Pair-safe range selection
// ---------------------------------------------------------------------------

function toolUseIds(message: Message): readonly string[] {
  if (message.type !== "assistant") return []
  return message.message.content
    .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use")
    .map((block) => block.id)
}

function toolResultIds(message: Message): readonly string[] {
  if (message.type !== "user" || typeof message.message.content === "string") return []
  return message.message.content
    .filter((block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result")
    .map((block) => block.tool_use_id)
}

function findToolUseBefore(messages: readonly Message[], toolId: string, end: number): number {
  for (let index = end - 1; index >= 0; index -= 1) {
    if (toolUseIds(messages[index]!).includes(toolId)) return index
  }
  return -1
}

function findToolResultAfter(messages: readonly Message[], toolId: string, start: number): number {
  for (let index = start; index < messages.length; index += 1) {
    if (toolResultIds(messages[index]!).includes(toolId)) return index
  }
  return -1
}

/**
 * Select the compact tail without separating a tool call from its result.
 *
 * A compact boundary is a model-facing message projection, so it must not
 * create an API-invalid history. The range may grow to include a matching
 * tool call/result, or skip an irreparably orphaned result.
 */
export function selectToolPairSafeRange(
  messages: readonly Message[],
  requestedStart: number,
  requestedEnd: number,
): { readonly start: number; readonly end: number } {
  const startLimit = Math.max(0, Math.min(messages.length, Math.trunc(requestedStart)))
  const endLimit = Math.max(startLimit, Math.min(messages.length, Math.trunc(requestedEnd)))
  let start = startLimit
  let end = endLimit

  for (let guard = 0; guard < messages.length * 2 + 2; guard += 1) {
    let changed = false

    for (let index = start; index < end; index += 1) {
      for (const toolId of toolResultIds(messages[index]!)) {
        const useIndex = findToolUseBefore(messages, toolId, start)
        if (useIndex !== -1) {
          const precedingUser = useIndex > 0 && messages[useIndex - 1]?.type === "user" ? useIndex - 1 : useIndex
          if (precedingUser < start) {
            start = precedingUser
            changed = true
            break
          }
        } else if (findToolUseBefore(messages, toolId, messages.length) === -1) {
          // A malformed result cannot be repaired by expanding the range.
          // Drop this user message from the retained tail instead.
          start = index + 1
          changed = true
          break
        }
      }
      if (changed) break
    }
    if (changed) continue

    const retainedUses = new Set<string>()
    for (let index = start; index < end; index += 1) {
      for (const toolId of toolUseIds(messages[index]!)) retainedUses.add(toolId)
    }
    for (const toolId of retainedUses) {
      if (findToolResultAfter(messages, toolId, start) < end) continue
      const resultIndex = findToolResultAfter(messages, toolId, end)
      if (resultIndex !== -1) {
        end = resultIndex + 1
        changed = true
        break
      }
      // A pending tool call is valid while a run is in flight. It is not
      // possible for normal compaction to observe one, so leave it intact.
    }
    if (!changed) break
  }

  return { start, end }
}

export interface TailSelection {
  readonly start: number
  readonly end: number
  readonly startsAtTextUser: boolean
}

/**
 * Pick the tail as a suffix of whole groups within the budget, then snap
 * pair-safe. When snapping forces the start onto a non-text row, prefer the
 * nearest preceding text-user anchor if the extension still fits; otherwise
 * keep the snapped start and disclose it.
 */
export function selectTailByGroups(messages: readonly Message[], grouping: ConversationGrouping, tailBudgetTokens: number): TailSelection {
  if (messages.length === 0) {
    return { start: 0, end: 0, startsAtTextUser: true }
  }
  if (grouping.groups.length === 0) {
    // No text-user anchor exists anywhere (steer-only or adjacent-assistant
    // history): fall back to a small pair-safe suffix.
    const fallback = selectToolPairSafeRange(messages, Math.max(0, messages.length - 2), messages.length)
    return {
      ...fallback,
      startsAtTextUser: isTextUserRow(messages[fallback.start] ?? messages[messages.length - 1]!),
    }
  }
  const end = messages.length
  let start = grouping.groups[grouping.groups.length - 1]!.start
  let used = estimateTokens(messages.slice(start, end))
  for (let index = grouping.groups.length - 2; index >= 0; index -= 1) {
    const group = grouping.groups[index]!
    const groupTokens = estimateTokens(messages.slice(group.start, group.end))
    if (used + groupTokens > tailBudgetTokens) break
    used += groupTokens
    start = group.start
  }
  const snapped = selectToolPairSafeRange(messages, start, end)
  if (isTextUserRow(messages[snapped.start]!)) {
    return { ...snapped, startsAtTextUser: true }
  }
  let backtrack = snapped.start - 1
  while (backtrack >= 0 && !isTextUserRow(messages[backtrack]!)) backtrack -= 1
  if (
    backtrack >= 0 &&
    estimateTokens(messages.slice(backtrack, end)) <= tailBudgetTokens &&
    validateBoundaryArray(messages.slice(backtrack, end)).length === 0
  ) {
    // Extending to the anchor must not re-admit an orphaned result that the
    // snap just dropped.
    return { start: backtrack, end, startsAtTextUser: true }
  }
  return { ...snapped, startsAtTextUser: false }
}

// ---------------------------------------------------------------------------
// Shrink ladder levels 1 and 2
// ---------------------------------------------------------------------------

export const TOOL_RESULT_COMPACT_MAX_CHARS = 512
const TOOL_RESULT_TRUNCATION_SUFFIX = "…[truncated]"

/** Ladder level 1: cap every tool_result body in the tail, pairing intact. */
export function truncateTailContents(messages: readonly Message[]): Message[] {
  const limit = TOOL_RESULT_COMPACT_MAX_CHARS - TOOL_RESULT_TRUNCATION_SUFFIX.length
  return messages.map((message) => {
    const content = message.message.content
    if (typeof content === "string") return message
    let changed = false
    const next = content.map((block) => {
      if (block.type !== "tool_result" || block.content.length <= TOOL_RESULT_COMPACT_MAX_CHARS) return block
      changed = true
      return { ...block, content: `${block.content.slice(0, limit)}${TOOL_RESULT_TRUNCATION_SUFFIX}` }
    })
    return changed ? replaceBlockContent(message, next) : message
  })
}

function replaceBlockContent(message: Message, content: ContentBlock[]): Message {
  if (message.type === "user") {
    return { ...message, message: { role: "user", content } }
  }
  return { ...message, message: { role: "assistant", content } }
}

export const TEXT_TRUNCATION_MARKER = " […truncated]"

/**
 * Ladder level 2: shrink one oversized message to a token budget by
 * truncating text content only. tool_use/tool_result blocks (and their ids)
 * pass through verbatim so pairing survives; when the preserved blocks alone
 * exceed the budget the message returns unchanged and the ladder drops
 * groups instead.
 */
export function truncateOversizedMessage(message: Message, budgetTokens: number): Message {
  if (estimateTokensMessage(message) <= budgetTokens) return message
  const content = message.message.content
  if (typeof content === "string") {
    const chars = Math.max(0, (budgetTokens - 4) * 4 - TEXT_TRUNCATION_MARKER.length)
    if (message.type !== "user") return message
    return {
      ...message,
      message: { role: "user", content: `${content.slice(0, chars)}${TEXT_TRUNCATION_MARKER}` },
    }
  }
  let preservedChars = 0
  for (const block of content) {
    if (block.type === "text") continue
    if (block.type === "thinking") preservedChars += block.thinking.length
    else if (block.type === "tool_use") preservedChars += JSON.stringify(block.input).length
    else if (block.type === "tool_result") preservedChars += block.content.length
  }
  const available = Math.max(0, (budgetTokens - 4 - Math.ceil(preservedChars / 4)) * 4 - TEXT_TRUNCATION_MARKER.length)
  let remaining = available
  let cut = false
  const next: ContentBlock[] = []
  for (const block of content) {
    if (block.type !== "text") {
      next.push(block)
      continue
    }
    if (remaining <= 0) {
      cut = true
      continue
    }
    if (block.text.length <= remaining) {
      remaining -= block.text.length
      next.push(block)
      continue
    }
    cut = true
    next.push({
      type: "text",
      text: `${block.text.slice(0, remaining - TEXT_TRUNCATION_MARKER.length)}${TEXT_TRUNCATION_MARKER}`,
    })
    remaining = 0
  }
  if (!cut) return message
  return replaceBlockContent(message, next)
}

// ---------------------------------------------------------------------------
// L3a quote ledger
// ---------------------------------------------------------------------------

export const USER_QUOTE_MAX_CHARS = 4_000

// The ledger grammar needs the checksum inline in synchronous emit/parse.
// node:crypto is not importable from this package and Web Crypto's digest
// is async, so SHA-256 runs here as a plain function over UTF-8 bytes.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const bitLength = bytes.length * 8
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000))
  view.setUint32(padded.length - 4, bitLength >>> 0)

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let a = h[0]!
    let b = h[1]!
    let c = h[2]!
    let d = h[3]!
    let e = h[4]!
    let f = h[5]!
    let g = h[6]!
    let hh = h[7]!
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0]! + a) >>> 0
    h[1] = (h[1]! + b) >>> 0
    h[2] = (h[2]! + c) >>> 0
    h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0
    h[5] = (h[5]! + f) >>> 0
    h[6] = (h[6]! + g) >>> 0
    h[7] = (h[7]! + hh) >>> 0
  }
  let hex = ""
  for (const word of h) hex += word.toString(16).padStart(8, "0")
  return hex
}

function sha256Hex16(value: string): string {
  return sha256Hex(value).slice(0, 16)
}

/**
 * Render ledger entries as quote lines (no header). Each entry is truncated
 * to USER_QUOTE_MAX_CHARS before hashing, so the checksum covers exactly the
 * bytes a later parse will read back.
 */
export function emitPreservedUsers(entries: readonly string[]): readonly string[] {
  const lines: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const content = entry.length > USER_QUOTE_MAX_CHARS ? entry.slice(0, USER_QUOTE_MAX_CHARS) : entry
    lines.push(`[quote ${index + 1} ${sha256Hex16(content)}]`, ...content.split("\n"), `[/quote ${index + 1}]`)
  }
  return lines
}

export type PreservedUsersParse =
  { readonly ok: true; readonly entries: readonly string[] } | { readonly ok: false; readonly reason: string }

const QUOTE_OPEN_PATTERN = /^\[quote (\d+) ([0-9a-f]{16})\]$/

/**
 * Parse ledger body lines under three predicates: strictly increasing quote
 * numbers from 1, a sha256-16 checksum over all content lines, and only
 * empty lines after the final close. Any violation degrades the whole
 * section — a partial carry-forward is never silently adopted.
 */
export function parsePreservedUsers(lines: readonly string[]): PreservedUsersParse {
  const entries: string[] = []
  let index = 0
  while (index < lines.length && lines[index] === "") index += 1
  while (index < lines.length) {
    const open = QUOTE_OPEN_PATTERN.exec(lines[index]!)
    if (open === null || Number(open[1]) !== entries.length + 1) {
      return { ok: false, reason: `quote-open:${index}` }
    }
    const close = `[/quote ${entries.length + 1}]`
    index += 1
    const contentStart = index
    while (index < lines.length && lines[index] !== close) index += 1
    if (index === lines.length) {
      return { ok: false, reason: `quote-close:${index}` }
    }
    const content = lines.slice(contentStart, index).join("\n")
    if (sha256Hex16(content) !== open[2]) {
      return { ok: false, reason: `checksum:${index}` }
    }
    entries.push(content)
    index += 1
    while (index < lines.length && lines[index] === "") index += 1
  }
  return { ok: true, entries }
}

function estimatePreservedUsersTokens(entries: readonly string[]): number {
  // Each entry carries ~30 chars of delimiter scaffold.
  return entries.reduce((sum, entry) => sum + Math.ceil(entry.length / 4) + 12, 0)
}

/**
 * Collect the ledger for the next boundary: carry the entries of the most
 * recent boundary block forward, append the region's text-user rows after
 * it, then fit the users budget by omitting whole entries from the oldest
 * side. A degraded or absent carry contributes nothing; the newest entry
 * may be dropped entirely when even it cannot fit.
 */
export function collectRetainedUsers(summarizeRegion: readonly Message[], usersBudgetTokens: number): readonly string[] {
  let lastBoundaryIndex = -1
  for (let index = summarizeRegion.length - 1; index >= 0; index -= 1) {
    if (isCompactionBoundaryMessage(summarizeRegion[index]!)) {
      lastBoundaryIndex = index
      break
    }
  }
  const carried: readonly string[] = lastBoundaryIndex === -1 ? [] : carryFromBoundary(summarizeRegion[lastBoundaryIndex]!)
  const fresh: string[] = []
  for (let index = lastBoundaryIndex + 1; index < summarizeRegion.length; index += 1) {
    const text = textUserRowText(summarizeRegion[index]!)
    if (text !== null) fresh.push(text)
  }
  const merged = [...carried, ...fresh]
  while (merged.length > 0 && estimatePreservedUsersTokens(merged) > usersBudgetTokens) {
    merged.shift()
  }
  return merged
}

function carryFromBoundary(block: Message): readonly string[] {
  const content = block.message.content
  if (typeof content !== "string") return []
  const section = preservedUsersLinesFromBoundary(content)
  if (section === undefined) return []
  const parsed = parsePreservedUsers(section)
  return parsed.ok ? parsed.entries : []
}

// ---------------------------------------------------------------------------
// Product validation
// ---------------------------------------------------------------------------

/**
 * INV: every tool_result in a compact product must answer a tool_use carried
 * by an earlier message of the same array. Returns the orphaned ids.
 */
export function validateBoundaryArray(messages: readonly Message[]): readonly string[] {
  const uses = new Set<string>()
  const orphans: string[] = []
  for (const message of messages) {
    const content = message.message.content
    if (typeof content === "string") continue
    for (const block of content) {
      if (block.type === "tool_use") {
        uses.add(block.id)
      } else if (block.type === "tool_result" && !uses.has(block.tool_use_id)) {
        orphans.push(block.tool_use_id)
      }
    }
  }
  return orphans
}
