import type { Message } from "@ag2cli/core/message.js"
import { userText } from "@ag2cli/core/message.js"

export const BOUNDARY_MARKER = "[AG2CLI compaction boundary]"
export const LEGACY_BOUNDARY_MARKER = "[Summary of the previous conversation]"
export const SUMMARY_HEADER = "[Summary of the earlier conversation]"
export const PRESERVED_USERS_HEADER = "[User inputs preserved verbatim]"
export const HISTORY_GUIDANCE_LINE = "Session history: use the `session_history` tool (search/read) over this session's events"

export const SESSION_NOTES_HEADER = "[Session notes]"
export const TRANSCRIPT_PATH_PREFIX = "Raw transcript path: "

/**
 * A compaction boundary is a user message whose first line is exactly one of
 * the two known markers. The legacy marker keeps blocks written before the
 * current format recognizable on equal terms.
 */
export function isCompactionBoundaryMessage(message: Message): boolean {
  if (message.type !== "user") return false
  const content = message.message.content
  if (typeof content !== "string") return false
  const firstLine = content.split("\n", 1)[0] ?? ""
  return firstLine === BOUNDARY_MARKER || firstLine === LEGACY_BOUNDARY_MARKER
}

export interface SyntheticBoundaryBlockInput {
  /** Omitted when the summarize region is empty and no summary exists. */
  readonly summary?: string
  /** Quote ledger lines as produced by emitPreservedUsers, without the header. */
  readonly preservedUserLines?: readonly string[]
  readonly notes?: string
  readonly includeHistoryGuidance: boolean
  readonly transcriptPath?: string
}

/**
 * The synthetic block is one user message: fixed first line, then optional
 * sections in a fixed order — summary, quote ledger, history guidance,
 * transcript path. Every section is optional.
 */
export function buildSyntheticBoundaryBlock(input: SyntheticBoundaryBlockInput): Message {
  const lines = [BOUNDARY_MARKER]
  if (input.notes !== undefined && input.notes.length > 0) {
    lines.push(SESSION_NOTES_HEADER, ...input.notes.split("\n"))
  }
  if (input.summary !== undefined && input.summary.length > 0) {
    lines.push(SUMMARY_HEADER, ...input.summary.split("\n"))
  }
  if (input.preservedUserLines !== undefined && input.preservedUserLines.length > 0) {
    lines.push(PRESERVED_USERS_HEADER, ...input.preservedUserLines)
  }
  if (input.includeHistoryGuidance) {
    lines.push(HISTORY_GUIDANCE_LINE)
  }
  if (input.transcriptPath !== undefined) {
    lines.push(`${TRANSCRIPT_PATH_PREFIX}${input.transcriptPath}`)
  }
  return userText(lines.join("\n"))
}

/**
 * The quote-ledger body lines of a boundary block, or undefined when the
 * block carries no ledger section. The section ends at the next structural
 * line (guidance, path, or another section header).
 */
export function preservedUsersLinesFromBoundary(content: string): readonly string[] | undefined {
  const lines = content.split("\n")
  const headerIndex = lines.indexOf(PRESERVED_USERS_HEADER)
  if (headerIndex === -1) return undefined
  const body: string[] = []
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (
      line === SESSION_NOTES_HEADER ||
      line === SUMMARY_HEADER ||
      line === PRESERVED_USERS_HEADER ||
      line === HISTORY_GUIDANCE_LINE ||
      line.startsWith(TRANSCRIPT_PATH_PREFIX)
    ) {
      break
    }
    body.push(line)
  }
  return body
}
