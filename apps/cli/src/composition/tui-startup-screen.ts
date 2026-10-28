import { isAbsolute, relative, resolve, sep } from "node:path"
import { createTuiScreen } from "./tui-screen-terminal.js"
import type { ScreenPreparation, TerminalScreen } from "../ui/tui/screen/index.js"
import { SUPPORT_FLOOR, workspaceIntroRows } from "../ui/tui/text/chrome.js"

export const TUI_STARTUP_SENTINEL = "Starting ag2cli"

export interface TuiStartupScreen {
  readonly screen: TerminalScreen
  readonly preparation: ScreenPreparation
  /** Transfer signal and input ownership to the TUI process entrypoint. */
  handoff(): void
  /**
   * The completed lines the kernel delivered before the composer
   * existed; consumes the buffer so a second call yields nothing.
   */
  takeTypeAhead(): string
  /** Restore the host terminal if the TUI entrypoint could not take ownership. */
  restore(): Promise<void>
}

/** The type-ahead budget; beyond it input is refused with one visible notice. */
const TYPE_AHEAD_BYTE_BUDGET = 4096
/** Framed exactly once when the budget is first exceeded; the buffer itself is left intact. */
const TRUNCATION_NOTICE = "\r\n… type-ahead truncated\r\n"

/** Empty-transcript intro; the independent early Preparing splash has its own copy. */
export function workspaceIntroLines(cwd: string, home: string, width: number) {
  const absoluteHome = resolve(home)
  const absoluteCwd = resolve(cwd)
  const fromHome = relative(absoluteHome, absoluteCwd)
  const displayPath =
    fromHome === ""
      ? "~"
      : isAbsolute(fromHome) || fromHome === ".." || fromHome.startsWith(`..${sep}`)
        ? cwd
        : `~/${fromHome.split(sep).join("/")}`
  const singleLinePath = displayPath.replaceAll("\r\n", " ").replaceAll("\r", " ").replaceAll("\n", " ")
  return workspaceIntroRows(singleLinePath, width)
}

function startupFrame(screen: TerminalScreen): string {
  const { columns, rows } = screen.size()
  const center = (text: string): string => `${" ".repeat(Math.max(0, Math.floor((columns - text.length) / 2)))}${text}`
  const top = Math.max(0, Math.floor((rows - 3) / 2))
  return `\u001b[2J\u001b[H${"\n".repeat(top)}${center(TUI_STARTUP_SENTINEL)}\n${center("Preparing your workspace...")}\n${center("Ctrl+C to exit")}`
}

/**
 * Start a small terminal-owned page before loading the full TUI module graph.
 * The same screen is handed to Ink later, so startup never opens a second
 * alternate buffer or leaves the terminal in a partial state.
 */
export async function startTuiStartupScreen(
  options: {
    readonly mouseTracking?: boolean
    readonly screen?: TerminalScreen
  } = {},
): Promise<TuiStartupScreen | undefined> {
  const stdin = process.stdin as typeof process.stdin & { isTTY?: boolean }
  const stdout = process.stdout as typeof process.stdout & { isTTY?: boolean; columns?: number; rows?: number }
  if (options.screen === undefined && (stdin.isTTY !== true || stdout.isTTY !== true)) return undefined

  const screen = options.screen ?? createTuiScreen({ mouseTracking: options.mouseTracking === true })
  const { columns, rows } = screen.size()
  if (columns < SUPPORT_FLOOR.columns || rows < SUPPORT_FLOOR.rows) return undefined

  const preparation = screen.prepare()
  let handedOff = false
  // Deliberately hand-rolled: restore memoizes forever, failure included —
  // a run-once guard that evicts on failure would newly allow re-running a
  // failed restore.
  let restorePromise: Promise<void> | undefined
  let detachEarlyTermination: (() => void) | undefined
  let detachEarlyInput: (() => void) | undefined
  let typeAhead = ""
  let typeAheadOverflow = false

  const recordTypeAhead = (bytes: string): void => {
    // Under ISIG the kernel turns Ctrl+C into SIGINT before it ever
    // reaches here; this exact-match belt covers the degraded path
    // where canonical establishment failed on a raw-inherited tty.
    if (bytes === "\u0003") {
      exitBeforeHandoff(0)
      return
    }
    // The kernel line discipline already echoed and edited the line;
    // the buffer keeps only what a composer can adopt: printable code
    // points, with the trailing line terminator stripped.
    const line = bytes.endsWith("\n") ? bytes.slice(0, -1) : bytes
    let printable = ""
    for (const char of line) {
      if (char >= " " && char !== "\u007f") printable += char
    }
    if (printable === "") return
    if (typeAheadOverflow) return
    if (Buffer.byteLength(`${typeAhead}${printable}`, "utf8") > TYPE_AHEAD_BYTE_BUDGET) {
      typeAheadOverflow = true
      screen.frame(TRUNCATION_NOTICE)
      return
    }
    typeAhead += printable
  }

  const restore = (): Promise<void> => {
    if (restorePromise !== undefined) return restorePromise
    handedOff = true
    detachEarlyInput?.()
    detachEarlyInput = undefined
    detachEarlyTermination?.()
    detachEarlyTermination = undefined
    restorePromise = (async () => {
      try {
        screen.teardown()
      } finally {
        try {
          await screen.flush()
        } finally {
          screen.finishShutdown()
        }
      }
    })()
    return restorePromise
  }

  const exitBeforeHandoff = (exitCode: number): void => {
    if (handedOff) return
    void restore().finally(() => {
      process.exitCode = exitCode
      process.exit(exitCode)
    })
  }

  if (preparation.ok) {
    // Install the short-lived handlers before activation so Ctrl+C or a
    // termination signal cannot strand raw mode while the full TUI imports.
    detachEarlyTermination = screen.onTerminationRequest(() => exitBeforeHandoff(0))
    detachEarlyInput = screen.onInput((bytes) => {
      if (!handedOff) recordTypeAhead(bytes)
    })
    screen.onWriteFault(() => exitBeforeHandoff(1))
    screen.activate({ input: "canonical" })
    screen.frame(startupFrame(screen))
    try {
      await screen.flush()
    } catch (error) {
      await restore()
      throw error
    }
  }

  return {
    screen,
    preparation,
    handoff() {
      handedOff = true
      detachEarlyInput?.()
      detachEarlyInput = undefined
      detachEarlyTermination?.()
      detachEarlyTermination = undefined
      screen.engageRawInput()
    },
    takeTypeAhead(): string {
      const buffered = typeAhead
      typeAhead = ""
      typeAheadOverflow = false
      return buffered
    },
    restore,
  }
}
