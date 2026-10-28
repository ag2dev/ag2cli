/**
 * Terminal lifecycle deep module for the isolated screen stack
 * the sole physical owner of the host
 * terminal. Everything mutable about it — raw mode, input modes, the
 * alternate screen, and teardown on every exit path — flows through this
 * seam, so no other module ever writes an escape sequence.
 *
 * Contract, locked by tests/unit/ui/screen/terminal-screen.test.ts:
 * - The capability gate runs before any terminal mutation: interactive
 *   TTY streams, a real TERM and provable alternate-screen support are
 *   all required, and without them prepare() refuses while not one byte
 *   is written and raw mode is never entered.
 * - Activation order (raw, the default): raw mode → input modes →
 *   alternate screen. Canonical activation swaps the raw-mode step for
 *   an explicit kernel-canonical re-establishment — the line discipline
 *   then echoes type-ahead itself while the event loop is busy — and
 *   `engageRawInput()` completes the transition once the app owns
 *   input. Frames only exist on the alternate buffer; the primary
 *   screen and its scrollback stay byte-identical for the whole
 *   session. Signal handlers bind only at activation, so merely
 *   constructing or probing the screen never replaces the host's
 *   default signal behavior.
 * - A signal or stdin end first fences new input and resize events, then
 *   asks the application owner to unmount Ink while the output FIFO is
 *   still usable. Physical restoration follows unmount: unlock
 *   synchronized output, close input modes and restore the cursor, leave
 *   the alternate screen, then leave raw mode. Every restore step is
 *   attempted even when an earlier one throws, then the first fault is
 *   rethrown. Signal handlers stay bound until the owner completes the
 *   final output barrier.
 * - `CSI 3J` (erase scrollback) is never emitted; frame content is
 *   sanitized at this boundary. `CSI 2J` clears only the alternate
 *   buffer because frames only exist there.
 *
 * The module is deliberately import-free: the assembly root injects the
 * terminal port (process TTY in production), which keeps the physical
 * contract testable against a dual-buffer virtual terminal.
 */

export interface TerminalSize {
  readonly columns: number
  readonly rows: number
}

/** Facts about the host terminal as reported by the injected port probe. */
export interface ScreenCapabilities {
  readonly terminal: string
  readonly alternateScreen: boolean
  readonly reason?: string
  /**
   * The terminfo enter/leave sequences the proof rested on; present iff
   * alternateScreen is true. Activation and teardown write exactly
   * these, so the gate cannot prove one capability while executing
   * another (a terminal whose smcup is not CSI ?1049 must not receive
   * it anyway).
   */
  readonly enterAlternateScreen?: string
  readonly leaveAlternateScreen?: string
}

export type ScreenSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT"
export type ScreenTermination = ScreenSignal | "stdin-end"
export type ScreenWriteCallback = (error?: Error | null) => void

/** Terminal adapter injected by the assembly root (process TTY in production). */
export interface ScreenTerminalPort {
  write(bytes: string, callback?: ScreenWriteCallback): boolean
  flush(): Promise<void>
  onDrain(handler: () => void): () => void
  setRawMode(enabled: boolean): void
  /**
   * Returns the tty to the kernel's cooked line discipline with echo
   * (the canonical activation shape); never enters raw mode. Restoring
   * cooked flags explicitly matters because a raw-mode off switch only
   * restores whatever snapshot the first raw transition took.
   */
  establishCanonicalInput(): void
  size(): TerminalSize
  onData(handler: (bytes: string) => void): () => void
  onResize(handler: (size: TerminalSize) => void): () => void
  onInputEnd(handler: () => void): () => void
  /** Read-only terminfo/capability probe; must not mutate the terminal. */
  probeCapabilities(): ScreenCapabilities
  onSignal(handler: (signal: ScreenSignal) => void): () => void
}

export interface TerminalScreenOptions {
  /** Enable wheel-only mouse tracking with SGR reports; no hover or drag mode. */
  readonly mouseTracking?: boolean
}

export type ScreenInputMode = "raw" | "canonical"

export interface ScreenActivationOptions {
  /**
   * "raw" (default) enters raw mode at activation; "canonical" keeps
   * the kernel line discipline active so it echoes type-ahead itself,
   * deferring raw mode to engageRawInput().
   */
  readonly input?: ScreenInputMode
}

export type ScreenPreparation =
  | { readonly ok: true; readonly capabilities: ScreenCapabilities }
  | { readonly ok: false; readonly capabilities: ScreenCapabilities; readonly diagnostics: string }

/** Lifecycle phases: idle → prepared → active → torn-down (terminal). */
export type ScreenPhase = "idle" | "prepared" | "active" | "shutdown-requested" | "torn-down"

export interface TerminalScreen {
  /**
   * Capability gate, called before activation: refuses terminals whose
   * alternate-screen support cannot be proven. Refusal must exit fatally
   * before raw mode or the screen is ever touched. A torn-down screen
   * refuses too — build a new screen instead of restarting one.
   */
  prepare(): ScreenPreparation
  /**
   * Raw mode → input modes → alternate screen. Idempotent while
   * active; throws on a torn-down screen (build a new one instead).
   * `input: "canonical"` replaces the raw-mode step with an explicit
   * kernel-canonical re-establishment so the line discipline echoes
   * type-ahead; a later default activate() over that state self-heals
   * by engaging raw input.
   */
  activate(options?: ScreenActivationOptions): void
  /**
   * Late raw engagement over a canonical activation: raw mode plus the
   * app's input modes. A silent no-op unless the screen is active and
   * still canonical, so idle, fenced, and torn-down screens keep their
   * state and their existing throws untouched.
   */
  engageRawInput(): void
  /**
   * Frame content toward the alternate buffer while active; a silent
   * no-op before activation and after teardown. `CSI 3J` is stripped
   * here — the single sanitation point for frame bytes.
   */
  frame(content: string, callback?: ScreenWriteCallback): boolean
  /** Waits for all terminal output already accepted by the writable. */
  flush(): Promise<void>
  /** Screen-owned Writable backpressure state, shared with the renderer. */
  onBackpressureChange(handler: (blocked: boolean) => void): () => void
  /** Asynchronous writable faults that arrive after a frame commit returns. */
  onWriteFault(handler: (error: Error) => void): () => void
  /** Current lifecycle phase; the assembly root gates restarts on it. */
  phase(): ScreenPhase
  size(): TerminalSize
  /** Registered in order; the returned closure removes exactly this handler. */
  onInput(handler: (bytes: string) => void): () => void
  onResize(handler: (size: TerminalSize) => void): void
  /**
   * Handlers run once per received signal after the shared teardown has
   * restored the primary screen (the caller decides how the process
   * exits); they fire even when teardown already ran, so a second signal
   * cannot leave the process hanging.
   */
  onTerminationRequest(handler: (reason: ScreenTermination) => void): () => void
  /**
   * Idempotent ordered teardown; diagnostics land on the restored primary
   * screen. Every restore step is attempted even when an earlier one
   * throws (the EPIPE shape), and the first fault is rethrown after the
   * rest ran; signal teardown swallows it so exit handlers still fire.
   */
  teardown(options?: { readonly diagnostics?: string }): void
  /** Release process signal and terminal listeners after the restore barrier. */
  finishShutdown(): void
}

/** Bracketed paste on and cursor hidden: the input modes this app enables. */
const ENABLE_INPUT_MODES = "\x1b[?2004h\x1b[?25l"
/**
 * Cursor hide alone: canonical activation must not switch bracketed
 * paste or mouse tracking on while the kernel still owns input echo.
 */
const HIDE_CURSOR = "\x1b[?25l"
/** Wheel reports only: button presses, no hover or drag tracking. */
const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h"
/** Paste off, cursor visible, attributes reset: restores the host state. */
const RESTORE_INPUT_MODES = "\x1b[?2004l\x1b[?25h\x1b[0m"
/** Mouse modes are undone in reverse order before the host cursor returns. */
const RESTORE_MOUSE_TRACKING = "\x1b[?1006l\x1b[?1000l"
/** Ink may fault or unmount inside a synchronized-output transaction. */
const RESTORE_SYNC_OUTPUT = "\x1b[?2026l"
/**
 * Fallback enter/leave sequences for probes that prove alternate-screen
 * support without carrying the sequences (fabricated test capabilities).
 * A screenCapabilityFromProbe proof always carries its own terminfo
 * sequences, which activation and teardown then use verbatim.
 */
const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h"
const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l"
/** Scrollback erasure: must never reach the terminal. */
// eslint-disable-next-line no-control-regex -- matching the sequence is how this boundary strips it
const CLEAR_SCROLLBACK = /\x1b\[3J/g

/**
 * Capability decision over a terminfo probe (shared with the production
 * adapter): hosting the isolated screen requires interactive TTY streams,
 * a real TERM and provable smcup/rmcup sequences. Interactivity is
 * checked first — raw mode on a piped stdin would throw at activation
 * regardless of what terminfo promises.
 */
export function screenCapabilityFromProbe(probe: {
  readonly terminal: string
  readonly smcup: string
  readonly rmcup: string
  readonly stdinTTY: boolean
  readonly stdoutTTY: boolean
}): ScreenCapabilities {
  if (!probe.stdinTTY) {
    return { terminal: probe.terminal, alternateScreen: false, reason: "stdin is not a TTY" }
  }
  if (!probe.stdoutTTY) {
    return { terminal: probe.terminal, alternateScreen: false, reason: "stdout is not a TTY" }
  }
  if (probe.terminal === "") {
    return { terminal: "(unset)", alternateScreen: false, reason: "TERM is not set" }
  }
  if (probe.terminal === "dumb") {
    return { terminal: probe.terminal, alternateScreen: false, reason: "TERM=dumb has no terminfo capabilities" }
  }
  if (probe.smcup === "" || probe.rmcup === "") {
    return {
      terminal: probe.terminal,
      alternateScreen: false,
      reason: `terminfo for TERM=${probe.terminal} lacks smcup/rmcup`,
    }
  }
  return {
    terminal: probe.terminal,
    alternateScreen: true,
    enterAlternateScreen: probe.smcup,
    leaveAlternateScreen: probe.rmcup,
  }
}

export function createTerminalScreen(terminal: ScreenTerminalPort, options: TerminalScreenOptions = {}): TerminalScreen {
  const enableInputModes = `${ENABLE_INPUT_MODES}${options.mouseTracking === true ? ENABLE_MOUSE_TRACKING : ""}`
  const restoreInputModes = `${options.mouseTracking === true ? RESTORE_MOUSE_TRACKING : ""}${RESTORE_INPUT_MODES}`
  let phase: ScreenPhase = "idle"
  let preparation: ScreenPreparation | undefined
  let probed: ScreenCapabilities | undefined
  let inputMode: ScreenInputMode | undefined
  let signalsBound = false
  let shutdownFinished = false
  let backpressured = false
  let outputFault: Error | undefined
  let detachData: (() => void) | undefined
  let detachResize: (() => void) | undefined
  let detachInputEnd: (() => void) | undefined
  let detachSignal: (() => void) | undefined
  let detachDrain: (() => void) | undefined
  const inputHandlers: ((bytes: string) => void)[] = []
  const resizeHandlers: ((size: TerminalSize) => void)[] = []
  const terminationRequestHandlers = new Set<(reason: ScreenTermination) => void>()
  const backpressureHandlers = new Set<(blocked: boolean) => void>()
  const writeFaultHandlers = new Set<(error: Error) => void>()

  const asError = (fault: unknown): Error => (fault instanceof Error ? fault : new Error(String(fault)))

  const setBackpressured = (blocked: boolean): void => {
    if (backpressured === blocked) return
    backpressured = blocked
    for (const handler of backpressureHandlers) handler(blocked)
  }

  const reportWriteFault = (fault: unknown): Error => {
    const error = asError(fault)
    if (outputFault !== undefined) return outputFault
    outputFault = error
    for (const handler of writeFaultHandlers) handler(error)
    return error
  }

  const write = (bytes: string, callback?: ScreenWriteCallback): boolean => {
    let returned = false
    let syncFault: Error | undefined
    let completed = false
    const complete: ScreenWriteCallback = (fault) => {
      if (completed) return
      completed = true
      if (fault !== undefined && fault !== null) {
        if (returned) reportWriteFault(fault)
        else syncFault = asError(fault)
      }
      callback?.(fault)
    }

    let accepted: boolean
    try {
      accepted = terminal.write(bytes, complete)
    } catch (fault) {
      complete(asError(fault))
      returned = true
      throw fault
    }
    returned = true
    if (syncFault !== undefined) throw syncFault
    if (!accepted && !backpressured) {
      setBackpressured(true)
      detachDrain = terminal.onDrain(() => {
        detachDrain?.()
        detachDrain = undefined
        setBackpressured(false)
      })
    }
    return accepted
  }

  const detachInputListeners = (): void => {
    detachData?.()
    detachData = undefined
    detachResize?.()
    detachResize = undefined
    detachInputEnd?.()
    detachInputEnd = undefined
  }

  const detachTerminalListeners = (): void => {
    detachInputListeners()
    detachSignal?.()
    detachSignal = undefined
    detachDrain?.()
    detachDrain = undefined
  }

  const requestTermination = (reason: ScreenTermination): void => {
    if (phase === "active") {
      // Input is no longer meaningful once shutdown starts, but frame()
      // remains writable so Ink can flush its unmount through the same FIFO.
      phase = "shutdown-requested"
      detachInputListeners()
    }
    if (phase !== "shutdown-requested" && phase !== "torn-down") return
    for (const handler of terminationRequestHandlers) handler(reason)
  }

  /**
   * Fatal diagnostics must outlive the pipe that broke: the terminal
   * write is the delivery, and when it faults the message still reaches
   * the operator on stderr while the fault keeps its original
   * propagation.
   */
  const emitDiagnostics = (diagnostics: string): void => {
    try {
      write(diagnostics)
    } catch (fault) {
      try {
        process.stderr.write(diagnostics)
      } catch {
        // Nothing is left to carry the message; the rethrown fault is.
      }
      throw fault
    }
  }

  const teardown = (details?: { readonly diagnostics?: string }): void => {
    if (phase === "idle" || phase === "torn-down") {
      // The terminal was either never touched or is already restored to
      // the primary screen: a fatal diagnostic still belongs there, and
      // the write is safe precisely because this screen holds no state.
      // (A fault that already tore the screen down — a frame-write fault
      // followed by an input-pipeline fault — must not lose its message.)
      if (details?.diagnostics !== undefined) emitDiagnostics(details.diagnostics)
      if (phase === "idle") detachTerminalListeners()
      return
    }
    // A prepared-but-never-activated screen never touched the terminal;
    // only a fatal diagnostic needs to reach the primary screen.
    if (phase === "prepared") {
      phase = "torn-down"
      if (details?.diagnostics !== undefined) emitDiagnostics(details.diagnostics)
      detachInputListeners()
      return
    }
    // Frames stop first: the phase flip makes frame() silent for the rest
    // of the teardown, so no interleaved write can hit the torn screen.
    phase = "torn-down"
    detachInputListeners()
    // Every restore step is attempted even when an earlier one throws
    // (a broken pipe must not strand raw mode or the alternate buffer);
    // the first fault is rethrown once the rest have run.
    let firstFault: unknown
    let failed = false
    const attempt = (restore: () => void): void => {
      try {
        restore()
      } catch (fault) {
        if (!failed) {
          firstFault = fault
          failed = true
        }
      }
    }
    attempt(() => write(RESTORE_SYNC_OUTPUT))
    attempt(() => write(restoreInputModes))
    attempt(() => write(probed?.leaveAlternateScreen ?? LEAVE_ALTERNATE_SCREEN))
    attempt(() => terminal.setRawMode(false))
    const diagnostics = details?.diagnostics
    if (diagnostics !== undefined) attempt(() => emitDiagnostics(diagnostics))
    if (failed) throw firstFault
  }

  detachData = terminal.onData((bytes) => {
    if (phase !== "active") return
    for (const handler of inputHandlers) handler(bytes)
  })
  detachResize = terminal.onResize((size) => {
    if (phase !== "active") return
    for (const handler of resizeHandlers) handler(size)
  })

  const bindSignals = (): void => {
    if (signalsBound) return
    signalsBound = true
    detachSignal = terminal.onSignal((signal) => requestTermination(signal))
    detachInputEnd = terminal.onInputEnd(() => {
      requestTermination("stdin-end")
    })
  }

  return {
    prepare() {
      if (phase === "torn-down") {
        return {
          ok: false,
          capabilities: probed ?? { terminal: "(unprobed)", alternateScreen: false },
          diagnostics: "this isolated screen was already torn down; build a new screen instead of restarting it",
        }
      }
      if (preparation === undefined) {
        const capabilities = terminal.probeCapabilities()
        probed = capabilities
        preparation = capabilities.alternateScreen
          ? { ok: true, capabilities }
          : {
              ok: false,
              capabilities,
              diagnostics: `terminal ${capabilities.terminal} cannot host the isolated screen: ${
                capabilities.reason ?? "alternate-screen capability unprovable"
              }`,
            }
        phase = "prepared"
      }
      return preparation
    },
    activate(activation) {
      if (phase === "torn-down") {
        // A restart-after-teardown is a wiring bug, not a state to ride
        // out quietly: prepare() refuses the same case with a
        // diagnostic, and a silent no-op here would blank the screen
        // instead of surfacing it.
        throw new Error("this isolated screen was already torn down; build a new screen instead of activating it")
      }
      if (phase === "active") {
        if (inputMode === "canonical" && activation?.input !== "canonical") this.engageRawInput()
        return
      }
      if (phase === "shutdown-requested") throw new Error("this isolated screen is shutting down")
      if (preparation === undefined || !preparation.ok) {
        throw new Error("the isolated screen requires a successful capability probe before activation")
      }
      phase = "active"
      bindSignals()
      if (activation?.input === "canonical") {
        inputMode = "canonical"
        terminal.establishCanonicalInput()
        write(HIDE_CURSOR)
      } else {
        inputMode = "raw"
        terminal.setRawMode(true)
        write(enableInputModes)
      }
      write(preparation.capabilities.enterAlternateScreen ?? ENTER_ALTERNATE_SCREEN)
    },
    engageRawInput() {
      if (phase !== "active" || inputMode === "raw") return
      inputMode = "raw"
      terminal.setRawMode(true)
      write(enableInputModes)
    },
    frame(content, callback) {
      if (phase !== "active" && phase !== "shutdown-requested") {
        callback?.()
        return true
      }
      return write(content.replace(CLEAR_SCROLLBACK, ""), callback)
    },
    async flush() {
      try {
        await terminal.flush()
      } catch (fault) {
        reportWriteFault(fault)
        throw fault
      }
      if (outputFault !== undefined) throw outputFault
    },
    onBackpressureChange(handler) {
      backpressureHandlers.add(handler)
      handler(backpressured)
      return () => backpressureHandlers.delete(handler)
    },
    onWriteFault(handler) {
      writeFaultHandlers.add(handler)
      if (outputFault !== undefined) handler(outputFault)
      return () => writeFaultHandlers.delete(handler)
    },
    phase() {
      return phase
    },
    size() {
      return terminal.size()
    },
    onInput(handler) {
      inputHandlers.push(handler)
      return () => {
        const index = inputHandlers.indexOf(handler)
        if (index >= 0) inputHandlers.splice(index, 1)
      }
    },
    onResize(handler) {
      resizeHandlers.push(handler)
    },
    onTerminationRequest(handler) {
      terminationRequestHandlers.add(handler)
      return () => terminationRequestHandlers.delete(handler)
    },
    teardown,
    finishShutdown() {
      if (shutdownFinished) return
      if (phase !== "torn-down" && phase !== "idle") {
        throw new Error("the isolated screen must be restored before finishing shutdown")
      }
      shutdownFinished = true
      if (phase === "idle") phase = "torn-down"
      detachTerminalListeners()
      terminationRequestHandlers.clear()
      backpressureHandlers.clear()
      writeFaultHandlers.clear()
    },
  }
}
