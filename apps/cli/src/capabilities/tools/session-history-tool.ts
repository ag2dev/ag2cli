/**
 * SessionHistoryTool — session conversation history retrieval.
 *
 * The corpus is the segment-folded full history: every pre-compaction
 * segment stays retrievable while the compaction boundary blocks
 * themselves never enter it. The tool is session-bound — it reads the
 * canonical event stream named by the executor's execution context,
 * never a caller-supplied path — so its output carries the same trust
 * posture as other read-only views of past conversation content.
 */

import { z } from "zod/v4"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { Message } from "@ag2cli/core/message.js"
import { foldConversationSegments } from "@ag2cli/core/session/message-history.js"
import { projectConversationEvents } from "@ag2cli/core/session/session-projection.js"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import { tokenize } from "@ag2cli/runtime/application/memory/retrieve.js"
import type { Tool, ToolContext } from "@ag2cli/runtime/ports/tool/contract.js"

const MAX_MESSAGE_CHARS = 2_000
const MAX_RESPONSE_CHARS = 16_000
/** Reserved tail room so the continuation footer keeps a response within the cap. */
const FOOTER_BUDGET = 160

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search"),
    query: z.string().min(1).describe("Keyword query; every message in the session history is matched"),
    limit: z.number().int().positive().max(100).optional().describe("Maximum matching messages to return; defaults to 20"),
  }),
  z.object({
    action: z.literal("read"),
    offset: z.number().int().positive().optional().describe("1-based message number to start from; defaults to 1"),
    limit: z.number().int().positive().max(500).optional().describe("Maximum messages to return; defaults to 100"),
    charOffset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "0-based character start within the first message; pass the value from a truncation trailer to continue that message verbatim",
      ),
  }),
])

export interface SessionHistoryToolDeps {
  /** Canonical event source of the executing session; composition owns the store. */
  readonly events: (sessionId: SessionId) => Promise<readonly AgentEvent[]>
}

export class SessionHistoryTool implements Tool<typeof inputSchema> {
  readonly name = "session_history"
  readonly description =
    "Read this session's own conversation history, including every segment already removed by context compaction. " +
    "search finds messages by keywords and reports their message numbers; read pages messages by 1-based offset. " +
    "Each message is shown up to 2000 characters; a truncated message ends with a trailer giving the charOffset that continues it verbatim. " +
    "Only the active lineage is visible and there is no path parameter — the tool always reads the current session."
  readonly inputSchema = inputSchema

  constructor(private readonly deps: SessionHistoryToolDeps) {}

  async call(args: z.infer<typeof inputSchema>, context?: ToolContext): Promise<ToolResult> {
    try {
      const sessionId = context?.execution?.sessionId
      if (sessionId === undefined) {
        return { content: "session_history requires a session execution context", isError: true }
      }
      const events = await this.deps.events(sessionId)
      const corpus = foldConversationSegments(projectConversationEvents(events))
      if (args.action === "search") return search(corpus, args.query, args.limit ?? 20)
      return read(corpus, args.offset ?? 1, args.limit ?? 100, args.charOffset)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Failed to read history: ${msg}`, isError: true }
    }
  }

  isReadOnly(): boolean {
    return true
  }

  /** Read-only over an immutable stream; safe to execute concurrently. */
  isConcurrencySafe(): boolean {
    return true
  }
}

function read(corpus: readonly Message[], offset: number, limit: number, charOffset: number | undefined): ToolResult {
  if (corpus.length === 0) return { content: "No session history yet." }
  if (offset > corpus.length) {
    return { content: `offset ${offset} is beyond the session history (${corpus.length} messages)`, isError: true }
  }
  const entries: string[] = []
  let used = 0
  let stopped = false
  let lastIndex = 0
  for (let i = offset - 1; i < corpus.length && entries.length < limit; i++) {
    const message = corpus[i]!
    const text = messageText(message)
    const start = i === offset - 1 ? (charOffset ?? 0) : 0
    if (start !== 0 && start >= text.length) {
      return { content: `charOffset ${start} is beyond the end of message ${i + 1} (${text.length} chars)`, isError: true }
    }
    const entry = messageEntry(i + 1, messageRole(message), text, start)
    const cost = entries.length === 0 ? entry.length : entry.length + 2
    if (entries.length > 0 && used + cost > MAX_RESPONSE_CHARS - FOOTER_BUDGET) {
      stopped = true
      break
    }
    entries.push(entry)
    used += cost
    lastIndex = i + 1
  }
  const body = entries.join("\n\n")
  const footer =
    stopped || lastIndex < corpus.length
      ? `\n\n[${corpus.length} messages total, shown through ${lastIndex}; continue with offset=${lastIndex + 1}]`
      : offset > 1
        ? `\n\n[Read messages ${offset}-${lastIndex} of ${corpus.length}]`
        : ""
  return { content: `${body}${footer}` }
}

function search(corpus: readonly Message[], query: string, limit: number): ToolResult {
  const tokens = tokenize(query)
  if (tokens.length === 0) {
    return { content: "Query contains no searchable tokens", isError: true }
  }
  const hits: { index: number; role: string; text: string; score: number }[] = []
  corpus.forEach((message, i) => {
    const text = messageText(message)
    const lower = text.toLowerCase()
    let score = 0
    for (const token of tokens) {
      let from = 0
      for (;;) {
        const at = lower.indexOf(token, from)
        if (at === -1) break
        score += 1
        from = at + token.length
      }
    }
    if (score > 0) hits.push({ index: i + 1, role: messageRole(message), text, score })
  })
  if (hits.length === 0) return { content: "No matching messages." }
  hits.sort((a, b) => b.score - a.score || a.index - b.index)
  const entries: string[] = []
  let used = 0
  for (const hit of hits.slice(0, limit)) {
    const entry = messageEntry(hit.index, hit.role, hit.text, 0)
    const cost = entries.length === 0 ? entry.length : entry.length + 2
    if (entries.length > 0 && used + cost > MAX_RESPONSE_CHARS - FOOTER_BUDGET) break
    entries.push(entry)
    used += cost
  }
  const shown = entries.length
  const footer =
    shown < Math.min(hits.length, limit) ? `\n\n[${hits.length} matching messages, showing ${shown}; raise limit or refine the query]` : ""
  return { content: `${entries.join("\n\n")}${footer}` }
}

function messageEntry(index: number, role: string, text: string, start: number): string {
  const remaining = text.length - start
  const shown = remaining > MAX_MESSAGE_CHARS ? text.slice(start, start + MAX_MESSAGE_CHARS) : text.slice(start)
  if (shown.length === remaining) return `#${index} ${role}: ${shown}`
  const through = start + shown.length
  return `#${index} ${role}: ${shown}\n[… ${text.length} chars total, shown through ${through}; continue with charOffset=${through}]`
}

function messageRole(message: Message): string {
  return message.type === "user" ? "user" : "assistant"
}

/** Flat text of one message; thinking blocks are internal reasoning and stay out. */
function messageText(message: Message): string {
  const content = message.message.content
  if (typeof content === "string") return content
  const parts: string[] = []
  for (const block of content) {
    if (block.type === "text") parts.push(block.text)
    else if (block.type === "tool_use") parts.push(`${block.name}(${JSON.stringify(block.input)})`)
    else if (block.type === "tool_result") parts.push(block.content)
  }
  return parts.join("\n")
}
