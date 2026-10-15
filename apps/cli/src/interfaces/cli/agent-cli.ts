import type { HeadlessOutputFormat } from "../../config/output-format.js"
import type { SessionPermissionMode } from "@ag2cli/core/session/session-security.js"
import type { InvocationName } from "./unified-cli.js"

export interface AgentCliOptions {
  /** Explicit headless configuration file; no default user file is read. */
  configPath?: string
  sessionId?: string
  cwd?: string
  format?: HeadlessOutputFormat
  maxTurns?: number
  timeoutMs?: number
  /** Session permission mode override; omitted leaves canonical state unchanged. */
  permissionMode?: SessionPermissionMode
  /** Explicit headless capability source; never discovered implicitly. */
  skillDir?: string
  promptFromStdin?: boolean
  requestId?: string
}

export type PairingClientKind = "tui" | "web" | "mobile" | "desktop"

interface SessionRewindCliOptions {
  checkpointId?: string
  expectedRevision?: number
}

export type SessionAction =
  "create" | "list" | "get" | "events" | "resume" | "fork" | "archive" | "delete" | "checkpoints" | "preview-rewind" | "rewind"
export type AgentHelpTopic =
  "agent" | "plan" | "run" | "serve" | "pair" | "version" | "capabilities" | "session" | "inspect" | "observe" | "trace"

export type AgentCliCommand =
  | { readonly type: "help"; readonly topic?: AgentHelpTopic }
  | ({ readonly type: "version" } & Pick<AgentCliOptions, "format" | "requestId">)
  | ({ readonly type: "capabilities" } & Pick<AgentCliOptions, "format" | "requestId">)
  | ({ readonly type: "serve" } & Pick<AgentCliOptions, "configPath"> & { readonly workspaceRoots?: readonly string[] })
  | ({ readonly type: "pair"; readonly endpoint: string; readonly clientKind?: PairingClientKind; readonly ttlMs?: number } & Pick<
      AgentCliOptions,
      "configPath" | "format" | "requestId" | "timeoutMs"
    >)
  | ({ readonly type: "plan"; readonly goal: string } & AgentCliOptions)
  | ({ readonly type: "run"; readonly goal: string } & AgentCliOptions)
  | ({ readonly type: "inspect"; readonly sessionId: string } & Pick<AgentCliOptions, "format" | "requestId" | "timeoutMs">)
  | ({ readonly type: "trace"; readonly sessionId: string } & Pick<AgentCliOptions, "format" | "requestId" | "timeoutMs">)
  | ({ readonly type: "observe"; readonly sessionId: string } & Pick<AgentCliOptions, "format" | "requestId" | "timeoutMs">)
  | ({
      readonly type: "session"
      readonly action: SessionAction
      readonly sessionId?: string
      readonly targetSessionId?: string
      readonly checkpointId?: string
      readonly expectedRevision?: number
    } & AgentCliOptions)

export function parseAgentArgs(argv: readonly string[], options?: { invocationName?: InvocationName }): AgentCliCommand {
  const invocationName = options?.invocationName ?? "agent"
  const [command, ...rest] = argv
  if (!command || command === "--help" || command === "-h") return { type: "help" }
  if (command === "help") {
    if (rest.length > 1) throw new Error("Usage: agent help [command]")
    return { type: "help", ...(rest[0] ? { topic: parseHelpTopic(rest[0]) } : {}) }
  }
  if (command === "version") {
    if (hasHelpFlag(rest)) return { type: "help", topic: "version" }
    return { type: "version", ...parseFormatOnly(rest) }
  }
  if (command === "capabilities") {
    if (hasHelpFlag(rest)) return { type: "help", topic: "capabilities" }
    return { type: "capabilities", ...parseFormatOnly(rest) }
  }
  if (command === "serve") {
    if (hasHelpFlag(rest)) return { type: "help", topic: "serve" }
    return { type: "serve", ...parseConfigOnly(rest) }
  }
  if (command === "pair") {
    if (hasHelpFlag(rest)) return { type: "help", topic: "pair" }
    return { type: "pair", ...parsePairArgs(rest) }
  }
  if (command === "plan" || command === "run") {
    if (hasHelpFlag(rest)) return { type: "help", topic: command }
    const parsed = parseGoalArgs(rest, `${invocationName} ${command} <goal | -> [options]`)
    if (command === "plan" && (parsed.skillDir !== undefined || parsed.permissionMode !== undefined || parsed.maxTurns !== undefined)) {
      throw new Error("agent plan does not load skills and accepts no execution options; use agent run for capability configuration")
    }
    return { type: command, ...parsed }
  }
  if (command === "trace" || command === "inspect" || command === "observe") {
    if (hasHelpFlag(rest)) return { type: "help", topic: command }
    const parsed = parseSessionArgs(rest, command)
    return { type: command, ...parsed }
  }
  if (command === "session") return parseSessionCommand(rest)
  throw new Error(`unknown command: ${command}`)
}

export const AGENT_HELP = `Usage:
  agent plan <goal | -> [options]
  agent run <goal | -> [options]
  agent serve [--config <path>] [--workspace <path> ...]
  agent pair <ws://... | wss://...> [options]
  agent version [--format json]
  agent capabilities [--format json]
  agent session create|list|get|events|resume|fork|archive|delete|checkpoints|preview-rewind|rewind [session-id] [checkpoint-id]
  agent session inspect <session-id>
  agent session observe <session-id>
  agent inspect <session-id>
  agent observe <session-id>
  agent trace <session-id>

options:
  --config <path>             explicit config file (headless skips the user config by default)
  --session <id>             use the given session
  --cwd <path>               set the workspace
  --format text|json|jsonl   output format
  --json                     alias for --format json
  --max-turns <n>            maximum turns (agent run only)
  --timeout-ms <n>           request timeout (run, resume, pair and session reads)
  --permission-mode <mode>   manual|accept-edits|plan|full-access|auto (agent run only; a full-access session refuses unflagged run/plan, auto requires a configured guardian)
  --skill-dir <path>         explicitly load a skills directory (run/resume only)
  --request-id <id>          request id
  --expected-revision <n>   run rewind only if the session is unchanged

input:
  goal                       one or more positionals joined by spaces into the prompt
  -                          read the full prompt from stdin; with both goal and piped stdin, stdin is context

stdout carries results or JSONL events; text-format errors and diagnostics go to stderr.`

const COMMAND_HELP: Readonly<Record<AgentHelpTopic, string>> = {
  agent: AGENT_HELP,
  plan: `Usage: agent plan <goal | -> [options]

Produces a read-only plan without tools, file edits or Bash. Use - to read the full prompt from stdin.
  Options: --config, --session, --cwd, --format, --json, --timeout-ms, --request-id.`,
  run: `Usage: agent run <goal | -> [options]

Runs one non-interactive agent run.
--permission-mode sets the session permission mode (manual|accept-edits|plan|full-access|auto); default manual, write tools fail fast without an interactive approver, auto requires a configured guardian reviewer.
Use - to read the full prompt from stdin; with both goal and piped stdin, stdin is context.
Options: --config, --session, --cwd, --format, --json, --max-turns, --timeout-ms, --permission-mode, --skill-dir, --request-id.`,
  serve:
    "Usage: agent serve [--config <path>] [--workspace <path> ...]\n\nStarts the App Server WebSocket; the user config file is not read by default. Managed workspaces may be repeated.",
  pair: `Usage: agent pair <ws://... | wss://...> [options]

Connects to a running serve and creates a short-lived single-use connection link. Requires device:admin credentials via AG2CLI_SERVER_TOKEN; no local runtime is started.
Options: --connect, --client tui|web|mobile|desktop, --ttl-ms, --config, --format, --json, --timeout-ms, --request-id.`,
  version: "Usage: agent version [--format text|json|jsonl] [--json] [--request-id <id>]",
  capabilities: "Usage: agent capabilities [--format text|json|jsonl] [--json] [--request-id <id>]",
  session: `Usage: agent session create|list|get|events|resume|fork|archive|delete|checkpoints|preview-rewind|rewind [session-id] [checkpoint-id]

session resume resumes the most recent run without a terminal event; resume/create accept --cwd; checkpoints lists available checkpoints; rewind does not restore local files.`,
  inspect: "Usage: agent inspect <session-id> [--format text|json|jsonl] [--timeout-ms <n>]",
  observe: "Usage: agent observe <session-id> [--format text|json|jsonl] [--timeout-ms <n>]",
  trace: "Usage: agent trace <session-id> [--format text|json|jsonl] [--timeout-ms <n>]",
}

export function agentHelp(topic?: AgentHelpTopic): string {
  return COMMAND_HELP[topic ?? "agent"]
}

const PUBLIC_COMMAND_HELP: Readonly<Record<"run" | "serve", string>> = {
  run: `Usage: ag2cli run <goal | -> [options]

Runs one non-interactive run.
--permission-mode sets the session permission mode (manual|accept-edits|plan|full-access|auto); default manual, write tools fail fast without an interactive approver, auto requires a configured guardian reviewer.
Use - to read the full prompt from stdin; with both goal and piped stdin, stdin is context.
Options: --config, --session, --cwd, --format, --json, --max-turns, --timeout-ms, --permission-mode, --skill-dir, --request-id.`,
  serve:
    "Usage: ag2cli serve [--config <path>] [--workspace <path> ...]\n\nStarts the App Server WebSocket; the user config file is not read by default. Managed workspaces may be repeated.",
}

/** Detailed help for the public run/serve commands branded for the unified entry. */
export function publicCommandHelp(command: "run" | "serve"): string {
  return PUBLIC_COMMAND_HELP[command]
}

function parseGoalArgs(args: readonly string[], usage: string): { goal: string } & AgentCliOptions {
  const positionals: string[] = []
  const options: AgentCliOptions & SessionRewindCliOptions = {}
  let afterSeparator = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (afterSeparator || arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg)
      continue
    }
    if (arg === "--") {
      afterSeparator = true
      continue
    }
    const parsed = readOption(args, index)
    index = parsed.nextIndex
    assignOption(options, parsed.name, parsed.value)
  }
  if (positionals.length === 0) throw new Error(`Usage: ${usage}`)
  if (!afterSeparator && positionals.length === 1 && positionals[0] === "-") {
    return { goal: "", promptFromStdin: true, ...options }
  }
  if (!afterSeparator && positionals.includes("-")) {
    throw new Error("- is only valid alone as the stdin prompt; pass a literal - with --")
  }
  return { goal: positionals.join(" ").trim(), ...options }
}

function parseSessionArgs(
  args: readonly string[],
  command: "trace" | "inspect" | "observe",
): { sessionId: string } & Pick<AgentCliOptions, "format" | "requestId" | "timeoutMs"> {
  const positionals: string[] = []
  let format: HeadlessOutputFormat | undefined
  let requestId: string | undefined
  let timeoutMs: number | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith("-")) {
      positionals.push(arg)
      continue
    }
    const parsed = readOption(args, index)
    index = parsed.nextIndex
    if (parsed.name === "format") format = parseFormat(parsed.value)
    else if (parsed.name === "json") format = "json"
    else if (parsed.name === "request-id") requestId = requireValue(parsed.name, parsed.value)
    else if (parsed.name === "timeout-ms") timeoutMs = parsePositiveInteger(parsed.name, parsed.value)
    else throw new Error(`command ${command} does not support option --${parsed.name}`)
  }
  return {
    sessionId: requireSessionId(positionals, command),
    ...(format ? { format } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(requestId ? { requestId } : {}),
  }
}

function parseConfigOnly(args: readonly string[]): Pick<AgentCliOptions, "configPath"> & { readonly workspaceRoots?: readonly string[] } {
  let configPath: string | undefined
  const workspaceRoots: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (!args[index]!.startsWith("-")) throw new Error("serve takes no positional arguments")
    const parsed = readOption(args, index)
    index = parsed.nextIndex
    if (parsed.name === "config") {
      if (configPath !== undefined) throw new Error("--config may only be given once")
      configPath = requireValue(parsed.name, parsed.value)
      continue
    }
    if (parsed.name === "workspace") {
      workspaceRoots.push(requireValue(parsed.name, parsed.value))
      continue
    }
    throw new Error(`serve does not support option --${parsed.name}`)
  }
  return {
    ...(configPath === undefined ? {} : { configPath }),
    ...(workspaceRoots.length === 0 ? {} : { workspaceRoots }),
  }
}

function parsePairArgs(args: readonly string[]): {
  endpoint: string
  clientKind?: PairingClientKind
  ttlMs?: number
  configPath?: string
  format?: HeadlessOutputFormat
  requestId?: string
  timeoutMs?: number
} {
  let endpoint: string | undefined
  let clientKind: PairingClientKind | undefined
  let ttlMs: number | undefined
  let configPath: string | undefined
  let format: HeadlessOutputFormat | undefined
  let requestId: string | undefined
  let timeoutMs: number | undefined
  const positionals: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith("-")) {
      positionals.push(arg)
      continue
    }
    const parsed = readOption(args, index)
    index = parsed.nextIndex
    if (parsed.name === "connect") {
      if (endpoint !== undefined) throw new Error("--connect may only be given once")
      endpoint = requireValue(parsed.name, parsed.value)
    } else if (parsed.name === "client") {
      clientKind = parsePairingClientKind(parsed.value)
    } else if (parsed.name === "ttl-ms") {
      ttlMs = parsePositiveInteger(parsed.name, parsed.value)
    } else if (parsed.name === "config") {
      if (configPath !== undefined) throw new Error("--config may only be given once")
      configPath = requireValue(parsed.name, parsed.value)
    } else if (parsed.name === "format") format = parseFormat(parsed.value)
    else if (parsed.name === "json") format = "json"
    else if (parsed.name === "request-id") requestId = requireValue(parsed.name, parsed.value)
    else if (parsed.name === "timeout-ms") timeoutMs = parsePositiveInteger(parsed.name, parsed.value)
    else throw new Error(`pair does not support option --${parsed.name}`)
  }
  if (positionals.length > 1) throw new Error("Usage: agent pair <ws://... | wss://...> [options]")
  if (positionals[0] !== undefined) {
    if (endpoint !== undefined) throw new Error("endpoint may only be given once, as a positional or via --connect")
    endpoint = positionals[0]
  }
  if (endpoint === undefined) throw new Error("Usage: agent pair <ws://... | wss://...> [options]")
  return {
    endpoint,
    ...(clientKind === undefined ? {} : { clientKind }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(format === undefined ? {} : { format }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

function parseSessionCommand(args: readonly string[]): AgentCliCommand {
  const [action, ...rest] = args
  if (hasHelpFlag(args)) {
    return { type: "help", topic: action === "inspect" || action === "observe" ? action : "session" }
  }
  if (action === "inspect" || action === "observe") {
    const parsed = parseSessionArgs(rest, action)
    return { type: action, ...parsed }
  }
  if (!isSessionAction(action)) throw new Error("Usage: agent session create|list|get|events|resume|fork|archive|delete [session-id]")
  const positionals: string[] = []
  const options: AgentCliOptions = {}
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!
    if (!arg.startsWith("-")) {
      positionals.push(arg)
      continue
    }
    const parsed = readOption(rest, index)
    index = parsed.nextIndex
    assignSessionOption(options, action, parsed.name, parsed.value)
  }
  const requiresCheckpoint = action === "preview-rewind" || action === "rewind"
  const maxPositionals = action === "fork" || requiresCheckpoint ? 2 : 1
  if (positionals.length > maxPositionals) throw new Error(`session ${action} takes too many arguments`)
  if (action === "checkpoints" && positionals.length !== 1) throw new Error("Usage: agent session checkpoints <session-id>")
  if (requiresCheckpoint && positionals.length !== 2) throw new Error(`Usage: agent session ${action} <session-id> <checkpoint-id>`)
  return {
    type: "session",
    action,
    ...(positionals[0] ? { sessionId: positionals[0] } : {}),
    ...(action === "fork" && positionals[1] ? { targetSessionId: positionals[1] } : {}),
    ...(requiresCheckpoint && positionals[1] ? { checkpointId: positionals[1] } : {}),
    ...options,
  }
}

function parseFormatOnly(args: readonly string[]): Pick<AgentCliOptions, "format" | "requestId"> {
  let format: HeadlessOutputFormat | undefined
  let requestId: string | undefined
  for (let index = 0; index < args.length; index++) {
    const parsed = readOption(args, index)
    index = parsed.nextIndex
    if (parsed.name === "format") format = parseFormat(parsed.value)
    else if (parsed.name === "json") format = "json"
    else if (parsed.name === "request-id") requestId = requireValue(parsed.name, parsed.value)
    else throw new Error(`unsupported option --${parsed.name}`)
  }
  return { ...(format ? { format } : {}), ...(requestId ? { requestId } : {}) }
}

function hasHelpFlag(args: readonly string[]): boolean {
  let afterSeparator = false
  for (const arg of args) {
    if (arg === "--") {
      afterSeparator = true
      continue
    }
    if (!afterSeparator && (arg === "--help" || arg === "-h")) return true
  }
  return false
}

function parseHelpTopic(value: string): AgentHelpTopic {
  if (
    value === "agent" ||
    value === "plan" ||
    value === "run" ||
    value === "serve" ||
    value === "pair" ||
    value === "version" ||
    value === "capabilities" ||
    value === "session" ||
    value === "inspect" ||
    value === "observe" ||
    value === "trace"
  )
    return value
  throw new Error(`unknown help command: ${value}`)
}

function parsePairingClientKind(value: string | undefined): PairingClientKind {
  if (value === "tui" || value === "web" || value === "mobile" || value === "desktop") return value
  throw new Error("--client must be tui, web, mobile or desktop")
}

function readOption(args: readonly string[], index: number): { name: string; value?: string; nextIndex: number } {
  const arg = args[index]!
  if (arg === "--json") return { name: "json", nextIndex: index }
  if (!arg.startsWith("--")) throw new Error(`unsupported positional option: ${arg}`)
  const equals = arg.indexOf("=")
  if (equals >= 0) return { name: arg.slice(2, equals), value: arg.slice(equals + 1), nextIndex: index }
  const name = arg.slice(2)
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`option --${name} requires a value`)
  return { name, value, nextIndex: index + 1 }
}

function assignOption(options: AgentCliOptions, name: string, value: string | undefined): void {
  switch (name) {
    case "config":
      options.configPath = requireValue(name, value)
      return
    case "session":
      options.sessionId = requireValue(name, value)
      return
    case "cwd":
      options.cwd = requireValue(name, value)
      return
    case "add-dir":
      throw new Error("--add-dir has been removed; additional directories are not part of this release")
    case "format":
      options.format = parseFormat(value)
      return
    case "json":
      options.format = "json"
      return
    case "max-turns":
      options.maxTurns = parsePositiveInteger(name, value)
      return
    case "timeout-ms":
      options.timeoutMs = parsePositiveInteger(name, value)
      return
    case "permission":
      throw new Error("--permission has been removed; use --permission-mode")
    case "permission-mode":
      options.permissionMode = parsePermissionMode(value)
      return
    case "mcp-config":
      throw new Error("--mcp-config has been removed; the MCP tool stack is deleted")
    case "skill-dir":
      options.skillDir = requireValue(name, value)
      return
    case "request-id":
      options.requestId = requireValue(name, value)
      return
    default:
      throw new Error(`unsupported option --${name}`)
  }
}

function assignSessionOption(
  options: AgentCliOptions & SessionRewindCliOptions,
  action: SessionAction,
  name: string,
  value: string | undefined,
): void {
  const common = name === "config" || name === "format" || name === "json" || name === "request-id" || name === "timeout-ms"
  const allowed =
    common ||
    ((action === "create" || action === "resume") && (name === "cwd" || name === "add-dir")) ||
    (action === "resume" && (name === "permission" || name === "mcp-config" || name === "skill-dir")) ||
    ((action === "preview-rewind" || action === "rewind") && name === "expected-revision")
  if (!allowed) throw new Error(`command session ${action} does not support option --${name}`)
  if (name === "expected-revision") {
    options.expectedRevision = parseNonNegativeInteger(name, value)
    return
  }
  assignOption(options, name, value)
}

function requireValue(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) throw new Error(`option --${name} requires a non-empty value`)
  return value
}

function parseFormat(value: string | undefined): HeadlessOutputFormat {
  if (value === "text" || value === "json" || value === "jsonl") return value
  throw new Error("--format must be text, json or jsonl")
}

function parsePositiveInteger(name: string, value: string | undefined): number {
  const parsed = Number(requireValue(name, value))
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`)
  return parsed
}

function parseNonNegativeInteger(name: string, value: string | undefined): number {
  const parsed = Number(requireValue(name, value))
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative integer`)
  return parsed
}

function parsePermissionMode(value: string | undefined): SessionPermissionMode {
  if (value === "manual" || value === "accept-edits" || value === "plan" || value === "full-access" || value === "auto") return value
  throw new Error("--permission-mode must be manual, accept-edits, plan, full-access or auto")
}

function requireSessionId(args: readonly string[], command: string): string {
  const value = args.join(" ").trim()
  if (value.length === 0 || args.length !== 1) throw new Error(`Usage: agent ${command} <session-id>`)
  return value
}

function isSessionAction(value: string | undefined): value is SessionAction {
  return (
    value === "create" ||
    value === "list" ||
    value === "get" ||
    value === "events" ||
    value === "resume" ||
    value === "fork" ||
    value === "archive" ||
    value === "delete" ||
    value === "checkpoints" ||
    value === "preview-rewind" ||
    value === "rewind"
  )
}
