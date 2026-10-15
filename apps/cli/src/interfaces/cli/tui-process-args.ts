/**
 * Renderer-free TUI argument phase: parse --resume/--session/--config and
 * surface help before any Ink import. The unified dispatcher and the TUI
 * entrypoint both parse here, so `tui --help` never loads the renderer.
 */

/** Process arguments the TUI entrypoint accepts. */
export interface TuiProcessArgs {
  readonly sessionId?: string
  readonly resume?: boolean
  readonly configPath?: string
  readonly noMouse?: boolean
}

export type TuiProcessArgsResult = TuiProcessArgs | { readonly help: true } | { readonly error: string }

/**
 * Parse in order: the first meaningful token wins, so --help after an
 * unknown flag is an error and a help request never shadows a bad value.
 */
export function parseTuiProcessArgs(argv: readonly string[]): TuiProcessArgsResult {
  const parsed: { sessionId?: string; resume?: boolean; configPath?: string; noMouse?: boolean } = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "--help" || arg === "-h") return { help: true }
    if (arg === "--resume") {
      if (parsed.resume === true) return { error: "--resume may appear only once" }
      parsed.resume = true
      continue
    }
    if (arg === "--no-mouse") {
      if (parsed.noMouse === true) return { error: "--no-mouse may appear only once" }
      parsed.noMouse = true
      continue
    }
    if (arg === "--session") {
      if (parsed.sessionId !== undefined) return { error: "--session may appear only once" }
      const value = argv[index + 1]
      if (value === undefined) return { error: "--session requires a session id" }
      if (value.startsWith("-")) return { error: "--session requires a session id" }
      parsed.sessionId = value
      index += 1
      continue
    }
    if (arg === "--config" || arg.startsWith("--config=")) {
      if (parsed.configPath !== undefined) return { error: "--config may appear only once" }
      const value = arg === "--config" ? argv[index + 1] : arg.slice("--config=".length)
      if (value === undefined || value.trim().length === 0 || value.startsWith("-")) return { error: "--config requires a path" }
      parsed.configPath = value
      if (arg === "--config") index += 1
      continue
    }
    return { error: `unknown argument: ${arg} (usage: ag2cli tui [--resume] [--session <id>] [--config <path>] [--no-mouse])` }
  }
  return parsed
}

export const TUI_PROCESS_HELP = `Usage: ag2cli tui [options]

Starts the interactive TUI in the current workspace.

Options:
  --resume                adopt the latest resumable session when no id is selected
  --session <id>          select a session explicitly
  --config <path>         explicit config file
  --no-mouse              disable terminal mouse wheel reporting
  --help, -h              show this help

Non-interactive environments should call ag2cli run instead.`
