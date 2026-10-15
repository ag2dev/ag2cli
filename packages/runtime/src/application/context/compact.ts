import type { Message, ContentBlock } from "@ag2cli/core/message.js"
import { userText, assistantText } from "@ag2cli/core/message.js"
import type { ApiToolDefinition } from "@ag2cli/core/tool-facts.js"
import { DEFAULT_THRESHOLDS, type CompactThresholds } from "@ag2cli/core/model/limits.js"

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

function estimateSerializedTokens(value: unknown, envelopeTokens = 0): number {
  const serialized = JSON.stringify(value)
  return Math.ceil((serialized?.length ?? 0) / 4) + envelopeTokens
}

export function estimateTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + estimateTokensMessage(message), 0)
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
  return assessRequest({ totalTokens: messageTokens, messageTokens, systemPromptTokens: 0, toolTokens: 0 }, messages.length, thresholds)
}

export function assessRequest(
  usage: ContextUsage,
  messageCount: number,
  thresholds: CompactThresholds = DEFAULT_THRESHOLDS,
): { tokens: number; shouldCompact: boolean; isBlockingLimit: boolean; usage: ContextUsage } {
  const tokens = usage.totalTokens
  return {
    tokens,
    shouldCompact: tokens > thresholds.autoCompactTokens && messageCount > 4,
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
function selectToolPairSafeRange(
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

export async function compactHistory(
  messages: Message[],
  summarize: (messages: Message[]) => Promise<string>,
  options: { readonly keepTail?: number; readonly instructions?: string } = {},
): Promise<Message[]> {
  const keepTail = Math.max(0, Math.trunc(options.keepTail ?? 2))
  if (messages.length <= keepTail + 1) return messages

  const tailRange = selectToolPairSafeRange(messages, messages.length - keepTail, messages.length)
  const toSummarize = messages.slice(0, tailRange.start)
  const tail = messages.slice(tailRange.start, tailRange.end)
  const transcript = toSummarize
    .map((message) => {
      const content = message.message.content
      const text =
        typeof content === "string"
          ? content
          : content
              .map((block: ContentBlock) => {
                if (block.type === "text") return block.text
                if (block.type === "tool_use") return `[tool:${block.name}]`
                if (block.type === "tool_result") return block.content
                return ""
              })
              .join(" ")
      return `${message.message.role}: ${text}`
    })
    .join("\n\n")
    .slice(0, 12000)
  const extra = options.instructions?.trim()
  const summary = await summarize([
    userText(
      [
        "Summarize the following conversation history concisely (preserve key facts, decisions, and action items; under 200 words):",
        ...(extra ? [`Additional summarization requirements: ${extra}`] : []),
        "",
        transcript,
      ].join("\n\n"),
    ),
  ])
  return [
    userText(`[Summary of the previous conversation]\n${summary}`),
    assistantText("Understood. I have read the summary of the previous conversation. Please continue.", "end_turn"),
    ...tail,
  ]
}
