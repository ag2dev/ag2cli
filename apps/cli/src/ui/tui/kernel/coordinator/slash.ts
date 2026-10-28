/**
 * Slash grammar: submission parsing (exit words normalize; only a raw
 * "/" prefix tokenizes, leading whitespace keeps the text a prompt)
 * with quote-aware tokenization and shell-metacharacter rejection,
 * busy policies, and the routing table mapping every grammar to its
 * disposition — a command emission, a task open, or a document task
 * built from port facts.
 */
import type { CompletionItem } from "../fields/index.js"
import type { ThemeId } from "../../text/index.js"

export interface SlashInput {
  readonly name: string
  readonly args: readonly string[]
  readonly raw: string
}

/** Queue-policy commands park behind the busy run slot; immediates run now. */
export type SlashBusyPolicy = "immediate" | "queue"

export type SlashParse = { readonly slash: SlashInput } | { readonly prompt: true }

/**
 * Parse submitted text. Exit words and the /ctx alias normalize to
 * their canonical commands; only a raw "/" prefix tokenizes as a
 * command — leading whitespace keeps the text a prompt. Tokenization
 * errors propagate as SlashSyntaxError so the caller can surface them
 * without losing the draft.
 */
export function parseSlashSubmission(text: string): SlashParse {
  const normalized = text.trim().toLowerCase()
  if (normalized === "exit" || normalized === "quit") return { slash: { name: "exit", args: [], raw: text } }
  if (!text.startsWith("/")) return { prompt: true }
  const tokens = tokenizeWords(text.slice(1), "slash command")
  const [name = "", ...args] = tokens
  const command = name.toLowerCase()
  return { slash: { name: command === "ctx" ? "context" : command, args, raw: text } }
}

export class SlashSyntaxError extends Error {}

/** Quote-aware word tokenization; shell metacharacters are rejected. */
function tokenizeWords(value: string, label: string): string[] {
  const result: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaping = false
  for (const char of value) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaping = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/[|;&><`\n\r]/.test(char)) throw new SlashSyntaxError(`${label} does not support shell metacharacters: ${char}`)
    if (/\s/.test(char)) {
      if (current.length > 0) {
        result.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (escaping) current += "\\"
  if (quote !== undefined) throw new SlashSyntaxError(`${label} has an unclosed quote`)
  if (current.length > 0) result.push(current)
  if (result.length === 0) throw new SlashSyntaxError(`${label} must not be empty`)
  return result
}

/** The expanded prompt text each submit-family command stands for. */
const SUBMIT_TEXTS: Readonly<Record<string, string>> = {
  review:
    "Review the current codebase and code changes{args}. Report concrete findings with file and line references. Do not make changes.",
  "security-review":
    "Review the current git diff and changed files for concrete security vulnerabilities. Report only actionable findings with severity, file, line, impact, and remediation. Do not make changes.",
  simplify:
    "Review the current changes for unnecessary complexity, duplication, and maintainability problems. Make only safe, focused improvements and verify them.",
  "commit-message":
    "Draft a commit message for the current changes (prefer staged changes via `git diff --staged`; fall back to the full working tree diff via `git diff` if nothing is staged). Check `git log` for this repository's existing message style and match it. Only propose the message text; do not run `git commit` or make any other changes.",
}

const REPORT_NAMES = new Set(["status", "provider", "context"])

interface CommandDescription {
  readonly name: string
  readonly detail: string
  readonly usage: string
  readonly aliases?: readonly string[]
}

const COMMANDS: readonly CommandDescription[] = [
  { name: "help", detail: "Show available commands", usage: "Show commands" },
  { name: "clear", detail: "Clear the visible transcript", usage: "Clear transcript" },
  { name: "exit", detail: "Exit the TUI", usage: "Exit TUI" },
  { name: "review", detail: "Review the codebase and changes", usage: "[pr] Review changes" },
  { name: "security-review", detail: "Review changes for security vulnerabilities", usage: "Review security" },
  { name: "simplify", detail: "Simplify the current changes", usage: "Simplify changes" },
  { name: "commit-message", detail: "Draft a commit message for the current changes", usage: "Draft commit msg" },
  { name: "compact", detail: "Compact the conversation context now", usage: "Compact [instructions]" },
  { name: "status", detail: "Show session and runtime status", usage: "Show session status" },
  { name: "provider", detail: "Show the active provider", usage: "Show provider details" },
  { name: "context", aliases: ["ctx"], detail: "Show context usage", usage: "Context usage; /ctx alias" },
  { name: "theme", detail: "Preview or switch the TUI color theme", usage: "[theme-id] Preview/save" },
  { name: "diff", detail: "Browse workspace changes", usage: "Browse workspace changes" },
  { name: "permissions", detail: "View or change permissions", usage: "Change [mode/rules]" },
  { name: "rewind", detail: "Branch from a past checkpoint", usage: "Restore checkpoint" },
  { name: "resume", detail: "Choose a session by title and ID, or resume by ID", usage: "[session-id] Resume" },
  { name: "resume-tasks", detail: "Reopen paused task cards", usage: "Resume paused cards" },
  { name: "add-dir", detail: "Add a workspace directory", usage: "[dir] Authorize directory" },
]

/** The default completion and help corpus, in user-facing order. */
export function slashCompletionCandidates(): readonly CompletionItem[] {
  return COMMANDS.flatMap(({ name, aliases, detail }) => {
    // The corpus ranks by name only: description text stays a display
    // row, because a description match would commit a command the user
    // never typed when Enter runs the palette selection.
    return [
      { id: name, label: name, ...(detail === undefined ? {} : { detail }), kind: "command" as const, fields: { command: name } },
      ...(aliases ?? []).map((alias) => ({
        id: alias,
        label: alias,
        detail: `Alias for /${name}`,
        kind: "command" as const,
        fields: { command: alias },
      })),
    ]
  })
}

/** The M1 busy policy per grammar; unknown commands resolve immediate so their error lands promptly. */
export function slashBusyPolicy(name: string): SlashBusyPolicy {
  if (name in SUBMIT_TEXTS || name === "compact") return "queue"
  return "immediate"
}

/** One task the grammar can open; report documents defer their lines to the caller's port facts. */
export type SlashTaskOpen =
  | { readonly task: "theme" }
  | { readonly task: "diff" }
  | { readonly task: "document"; readonly title: string }
  | { readonly task: "permissions"; readonly initialTab?: "workspace" }
  | { readonly task: "rewind" }
  | { readonly task: "resume" }

/** The rule grammar mirrors the RPC syntax: a strict behavior enum and a bounded tool name. */
const RULE_BEHAVIORS: readonly string[] = ["allow", "ask", "deny"]
const MAX_RULE_TOOL_CHARS = 128

/** One rule edit the grammar carries; the kernel composes the full set against its mirror. */
export type SlashRulesAction =
  | { readonly type: "add"; readonly name: string; readonly behavior: "allow" | "ask" | "deny" }
  | { readonly type: "remove"; readonly name: string }

/**
 * The closed routing vocabulary: a command emission (by kind, carrying
 * its argument shape), a task open, or the local transcript clear.
 * Unknown names and arity violations route as errors; routing itself
 * never mutates state.
 */
export type SlashRouting =
  | { readonly kind: "submit"; readonly text: string }
  | { readonly kind: "compact"; readonly instructions?: string }
  | { readonly kind: "clear" }
  | { readonly kind: "exit" }
  | { readonly kind: "theme-commit"; readonly themeId: ThemeId }
  | { readonly kind: "permission-mode"; readonly mode: string }
  | { readonly kind: "permission-rules"; readonly action: SlashRulesAction }
  | { readonly kind: "resume"; readonly sessionId: string }
  | { readonly kind: "resume-tasks" }
  | { readonly kind: "add-dir"; readonly directory: string }
  | { readonly kind: "task"; readonly open: SlashTaskOpen }
  | { readonly kind: "error"; readonly text: string }

const PERMISSIONS_USAGE = "usage: /permissions [mode <mode> | rules add <tool> <allow|ask|deny> | rules remove <tool>]"

/**
 * Route one parsed slash input per the grammar table. Theme ids and
 * permission modes are validated against the vocabularies the caller
 * supplies (the theme palette and the session's selectable modes);
 * report documents defer their content to the caller's port facts.
 */
export function routeSlash(input: SlashInput, themes: readonly ThemeId[], selectableModes: readonly string[]): SlashRouting {
  const { name, args } = input
  if (name === "exit") return args.length === 0 ? { kind: "exit" } : error(`/exit takes no arguments`)
  if (name === "clear") return args.length === 0 ? { kind: "clear" } : error(`/clear takes no arguments`)
  if (name === "help")
    return args.length === 0 ? { kind: "task", open: { task: "document", title: "Available commands" } } : error(`/help takes no arguments`)
  if (name === "compact") {
    const instructions = args.join(" ")
    return instructions.length === 0 ? { kind: "compact" } : { kind: "compact", instructions }
  }
  if (name in SUBMIT_TEXTS) {
    const template = SUBMIT_TEXTS[name]!
    const text = template.replace("{args}", name === "review" && args.length > 0 ? ` and pull request ${args.join(" ")}` : "")
    return { kind: "submit", text }
  }
  if (REPORT_NAMES.has(name)) {
    return args.length === 0
      ? {
          kind: "task",
          open: {
            task: "document",
            title: name === "status" ? "Status" : name === "provider" ? "Provider" : "Context",
          },
        }
      : error(`/${name} takes no arguments`)
  }
  if (name === "theme") {
    if (args.length === 0) return { kind: "task", open: { task: "theme" } }
    if (args.length !== 1) return error(`/theme takes zero or one argument`)
    const themeId = args[0]!
    if (!themes.includes(themeId as ThemeId)) return error(`Unknown theme: ${themeId}. Choose one of: ${themes.join(", ")}`)
    return { kind: "theme-commit", themeId: themeId as ThemeId }
  }
  if (name === "diff") return args.length === 0 ? { kind: "task", open: { task: "diff" } } : error(`/diff takes no arguments`)
  if (name === "rewind") return args.length === 0 ? { kind: "task", open: { task: "rewind" } } : error(`/rewind takes no arguments`)
  if (name === "resume") {
    if (args.length === 0) return { kind: "task", open: { task: "resume" } }
    if (args.length !== 1) return error(`/resume takes zero or one argument`)
    return { kind: "resume", sessionId: args[0]! }
  }
  if (name === "resume-tasks") return args.length === 0 ? { kind: "resume-tasks" } : error(`/resume-tasks takes no arguments`)
  if (name === "add-dir") {
    if (args.length === 0) return { kind: "task", open: { task: "permissions", initialTab: "workspace" } }
    if (args.length !== 1) return error(`/add-dir takes exactly one directory`)
    return { kind: "add-dir", directory: args[0]! }
  }
  if (name === "permissions") {
    if (args.length === 0) return { kind: "task", open: { task: "permissions" } }
    const [sub = "", ...rest] = args
    if (sub === "mode") {
      if (rest.length !== 1) return error(PERMISSIONS_USAGE)
      // The selectable set already excludes auto without a Guardian, so
      // one membership check covers both the grammar and the gate.
      if (selectableModes.length === 0) return error(`permission modes not reported by host yet`)
      const mode = rest[0]!
      if (!selectableModes.includes(mode)) return error(`Unknown permission mode: ${mode}. Choose one of: ${selectableModes.join(", ")}`)
      return { kind: "permission-mode", mode }
    }
    if (sub === "rules") {
      const [verb = "", ...tail] = rest
      if (verb === "add") {
        if (tail.length !== 2) return error(PERMISSIONS_USAGE)
        const [ruleTool = "", behavior = ""] = tail
        if (ruleTool.length > MAX_RULE_TOOL_CHARS) return error(`rule tool name must be at most ${MAX_RULE_TOOL_CHARS} characters`)
        if (!RULE_BEHAVIORS.includes(behavior))
          return error(`Unknown rule behavior: ${behavior}. Choose one of: ${RULE_BEHAVIORS.join(", ")}`)
        return { kind: "permission-rules", action: { type: "add", name: ruleTool, behavior: behavior as "allow" | "ask" | "deny" } }
      }
      if (verb === "remove") {
        if (tail.length !== 1) return error(PERMISSIONS_USAGE)
        const ruleTool = tail[0]!
        if (ruleTool.length > MAX_RULE_TOOL_CHARS) return error(`rule tool name must be at most ${MAX_RULE_TOOL_CHARS} characters`)
        return { kind: "permission-rules", action: { type: "remove", name: ruleTool } }
      }
      return error(PERMISSIONS_USAGE)
    }
    return error(PERMISSIONS_USAGE)
  }
  return error(`Unknown slash command: /${name}`)
}

const error = (text: string): SlashRouting => ({ kind: "error", text })

/** The listing a /help document renders; the grammar table is its own authority. */
export function slashHelpLines(): readonly string[] {
  return COMMANDS.map(({ name, usage }) => `/${name}  ${usage}`)
}
