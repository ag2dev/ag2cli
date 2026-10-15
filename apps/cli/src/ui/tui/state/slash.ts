/**
 * Slash command framework: command definitions, the registry (names and
 * aliases resolve before dispatch; duplicate or empty keys are
 * construction errors), submission parsing (exit/quit normalize to the
 * exit command; only a raw "/" prefix tokenizes — leading whitespace
 * keeps the text a prompt — with quote awareness and shell metacharacter
 * rejection), busy policies for the host's run coordination, and the
 * feedback surfaces a slash outcome renders. The result vocabulary is
 * closed: text and document results are inert display facts, while
 * submit/clear/exit/theme/card results are directives the slash host
 * digests into store inputs and host effects — and new result shapes
 * are a decided change, not a quiet extension.
 */
import { THEME_IDS } from "../text/index.js"
import type { DiffFileOption } from "./diff-card.js"
import { formatFooterContext, formatFooterTokens } from "./footer.js"
import type { CompletionItem } from "./matching.js"
import type { PermissionModeOption, PermissionRule, PermissionsCardTab } from "./permissions-card.js"
import type { ResumeSessionOption } from "./resume-card.js"
import type { RewindCheckpoint } from "./rewind-card.js"
/** One submitted slash command: lowercased name plus tokenized arguments. */
export interface SlashInput {
  readonly name: string
  readonly args: readonly string[]
  readonly raw: string
}

/**
 * Whether a command may run while an agent run is active. "queue" parks
 * behind the active run and, when the slot is idle, executes at once
 * owning the slot for its duration — the four core submit commands
 * (review, security-review, simplify, commit-message) keep their
 * serialization, and a prompt submitted underneath parks. "immediate"
 * runs without waiting: issuances stay ordered, but a slow read's
 * completion may interleave with the next immediate's. Unknown commands
 * resolve as immediate so their error lands promptly.
 */
export type SlashBusyPolicy = "immediate" | "queue"
export type SlashBusyPolicyResolver = (input: SlashInput) => SlashBusyPolicy

/** Narrow handler context; capability ports join as handlers land. */
export interface SlashExecutionContext {
  readonly signal: AbortSignal
  readonly commands: readonly SlashCommandDefinition[]
}

/** Closed result vocabulary the dispatching host digests. */
export type SlashResult =
  | { readonly type: "none" }
  /**
   * A text result may declare whose screen it speaks for: "client"
   * names the client's own outcome rather than the issuing session's
   * (/resume's destination texts) and survives a session switch or an
   * interrupt, but nothing lands past teardown.
   */
  | { readonly type: "text"; readonly kind: "status" | "error"; readonly text: string; readonly scope?: "client" }
  | { readonly type: "document"; readonly document: { readonly title: string; readonly lines: readonly string[] } }
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "clear" }
  | { readonly type: "exit" }
  | { readonly type: "theme"; readonly themeId: string }
  | { readonly type: "theme-card" }
  | { readonly type: "rewind-card" }
  | { readonly type: "diff-card"; readonly files: readonly DiffFileOption[] }
  | { readonly type: "resume-card"; readonly sessions: readonly ResumeSessionOption[] }
  | { readonly type: "permissions-card"; readonly initialTab?: PermissionsCardTab }

export type SlashHandler = (input: SlashInput, context: SlashExecutionContext) => SlashResult | Promise<SlashResult> | undefined

/** One registered command; adding an ordinary command adds one of these. */
export interface SlashCommandDefinition {
  readonly name: string
  readonly description: string
  readonly aliases?: readonly string[]
  readonly argumentHint?: string
  readonly busyPolicy?: SlashBusyPolicy | SlashBusyPolicyResolver
  readonly execute: SlashHandler
}

export interface SlashCommandRegistry {
  readonly commands: readonly SlashCommandDefinition[]
  resolve(name: string): SlashCommandDefinition | undefined
  execute(input: SlashInput, context: SlashExecutionContext): Promise<SlashResult | undefined> | SlashResult | undefined
}

export function createSlashCommandRegistry(definitions: readonly SlashCommandDefinition[]): SlashCommandRegistry {
  const byName = new Map<string, SlashCommandDefinition>()
  for (const definition of definitions) registerCommandKey(byName, definition.name, definition)
  for (const definition of definitions) {
    for (const alias of definition.aliases ?? []) registerCommandKey(byName, alias, definition)
  }
  return {
    commands: [...definitions],
    resolve(name) {
      return byName.get(name.toLowerCase())
    },
    execute(input, context) {
      const command = byName.get(input.name.toLowerCase())
      return command === undefined ? undefined : command.execute(input, context)
    },
  }
}

function registerCommandKey(byName: Map<string, SlashCommandDefinition>, key: string, definition: SlashCommandDefinition): void {
  const normalized = key.trim().toLowerCase()
  if (normalized.length === 0) throw new Error(`Slash command key must not be empty: ${definition.name}`)
  if (byName.has(normalized)) throw new Error(`Duplicate slash command key: ${key}`)
  byName.set(normalized, definition)
}

/**
 * Project a registry into the command picker's corpus: the bare name is
 * the label and primary match field, the description rides along as
 * detail and a low-weight field, and aliases join under their own field
 * so "/perm" reaches "/permissions". The store falls back to this when
 * the host injects no command source — the registry a store dispatches
 * with is the corpus its slash palette ranks.
 */
export function slashCompletionItems(registry: SlashCommandRegistry): readonly CompletionItem[] {
  return registry.commands.map((definition) => ({
    id: definition.name,
    label: definition.name,
    kind: "command" as const,
    detail: definition.description,
    fields: {
      command: definition.name,
      description: definition.description,
      ...(definition.aliases === undefined || definition.aliases.length === 0 ? {} : { alias: definition.aliases.join(" ") }),
    },
  }))
}

/** Unknown commands resolve immediate so their error lands promptly; the default is queue. */
export function resolveSlashBusyPolicy(command: SlashCommandDefinition | undefined, input: SlashInput): SlashBusyPolicy {
  if (command === undefined) return "immediate"
  if (typeof command.busyPolicy === "function") return command.busyPolicy(input)
  return command.busyPolicy ?? "queue"
}

/**
 * Parse submitted text into a slash input. Exit words normalize to the
 * exit command; only a raw "/" prefix
 * tokenizes as a command — leading whitespace keeps the text a prompt.
 * Tokenization errors propagate to the caller for the error surface.
 */
export function parseSlashSubmission(text: string): SlashInput | null {
  const normalized = text.trim().toLowerCase()
  if (normalized === "exit" || normalized === "quit") return { name: "exit", args: [], raw: text }
  if (!text.startsWith("/")) return null
  const tokens = tokenizeWords(text.slice(1), "slash command")
  const [name = "", ...args] = tokens
  return { name: name.toLowerCase(), args, raw: text }
}

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
    if (/[|;&><`\n\r]/.test(char)) throw new Error(`${label} does not support shell metacharacters: ${char}`)
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
  if (quote !== undefined) throw new Error(`${label} has an unclosed quote`)
  if (current.length > 0) result.push(current)
  if (result.length === 0) throw new Error(`${label} must not be empty`)
  return result
}

/** Guard helper: reject any arguments with the shared usage error. */
export function exactArgs(name: string, handler: SlashHandler): SlashHandler {
  return (input, context) =>
    input.args.length === 0 ? handler(input, context) : { type: "text", kind: "error", text: `/${name} takes no arguments` }
}

/** Blank handler output still lands a visible feedback line. */
export function ensureVisibleSlashText(text: string, kind: "status" | "error"): string {
  return text.trim().length > 0
    ? text
    : kind === "error"
      ? "Command failed with no displayable error."
      : "Command completed with no displayable output."
}

/** Feedback surface for one slash outcome: a styled title and body. */
export interface SlashNotice {
  readonly kind: "status" | "error"
  readonly title: string
  readonly body: string
}

/**
 * Derive the feedback surface for a slash outcome: the title ladder names
 * the command (the help letter gets its listing title).
 */
export function slashNotice(input: SlashInput, kind: "status" | "error", text: string): SlashNotice {
  const title = kind === "error" ? `Error · /${input.name}` : input.name === "help" ? "Available commands" : `/${input.name}`
  return { kind, title, body: ensureVisibleSlashText(text, kind) }
}

/** Feedback for a submission the tokenizer rejected. */
export function slashParseErrorNotice(error: unknown): SlashNotice {
  return { kind: "error", title: "Slash command error", body: error instanceof Error ? error.message : String(error) }
}

/** Feedback for a submission no registered command claims. */
export function unknownSlashNotice(input: SlashInput): SlashNotice {
  return slashNotice(input, "error", `Unknown slash command: /${input.name}`)
}

const helpCommand: SlashHandler = (_input, context) => {
  const lines = context.commands.map(
    (command) => `/${command.name}${command.argumentHint === undefined ? "" : ` ${command.argumentHint}`}  ${command.description}`,
  )
  return { type: "document", document: { title: "Available commands", lines } }
}

/** Core local commands whose data seams exist in this stack. */
export const CORE_SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  { name: "help", description: "Show available commands", busyPolicy: "immediate", execute: exactArgs("help", helpCommand) },
  {
    name: "clear",
    description: "Clear the current TUI transcript",
    busyPolicy: "immediate",
    execute: exactArgs("clear", () => ({ type: "clear" })),
  },
  { name: "exit", description: "Exit the TUI", busyPolicy: "immediate", execute: exactArgs("exit", () => ({ type: "exit" })) },
  {
    name: "review",
    description: "Review the codebase and changes",
    execute: (input) => ({
      type: "submit",
      text: `Review the current codebase and code changes${input.args.length ? ` and pull request ${input.args.join(" ")}` : ""}. Report concrete findings with file and line references. Do not make changes.`,
    }),
  },
  {
    name: "security-review",
    description: "Review changes for security vulnerabilities",
    execute: exactArgs("security-review", () => ({
      type: "submit",
      text: "Review the current git diff and changed files for concrete security vulnerabilities. Report only actionable findings with severity, file, line, impact, and remediation. Do not make changes.",
    })),
  },
  {
    name: "simplify",
    description: "Simplify current changes",
    execute: exactArgs("simplify", () => ({
      type: "submit",
      text: "Review the current changes for unnecessary complexity, duplication, and maintainability problems. Make only safe, focused improvements and verify them.",
    })),
  },
  {
    name: "commit-message",
    description: "Draft a commit message for current changes",
    execute: exactArgs("commit-message", () => ({
      type: "submit",
      text: "Draft a commit message for the current changes (prefer staged changes via `git diff --staged`; fall back to the full working tree diff via `git diff` if nothing is staged). Check `git log` for this repository's existing message style and match it. Only propose the message text; do not run `git commit` or make any other changes.",
    })),
  },
]

/** Runtime identity and context usage the report commands read; absent fields show as unknown. */
export interface SlashRuntimeReport {
  readonly providerName?: string
  readonly modelName?: string
  readonly endpoint?: string
  readonly sessionId?: string
  readonly contextTokens?: number
  readonly contextWindow?: number
  readonly contextEstimated?: boolean
}

/** Sources the report commands compose from; every member optional. */
export interface SlashReportSources {
  readonly runtime?: () => SlashRuntimeReport | undefined
  readonly permissionMode?: () => string | null
  readonly modeLabel?: (mode: string) => string
}

/** Read-only report commands over the injected runtime source. */
export function reportSlashCommands(sources: SlashReportSources): readonly SlashCommandDefinition[] {
  const view = () => sources.runtime?.()
  return [
    {
      name: "status",
      description: "Show session and runtime status",
      busyPolicy: "immediate",
      execute: exactArgs("status", () => {
        const report = view()
        if (report === undefined) {
          return { type: "text", kind: "error" as const, text: "Runtime status is unavailable; cannot show /status" }
        }
        const mode = sources.permissionMode?.() ?? null
        return {
          type: "document" as const,
          document: {
            title: "Status",
            lines: [
              `provider: ${report.providerName || "unknown"}`,
              `model: ${report.modelName || "unknown"}`,
              `endpoint: ${report.endpoint ?? "unknown"}`,
              `session: ${report.sessionId ?? "not created"}`,
              `mode: ${mode === null ? "unknown" : (sources.modeLabel?.(mode) ?? mode)}`,
              `context: ${formatFooterContext(report.contextTokens, report.contextWindow, report.contextEstimated === true)}`,
            ],
          },
        }
      }),
    },
    {
      name: "provider",
      description: "Show the active provider",
      busyPolicy: "immediate",
      execute: exactArgs("provider", () => ({
        type: "document" as const,
        document: { title: "Provider", lines: [`provider: ${view()?.providerName || "unknown"}`] },
      })),
    },
    {
      name: "context",
      aliases: ["ctx"],
      description: "Show context usage",
      busyPolicy: "immediate",
      execute: exactArgs("context", () => {
        const report = view()
        if (report === undefined) {
          return { type: "text", kind: "error" as const, text: "Runtime status is unavailable; cannot show /context" }
        }
        const currentText =
          report.contextTokens === undefined ? "--" : `${report.contextEstimated ? "~" : ""}${formatFooterTokens(report.contextTokens)}`
        const limitText = report.contextWindow === undefined ? "unknown" : formatFooterTokens(report.contextWindow)
        const percentage =
          report.contextTokens !== undefined && report.contextWindow !== undefined && report.contextWindow > 0
            ? ` (${((report.contextTokens / report.contextWindow) * 100).toFixed(1)}%)`
            : ""
        return {
          type: "document" as const,
          document: {
            title: "Context",
            lines: [
              `  model: ${report.modelName || "unknown"}`,
              `  input: ${currentText}/${limitText}${percentage}`,
              `  source: ${report.contextEstimated ? "runtime request estimate" : "provider usage metadata"}`,
            ],
          },
        }
      }),
    },
  ]
}

/**
 * Raw working-tree file facts the host reads through its workspace port;
 * every presentation decision (row description, preview lines) stays
 * with the diff command.
 */
export interface SlashWorkspaceDiffFile {
  readonly path: string
  readonly untracked: boolean
  readonly binary: boolean
  readonly additions: number
  readonly deletions: number
  readonly truncated: boolean
  readonly diff: string
}

/**
 * Sources the card-bound commands run over; every member optional. An
 * absent source keeps its command honest about what this TUI cannot do.
 */
export interface CardSlashCommandSources {
  /** Theme palette; defaults to the closed theme table. */
  readonly themes?: readonly string[]
  readonly rewind?: { checkpoints(): readonly RewindCheckpoint[] }
  readonly diff?: { files(signal?: AbortSignal): Promise<readonly SlashWorkspaceDiffFile[]> | readonly SlashWorkspaceDiffFile[] }
  readonly sessions?: {
    list(): Promise<readonly ResumeSessionOption[]> | readonly ResumeSessionOption[]
    currentSessionId(): string | null
    resume(sessionId: string): Promise<boolean> | boolean
  }
  /**
   * Permission probes plus the canonical commit ports — the same
   * authority the card path bubbles to the host, awaited here so a
   * rejected rules commit can answer in place.
   */
  readonly permissions?: {
    readonly modes: () => readonly PermissionModeOption[]
    readonly rules: () => readonly PermissionRule[]
    readonly commitMode: (mode: string) => Promise<boolean> | boolean
    readonly commitRules: (rules: readonly PermissionRule[]) => Promise<boolean> | boolean
  }
  /** Canonical workspace directory commit; an absent source keeps /add-dir honest. */
  readonly workspaceDirectory?: {
    readonly add: (
      directory: string,
      signal?: AbortSignal,
    ) => Promise<
      { readonly ok: true; readonly canonical: string; readonly changed: boolean } | { readonly ok: false; readonly error: string }
    >
  }
}

/** Whether a rules behavior argument names a real rule behavior. */
function isRuleBehavior(value: string): value is "allow" | "ask" | "deny" {
  return value === "allow" || value === "ask" || value === "deny"
}

/**
 * Interactive commands whose destination is a card or a canonical
 * commit: theme, rewind, diff, resume and the /permissions umbrella.
 * Each opens its card through the executor's store seam (the card-bound
 * result types); permission commits ride the injected ports so a failed
 * rules commit answers with an inline error in place.
 */
export function cardSlashCommands(sources: CardSlashCommandSources): readonly SlashCommandDefinition[] {
  const themes = sources.themes ?? THEME_IDS
  const notEnabled = "Permission mode switching is not enabled in this TUI"
  const rulesUsage = "usage: /permissions rules add <tool> <allow|ask|deny> | /permissions rules remove <tool>"
  return [
    {
      name: "theme",
      description: "Choose the TUI color theme",
      argumentHint: "[theme-id]",
      busyPolicy: "immediate",
      execute: (input) => {
        if (input.args.length === 0) return { type: "theme-card" }
        if (input.args.length !== 1) return { type: "text", kind: "error", text: "/theme takes zero or one argument" }
        const themeId = input.args[0]!
        if (!themes.includes(themeId)) {
          return { type: "text", kind: "error", text: `Unknown theme: ${themeId}. Choose one of: ${themes.join(", ")}` }
        }
        return { type: "theme", themeId }
      },
    },
    {
      name: "rewind",
      description: "Branch from a past checkpoint",
      busyPolicy: "immediate",
      execute: (input) => {
        if (input.args.length > 0) return { type: "text", kind: "error", text: "usage: /rewind" }
        if (sources.rewind === undefined || sources.rewind.checkpoints().length === 0) {
          return { type: "text", kind: "status", text: "Nothing to rewind to yet." }
        }
        return { type: "rewind-card" }
      },
    },
    {
      name: "diff",
      description: "Show working-tree changes",
      busyPolicy: "immediate",
      execute: async (input, context) => {
        if (input.args.length > 0) return { type: "text", kind: "error", text: "/diff takes no arguments" }
        const read = sources.diff
        if (read === undefined) return { type: "text", kind: "error", text: "Git diff is not enabled in this TUI" }
        const files = await read.files(context.signal)
        if (files.length === 0) return { type: "text", kind: "status", text: "No uncommitted changes" }
        return {
          type: "diff-card",
          files: files.map((file) => ({
            path: file.path,
            description: file.untracked
              ? "untracked · not staged yet"
              : file.binary
                ? "binary"
                : `+${file.additions} · -${file.deletions}${file.truncated ? " · truncated" : ""}`,
            detail: file.untracked
              ? ["Untracked file", "", `Not staged yet. Run git add ${file.path} to see a line-level diff.`]
              : file.diff.split("\n"),
          })),
        }
      },
    },
    {
      name: "resume",
      description: "Resume another session",
      busyPolicy: "immediate",
      execute: async (input) => {
        const sessions = sources.sessions
        if (sessions === undefined) return { type: "text", kind: "error", text: "Session resume is not enabled in this TUI" }
        const current = sessions.currentSessionId()
        const resumable = (await sessions.list()).filter((record) => record.sessionId !== current)
        // Both destination texts speak for the client, not the issuing
        // session: the switch happened inside resume, and a superseded
        // attempt's failure still names a destination the user asked for.
        const resume = async (sessionId: string): Promise<SlashResult> =>
          (await sessions.resume(sessionId))
            ? { type: "text", kind: "status", text: `Resumed session ${sessionId}`, scope: "client" }
            : { type: "text", kind: "error", text: `Could not resume session: ${sessionId}`, scope: "client" }
        if (input.args.length > 0) {
          const query = input.args.join(" ").trim()
          const exact = resumable.find((record) => record.sessionId === query)
          if (exact === undefined) return { type: "text", kind: "error", text: `No resumable session found: ${query}` }
          return resume(exact.sessionId)
        }
        if (resumable.length === 0) return { type: "text", kind: "status", text: "No resumable sessions" }
        if (resumable.length === 1) return resume(resumable[0]!.sessionId)
        return { type: "resume-card", sessions: resumable }
      },
    },
    {
      name: "permissions",
      description: "Show or set the session permission mode and rules",
      argumentHint: "[mode] | rules add <tool> <behavior> | rules remove <tool>",
      busyPolicy: "immediate",
      execute: async (input) => {
        const permissions = sources.permissions
        if (permissions === undefined) return { type: "text", kind: "error", text: notEnabled }
        if (input.args.length === 0) {
          if (permissions.modes().length === 0) return { type: "text", kind: "error", text: notEnabled }
          return { type: "permissions-card" }
        }
        if (input.args[0] === "rules") {
          const args = input.args
          if (args[1] === "add") {
            const tool = args[2]
            const behavior = args[3]
            if (args.length !== 4 || tool === undefined || behavior === undefined || !isRuleBehavior(behavior)) {
              return { type: "text", kind: "error", text: rulesUsage }
            }
            const name = tool.trim()
            if (name.length === 0 || name.length > 128) {
              return { type: "text", kind: "error", text: "tool name must be 1-128 characters" }
            }
            const others = permissions.rules().filter((rule) => rule.name !== name)
            const applied = await permissions.commitRules([...others, { name, behavior }])
            if (!applied) {
              return { type: "text", kind: "error", text: `Could not update rule for "${name}"; the current set is unchanged` }
            }
            return { type: "none" }
          }
          if (args[1] === "remove") {
            const tool = args[2]
            if (args.length !== 3 || tool === undefined) {
              return { type: "text", kind: "error", text: rulesUsage }
            }
            const name = tool.trim()
            if (name.length === 0 || name.length > 128) {
              return { type: "text", kind: "error", text: "tool name must be 1-128 characters" }
            }
            if (!permissions.rules().some((rule) => rule.name === name)) {
              return { type: "text", kind: "error", text: `no permission rule for tool: ${name}` }
            }
            const applied = await permissions.commitRules(permissions.rules().filter((rule) => rule.name !== name))
            if (!applied) {
              return { type: "text", kind: "error", text: `Could not update rule for "${name}"; the current set is unchanged` }
            }
            return { type: "none" }
          }
          return { type: "text", kind: "error", text: rulesUsage }
        }
        const modes = permissions.modes().map((option) => option.mode)
        if (input.args.length !== 1) {
          return { type: "text", kind: "error", text: `/permissions takes zero or one argument: /permissions <${modes.join("|")}>` }
        }
        const mode = input.args[0]!
        if (!modes.includes(mode)) {
          return { type: "text", kind: "error", text: `Unknown mode: ${mode}. Choose one of: ${modes.join(", ")}` }
        }
        // Fire-and-forget: the canonical echo owns the display, and a
        // lost race changes nothing. The port may legally be async, so
        // a rejection must not escape as an unhandled rejection.
        void Promise.resolve(permissions.commitMode(mode)).catch(() => {})
        return { type: "none" }
      },
    },
    {
      name: "add-dir",
      description: "Add a workspace directory, or open the workspace panel",
      argumentHint: "<path>",
      busyPolicy: "immediate",
      execute: async (input, context) => {
        const dirNotEnabled = "Workspace directory management is not enabled in this TUI"
        if (input.args.length > 1) return { type: "text", kind: "error", text: "usage: /add-dir <path>" }
        const source = sources.workspaceDirectory
        if (input.args.length === 0) {
          // The card open targets the permissions umbrella's Workspace
          // tab, so both sources must exist — and carry a mode ring —
          // for it to mean anything (an empty ring renders no card).
          if (source === undefined || sources.permissions === undefined || sources.permissions.modes().length === 0) {
            return { type: "text", kind: "error", text: dirNotEnabled }
          }
          return { type: "permissions-card", initialTab: "workspace" }
        }
        if (source === undefined) return { type: "text", kind: "error", text: dirNotEnabled }
        const result = await source.add(input.args[0]!, context.signal)
        if (!result.ok) return { type: "text", kind: "error", text: result.error }
        return {
          type: "text",
          kind: "status",
          text: result.changed
            ? `Workspace directory added: ${result.canonical}`
            : `Workspace directory already in scope: ${result.canonical}`,
        }
      },
    },
  ]
}
