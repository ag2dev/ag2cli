import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { Message } from "@ag2cli/core/message.js"
import { userText } from "@ag2cli/core/message.js"
import type { CompactThresholds } from "@ag2cli/core/model/limits.js"
import { reduceCanonicalSession, type CanonicalSessionState } from "@ag2cli/core/session/canonical-session.js"
import { foldConversationSegments, messagesFromConversationEvents } from "@ag2cli/core/session/message-history.js"
import { projectConversationEvents } from "@ag2cli/core/session/session-projection.js"
import { budgetsFor, estimateTokens, MIN_NOTES_CAP_TOKENS, watermarkFor } from "./compact-budgets.js"
import {
  BOUNDARY_MARKER,
  HISTORY_GUIDANCE_LINE,
  LEGACY_BOUNDARY_MARKER,
  PRESERVED_USERS_HEADER,
  SESSION_NOTES_HEADER,
  SUMMARY_HEADER,
  TRANSCRIPT_PATH_PREFIX,
  isCompactionBoundaryMessage,
} from "./compact-boundary.js"
import { notesUpdaterPrompt } from "./notes-prompt.js"
import type { SessionNotesStore, SessionNotesUpdater } from "../../ports/session-notes-store.js"

// ---------------------------------------------------------------------------
// File format: frontmatter + four fixed-order sections
// ---------------------------------------------------------------------------

export const NOTES_SECTION_HEADERS = ["## Current State", "## Decisions", "## Errors & Corrections", "## Open Threads"] as const
export const NOTES_SECTION_MAX_CHARS = 2_000

/** The four section headers in order with empty bodies. */
export const EMPTY_NOTES_BODY = NOTES_SECTION_HEADERS.join("\n")

export interface NotesFileParts {
  readonly coveredUpTo: string
  readonly updatedAt: string
  /** Section bodies without their header lines, in fixed order. */
  readonly sections: readonly [string, string, string, string]
}

export function renderNotesFile(parts: NotesFileParts): string {
  const body: string[] = []
  NOTES_SECTION_HEADERS.forEach((header, index) => {
    body.push(header)
    const section = parts.sections[index] ?? ""
    if (section.length > 0) body.push(...section.split("\n"))
  })
  return [`---`, `coveredUpTo: "${parts.coveredUpTo}"`, `updatedAt: "${parts.updatedAt}"`, `---`, ...body].join("\n")
}

export interface ParsedNotesFile {
  readonly coveredUpTo: string
  readonly updatedAt: string
  readonly body: string
}

/** Unparseable frontmatter resolves to undefined: callers treat it as absent. */
export function parseNotesFile(content: string): ParsedNotesFile | undefined {
  const lines = content.split("\n")
  const covered = /^coveredUpTo: "(.*)"$/.exec(lines[1] ?? "")
  const updated = /^updatedAt: "(.*)"$/.exec(lines[2] ?? "")
  if (lines[0] !== "---" || covered === null || updated === null || lines[3] !== "---") return undefined
  return { coveredUpTo: covered[1]!, updatedAt: updated[1]!, body: lines.slice(4).join("\n") }
}

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

/**
 * Exact-line matches forbidden inside section bodies: the seven boundary
 * block structural lines and the four notes file section headers. The
 * transcript path line matches by prefix, mirroring the boundary parser.
 */
const FORBIDDEN_EQUAL_LINES: readonly string[] = [
  BOUNDARY_MARKER,
  LEGACY_BOUNDARY_MARKER,
  SUMMARY_HEADER,
  PRESERVED_USERS_HEADER,
  SESSION_NOTES_HEADER,
  HISTORY_GUIDANCE_LINE,
  ...NOTES_SECTION_HEADERS,
]

export function isNotesForbiddenLine(line: string): boolean {
  return FORBIDDEN_EQUAL_LINES.includes(line) || line.startsWith(TRANSCRIPT_PATH_PREFIX)
}

/**
 * Split a body into section texts under the fixed grammar: the first line is
 * the first header, headers appear exactly once in order, and any other
 * header-equal line out of position is a duplicate or disorder rejection.
 */
export function parseNotesBodySections(body: string): [string, string, string, string] | undefined {
  const lines = body.split("\n")
  if (lines[0] !== NOTES_SECTION_HEADERS[0]) return undefined
  const sections: string[][] = [[], [], [], []]
  let sectionIndex = 0
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (NOTES_SECTION_HEADERS.includes(line as (typeof NOTES_SECTION_HEADERS)[number])) {
      if (line !== NOTES_SECTION_HEADERS[sectionIndex + 1]) return undefined
      sectionIndex += 1
      continue
    }
    sections[sectionIndex]!.push(line)
  }
  if (sectionIndex !== NOTES_SECTION_HEADERS.length - 1) return undefined
  return [sections[0]!.join("\n"), sections[1]!.join("\n"), sections[2]!.join("\n"), sections[3]!.join("\n")]
}

function sectionTooLong(sections: readonly string[]): boolean {
  return sections.some((section) => section.length > NOTES_SECTION_MAX_CHARS)
}

function forbiddenLineInSections(sections: readonly string[]): boolean {
  return sections.some((section) => section.split("\n").some((line) => isNotesForbiddenLine(line)))
}

/** Structural clauses only. Shared by the write check and both assembly reads. */
export function notesBodyStructureValid(body: string): boolean {
  const sections = parseNotesBodySections(body)
  return sections !== undefined && !sectionTooLong(sections) && !forbiddenLineInSections(sections)
}

/** The total budget clause is a write-side check only; reads never reapply it. */
export function notesBodyWithinCap(sections: readonly string[], notesCap: number): boolean {
  const totalChars = sections.reduce((sum, section) => sum + section.length, 0)
  return Math.ceil(totalChars / 4) <= notesCap
}

export function notesBodyValid(body: string, notesCap: number): boolean {
  const sections = parseNotesBodySections(body)
  return notesBodyStructureValid(body) && sections !== undefined && notesBodyWithinCap(sections, notesCap)
}

// ---------------------------------------------------------------------------
// Cursor helpers (lineage membership by event id string equality)
// ---------------------------------------------------------------------------

/** The empty string is a no-coverage claim and always passes. */
export function coveredUpToOnActiveLineage(state: CanonicalSessionState, coveredUpTo: string): boolean {
  if (coveredUpTo === "") return true
  let cursor = state.activeHead
  while (cursor !== undefined) {
    const node = state.nodes.get(`${cursor.branchId}:${cursor.nodeId}`)
    if (node?.eventId === coveredUpTo) return true
    cursor = node?.parentCursor
  }
  return false
}

/**
 * The reset cursor: the event id of the deepest node shared by the active
 * head's chain and the detached cursor's chain, so the rebuild delta is
 * exactly the post-divergence work. An unfindable cursor or a divergence
 * that bottoms out at the eventId-less genesis root resolves to the empty
 * string, which claims no coverage and re-feeds the full lineage.
 */
export function resetAssignedCursor(state: CanonicalSessionState, detachedCoveredUpTo: string): string {
  const activeKeys = new Set<string>()
  let cursor = state.activeHead
  while (cursor !== undefined) {
    const key = `${cursor.branchId}:${cursor.nodeId}`
    activeKeys.add(key)
    cursor = state.nodes.get(key)?.parentCursor
  }
  let node = [...state.nodes.values()].find((candidate) => candidate.eventId === detachedCoveredUpTo)
  while (node !== undefined) {
    if (activeKeys.has(`${node.branchId}:${node.nodeId}`)) return node.eventId ?? ""
    node = node.parentCursor === undefined ? undefined : state.nodes.get(`${node.parentCursor.branchId}:${node.parentCursor.nodeId}`)
  }
  return ""
}

// ---------------------------------------------------------------------------
// Delta pipeline
// ---------------------------------------------------------------------------

export function buildNotesDeltaFromProjection(projection: readonly AgentEvent[], coveredUpTo: string): readonly AgentEvent[] {
  if (coveredUpTo === "") return projection
  const index = projection.findIndex((event) => event.eventId === coveredUpTo)
  if (index === -1) return projection
  return projection.filter((event, position) => event.type === "InputAccepted" || position > index)
}

export function buildNotesDelta(events: readonly AgentEvent[], coveredUpTo: string): readonly AgentEvent[] {
  return buildNotesDeltaFromProjection(projectConversationEvents(events), coveredUpTo)
}

// ---------------------------------------------------------------------------
// Delta truncation: additive budget over non-boundary rows only
// ---------------------------------------------------------------------------

export const NOTES_DELTA_MAX_CHARS = 60_000

/** Mirrors the summary-input character accounting, including thinking = 0. */
function rowChars(message: Message): number {
  const content = message.message.content
  if (typeof content === "string") return content.length
  return content.reduce((sum, block) => {
    if (block.type === "text") return sum + block.text.length
    if (block.type === "thinking") return sum
    if (block.type === "tool_use") return sum + JSON.stringify(block.input).length
    return sum + block.content.length
  }, 0)
}

export interface TruncatedDeltaRows {
  readonly rows: readonly Message[]
  readonly droppedNonBoundaryRows: number
}

/**
 * Boundary rows never count against the character budget and never drop;
 * the oldest non-boundary rows drop first once the budget overflows, so the
 * survivors are the newest tail plus every boundary row.
 */
export function truncateDeltaRows(rows: readonly Message[]): TruncatedDeltaRows {
  let used = 0
  let nonBoundaryOpen = true
  let dropped = 0
  const keep = new Array<boolean>(rows.length).fill(false)
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (isCompactionBoundaryMessage(row)) {
      keep[index] = true
      continue
    }
    if (!nonBoundaryOpen) {
      dropped += 1
      continue
    }
    const chars = rowChars(row)
    if (used + chars > NOTES_DELTA_MAX_CHARS) {
      nonBoundaryOpen = false
      dropped += 1
      continue
    }
    used += chars
    keep[index] = true
  }
  return { rows: rows.filter((_, index) => keep[index]), droppedNonBoundaryRows: dropped }
}

/**
 * The cursor rule, shared by all three entries: a full feed advances to the
 * last delta event id; any dropped non-boundary row keeps the entry's held
 * value untouched so the frontmatter never claims uncovered events.
 */
export function nextCoveredUpTo(held: string, droppedNonBoundaryRows: number, deltaEvents: readonly AgentEvent[]): string {
  if (droppedNonBoundaryRows > 0) return held
  return deltaEvents.at(-1)?.eventId ?? held
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export const NOTES_INIT_THRESHOLD_TOKENS = 10_000
export const NOTES_REFRESH_THRESHOLD_TOKENS = 5_000
export const NOTES_TIMEOUT_MS = 15_000

/** Same derivation as compactHistory: budgets for the watermark of auto. */
export function effectiveNotesCap(thresholds: CompactThresholds): number {
  return budgetsFor(watermarkFor(thresholds.autoCompactTokens)).notesCap
}

export function notesCapAdmitsNotes(thresholds: CompactThresholds): boolean {
  return effectiveNotesCap(thresholds) >= MIN_NOTES_CAP_TOKENS
}

/** Creation gate: the segment-cumulative corpus, never a boundary-reset window. */
export function initGatePassed(corpusRows: readonly Message[]): boolean {
  return estimateTokens(corpusRows) >= NOTES_INIT_THRESHOLD_TOKENS
}

/** Refresh gate: rows folded from the post-cursor delta. */
export function refreshGatePassed(postCursorRows: readonly Message[]): boolean {
  return estimateTokens(postCursorRows) >= NOTES_REFRESH_THRESHOLD_TOKENS
}

// ---------------------------------------------------------------------------
// Boundary block helpers
// ---------------------------------------------------------------------------

/**
 * Remove the `[Session notes]` section from a boundary block's text; every
 * other line survives byte-identically. The section ends at the next
 * structural line, which itself belongs to the following section.
 */
export function stripNotesSection(content: string): string {
  const lines = content.split("\n")
  const start = lines.indexOf(SESSION_NOTES_HEADER)
  if (start === -1) return content
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isNotesForbiddenLine(lines[index]!)) {
      end = index
      break
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n")
}

function stripBoundaryNotes(rows: readonly Message[]): Message[] {
  return rows.map((row) => {
    if (!isCompactionBoundaryMessage(row)) return row
    const content = row.message.content
    if (typeof content !== "string") return row
    return userText(stripNotesSection(content))
  })
}

const NOTES_SECTION_PREAMBLE = [
  "Session notes distilled across this session; they may lag the latest turns.",
  "The raw transcript is authoritative when the two disagree.",
]

/** Fixed framework lines plus the validated body; the preamble stays outside notesCap accounting. */
export function notesSectionForBlock(body: string): string {
  return `${NOTES_SECTION_PREAMBLE.join("\n")}\n${body}`
}

// ---------------------------------------------------------------------------
// Two entry points
// ---------------------------------------------------------------------------

export type NotesTrace = "refreshed" | "kept" | "absent" | "read-error"

export interface NotesOutcome {
  /** Present only when a file exists on disk and passes structural validation. */
  readonly content?: string
  readonly trace: NotesTrace
}

export interface ReadNotesForAssemblyInput {
  readonly sessionId: SessionId
  readonly store: SessionNotesStore
  /** Echo a prior refresh outcome instead of re-deriving from presence. */
  readonly refreshTrace?: NotesTrace
}

/**
 * The direct assembly read: one store read, structure-validated, corrupt
 * content treated as absent while the trace still reflects disk presence.
 */
export async function readNotesForAssembly(input: ReadNotesForAssemblyInput): Promise<NotesOutcome> {
  let stored
  try {
    stored = await input.store.read(input.sessionId)
  } catch {
    return { trace: "read-error" }
  }
  const trace = input.refreshTrace ?? (stored === undefined ? "absent" : "kept")
  if (stored === undefined) return { trace }
  const parsed = parseNotesFile(stored.content)
  if (parsed === undefined || !notesBodyStructureValid(parsed.body)) return { trace }
  return { trace, content: notesSectionForBlock(parsed.body) }
}

export interface PrepareSessionNotesInput {
  readonly sessionId: SessionId
  readonly store: SessionNotesStore
  readonly updater: SessionNotesUpdater
  /** A closure: events are fetched only after the arithmetic gates and the presence read pass. */
  readonly eventsSource: () => Promise<readonly AgentEvent[]>
  readonly thresholds: CompactThresholds
  readonly timeoutMs?: number
}

/**
 * The refresh entry: gate chain (availability, notes cap), one presence read
 * feeding the CAS expected value, the updater's current file and the
 * refresh-vs-create decision, INV-7 validation with template reset, the
 * delta pipeline with its own gates, the bounded updater call, and finally
 * the same assembly read the direct paths use. Never rejects.
 */
export async function prepareSessionNotes(input: PrepareSessionNotesInput): Promise<NotesOutcome> {
  if (!input.store.isAvailable(input.sessionId)) return { trace: "absent" }
  if (!notesCapAdmitsNotes(input.thresholds)) {
    return await readNotesForAssembly({ sessionId: input.sessionId, store: input.store })
  }

  let presence
  try {
    presence = await input.store.read(input.sessionId)
  } catch {
    return { trace: "read-error" }
  }
  const parsed = presence === undefined ? undefined : parseNotesFile(presence.content)
  // Missing and unparseable files both take the creation path; a corrupt
  // frontmatter compares equal to the empty string for the CAS write.
  const filePresent = parsed !== undefined
  const expectedCoveredUpTo = parsed?.coveredUpTo ?? ""
  let held = expectedCoveredUpTo
  let updaterCurrentFile =
    presence === undefined
      ? renderNotesFile({ coveredUpTo: "", updatedAt: new Date().toISOString(), sections: ["", "", "", ""] })
      : presence.content

  let events
  try {
    events = await input.eventsSource()
  } catch {
    return { trace: "read-error" }
  }

  const state = reduceCanonicalSession(events)
  if (held !== "" && !coveredUpToOnActiveLineage(state, held)) {
    // Detached cursor: rebuild from the template and hold the assigned
    // divergence-point id; the on-disk frontmatter still supplies the CAS
    // expected value, so this round writes only the assigned cursor.
    held = resetAssignedCursor(state, held)
    updaterCurrentFile = renderNotesFile({ coveredUpTo: held, updatedAt: new Date().toISOString(), sections: ["", "", "", ""] })
  }

  const projection = projectConversationEvents(events)
  const deltaEvents = buildNotesDeltaFromProjection(projection, held)
  const deltaRows = messagesFromConversationEvents(deltaEvents)
  const gatePassed = filePresent ? refreshGatePassed(deltaRows) : initGatePassed(foldConversationSegments(projection))
  if (!gatePassed) {
    return await readNotesForAssembly({ sessionId: input.sessionId, store: input.store })
  }

  const truncated = truncateDeltaRows(deltaRows)
  const prompt = userText(notesUpdaterPrompt(updaterCurrentFile))
  let body
  try {
    body = await input.updater({
      sessionId: input.sessionId,
      messages: [prompt, ...stripBoundaryNotes(truncated.rows)],
      signal: AbortSignal.timeout(input.timeoutMs ?? NOTES_TIMEOUT_MS),
    })
  } catch {
    return await readNotesForAssembly({ sessionId: input.sessionId, store: input.store })
  }
  if (typeof body !== "string" || !notesBodyValid(body, effectiveNotesCap(input.thresholds))) {
    return await readNotesForAssembly({ sessionId: input.sessionId, store: input.store })
  }

  const cursor = nextCoveredUpTo(held, truncated.droppedNonBoundaryRows, deltaEvents)
  const content = renderNotesFile({ coveredUpTo: cursor, updatedAt: new Date().toISOString(), sections: parseNotesBodySections(body)! })
  let written = false
  try {
    written = await input.store.replace(input.sessionId, content, { coveredUpTo: expectedCoveredUpTo })
  } catch {
    written = false
  }
  // A lost CAS race leaves the file untouched by this round, so the trace
  // reports kept; the assembly read below still sees disk truth either way.
  return await readNotesForAssembly({
    sessionId: input.sessionId,
    store: input.store,
    refreshTrace: written ? "refreshed" : "kept",
  })
}
