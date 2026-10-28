/**
 * Transcript line kernel: map the committed transcript plus the live
 * tail to wrapped, styled lines at one fixed width. A source also
 * present in the live tail renders from the tail only — the committed
 * copy is a stale snapshot of the same block, and both together would
 * double-render a still-streaming source — and a sourceId the input
 * repeats (a reconcile window, a re-read tail) renders once, so every
 * source owns one contiguous span downstream. Assistant and user
 * entries render under a marker gutter (body width reduced by the
 * marker, continuation rows indented; user rows paint as one
 * full-width quoted band with a gray padding row above and below),
 * assistant bodies through the bounded markdown renderer with
 * the phase taken from the streaming flag, user rows always final;
 * shell/status/error rows render sanitized plain text wrapped verbatim
 * (tabs expanded to terminal stops, spacing kept); the compact renderer
 * gives tool blocks one status-first row, while the detailed renderer
 * expands retained fields in the same source slot. Every entry closes with one blank
 * separator row. The input shapes are structural: the kernel reads the
 * projection's block vocabulary by shape, never by import.
 */
import { renderMarkdownRuns, renderMarkdownRunsRange, type MarkdownRenderPhase } from "./markdown.js"
import { clipText, expandTabs, measureVerbatim, textWidth, wrapVerbatim, wrapVerbatimRange } from "./measure.js"
import { sanitizeText } from "./sanitize.js"
import type { TextRun } from "./theme.js"

/** One text-bearing committed block: body plus its row kind. */
export interface TranscriptTextInput {
  readonly sourceId: string
  readonly kind: "user" | "assistant" | "status" | "shell" | "error"
  readonly body: string
  readonly streaming?: boolean
}

/** One tool block: compact identity plus retained fields for the detailed reader. */
export interface TranscriptToolInput {
  readonly sourceId: string
  readonly kind: "tool"
  readonly body: string
  readonly runId?: string
  readonly turn?: number
  readonly toolUseId?: string
  readonly name?: string
  readonly input?: unknown
  /** Display title derived from a string `description` input at merge time. */
  readonly title?: string
  readonly status: "streaming" | "running" | "waiting" | "approved" | "denied" | "done" | "error"
  /** Canonical public tool status, retained separately from the display lifecycle. */
  readonly toolStatus?: "requested" | "awaiting_approval" | "running" | "completed" | "failed" | "denied"
  readonly result?: string
  readonly partialInput?: string
  readonly durationMs?: number
  readonly questionOutcome?: "answered" | "declined" | "rejected"
  readonly diff?: unknown
}

/** Committed blocks the kernel maps; only the transcript is read. */
export type TranscriptSourceInput = TranscriptTextInput | TranscriptToolInput

/** The committed session content; only its transcript feeds the kernel. */
export interface TranscriptSessionInput {
  readonly transcript: readonly TranscriptSourceInput[]
}

/** One still-streaming source the committed transcript may lag behind. */
export type TranscriptTailInput =
  | {
      readonly sourceId: string
      /** Block kind carried so an assistant tail renders under its entry gutter. */
      readonly kind: "user" | "assistant" | "status" | "shell" | "error"
      readonly body: string
      readonly streaming?: boolean
    }
  | TranscriptToolInput

/** One wrapped transcript line and the source it belongs to. */
export interface TranscriptLine {
  readonly sourceId: string
  readonly runs: readonly TextRun[]
}

/** One deduplicated source with the renderer needed for its current phase. */
export type TranscriptRenderSource =
  { readonly kind: "block"; readonly block: TranscriptSourceInput } | { readonly kind: "tail"; readonly tail: TranscriptTailInput }

function plainLines(body: string, token: TextRun["token"], columns: number): readonly (readonly TextRun[])[] {
  const lines: (readonly TextRun[])[] = []
  for (const paragraph of sanitizeText(body).split("\n")) {
    // Plain rows carry meaning in their spacing (shell output columns,
    // stack-trace indent), so they expand tabs to terminal stops and
    // wrap verbatim instead of reflowing like prose: the measured
    // width and the rendered width stay identical. A blank paragraph
    // wraps to one empty-text run, never to an empty row.
    for (const text of wrapVerbatim(expandTabs(paragraph), columns)) lines.push([{ text, token }])
  }
  return lines
}

function toolToken(status: TranscriptToolInput["status"]): TextRun["token"] {
  switch (status) {
    case "error":
      return "error"
    case "denied":
      return "warning"
    case "done":
      return "success"
    default:
      return "accent"
  }
}

function publicToolToken(status: NonNullable<TranscriptToolInput["toolStatus"]>): TextRun["token"] {
  switch (status) {
    case "failed":
      return "error"
    case "denied":
    case "awaiting_approval":
      return "warning"
    case "completed":
      return "success"
    default:
      return "accent"
  }
}

function toolStatusLabel(status: TranscriptToolInput["status"]): string {
  switch (status) {
    case "waiting":
      return "waiting"
    case "error":
      return "failed"
    default:
      return status
  }
}

function publicToolStatusLabel(status: NonNullable<TranscriptToolInput["toolStatus"]>): string {
  switch (status) {
    case "completed":
      return "done"
    case "awaiting_approval":
      return "approval"
    default:
      return status
  }
}

function friendlyToolName(name: string): string {
  const names: Readonly<Record<string, string>> = {
    read_file: "Read",
    glob: "Find files",
    grep: "Search",
    write_file: "Write",
    web_fetch: "Fetch URL",
    skill: "Skill",
    todo_write: "Update todos",
    ask_user: "Ask user",
    session_history: "Session history",
    bash: "Bash",
    file_edit: "Edit",
    agent: "Agent",
    agent_join: "Join agent",
  }
  return names[name.toLowerCase()] ?? name
}

type InputRecord = Record<string, unknown>

function inputRecord(value: unknown): InputRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as InputRecord) : null
}

function inputText(record: InputRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function inputNumber(record: InputRecord, key: string): number | undefined {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function inputBool(record: InputRecord, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === "boolean" ? value : undefined
}

function toolInputRecord(block: TranscriptToolInput): InputRecord | null {
  const direct = inputRecord(block.input)
  if (direct !== null) return direct
  if (typeof block.partialInput !== "string") return null
  try {
    const parsed: unknown = JSON.parse(block.partialInput)
    return inputRecord(parsed)
  } catch {
    return null
  }
}

function partialInputRecord(block: TranscriptToolInput): InputRecord | null {
  if (typeof block.partialInput !== "string") return null
  try {
    const parsed: unknown = JSON.parse(block.partialInput)
    return inputRecord(parsed)
  } catch {
    return null
  }
}

function writePreview(content: string, limit: number): { readonly lines: readonly string[]; readonly omitted: number } {
  const lines = content === "" ? [] : content.split("\n")
  if (content.endsWith("\n")) lines.pop()
  return { lines: lines.slice(0, limit), omitted: Math.max(0, lines.length - limit) }
}

/** Compact, schema-aware action text; unknown tools keep their actual input as a fallback. */
function toolInputSummary(block: TranscriptToolInput): string | undefined {
  const input = toolInputRecord(block)
  if (input === null) return undefined
  const name = toolDisplayName(block).toLowerCase()
  const path = (): string | undefined => inputText(input, "path") ?? inputText(input, "file_path")
  switch (name) {
    case "read_file":
      return (
        [
          path(),
          inputNumber(input, "offset") === undefined ? undefined : `line ${inputNumber(input, "offset")}`,
          inputNumber(input, "limit") === undefined ? undefined : `limit ${inputNumber(input, "limit")}`,
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      )
    case "glob":
      return (
        [
          inputText(input, "pattern"),
          path(),
          inputNumber(input, "offset") === undefined ? undefined : `offset ${inputNumber(input, "offset")}`,
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      )
    case "grep":
      return (
        [inputText(input, "pattern"), path(), inputText(input, "glob"), inputText(input, "output_mode")].filter(Boolean).join(" · ") ||
        undefined
      )
    case "write_file": {
      const content = inputText(input, "content")
      if (content === undefined) return path()
      const preview = writePreview(content, 10)
      const suffix = preview.omitted > 0 ? ` · +${preview.omitted} lines` : ""
      return `${path() ?? "content"} · ${preview.lines.join(" ")}${suffix}`
    }
    case "web_fetch":
      return inputText(input, "url")
    case "skill":
      return inputText(input, "name")
    case "todo_write": {
      const todos = input.todos
      if (!Array.isArray(todos)) return undefined
      const labels = todos.slice(0, 3).flatMap((item) => {
        const todo = inputRecord(item)
        if (todo === null) return []
        const label = inputText(todo, "activeForm") ?? inputText(todo, "content")
        return label === undefined ? [] : [label]
      })
      const more = Math.max(0, todos.length - Math.min(3, todos.length))
      return [...labels, ...(more > 0 ? [`+${more} more`] : [])].join(" · ") || `${todos.length} items`
    }
    case "session_history":
      return (
        [
          inputText(input, "action"),
          inputText(input, "query"),
          inputNumber(input, "offset") === undefined ? undefined : `offset ${inputNumber(input, "offset")}`,
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      )
    case "bash":
      return inputText(input, "command")
    case "file_edit": {
      const oldString = inputText(input, "old_string")
      const newString = inputText(input, "new_string")
      return (
        [
          path(),
          oldString === undefined ? undefined : `replace ${clipText(oldString.replace(/\s+/gu, " "), 36).text}`,
          newString === undefined ? undefined : `with ${clipText(newString.replace(/\s+/gu, " "), 36).text}`,
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      )
    }
    case "agent":
      return Object.hasOwn(input, "description") ? inputText(input, "description") : undefined
    case "agent_join":
      return Object.hasOwn(input, "task_id") ? inputText(input, "task_id") : undefined
    default:
      return undefined
  }
}

function indentRuns(line: readonly TextRun[], indent: string): readonly TextRun[] {
  return [{ text: indent, token: "text" }, ...line]
}

/**
 * The name both renderers label a tool with: the canonical `name`
 * when the projection carries it, otherwise the body with a trailing
 * status word stripped.
 */
function toolDisplayName(block: TranscriptToolInput): string {
  return block.name ?? (block.body.endsWith(` ${block.status}`) ? block.body.slice(0, -block.status.length - 1) : block.body)
}

function toolLines(block: TranscriptToolInput, columns: number): readonly (readonly TextRun[])[] {
  const token = block.toolStatus === undefined ? toolToken(block.status) : publicToolToken(block.toolStatus)
  const name = toolDisplayName(block)
  const status = block.toolStatus === undefined ? toolStatusLabel(block.status) : publicToolStatusLabel(block.toolStatus)
  const isError = block.toolStatus === "failed" || block.status === "error"
  const input = toolInputSummary(block)
  const title = typeof block.title === "string" && block.title.length > 0 ? block.title : undefined
  const shortEditError = isError && columns <= 40 && name.toLowerCase() === "file_edit"
  const actionInput = shortEditError ? undefined : input
  const action = [actionInput, ...(title !== undefined && title !== input ? [title] : [])].filter(Boolean).join(" · ")
  const width = Math.max(1, columns)
  const statusText = sanitizeText(`[${status}] `)
  const nameText = sanitizeText(friendlyToolName(name))
  const safeAction = sanitizeText(action).replace(/\s+/gu, " ").trim()
  const separator = safeAction.length > 0 ? " · " : ""
  const fixedWidth = textWidth(statusText) + textWidth(nameText) + textWidth(separator)
  // Keep the final cell clear so Ink's width-constrained Text does not
  // leave a wrap-pending fragment to bleed into the following transcript row.
  const actionWidth = Math.max(0, width - fixedWidth - 1)
  const clippedAction = actionWidth > 0 ? clipText(safeAction, actionWidth) : { text: "", clipped: safeAction.length > 0 }
  const actionText = clippedAction.clipped ? `${clipText(safeAction, Math.max(0, actionWidth - textWidth("…"))).text}…` : clippedAction.text
  const summaryRuns: TextRun[] = [
    { text: statusText, token },
    { text: nameText, token: "accent" },
  ]
  if (actionText.length > 0) summaryRuns.push({ text: separator, token: "muted" }, { text: actionText, token: "muted" })
  const rows: (readonly TextRun[])[] = [summaryRuns]
  if (name.toLowerCase() === "ask_user" && block.questionOutcome !== undefined) {
    const outcome =
      block.questionOutcome === "answered" ? "Answered" : block.questionOutcome === "declined" ? "User declined" : "Clarification requested"
    rows.push([{ text: `  ${outcome}`, token: block.questionOutcome === "rejected" ? "warning" : "muted" }])
  }
  const nameIsBash = name.toLowerCase() === "bash"
  const isRunning = block.toolStatus === "running" || block.status === "running"
  const isComplete = block.toolStatus === "completed" || block.status === "done"
  if ((nameIsBash && isRunning) || isError) {
    if (block.result === undefined) {
      if (nameIsBash && (isComplete || isError)) {
        rows.push([{ text: "  Output unavailable in public projection", token: "muted" }])
      } else if (isError) rows.push([{ text: "  Error details unavailable · Ctrl+O", token: "warning" }])
      return rows
    }
    const outputColumns = Math.max(1, width - 4)
    const total = measurePlainText(block.result, outputColumns).lineCount
    const windowSize = nameIsBash ? 5 : width <= 40 ? (shortEditError ? 2 : 3) : 10
    const start = nameIsBash ? Math.max(0, total - windowSize) : 0
    const count = Math.min(windowSize, total)
    const compactBash = nameIsBash && width <= 40
    if (!compactBash) {
      if (nameIsBash) rows.push([{ text: "  Live output window · captured deltas", token: "muted" }])
      else if (width <= 40) {
        const record = toolInputRecord(block)
        const errorPath = record === null ? undefined : (inputText(record, "file_path") ?? inputText(record, "path"))
        const prefix = `  ${friendlyToolName(name)} failed · `
        const pathWidth = Math.max(1, width - 1 - textWidth(prefix))
        const clippedPath = errorPath === undefined ? { text: "captured output", clipped: false } : clipText(errorPath, pathWidth)
        const pathText = clippedPath.clipped ? `${clipText(errorPath!, Math.max(0, pathWidth - textWidth("…"))).text}…` : clippedPath.text
        rows.push([{ text: `${prefix}${pathText}`, token: "warning" }])
      } else rows.push([{ text: "  Error detail · captured output", token: "muted" }])
    }
    const visibleCount = compactBash ? Math.min(2, count) : count
    const visibleStart = compactBash ? Math.max(0, total - visibleCount) : start
    rows.push(...plainLinesRange(block.result, "text", outputColumns, visibleStart, visibleCount).map((line) => indentRuns(line, "    ")))
    if (total > visibleCount && !compactBash) {
      const omitted = nameIsBash ? start : total - count
      rows.push([{ text: `  +${omitted} captured rows omitted · Ctrl+O details`, token: "muted" }])
    }
  } else if (nameIsBash && isComplete) {
    if (block.result === undefined) rows.push([{ text: "  Output unavailable in public projection", token: "muted" }])
    else {
      const outputColumns = Math.max(1, width - 4)
      const total = measurePlainText(block.result, outputColumns).lineCount
      const count = Math.min(3, total)
      rows.push([{ text: "  Captured output window · extent unknown", token: "muted" }])
      rows.push(...plainLinesRange(block.result, "text", outputColumns, 0, count).map((line) => indentRuns(line, "    ")))
      if (total > count) rows.push([{ text: `  +${total - count} captured rows omitted · Ctrl+O details`, token: "muted" }])
    }
  }
  return rows
}

// The live tail re-mints its wrapper every tick but carries the same
// input reference, so keying the serialization on object identity
// keeps the O(payload) stringify to once per input; the cache dies
// with the object itself.
const jsonTextCache = new WeakMap<object, string>()

function jsonText(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    try {
      return JSON.stringify(value, null, 2) ?? "undefined"
    } catch {
      return "[unserializable tool input]"
    }
  }
  const cached = jsonTextCache.get(value)
  if (cached !== undefined) return cached
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? "undefined"
  } catch {
    text = "[unserializable tool input]"
  }
  jsonTextCache.set(value, text)
  return text
}

interface DetailedToolSection {
  readonly body: string
  readonly token: TextRun["token"]
}

export function detailedToolSections(block: TranscriptToolInput): readonly DetailedToolSection[] {
  const sections: DetailedToolSection[] = [
    {
      body: `[${block.toolStatus === undefined ? toolStatusLabel(block.status) : publicToolStatusLabel(block.toolStatus)}] ${friendlyToolName(toolDisplayName(block))}`,
      token: block.toolStatus === undefined ? toolToken(block.status) : publicToolToken(block.toolStatus),
    },
  ]
  // The title gate matches the compact row: an empty title carries no
  // action, and a muted "Action:" line with nothing after it reads as
  // a stray.
  if (typeof block.title === "string" && block.title.length > 0) sections.push({ body: `Action: ${block.title}`, token: "muted" })
  const metadata = [
    block.turn === undefined ? null : `Turn ${block.turn}`,
    block.durationMs === undefined ? null : `${block.durationMs} ms`,
  ].filter((part): part is string => part !== null)
  if (metadata.length > 0) sections.push({ body: metadata.join(" · "), token: "muted" })
  const input = toolInputRecord(block)
  const inputSummary = toolInputSummary(block)
  if (input !== null && inputSummary !== undefined) {
    sections.push({ body: block.input === undefined || block.input === null ? "Partial input:" : "Input:", token: "muted" })
    const name = toolDisplayName(block).toLowerCase()
    const path = inputText(input, "path") ?? inputText(input, "file_path")
    const add = (label: string, value: string | number | boolean | undefined): void => {
      if (value !== undefined) sections.push({ body: `${label}: ${value}`, token: "text" })
    }
    switch (name) {
      case "read_file":
      case "glob":
      case "grep":
        add("path", path)
        add(name === "read_file" ? "offset" : "pattern", name === "read_file" ? inputNumber(input, "offset") : inputText(input, "pattern"))
        add(
          name === "read_file" || name === "glob" ? "limit" : "mode",
          name === "read_file" || name === "glob" ? inputNumber(input, "limit") : inputText(input, "output_mode"),
        )
        if (name === "grep") add("glob", inputText(input, "glob"))
        break
      case "write_file": {
        add("path", path)
        const content = inputText(input, "content")
        if (content !== undefined) {
          const preview = writePreview(content, 10)
          sections.push({ body: "Content preview:", token: "muted" })
          for (const line of preview.lines) sections.push({ body: line, token: "text" })
          if (preview.omitted > 0) sections.push({ body: `… ${preview.omitted} more lines omitted`, token: "muted" })
        }
        break
      }
      case "web_fetch":
        add("url", inputText(input, "url"))
        add("max_length", inputNumber(input, "max_length"))
        break
      case "skill":
        add("name", inputText(input, "name"))
        break
      case "todo_write": {
        const todos = input.todos
        if (Array.isArray(todos)) {
          sections.push({ body: `Todos (${todos.length}):`, token: "muted" })
          for (const item of todos.slice(0, 10)) {
            const todo = inputRecord(item)
            if (todo === null) continue
            const label = inputText(todo, "activeForm") ?? inputText(todo, "content")
            if (label !== undefined) sections.push({ body: `[${inputText(todo, "status") ?? "unknown"}] ${label}`, token: "text" })
          }
          if (todos.length > 10) sections.push({ body: `… ${todos.length - 10} more todos omitted`, token: "muted" })
        } else sections.push({ body: jsonText(block.input), token: "text" })
        break
      }
      case "session_history":
        add("action", inputText(input, "action"))
        add("query", inputText(input, "query"))
        add("offset", inputNumber(input, "offset"))
        add("limit", inputNumber(input, "limit"))
        add("charOffset", inputNumber(input, "charOffset"))
        break
      case "bash":
        add("command", inputText(input, "command"))
        add("timeout", inputNumber(input, "timeout"))
        break
      case "file_edit":
        add("file_path", path)
        add("old_string", inputText(input, "old_string"))
        add("new_string", inputText(input, "new_string"))
        add("replace_all", inputBool(input, "replace_all"))
        break
      case "agent":
        if (Object.hasOwn(input, "description")) {
          add("description", inputText(input, "description"))
          add("subagent_type", inputText(input, "subagent_type"))
          add("child handle", inputText(input, "task_id"))
        } else sections.push({ body: jsonText(block.input), token: "text" })
        break
      case "agent_join":
        if (Object.hasOwn(input, "task_id")) {
          add("task_id", inputText(input, "task_id"))
          add("timeout_ms", inputNumber(input, "timeout_ms"))
        } else sections.push({ body: jsonText(block.input), token: "text" })
        break
      default:
        sections.push({ body: jsonText(block.input), token: "text" })
    }
  } else if (block.input !== undefined) {
    sections.push({ body: "Input:", token: "muted" }, { body: jsonText(block.input), token: "text" })
  }
  if (block.partialInput !== undefined && partialInputRecord(block) === null)
    sections.push(
      { body: input === null ? "Input unavailable · partial JSON:" : "Partial input could not be parsed:", token: "muted" },
      { body: block.partialInput, token: "text" },
    )
  else if (block.partialInput !== undefined && input === null)
    sections.push({ body: "Partial input:", token: "muted" }, { body: block.partialInput, token: "text" })
  const isBash = toolDisplayName(block).toLowerCase() === "bash"
  const isRunning = block.toolStatus === "running" || block.status === "running"
  if (isBash) {
    if (block.result === undefined) sections.push({ body: "Output unavailable in public projection", token: "muted" })
    else {
      const heading = isRunning ? "Live output window · captured deltas" : "Captured output window · extent unknown"
      sections.push({ body: heading, token: "muted" }, { body: block.result, token: "text" })
    }
  } else if (block.result !== undefined) sections.push({ body: "Result:", token: "muted" }, { body: block.result, token: "text" })
  else if (block.status === "error") sections.push({ body: "Error details unavailable in public projection", token: "muted" })
  if (block.diff !== undefined && typeof block.diff === "object" && block.diff !== null) {
    const diff = block.diff as {
      readonly addedLines?: unknown
      readonly removedLines?: unknown
      readonly sites?: unknown
      readonly truncated?: unknown
      readonly previewAvailable?: unknown
      readonly hunks?: unknown
    }
    if (typeof diff.addedLines === "number" && typeof diff.removedLines === "number" && typeof diff.sites === "number") {
      const marker = diff.truncated === true ? " · truncated" : ""
      sections.push({ body: `Diff: +${diff.addedLines} −${diff.removedLines} across ${diff.sites} change sites${marker}`, token: "muted" })
      if (diff.previewAvailable === false) sections.push({ body: "Diff preview unavailable", token: "warning" })
      else if (Array.isArray(diff.hunks)) {
        for (const rawHunk of diff.hunks) {
          const hunk = inputRecord(rawHunk)
          if (hunk === null || !Array.isArray(hunk.lines)) continue
          const oldStart = typeof hunk.oldStart === "number" ? hunk.oldStart : "?"
          const oldLines = typeof hunk.oldLines === "number" ? hunk.oldLines : "?"
          const newStart = typeof hunk.newStart === "number" ? hunk.newStart : "?"
          const newLines = typeof hunk.newLines === "number" ? hunk.newLines : "?"
          sections.push({
            body: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
            token: "muted",
          })
          let oldLine = typeof hunk.oldStart === "number" ? hunk.oldStart : undefined
          let newLine = typeof hunk.newStart === "number" ? hunk.newStart : undefined
          for (const rawLine of hunk.lines) {
            const line = inputRecord(rawLine)
            if (
              line === null ||
              typeof line.text !== "string" ||
              (line.kind !== "context" && line.kind !== "added" && line.kind !== "removed")
            )
              continue
            const diffMarker = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "
            const token = line.kind === "added" ? "diffAdded" : line.kind === "removed" ? "diffRemoved" : "text"
            const oldNumber = line.kind === "added" ? "  " : oldLine === undefined ? "?" : String(oldLine++)
            const newNumber = line.kind === "removed" ? "  " : newLine === undefined ? "?" : String(newLine++)
            sections.push({ body: `${oldNumber.padStart(3)} ${newNumber.padStart(3)} │ ${diffMarker}${line.text}`, token })
          }
        }
      }
    }
  }
  if (block.questionOutcome !== undefined) sections.push({ body: `Question: ${block.questionOutcome}`, token: "muted" })
  return sections
}

function detailedToolLines(block: TranscriptToolInput, columns: number): readonly (readonly TextRun[])[] {
  return detailedToolSections(block).flatMap(({ body, token }) => plainLines(body, token, columns))
}

function measurePlainText(body: string, columns: number): { readonly lineCount: number; readonly trailingBlankLines: number } {
  let lineCount = 0
  let trailingBlankLines = 0
  for (const paragraph of sanitizeText(body).split("\n")) {
    const measured = measureVerbatim(expandTabs(paragraph), columns)
    lineCount += measured.lineCount
    trailingBlankLines =
      measured.trailingBlankLines === measured.lineCount ? trailingBlankLines + measured.lineCount : measured.trailingBlankLines
  }
  return { lineCount, trailingBlankLines }
}

/** Exact detailed row count for tool sources without retaining their rendered rows. */
export function measureDetailedTranscriptSource(source: TranscriptRenderSource, columns: number): number | null {
  const block = source.kind === "block" ? source.block : source.tail
  if (block.kind !== "tool") return null
  let rows = 0
  let trailingBlankRows = 0
  for (const section of detailedToolSections(block)) {
    const measured = measurePlainText(section.body, columns)
    rows += measured.lineCount
    trailingBlankRows =
      measured.trailingBlankLines === measured.lineCount ? trailingBlankRows + measured.lineCount : measured.trailingBlankLines
  }
  // Each rendered source ends with one blank separator. The normalizer
  // removes only blank body rows immediately before that separator.
  return rows - trailingBlankRows + 1
}

function plainLinesRange(
  body: string,
  token: TextRun["token"],
  columns: number,
  start: number,
  count: number,
): readonly (readonly TextRun[])[] {
  const rows: (readonly TextRun[])[] = []
  const end = start + count
  let offset = 0
  for (const paragraph of sanitizeText(body).split("\n")) {
    const expanded = expandTabs(paragraph)
    const measured = measureVerbatim(expanded, columns)
    const localStart = Math.max(0, start - offset)
    const localEnd = Math.min(measured.lineCount, end - offset)
    if (localEnd > localStart) {
      for (const text of wrapVerbatimRange(expanded, columns, localStart, localEnd - localStart)) rows.push([{ text, token }])
    }
    offset += measured.lineCount
    if (offset >= end) break
  }
  return rows
}

function entryGutterRow(marker: string, row: readonly TextRun[], index: number): readonly TextRun[] {
  if (row.length === 0) return index === 0 ? [{ text: marker, token: "accent" }] : row
  return [{ text: index === 0 ? marker : " ".repeat(textWidth(marker)), token: index === 0 ? "accent" : "text" }, ...row]
}

function renderTextSourceRange(
  sourceId: string,
  block: Exclude<TranscriptSourceInput | TranscriptTailInput, TranscriptToolInput>,
  columns: number,
  start: number,
  count: number,
): readonly TranscriptLine[] {
  const from = Math.max(0, Math.floor(start))
  const end = from + Math.max(0, Math.floor(count))
  if (end <= from) return []
  if (block.kind === "assistant" || block.kind === "user") {
    const marker = block.kind === "assistant" ? "⏺ " : "❯ "
    const phase: MarkdownRenderPhase = block.kind === "assistant" && block.streaming === true ? "streaming" : "final"
    const body = block.kind === "assistant" ? block.body.replace(/^(?:[ \t]*\r?\n)+/u, "") : block.body
    const bodyStart = block.kind === "user" ? Math.max(0, from - 1) : from
    const bodyEnd = block.kind === "user" ? Math.max(0, end - 1) : end
    const rendered = renderMarkdownRunsRange(
      body,
      { width: columns - textWidth(marker), phase },
      bodyStart,
      Math.max(0, bodyEnd - bodyStart),
    )
    // The full render's cut is overlay-aware — bold whitespace rides the
    // focus overlay and counts as content — so the assistant window
    // derives from the walk's overlay-aware trailing-blank metric; the
    // user band pops its trailing rows on text alone, so it keeps the
    // text-only last-text index.
    const bodyCount =
      block.kind === "assistant" ? Math.max(1, rendered.lineCount - rendered.trailingBlankLines) : Math.max(1, rendered.lastTextLine + 1)
    const total = block.kind === "user" ? bodyCount + 3 : bodyCount + 1
    const lines: TranscriptLine[] = []
    if (block.kind === "assistant") {
      for (let sourceLine = from; sourceLine < Math.min(end, total); sourceLine += 1) {
        if (sourceLine === bodyCount) {
          lines.push({ sourceId, runs: [] })
          continue
        }
        const row = rendered.lines[sourceLine - bodyStart]
        if (row !== undefined) lines.push({ sourceId, runs: entryGutterRow(marker, row, sourceLine) })
      }
      return lines
    }

    const padding: readonly TextRun[] = [{ text: " ".repeat(columns), token: "text", overlays: ["quoted"] }]
    for (let sourceLine = from; sourceLine < Math.min(end, total); sourceLine += 1) {
      if (sourceLine === 0 || sourceLine === bodyCount + 1) {
        lines.push({ sourceId, runs: padding })
        continue
      }
      if (sourceLine === bodyCount + 2) {
        lines.push({ sourceId, runs: [] })
        continue
      }
      const bodyLine = sourceLine - 1
      const row = rendered.lines[bodyLine - bodyStart]
      if (row === undefined) continue
      const guttered = entryGutterRow(marker, row, bodyLine)
      const banded = guttered.map((run): TextRun => ({ ...run, overlays: [...(run.overlays ?? []), "quoted"] }))
      const used = banded.reduce((width, run) => width + textWidth(run.text), 0)
      const pad = Math.max(0, columns - used)
      lines.push({
        sourceId,
        runs: pad > 0 ? [...banded, { text: " ".repeat(pad), token: "text", overlays: ["quoted"] }] : banded,
      })
    }
    return lines
  }

  const token: TextRun["token"] = block.kind === "error" ? "error" : block.kind === "status" ? "muted" : "text"
  const measured = measurePlainText(block.body, columns)
  const bodyCount = Math.max(0, measured.lineCount - measured.trailingBlankLines)
  const bodyStart = Math.min(from, bodyCount)
  const bodyEnd = Math.min(end, bodyCount)
  const rows = plainLinesRange(block.body, token, columns, bodyStart, Math.max(0, bodyEnd - bodyStart))
  const lines = rows.map((runs) => ({ sourceId, runs }))
  if (from <= bodyCount && end > bodyCount) lines.push({ sourceId, runs: [] })
  return lines
}

/** Render only a visible line range from a detailed tool source. */
export function renderDetailedTranscriptSourceRange(
  source: TranscriptRenderSource,
  columns: number,
  start: number,
  count: number,
): readonly TranscriptLine[] {
  const sourceId = source.kind === "block" ? source.block.sourceId : source.tail.sourceId
  const block = source.kind === "block" ? source.block : source.tail
  const from = Math.max(0, Math.floor(start))
  const boundedCount = Math.max(0, Math.floor(count))
  if (boundedCount === 0) return []
  if (block.kind !== "tool") return renderTextSourceRange(sourceId, block, columns, from, boundedCount)

  const sections = detailedToolSections(block)
  const measured = sections.map((section) => measurePlainText(section.body, columns))
  let rawCount = 0
  let trailingBlankRows = 0
  for (const section of measured) {
    rawCount += section.lineCount
    trailingBlankRows =
      section.trailingBlankLines === section.lineCount ? trailingBlankRows + section.lineCount : section.trailingBlankLines
  }
  const bodyLineCount = rawCount - trailingBlankRows
  const end = from + boundedCount
  const lines: TranscriptLine[] = []
  let sourceOffset = 0
  for (let index = 0; index < sections.length && sourceOffset < bodyLineCount; index += 1) {
    const section = sections[index]!
    const lineCount = measured[index]!.lineCount
    const sectionEnd = sourceOffset + lineCount
    const visibleStart = Math.max(from, sourceOffset)
    const visibleEnd = Math.min(end, bodyLineCount, sectionEnd)
    if (visibleEnd > visibleStart) {
      const rows = plainLinesRange(section.body, section.token, columns, visibleStart - sourceOffset, visibleEnd - visibleStart)
      for (const runs of rows) lines.push({ sourceId, runs })
    }
    sourceOffset = sectionEnd
  }
  if (from <= bodyLineCount && end > bodyLineCount) lines.push({ sourceId, runs: [] })
  return lines
}

function blockLines(block: TranscriptSourceInput, columns: number, detailed: boolean): readonly (readonly TextRun[])[] {
  if (block.kind === "tool") {
    return detailed ? detailedToolLines(block, columns) : toolLines(block, columns)
  }
  const phase: MarkdownRenderPhase = block.streaming === true ? "streaming" : "final"
  if (block.kind === "assistant") {
    return assistantLines(block.body, phase, columns)
  }
  if (block.kind === "error") {
    return plainLines(block.body, "error", columns)
  }
  if (block.kind === "status") {
    return plainLines(block.body, "muted", columns)
  }
  if (block.kind === "user") {
    return userLines(block.body, columns)
  }
  return plainLines(block.body, "text", columns)
}

/**
 * Seat one entry's rows under a marker gutter: the body renders at the
 * width the gutter leaves, row 0 carries the marker, and every
 * continuation row carries an equal-width indent so wrapped rows stay
 * aligned. Blank continuation rows stay empty — the gutter paints
 * where content sits.
 */
function withEntryGutter(marker: string, rows: readonly (readonly TextRun[])[]): readonly (readonly TextRun[])[] {
  const head: TextRun = { text: marker, token: "accent" }
  const indent: TextRun = { text: " ".repeat(textWidth(marker)), token: "text" }
  return rows.map((row, index) => {
    if (row.length === 0) return index === 0 ? [head] : row
    return [...(index === 0 ? [head] : [indent]), ...row]
  })
}

/**
 * Assistant entry rows: leading blank lines strip before the render so
 * streaming and committed bodies of the same text can never differ in
 * row count on this account — the shared shape of the committed block
 * and the live tail.
 */
function assistantLines(body: string, phase: MarkdownRenderPhase, columns: number): readonly (readonly TextRun[])[] {
  const marker = "⏺ "
  const stripped = body.replace(/^(?:[ \t]*\r?\n)+/u, "")
  return withEntryGutter(marker, renderMarkdownRuns(stripped, { width: columns - textWidth(marker), phase }))
}

/**
 * User entry rows: the body shares the assistant's markdown kernel,
 * always final — user input has no streaming phase — and the whole
 * entry paints as one full-width quoted band: a gray padding row above
 * and below the body, every body row carrying the quoted overlay and
 * padded to the terminal width so short rows still close the band.
 * The foreground stays the theme's normal color; inline styles keep
 * their own tokens.
 */
function userLines(body: string, columns: number): readonly (readonly TextRun[])[] {
  const marker = "❯ "
  const rows = withEntryGutter(marker, renderMarkdownRuns(body, { width: columns - textWidth(marker), phase: "final" })).slice()
  // The body's own trailing blank rows fold into the band's bottom
  // padding instead of stacking extra gray blanks above it.
  while (rows.length > 0 && rows[rows.length - 1]!.every((run) => run.text.trim().length === 0)) rows.pop()
  const bandRow = (row: readonly TextRun[]): readonly TextRun[] => {
    const banded = row.map((run): TextRun => ({ ...run, overlays: [...(run.overlays ?? []), "quoted"] }))
    // Body rows render at the width the two-cell marker leaves, so the
    // pad closes exactly at the terminal width; the degenerate floor
    // can overshoot it, and there the band simply runs ragged.
    const pad = Math.max(0, columns - banded.reduce((width, run) => width + textWidth(run.text), 0))
    return pad > 0 ? [...banded, { text: " ".repeat(pad), token: "text", overlays: ["quoted"] }] : banded
  }
  const padding: readonly TextRun[] = [{ text: " ".repeat(columns), token: "text", overlays: ["quoted"] }]
  return [padding, ...rows.map(bandRow), padding]
}

/**
 * Tail rows mirror the committed shape of their kind — the tail is the
 * same block at a fresher revision, so the commit swap must not move a
 * row. Tool tails carry the same lifecycle and detail fields as their
 * committed block, so both renderers keep the source's row shape aligned.
 */
function tailLines(block: TranscriptTailInput, columns: number, detailed: boolean): readonly (readonly TextRun[])[] {
  if (block.kind === "tool") return detailed ? detailedToolLines(block, columns) : toolLines(block, columns)
  switch (block.kind) {
    case "assistant":
      return assistantLines(block.body, block.streaming === true ? "streaming" : "final", columns)
    case "user":
      return userLines(block.body, columns)
    case "error":
      return plainLines(block.body, "error", columns)
    case "status":
      return plainLines(block.body, "muted", columns)
    case "shell":
      return plainLines(block.body, "text", columns)
  }
}

/** Committed sources followed by tail-only sources, preserving live block positions. */
export function transcriptRenderSources(
  session: TranscriptSessionInput,
  liveTail: readonly TranscriptTailInput[],
): readonly TranscriptRenderSource[] {
  const seen = new Set<string>()
  const tailSources = new Map<string, TranscriptTailInput>()
  for (const block of liveTail) if (!tailSources.has(block.sourceId)) tailSources.set(block.sourceId, block)
  const sources: TranscriptRenderSource[] = []
  for (const block of session.transcript) {
    if (seen.has(block.sourceId)) continue
    seen.add(block.sourceId)
    const tail = tailSources.get(block.sourceId)
    sources.push(tail === undefined ? { kind: "block", block } : { kind: "tail", tail })
  }
  for (const block of tailSources.values()) {
    if (seen.has(block.sourceId)) continue
    seen.add(block.sourceId)
    sources.push({ kind: "tail", tail: block })
  }
  return sources
}

/**
 * Render one deduplicated source without touching any other transcript
 * block. Every entry closes with exactly one blank separator row.
 */
export function renderTranscriptSource(source: TranscriptRenderSource, columns: number): readonly TranscriptLine[] {
  return renderSource(source, columns, false)
}

/** Render one source for the full-screen reader, expanding tool facts in place. */
export function renderDetailedTranscriptSource(source: TranscriptRenderSource, columns: number): readonly TranscriptLine[] {
  return renderSource(source, columns, true)
}

function renderSource(source: TranscriptRenderSource, columns: number, detailed: boolean): readonly TranscriptLine[] {
  const sourceId = source.kind === "block" ? source.block.sourceId : source.tail.sourceId
  const rendered = source.kind === "block" ? blockLines(source.block, columns, detailed) : tailLines(source.tail, columns, detailed)
  // A blank row is any row without visible text and without an
  // overlay: the markdown kernel mints [], the plain paths an
  // empty-text run, and an excerpt cut can strand either at the end —
  // while the quoted band's pad rows carry their color in the overlay
  // alone, so they count as content. All blank rows coalesce into the
  // one separator.
  const blankRow = (row: readonly TextRun[]): boolean =>
    row.every((run) => run.text.trim().length === 0 && (run.overlays ?? []).length === 0)
  let cut = rendered.length
  while (cut > 0 && blankRow(rendered[cut - 1]!)) cut -= 1
  return [...rendered.slice(0, cut), [] as readonly TextRun[]].map((runs) => ({ sourceId, runs }))
}
