/**
 * Production terminal port for the isolated screen stack: binds the
 * process TTY, decodes stdin bytes, reports sizes, and probes terminfo
 * smcup/rmcup via tput so the capability gate can refuse unsuitable
 * terminals before raw mode. The lifecycle logic itself lives in the
 * screen deep module; this adapter only reports facts and forwards I/O.
 */
import { spawnSync } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import {
  createTerminalScreen,
  screenCapabilityFromProbe,
  type ScreenCapabilities,
  type ScreenSignal,
  type ScreenWriteCallback,
  type ScreenTerminalPort,
  type TerminalSize,
  type TerminalScreen,
} from "../ui/tui/screen/index.js"

interface RawModeStdin {
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown
  on(event: "end" | "close", listener: () => void): unknown
  off(event: "data", listener: (chunk: Uint8Array) => void): unknown
  off(event: "end" | "close", listener: () => void): unknown
  setRawMode(mode: boolean): void
  /** TTY fact folded into the capability gate; absent on pipes. */
  readonly isTTY?: boolean
}

interface SizeAwareStdout {
  write(bytes: string, callback?: ScreenWriteCallback): boolean
  on(event: "resize", listener: () => void): unknown
  on(event: "drain", listener: () => void): unknown
  off(event: "resize", listener: () => void): unknown
  off(event: "drain", listener: () => void): unknown
  readonly columns?: number
  readonly rows?: number
  /** TTY fact folded into the capability gate; absent on pipes. */
  readonly isTTY?: boolean
}

export interface TuiScreenTerminalOptions {
  readonly stdin?: RawModeStdin
  readonly stdout?: SizeAwareStdout
  readonly environment?: Record<string, string | undefined>
  /** Runs a terminfo capability query; returns "" when unavailable. */
  readonly probeRunner?: (name: string) => string
  /** Passed to the screen owner, which enables paired wheel-only mouse modes. */
  readonly mouseTracking?: boolean
}

/** Assembles the process-TTY terminal port injected into the screen module. */
export function createTuiScreenTerminal(options: TuiScreenTerminalOptions = {}): ScreenTerminalPort {
  const stdin = options.stdin ?? (process.stdin as unknown as RawModeStdin)
  const stdout = options.stdout ?? process.stdout
  const environment = options.environment ?? process.env
  const runProbe =
    options.probeRunner ??
    ((name: string): string => {
      const result = spawnSync("tput", [name], { env: environment, encoding: "utf8" })
      return result.status === 0 ? (result.stdout ?? "") : ""
    })
  const size = (): TerminalSize => ({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
  return {
    write: (bytes, callback) => {
      // A false return is ordinary stream flow control: the bytes stay
      // queued and are delivered in order as the pipe drains, so the
      // frame must ride it out — a slow terminal (text selection, SSH
      // lag, a big resize redraw) slows frames down instead of killing
      // the TUI mid-frame. Real write faults (a broken pipe) still
      // throw from here and ride the frame-write fault seam.
      return stdout.write(bytes, callback)
    },
    flush: () =>
      new Promise<void>((resolve, reject) => {
        stdout.write("", (error) => (error === undefined || error === null ? resolve() : reject(error)))
      }),
    onDrain: (handler) => {
      stdout.on("drain", handler)
      return () => stdout.off("drain", handler)
    },
    setRawMode: (enabled) => {
      stdin.setRawMode(enabled)
    },
    size,
    onData: (handler) => {
      // Chunks can split a multi-byte grapheme across reads; the decoder
      // holds the incomplete tail instead of emitting replacement chars,
      // and a chunk that completes nothing stays silent. Legacy X10 mouse
      // reports carry raw coordinate bytes >= 0x80 that no UTF-8 decode
      // can pass through, so their coordinates arrive best-effort; the
      // screen enables SGR wheel reports instead, which stay ASCII.
      const decoder = new StringDecoder("utf8")
      const listener = (chunk: Uint8Array): void => {
        const bytes = decoder.write(Buffer.from(chunk))
        if (bytes !== "") handler(bytes)
      }
      stdin.on("data", listener)
      return () => stdin.off("data", listener)
    },
    onResize: (handler) => {
      const listener = (): void => handler(size())
      stdout.on("resize", listener)
      return () => stdout.off("resize", listener)
    },
    onInputEnd: (handler) => {
      let fired = false
      const listener = (): void => {
        if (fired) return
        fired = true
        handler()
      }
      stdin.on("end", listener)
      stdin.on("close", listener)
      return () => {
        stdin.off("end", listener)
        stdin.off("close", listener)
      }
    },
    probeCapabilities: (): ScreenCapabilities =>
      screenCapabilityFromProbe({
        terminal: environment.TERM ?? "",
        smcup: runProbe("smcup"),
        rmcup: runProbe("rmcup"),
        stdinTTY: stdin.isTTY === true,
        stdoutTTY: stdout.isTTY === true,
      }),
    onSignal: (handler) => {
      const listeners = new Map<ScreenSignal, () => void>()
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        const listener = (): void => handler(signal)
        listeners.set(signal, listener)
        process.on(signal, listener)
      }
      return () => {
        for (const [signal, listener] of listeners) process.off(signal, listener)
      }
    },
  }
}

/**
 * The production screen bound to this process's TTY. The one-step
 * assembly entrypoints use: the terminal port above wrapped in the
 * screen deep module, so the entrypoint wires lifecycle only.
 */
export function createTuiScreen(options: TuiScreenTerminalOptions = {}): TerminalScreen {
  return createTerminalScreen(createTuiScreenTerminal(options), options.mouseTracking === true ? { mouseTracking: true } : {})
}
