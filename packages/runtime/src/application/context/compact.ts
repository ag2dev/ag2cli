import type { Message, ContentBlock } from "@ag2cli/core/message.js"
import { userText, assistantText } from "@ag2cli/core/message.js"
import type { ApiToolDefinition } from "@ag2cli/core/tool-facts.js"
import { DEFAULT_THRESHOLDS, type CompactThresholds } from "@ag2cli/core/model/limits.js"
import {
  budgetsFor,
  collectRetainedUsers,
  emitPreservedUsers,
  estimateTokens,
  MIN_NOTES_CAP_TOKENS,
  partitionGroups,
  selectTailByGroups,
  truncateOversizedMessage,
  truncateTailContents,
  validateBoundaryArray,
  watermarkFor,
  type CompactBudgets,
  type ConversationGrouping,
} from "./compact-budgets.js"
import { buildSyntheticBoundaryBlock, isCompactionBoundaryMessage } from "./compact-boundary.js"
import { clampSummaryToCap, summaryPrompt } from "./compact-prompt.js"

export { estimateTokens } from "./compact-budgets.js"

function estimateSerializedTokens(value: unknown, envelopeTokens = 0): number {
  const serialized = JSON.stringify(value)
  return Math.ceil((serialized?.length ?? 0) / 4) + envelopeTokens
}

/**
 * Request-level context accounting used by the compact boundary.
 *
 * This is deliberately provider-neutral. It is a bounded estimate for
 * compatible endpoints, not a replacement for a model-specific tokenizer.
 * The system prompt already contains request context, attachments and loaded
 * memory, so those values must not be counted a second time here.
 */
export interface ContextUsage {
  readonly totalTokens: number
  readonly messageTokens: number
  readonly systemPromptTokens: number
  readonly toolTokens: number
}

export interface ContextUsageInput {
  readonly messages: readonly Message[]
  readonly systemPrompt?: readonly string[]
  readonly tools?: readonly ApiToolDefinition[]
}

export function estimateRequestUsage(input: ContextUsageInput): ContextUsage {
  const messageTokens = estimateTokens(input.messages)
  const systemPromptTokens =
    input.systemPrompt === undefined || input.systemPrompt.length === 0 ? 0 : estimateSerializedTokens(input.systemPrompt, 4)
  const toolTokens = input.tools === undefined || input.tools.length === 0 ? 0 : estimateSerializedTokens(input.tools, 8)
  return {
    totalTokens: messageTokens + systemPromptTokens + toolTokens,
    messageTokens,
    systemPromptTokens,
    toolTokens,
  }
}

export function assessContext(
  messages: Message[],
  thresholds: CompactThresholds = DEFAULT_THRESHOLDS,
): { tokens: number; shouldCompact: boolean; isBlockingLimit: boolean } {
  const messageTokens = estimateTokens(messages)
  return assessRequest({ totalTokens: messageTokens, messageTokens, systemPromptTokens: 0, toolTokens: 0 }, thresholds)
}

export function assessRequest(
  usage: ContextUsage,
  thresholds: CompactThresholds = DEFAULT_THRESHOLDS,
): { tokens: number; shouldCompact: boolean; isBlockingLimit: boolean; usage: ContextUsage } {
  const tokens = usage.totalTokens
  return {
    tokens,
    shouldCompact: tokens > thresholds.autoCompactTokens,
    isBlockingLimit: tokens > thresholds.blockingLimitTokens,
    usage,
  }
}

export const MAX_CONSECUTIVE_COMPACT_FAILURES = 3
export const COMPACT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000
export type BreakerState = "closed" | "open"
export interface CircuitBreaker {
  readonly state: BreakerState
  readonly consecutiveFailures: number
  readonly retryAtMs?: number
}

export function newBreaker(): CircuitBreaker {
  return { state: "closed", consecutiveFailures: 0 }
}

export function breakerOnSuccess(_breaker?: CircuitBreaker): CircuitBreaker {
  return newBreaker()
}

export function breakerCanAttempt(breaker: CircuitBreaker, nowMs = Date.now()): boolean {
  if (breaker.state === "closed") return true
  return breaker.retryAtMs !== undefined && nowMs >= breaker.retryAtMs
}

export function breakerOnFailure(breaker: CircuitBreaker, nowMs = Date.now(), cooldownMs = COMPACT_FAILURE_COOLDOWN_MS): CircuitBreaker {
  const consecutiveFailures = Math.min(MAX_CONSECUTIVE_COMPACT_FAILURES, breaker.consecutiveFailures + 1)
  const retryAtMs = consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES ? nowMs + Math.max(0, cooldownMs) : undefined
  return {
    consecutiveFailures,
    state: consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES ? "open" : "closed",
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
  }
}

// ---------------------------------------------------------------------------
// Summary input compression
// ---------------------------------------------------------------------------

const SUMMARY_INPUT_TEXT_MAX_CHARS = 2_000
const SUMMARY_INPUT_TOTAL_MAX_CHARS = 120_000
const SUMMARY_INPUT_TRUNCATION_MARKER = " […truncated]"

function blockChars(block: ContentBlock): number {
  if (block.type === "text") return block.text.length
  if (block.type === "thinking") return 0
  if (block.type === "tool_use") return JSON.stringify(block.input).length
  return block.content.length
}

function messageChars(message: Message): number {
  const content = message.message.content
  if (typeof content === "string") return content.length
  return content.reduce((sum, block) => sum + blockChars(block), 0)
}

function capText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - SUMMARY_INPUT_TRUNCATION_MARKER.length)}${SUMMARY_INPUT_TRUNCATION_MARKER}`
}

function compressSummaryMessage(message: Message): Message {
  const content = message.message.content
  if (typeof content === "string") {
    if (message.type !== "user") return message
    return { ...message, message: { role: "user", content: capText(content, SUMMARY_INPUT_TEXT_MAX_CHARS) } }
  }
  let changed = false
  const kept: ContentBlock[] = []
  for (const block of content) {
    if (block.type === "thinking") {
      changed = true
      continue
    }
    if (block.type === "text" && block.text.length > SUMMARY_INPUT_TEXT_MAX_CHARS) {
      changed = true
      kept.push({ type: "text", text: capText(block.text, SUMMARY_INPUT_TEXT_MAX_CHARS) })
      continue
    }
    kept.push(block)
  }
  const base = changed ? replaceContent(message, kept) : message
  // tool_result bodies share the tail cap through the ladder-1 truncator.
  return truncateTailContents([base])[0]!
}

function replaceContent(message: Message, content: ContentBlock[]): Message {
  if (message.type === "user") return { ...message, message: { role: "user", content } }
  return { ...message, message: { role: "assistant", content } }
}

/**
 * Deterministic compression of the summarize region before the model call:
 * thinking blocks drop, text caps at 2K chars, tool_result bodies reuse the
 * 512-char tail cap, and prior boundary blocks pass verbatim under a shared
 * character budget — when the budget overflows, the oldest non-boundary
 * messages drop first. Boundary mass intentionally counts against this
 * budget: the region feeds a summary-of-summaries call, so stale boundaries
 * must yield to fresh content.
 */
export function compressSummaryInput(region: readonly Message[], autoCompactTokens: number): Message[] {
  const totalCap = Math.min(SUMMARY_INPUT_TOTAL_MAX_CHARS, autoCompactTokens * 4)
  const compressed = region.map((message) => (isCompactionBoundaryMessage(message) ? message : compressSummaryMessage(message)))
  let total = compressed.reduce((sum, message) => sum + messageChars(message), 0)
  const kept: Message[] = []
  for (const message of compressed) {
    if (total <= totalCap) kept.push(message)
    else if (isCompactionBoundaryMessage(message)) kept.push(message)
    else total -= messageChars(message)
  }
  return kept
}

// ---------------------------------------------------------------------------
// Compact product construction
// ---------------------------------------------------------------------------

export const TIER2_SUMMARY_PLACEHOLDER =
  "A model summary was unavailable, so the earlier conversation was compacted structurally. Use the session history to retrieve earlier turns."

const ACK_TEXT = "Understood. I have read the compaction boundary and will continue from there."

export interface CompactHistoryOptions {
  /** Effective thresholds; the watermark and default budgets derive from auto. */
  readonly thresholds?: CompactThresholds
  readonly budgets?: CompactBudgets
  /**
   * Request fragments outside the replaceable messages (system prompt, tool
   * schemas, context fragments), used for post-compaction accounting.
   */
  readonly fragmentsTokens?: number
  /** 1 = model summary, 2 = deterministic structural fallback. */
  readonly tier?: 1 | 2
  readonly includeHistoryGuidance?: boolean
  readonly transcriptPath?: string
  /**
   * Pre-validated session notes section text. Omitted entirely while the
   * effective notesCap stays below MIN_NOTES_CAP_TOKENS, and dropped at
   * shrink-ladder level 5 and above.
   */
  readonly notes?: string
  readonly instructions?: string
}

function shrinkOversizedMessages(tail: readonly Message[], tailBudgetTokens: number): Message[] {
  let total = estimateTokens(tail)
  const out: Message[] = []
  for (const message of tail) {
    const messageTokens = estimateTokens([message])
    const allowance = tailBudgetTokens - (total - messageTokens)
    if (allowance > 0 && messageTokens > allowance) {
      const truncated = truncateOversizedMessage(message, allowance)
      total += estimateTokens([truncated]) - messageTokens
      out.push(truncated)
    } else {
      out.push(message)
    }
  }
  return out
}

interface TailSlice {
  readonly start: number
  readonly end: number
  readonly messages: readonly Message[]
}

/**
 * The tail at a shrink-ladder level: level 1 caps tool_result bodies, level 2
 * additionally truncates oversized single messages, and level 3 additionally
 * drops the oldest whole groups while more than one group remains.
 */
function tailAtLevel(messages: readonly Message[], grouping: ConversationGrouping, tailBudgetTokens: number, level: number): TailSlice {
  const selection = selectTailByGroups(messages, grouping, tailBudgetTokens)
  let start = selection.start
  const build = (): readonly Message[] => {
    let tail = messages.slice(start, selection.end)
    tail = truncateTailContents(tail)
    if (level >= 2) tail = shrinkOversizedMessages(tail, tailBudgetTokens)
    return tail
  }
  let tail = build()
  while (level >= 3 && estimateTokens(tail) > tailBudgetTokens) {
    const next = grouping.groups.find((group) => group.start > start)
    if (next === undefined) break // the last group is never dropped whole
    start = next.start
    tail = build()
  }
  return { start, end: selection.end, messages: tail }
}

/**
 * Rewrite the history as [boundary block, ack, ...real tail]. The product is
 * built with budgets derived from the effective auto threshold; when the
 * request fragments push the post-compaction total past the watermark, the
 * shrink ladder escalates level by level to a Tier-2 structural product and
 * finally throws when even that cannot fit under the blocking limit.
 */
export async function compactHistory(
  messages: Message[],
  summarize: (messages: Message[]) => Promise<string>,
  options: CompactHistoryOptions = {},
): Promise<Message[]> {
  if (messages.length === 0) return messages
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS
  const budgets = options.budgets ?? budgetsFor(watermarkFor(thresholds.autoCompactTokens))
  const watermark = watermarkFor(thresholds.autoCompactTokens)
  const fragments = Math.max(0, Math.trunc(options.fragmentsTokens ?? 0))
  const grouping = partitionGroups(messages)

  const initial = selectTailByGroups(messages, grouping, budgets.tailBudget)
  let summary: string | undefined
  if ((options.tier ?? 1) === 2) {
    summary = TIER2_SUMMARY_PLACEHOLDER
  } else if (initial.start > 0) {
    const summaryInput = compressSummaryInput(messages.slice(0, initial.start), thresholds.autoCompactTokens)
    const prompt = userText(summaryPrompt(options.instructions === undefined ? {} : { instructions: options.instructions }))
    const text = await summarize([prompt, ...summaryInput])
    summary = clampSummaryToCap(text, budgets.summaryCap)
  }

  let usersBudget = budgets.usersBudget
  const notesText =
    options.notes !== undefined && options.notes.length > 0 && budgets.notesCap >= MIN_NOTES_CAP_TOKENS ? options.notes : undefined
  let product: Message[] | undefined
  let postTotal = 0
  for (let level = 1; level <= 6; level += 1) {
    if (level === 4) usersBudget = Math.floor(usersBudget / 2)
    const tail = tailAtLevel(messages, grouping, budgets.tailBudget, level)
    const summaryText = summary ?? (level >= 6 ? TIER2_SUMMARY_PLACEHOLDER : undefined)
    const ledger = collectRetainedUsers(messages.slice(0, tail.start), usersBudget)
    const block = buildSyntheticBoundaryBlock({
      ...(summaryText === undefined ? {} : { summary: summaryText }),
      ...(ledger.length > 0 ? { preservedUserLines: emitPreservedUsers(ledger) } : {}),
      includeHistoryGuidance: options.includeHistoryGuidance ?? false,
      ...(options.transcriptPath === undefined ? {} : { transcriptPath: options.transcriptPath }),
      ...(notesText !== undefined && level < 5 ? { notes: notesText } : {}),
    })
    const candidate: Message[] = [block, assistantText(ACK_TEXT, "end_turn"), ...tail.messages]
    const orphans = validateBoundaryArray(candidate)
    if (orphans.length > 0) {
      throw new Error(`Compact product broke tool pairing for ids: ${orphans.join(", ")}`)
    }
    product = candidate
    postTotal = fragments + estimateTokens(candidate)
    if (postTotal <= watermark) return candidate
  }
  if (postTotal > thresholds.blockingLimitTokens) {
    throw new Error(`Compaction cannot fit the context under the blocking limit (${postTotal} tokens)`)
  }
  return product!
}
