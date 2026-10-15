import type { AssistantMessage, ContentBlock } from "@ag2cli/core/message.js"

export interface OpenAIUsageLike {
  readonly prompt_tokens?: unknown
  readonly completion_tokens?: unknown
  readonly total_tokens?: unknown
  readonly prompt_tokens_details?: { readonly cached_tokens?: unknown }
  readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown }
}

export interface OpenAIChoiceLike {
  readonly finish_reason?: unknown
  readonly message?: Record<string, unknown>
}

export interface OpenAICompletionLike {
  readonly id?: unknown
  readonly model?: unknown
  readonly choices?: readonly OpenAIChoiceLike[]
  readonly usage?: OpenAIUsageLike
}

export interface OpenAIResponseParts {
  readonly thinking: string
  readonly text: string
}

export function normalizeOpenAIResponse(
  response: OpenAICompletionLike,
  parseThinkTags: boolean,
  visibleReasoningDetailTypes: readonly string[] = [],
): { readonly content: ContentBlock[]; readonly choice: OpenAIChoiceLike | undefined } {
  const choice = response.choices?.[0]
  const message = choice?.message
  if (!message) return { content: [], choice }
  const parts = normalizeOpenAIParts(message, parseThinkTags, visibleReasoningDetailTypes)
  const content: ContentBlock[] = []
  if (parts.thinking) content.push({ type: "thinking", thinking: parts.thinking })
  if (parts.text) content.push({ type: "text", text: parts.text })
  for (const toolCall of readToolCalls(message.tool_calls, message.function_call)) {
    content.push(toolCall)
  }
  return { content, choice }
}

export function normalizeOpenAIParts(
  message: Record<string, unknown>,
  parseThinkTags: boolean,
  visibleReasoningDetailTypes: readonly string[] = [],
): OpenAIResponseParts {
  const reasoningDetails = reasoningDetailsParts(message.reasoning_details, visibleReasoningDetailTypes)
  const structuredThinking = firstNonEmpty([
    reasoningValueText(message.reasoning_content),
    reasoningValueText(message.reasoning),
    reasoningValueText(message.reasoning_text),
    reasoningDetails.thinking,
  ])
  const normalizedContent = contentParts(message.content)
  const rawText = normalizedContent.text
  const tagged = parseThinkTags ? splitThinkTags(rawText) : { text: rawText }
  return {
    thinking: structuredThinking ?? (normalizedContent.thinking || tagged.thinking || ""),
    // Explicit response.* detail types are a visible source. Prefer the
    // ordinary content field when both are present because compatible
    // providers may mirror the same answer in both locations.
    text: tagged.text || reasoningDetails.text,
  }
}

export function readReasoningDelta(
  delta: Record<string, unknown>,
  visibleReasoningDetailTypes: readonly string[] = [],
): OpenAIResponseParts {
  const reasoningDetails = reasoningDetailsParts(delta.reasoning_details, visibleReasoningDetailTypes)
  return {
    thinking:
      firstNonEmpty([
        reasoningValueText(delta.reasoning_content),
        reasoningValueText(delta.reasoning),
        reasoningValueText(delta.reasoning_text),
        reasoningDetails.thinking,
      ]) ?? "",
    text: reasoningDetails.text ?? "",
  }
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) {
    const record = recordValue(value)
    return textValue(record?.text) ?? textValue(record?.content) ?? ""
  }
  return value
    .map((part) => {
      if (typeof part === "string") return part
      const record = recordValue(part)
      if (!record) return ""
      if (isThinkingPart(record)) return ""
      return textValue(record.text) ?? textValue(record.content) ?? ""
    })
    .join("")
}

/** Normalize content arrays used by newer Chat Completions-compatible servers. */
export function contentParts(value: unknown): OpenAIResponseParts {
  if (!Array.isArray(value)) return { thinking: "", text: contentText(value) }
  let thinking = ""
  let text = ""
  for (const part of value) {
    if (typeof part === "string") {
      text += part
      continue
    }
    const record = recordValue(part)
    if (!record) continue
    const partText = textValue(record.text) ?? textValue(record.content) ?? ""
    if (isThinkingPart(record)) thinking += partText
    else text += partText
  }
  return { thinking, text }
}

export function splitThinkTags(value: string): { readonly thinking?: string; readonly text: string } {
  const match = value.match(/^\s*<(thinking|think)>([\s\S]*?)<\/\1>([\s\S]*)$/iu)
  if (!match) return { text: value }
  const thinking = match[2] ?? ""
  const text = match[3] ?? ""
  return thinking.length > 0 ? { thinking, text } : { text }
}

export function readToolCalls(value: unknown, legacyValue?: unknown): ContentBlock[] {
  const calls = Array.isArray(value)
    ? value.flatMap((item) => {
        const record = recordValue(item)
        const fn = recordValue(record?.function)
        if (!record || record.type !== "function" || typeof record.id !== "string" || !fn) return []
        const name = typeof fn.name === "string" ? fn.name : ""
        const argumentsText = typeof fn.arguments === "string" ? fn.arguments : "{}"
        return [
          {
            type: "tool_use" as const,
            id: record.id,
            name,
            input: parseToolInput(argumentsText),
          },
        ]
      })
    : []
  if (calls.length > 0) return calls
  const legacy = recordValue(legacyValue)
  if (!legacy || typeof legacy.name !== "string") return []
  const argumentsText = typeof legacy.arguments === "string" ? legacy.arguments : "{}"
  return [{ type: "tool_use", id: "tool_call_0", name: legacy.name, input: parseToolInput(argumentsText) }]
}

export function makeAssistantMessage(
  content: ContentBlock[],
  stopReason: string | undefined,
  metadata?: AssistantMessage["modelMetadata"],
): AssistantMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content },
    ...(stopReason ? { stop_reason: stopReason } : {}),
    ...(metadata ? { modelMetadata: metadata } : {}),
  }
}

export class ThinkTagStreamParser {
  private mode: "undecided" | "thinking" | "text" = "undecided"
  private buffer = ""
  private thinkingBuffer = ""
  private openingTag: "<think>" | "<thinking>" | undefined

  feed(value: string): OpenAIResponseParts {
    if (!value) return { thinking: "", text: "" }
    if (this.mode === "text") return { thinking: "", text: value }
    if (this.mode === "thinking") this.thinkingBuffer += value
    else this.buffer += value
    if (this.mode === "undecided") {
      const trimmed = this.buffer.replace(/^\s*/u, "")
      const normalized = trimmed.toLowerCase()
      const opening = ["<thinking>", "<think>"].find((tag) => normalized.startsWith(tag))
      const partial = ["<thinking>", "<think>"].some((tag) => tag.startsWith(normalized) && normalized.length < tag.length)
      if (partial) {
        return { thinking: "", text: "" }
      }
      if (opening === "<thinking>" || opening === "<think>") {
        this.mode = "thinking"
        this.openingTag = opening
        this.thinkingBuffer = trimmed.slice(opening.length)
        this.buffer = ""
      } else {
        this.mode = "text"
        const text = this.buffer
        this.buffer = ""
        return { thinking: "", text }
      }
    }
    const closeTag = this.openingTag === "<thinking>" ? "</thinking>" : "</think>"
    const close = this.thinkingBuffer.toLowerCase().indexOf(closeTag)
    if (close === -1) return { thinking: "", text: "" }
    const thinking = this.thinkingBuffer.slice(0, close)
    const text = this.thinkingBuffer.slice(close + closeTag.length)
    this.thinkingBuffer = ""
    this.openingTag = undefined
    this.mode = "text"
    return { thinking, text }
  }

  finish(): OpenAIResponseParts {
    if (this.mode === "text") return { thinking: "", text: "" }
    if (this.mode === "undecided") {
      const text = this.buffer
      this.buffer = ""
      return { thinking: "", text }
    }
    const text = `${this.openingTag ?? "<think>"}${this.thinkingBuffer}`
    this.thinkingBuffer = ""
    this.openingTag = undefined
    this.mode = "text"
    return { thinking: "", text }
  }
}

function reasoningDetailsParts(value: unknown, visibleReasoningDetailTypes: readonly string[]): OpenAIResponseParts {
  if (!Array.isArray(value)) return { thinking: "", text: "" }
  const visibleTypes = new Set(visibleReasoningDetailTypes.map((type) => type.toLowerCase()))
  let thinking = ""
  let text = ""
  for (const item of value) {
    const record = recordValue(item)
    if (!record) continue
    const type = typeof record.type === "string" ? record.type.toLowerCase() : ""
    const partText = reasoningDetailItemText(record)
    if (!partText) continue
    if (visibleTypes.has(type)) text += partText
    else thinking += partText
  }
  return { thinking, text }
}

function reasoningDetailItemText(record: Record<string, unknown>): string | undefined {
  const direct = textValue(record.text) ?? textValue(record.reasoning)
  if (direct) return direct
  return reasoningValueText(record.summary)
}

function reasoningValueText(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return joinNonEmpty(value.map((item) => reasoningValueText(item)))
  }
  const record = recordValue(value)
  return textValue(record?.text) ?? textValue(record?.content) ?? textValue(record?.summary) ?? textValue(record?.reasoning)
}

function firstNonEmpty(values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0)
}

function joinNonEmpty(values: readonly (string | undefined)[]): string | undefined {
  const joined = values.filter((value): value is string => value !== undefined && value.length > 0).join("")
  return joined.length > 0 ? joined : undefined
}

function isThinkingPart(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type.toLowerCase() : ""
  return type === "thinking" || type === "reasoning" || type.includes("reasoning") || type.includes("thinking")
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function parseToolInput(value: string): unknown {
  if (!value.trim()) return {}
  try {
    return JSON.parse(value) as unknown
  } catch {
    return { _raw: value }
  }
}
