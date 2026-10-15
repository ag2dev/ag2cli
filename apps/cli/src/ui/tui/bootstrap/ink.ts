/**
 * Assembly root for the Ink frame: composes the screen deep module,
 * the framework-free state
 * store and the React/Ink view tree into one lifecycle. Ink's terminal
 * reach is narrowed to a frame-only stdout proxy — every byte it writes
 * funnels through screen.frame(), raw mode and buffer switching stay
 * with the screen module (Ink's own alternateScreen/exitOnCtrlC/
 * patchConsole paths are off). Shutdown fences input and state-driven
 * renders, unmounts Ink through the still-live output FIFO and restores
 * the host terminal in the same stack — a stop, a signal or a pipeline
 * fault must never leave the terminal raw on the alternate buffer past
 * its caller — then awaits Ink's exit barrier and the terminal flush
 * before releasing the screen's listeners. Pipeline faults with a
 * caller (input, resize, the first frame) rethrow after that
 * synchronous teardown; faults with none (a frame write inside Ink's
 * own commit, a bare timer) defer the unmount to the next loop turn and
 * surface through flush(). Keys enter as
 * store key-intents; their effects (submissions and global key
 * requests) leave through one host seam, and the confirmation-window
 * expiry is scheduled off the store's own commits while the frame is
 * live.
 */
import { createElement } from "react"
import type { ReactNode } from "react"
import { render } from "ink"
import { createInputDecoder, intentFor } from "../keys/index.js"
import {
  createTuiStateStore,
  SUPPORT_FLOOR,
  type TuiCompletionSources,
  type TuiStateEffect,
  type TuiStateStore,
  type TuiStateStoreOptions,
} from "../state/index.js"
import type { ScreenPreparation, TerminalScreen, TerminalSize } from "../screen/index.js"
import type { ThemeId } from "../text/index.js"
import { TuiRoot } from "../view/index.js"

// The bootstrap is the entrypoint's only legal window onto the TUI
// tree, so the floor constant rides this seam for its pre-flight check.
export { SUPPORT_FLOOR } from "../state/index.js"

const ESCAPE_AMBIGUITY_WINDOW_MS = 35
const INK_EXIT_TIMEOUT_MS = 1_000
const TERMINAL_FLUSH_TIMEOUT_MS = 300

type BoundedOutcome = { readonly kind: "complete" } | { readonly kind: "error"; readonly error: unknown } | { readonly kind: "timeout" }

function waitBounded(promise: Promise<unknown>, timeoutMs: number): Promise<BoundedOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ kind: "timeout" })
    }, timeoutMs)
    promise.then(
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ kind: "complete" })
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ kind: "error", error })
      },
    )
  })
}

export interface InkTuiFrame {
  /** Store the host application dispatches session content into. */
  readonly store: TuiStateStore
  /**
   * Capability gate, then activation and the first frame: refuses
   * terminals that cannot prove alternate-screen support before a single
   * byte is written or raw mode is entered. Idempotent while live; a
   * stopped frame refuses to restart (build a new frame instead).
   */
  start(): ScreenPreparation
  /**
   * Fence the frame, unmount Ink while the alternate buffer still owns
   * output, restore the host terminal in the same stack, then await
   * Ink's bounded exit barrier and the terminal flush. Idempotent;
   * diagnostics land on the restored primary screen.
   */
  stop(options?: { readonly diagnostics?: string }): Promise<void>
  /**
   * Resolves once pending render output has been written; a stop() or
   * signal landing while a flush is pending resolves it instead of
   * awaiting a dead renderer. A fatal frame fault — a frame write or
   * the window-expiry pipeline — is rethrown here, after the teardown
   * the fault itself already scheduled, because rethrowing
   * synchronously from inside Ink's own commit leaves the
   * process-global React dispatcher poisoned for every later render
   * (and a bare timer callback has no caller to rethrow to).
   */
  flush(): Promise<void>
  /**
   * Swap the theme the tree renders with: a live frame re-renders in
   * place, one that has not started (or already stopped) applies the
   * theme at its next build. An equal theme re-renders nothing — the
   * theme commit path treats a no-op commit as the same frame.
   */
  setTheme(theme: ThemeId): void
}

export interface InkTuiFrameOptions {
  readonly screen: TerminalScreen
  /** Let an enclosing application owner stop its controllers before Ink unmounts. */
  readonly autoStopOnTermination?: boolean
  readonly store?: TuiStateStore
  /**
   * Completion sources for the frame-built store: mention candidates for
   * @ tokens and command candidates for / tokens. Ignored when a store
   * is injected — sources are store-construction state.
   */
  readonly completion?: TuiCompletionSources
  /**
   * Resting-screen key policy wiring for the frame-built store: the
   * clock the confirmation windows live on and the permission rotation
   * the Shift+Tab hint mirrors. Ignored when a store is injected — the
   * injected store's own clock then drives the expiry scheduling.
   */
  readonly keys?: TuiStateStoreOptions
  readonly theme?: ThemeId
  /**
   * Ink render entry, overridable so lifecycle tests can substitute a
   * stub renderer (one whose unmount faults, say); production leaves
   * it unset and gets the real one.
   */
  readonly render?: typeof render
  /**
   * Every outbound store effect — composer submissions plus the global
   * key requests the resting-screen policy produces (interrupt, exit,
   * rewind, permission rotation). Unset keeps them inert — the test
   * frame's default.
   */
  readonly onEffect?: (effect: TuiStateEffect) => void
  /**
   * A fatal frame fault (a frame write or the window-expiry pipeline)
   * the frame could not surface to a caller synchronously: the terminal
   * is already restored by the fault path itself, so this notification
   * is the production host's cue to exit the process. Fires at most
   * once per frame.
   */
  readonly onFatal?: (reason: string) => void
}

export function createInkTuiFrame(options: InkTuiFrameOptions): InkTuiFrame {
  const screen = options.screen
  const renderFrame = options.render ?? render
  const store = options.store ?? createTuiStateStore(options.completion, options.keys)
  // The expiry timer must measure deadlines on the store's own clock:
  // an injected store may carry a non-wall clock, and mixing the two
  // turns every deadline into an immediate 0ms re-arm.
  const clock = options.store?.now ?? options.keys?.now ?? Date.now
  let theme = options.theme ?? "dark"
  const decoder = createInputDecoder()
  const resizeListeners = new Set<() => void>()
  const viewListeners = new Set<() => void>()
  let renderer: ReturnType<typeof render> | undefined
  let started: ScreenPreparation | undefined
  // The first fatal frame fault (a frame write or the window-expiry
  // pipeline), held for the next flush() to rethrow: a synchronous
  // rethrow from inside Ink's commit poisons the process-global React
  // dispatcher for every later render, and a rethrow from a bare timer
  // callback is an uncaught exception — so those paths swallow the
  // fault and record it here instead.
  let writeFault: unknown
  let renderBlocked = false
  let viewDirty = false
  let resizeDirty = false
  let themeDirty = false
  let coalescingView = false
  let drainWaiters: (() => void)[] = []
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let escapeTimer: ReturnType<typeof setTimeout> | undefined
  let expiryUnsubscribe: (() => void) | undefined
  let viewStoreUnsubscribe: (() => void) | undefined
  let detachBackpressure: (() => void) | undefined
  let detachWriteFault: (() => void) | undefined
  let detachTerminationRequest: (() => void) | undefined
  let stopPromise: Promise<void> | undefined
  let stopStartedResolve!: () => void
  const stopStarted = new Promise<void>((resolve) => {
    stopStartedResolve = resolve
  })
  let fatalNotified = false

  const notifyViewListeners = (): void => {
    for (const listener of [...viewListeners]) listener()
  }

  const viewStore: TuiStateStore = {
    subscribe(listener) {
      viewListeners.add(listener)
      return () => viewListeners.delete(listener)
    },
    getSnapshot: () => store.getSnapshot(),
    themeCardVisible: () => store.themeCardVisible(),
    dispatch: (input) => store.dispatch(input),
    windowDeadline: () => store.windowDeadline(),
    now: () => store.now(),
  }

  viewStoreUnsubscribe = store.subscribe(() => {
    if (renderBlocked || coalescingView) {
      viewDirty = true
      return
    }
    notifyViewListeners()
  })

  const wakeDrainWaiters = (): void => {
    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  const clearEscapeTimer = (): void => {
    if (escapeTimer !== undefined) clearTimeout(escapeTimer)
    escapeTimer = undefined
  }

  /** Timer plumbing for the store's confirmation windows: expiry is host work. */
  const scheduleWindowExpiry = (): void => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    expiryTimer = undefined
    const deadline = store.windowDeadline()
    if (deadline === null) return
    expiryTimer = setTimeout(
      () => {
        expiryTimer = undefined
        try {
          store.dispatch({ kind: "expire-windows" })
          // Re-arm unconditionally: an expiry whose commit the hint could
          // not express (a second window still live) must still find the
          // next deadline, and an armed-nothing read schedules nothing.
          scheduleWindowExpiry()
        } catch (fault) {
          // The timer runs bare in the event loop: a rethrow here is an
          // uncaught exception, so the expiry fault follows the
          // frame-fault path — complete shutdown first, then flush() rethrows.
          failFrame(fault, "tui window expiry fault", `fatal: tui window expiry fault: ${String(fault)}\r\n`)
        }
      },
      Math.max(0, deadline - clock()),
    )
    // An armed window must not hold the process open: the timer dies
    // with the loop instead of delaying exit by its own deadline.
    expiryTimer.unref?.()
  }

  /**
   * Track the windows off the store's own commits: any dispatch path
   * that arms, re-arms or disarms a window — keys, host inputs, the
   * expiry itself — lands a committed revision, and the commit is the
   * one signal every one of them shares. Bound while the frame is
   * live; a stopped frame leaves no subscription or timer behind.
   */
  const bindWindowExpiry = (): void => {
    expiryUnsubscribe?.()
    expiryUnsubscribe = store.subscribe(scheduleWindowExpiry)
    scheduleWindowExpiry()
  }

  const clearWindowExpiry = (): void => {
    expiryUnsubscribe?.()
    expiryUnsubscribe = undefined
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    expiryTimer = undefined
  }

  const routeInputEvents = (events: ReturnType<typeof decoder.decode>): void => {
    for (const event of events) {
      if (renderer === undefined) break
      const intent = intentFor(event)
      const size = frameSize()
      const tooSmall = size.columns < SUPPORT_FLOOR.columns || size.rows < SUPPORT_FLOOR.rows
      // Keep the host's two-step Ctrl+C exit available on the diagnostic
      // screen; hidden composer/card actions must not mutate the draft.
      if (tooSmall && intent.kind !== "interrupt") continue
      for (const effect of store.dispatch({ kind: "key-intent", intent })) options.onEffect?.(effect)
    }
  }

  const scheduleEscapeResolution = (): void => {
    if (!decoder.hasPendingEscape()) return
    escapeTimer = setTimeout(() => {
      escapeTimer = undefined
      try {
        routeInputEvents(decoder.flushPendingEscape())
      } catch (fault) {
        failFrame(fault, "tui input pipeline fault", `fatal: tui input pipeline fault: ${String(fault)}\r\n`)
      }
    }, ESCAPE_AMBIGUITY_WINDOW_MS)
    escapeTimer.unref?.()
  }

  /**
   * One fault path for synchronous throws and Writable callback errors.
   * A fault raised inside Ink's own commit passes defer: unmounting
   * reentrantly from inside the commit would poison the process-global
   * React dispatcher, so its teardown runs on the next loop turn.
   */
  const failFrame = (
    fault: unknown,
    reason = "tui frame write fault",
    diagnostics = `fatal: tui frame write fault: ${String(fault)}\r\n`,
    defer = false,
  ): void => {
    if (writeFault !== undefined) return
    writeFault = fault instanceof Error ? fault : new Error(String(fault))
    clearEscapeTimer()
    void stopFrames({ diagnostics }, defer)
      .finally(() => {
        if (fatalNotified) return
        fatalNotified = true
        // The host cannot poll flush() in production: this is its exit cue.
        options.onFatal?.(reason)
      })
      .catch(() => {})
  }

  /**
   * Fence the app, unmount Ink through its output FIFO and restore the
   * host terminal — all synchronously, so no caller's stack can end
   * with the terminal still raw on the alternate buffer — then await
   * Ink's bounded exit barrier and the terminal flush before releasing
   * the screen's listeners. Ink-side faults (unmount, exit barrier)
   * land in writeFault for the next flush() to rethrow; only screen
   * and terminal faults reject the stop itself.
   */
  const stopFrames = (stopOptions?: { readonly diagnostics?: string }, defer = false): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise
    // Publish the shared promise before calling renderer code: unmount may
    // synchronously report another write fault that re-enters this path.
    let resolveStop!: () => void
    let rejectStop!: (fault: unknown) => void
    stopPromise = new Promise<void>((resolve, reject) => {
      resolveStop = resolve
      rejectStop = reject
    })
    stopStartedResolve()
    const finishStop = (): void => {
      const asError = (fault: unknown): Error => (fault instanceof Error ? fault : new Error(String(fault)))
      clearWindowExpiry()
      clearEscapeTimer()
      renderBlocked = true
      wakeDrainWaiters()
      started = undefined
      const current = renderer
      renderer = undefined
      viewStoreUnsubscribe?.()
      viewStoreUnsubscribe = undefined
      detachBackpressure?.()
      detachBackpressure = undefined
      detachWriteFault?.()
      detachWriteFault = undefined

      if (current !== undefined) {
        try {
          current.unmount()
        } catch (fault) {
          // The terminal restore below is the part that cannot be
          // skipped; the renderer fault waits at the flush seam.
          if (writeFault === undefined) writeFault = asError(fault)
        }
      }
      let screenFault: unknown
      // A screen that never activated never wrote a byte; its drain
      // barrier would be the first write an untouched terminal sees.
      const screenWrote = screen.phase() === "active" || screen.phase() === "shutdown-requested"
      try {
        screen.teardown(stopOptions)
      } catch (fault) {
        screenFault = fault
      }
      void (async (): Promise<void> => {
        if (current !== undefined && typeof current.waitUntilExit === "function") {
          const outcome = await waitBounded(
            Promise.resolve().then(() => current.waitUntilExit()),
            INK_EXIT_TIMEOUT_MS,
          )
          if (outcome.kind === "error" || outcome.kind === "timeout") {
            const fault = outcome.kind === "error" ? outcome.error : new Error("Ink unmount timed out")
            if (writeFault === undefined) writeFault = asError(fault)
          }
        }
        let terminalFault: unknown
        if (screenWrote) {
          const flush = await waitBounded(screen.flush(), TERMINAL_FLUSH_TIMEOUT_MS)
          if (flush.kind === "error") terminalFault = flush.error
          else if (flush.kind === "timeout") terminalFault = new Error("terminal restore flush timed out")
        }
        try {
          screen.finishShutdown()
        } catch (fault) {
          if (screenFault === undefined) screenFault = fault
        }
        detachTerminationRequest?.()
        detachTerminationRequest = undefined
        if (screenFault !== undefined) rejectStop(screenFault)
        else if (terminalFault !== undefined) rejectStop(terminalFault)
        else resolveStop()
      })()
    }
    if (defer) {
      const timer = setTimeout(finishStop, 0)
      timer.unref?.()
    } else {
      finishStop()
    }
    return stopPromise
  }

  // Keys flow through the screen (the terminal's only owner) and the
  // decoder into the store's one key pipeline; whatever leaves as an
  // effect is the host's to execute. A fault anywhere in that pipeline
  // must not strand the host terminal in raw mode on the alternate
  // buffer: the frame fences work and restores the terminal in this
  // stack, then the original fault rethrows through the seam that fed
  // the bytes — the input caller crashes with the terminal restored.
  screen.onInput((bytes) => {
    clearEscapeTimer()
    try {
      routeInputEvents(decoder.decode(bytes))
      scheduleEscapeResolution()
    } catch (fault) {
      failFrame(fault, "tui input pipeline fault", `fatal: tui input pipeline fault: ${String(fault)}\r\n`)
      throw fault
    }
  })

  // Frame-only stdout proxy: Ink renders, the screen owns the terminal.
  // Ink 8 uses empty writes with callbacks as render/unmount barriers; route
  // those barriers through the screen's ordered writable flush.
  // The screen's resize notifications are forwarded so Ink re-renders with
  // fresh stdout geometry; the tree itself reads the size from the store
  // snapshot the resize's layout dispatch commits.
  const stdout = {
    write(bytes: string | Uint8Array, callback?: (error?: Error | null) => void): boolean {
      const content = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)
      if (content === "" && callback !== undefined) {
        void screen.flush().then(
          () => callback(),
          (fault: unknown) => callback(fault instanceof Error ? fault : new Error(String(fault))),
        )
        return true
      }
      try {
        return screen.frame(content, callback)
      } catch (fault) {
        // A frame-write fault (a broken pipe) must
        // not strand the host terminal in raw mode on the alternate
        // buffer — but it also must not rethrow from in here: this
        // write runs inside Ink's own synchronous commit, and an
        // exception escaping it leaves the process-global React
        // dispatcher poisoned for every later render in the process.
        // So the fault is recorded and shutdown — including the
        // unmount, which must not run reentrantly inside the commit —
        // starts on the next loop turn; flush() reports it after Ink
        // and Screen cleanup.
        failFrame(fault, undefined, undefined, true)
        // The screen wrapper already reported synchronous write errors to
        // the supplied callback exactly once before rethrowing.
        return true
      }
    },
    get columns(): number {
      return frameSize().columns
    },
    get rows(): number {
      return frameSize().rows
    },
    isTTY: true,
    on(_event: "resize", listener: () => void): void {
      resizeListeners.add(listener)
    },
    off(_event: "resize", listener: () => void): void {
      resizeListeners.delete(listener)
    },
  } as unknown as NodeJS.WriteStream

  detachWriteFault = screen.onWriteFault(failFrame)

  // The terminal's size facts enter the frame here, clamped to the
  // finite floor the tree's geometry assumes: a port that ever reports
  // NaN lands on the too-small diagnostic instead of poisoning every
  // width computation downstream (the comparisons in the tree cannot
  // catch NaN themselves). The store clamps its layout input the same
  // way at its own boundary.
  const frameSize = (): TerminalSize => {
    const size = screen.size()
    return {
      columns: Number.isFinite(size.columns) ? Math.max(1, Math.floor(size.columns)) : 1,
      rows: Number.isFinite(size.rows) ? Math.max(0, Math.floor(size.rows)) : 0,
    }
  }

  const rootElement = (): ReactNode => {
    return createElement(TuiRoot, { store: viewStore, theme })
  }

  // The screen's size is the store's single geometry authority: every
  // frame the terminal lays out is preceded by the layout it derives
  // the transcript window and the card grants against.
  const dispatchLayout = (): void => {
    const size = frameSize()
    store.dispatch({ kind: "layout", columns: size.columns, rows: size.rows })
  }

  /**
   * Render only the latest snapshot once output backpressure clears.
   * Faults propagate to the caller: the seams with a caller (resize,
   * the first frame) restore the terminal and rethrow; bare callbacks
   * (the drain notification) take the frame-fault path instead.
   */
  const flushPendingView = (): void => {
    if (renderBlocked) return
    const pendingResize = resizeDirty
    const pendingTheme = themeDirty
    const shouldRender = viewDirty || pendingResize || pendingTheme
    if (!shouldRender) return

    resizeDirty = false
    viewDirty = false
    themeDirty = false
    if (pendingResize) {
      coalescingView = true
      try {
        dispatchLayout()
      } finally {
        coalescingView = false
      }
    }

    const changedView = viewDirty
    viewDirty = false
    // Store listeners render session/layout changes. A theme is root
    // configuration, so it uses Ink's explicit rerender seam. This keeps
    // a resize from committing once through the store and again through a
    // redundant renderer.rerender call.
    if (pendingTheme && renderer !== undefined) renderer.rerender(rootElement())
    else if (changedView) notifyViewListeners()
    if (pendingResize) {
      if (renderBlocked) {
        // Ink's resize bookkeeping must run after its current frame can
        // reach the terminal; replay only the latest size after drain.
        resizeDirty = true
        return
      }
      for (const listener of [...resizeListeners]) listener()
    }
  }

  const awaitDrain = (): Promise<void> => {
    if (!renderBlocked) return Promise.resolve()
    return new Promise((resolve) => drainWaiters.push(resolve))
  }

  detachBackpressure = screen.onBackpressureChange((blocked) => {
    renderBlocked = blocked
    if (blocked) return
    try {
      flushPendingView()
    } catch (fault) {
      // A bare drain callback has no caller to crash: the fault takes
      // the frame-fault path and surfaces through flush().
      failFrame(fault)
      return
    }
    if (!renderBlocked) wakeDrainWaiters()
  })

  // Inert stdin: Ink must never touch the real stdin (raw mode is the
  // screen's). With isTTY false its whole input pipeline — useInput, focus,
  // exitOnCtrlC — stays deterministically off; keys arrive only through
  // screen.onInput above.
  const inertStdin = { isTTY: false } as unknown as NodeJS.ReadStream

  // A resize runs the same pipeline as input — layout dispatch, Ink
  // rerender — so a fault in it follows the same ordered shutdown path
  // and rethrows: the resize caller crashes with the terminal restored.
  screen.onResize(() => {
    if (renderBlocked) {
      resizeDirty = true
      viewDirty = true
      return
    }
    resizeDirty = true
    try {
      flushPendingView()
    } catch (fault) {
      failFrame(fault, "tui resize pipeline fault", `fatal: tui resize pipeline fault: ${String(fault)}\r\n`)
      throw fault
    }
  })
  // Standalone frames also complete shutdown. The process owner registers
  // its own request handler after host construction; both paths share this
  // promise, so duplicate signals cannot race terminal restoration.
  if (options.autoStopOnTermination !== false) {
    detachTerminationRequest = screen.onTerminationRequest(() => {
      void stopFrames().catch(() => {})
    })
  }

  return {
    store,
    start() {
      if (stopPromise !== undefined) {
        const previous = screen.prepare()
        return {
          ok: false,
          capabilities: previous.capabilities,
          diagnostics: "this Ink frame is torn down; build a new frame instead of restarting it",
        }
      }
      // Idempotent: a live frame keeps its renderer and preparation; a
      // second start writes nothing. A stopped frame cannot restart —
      // the screen's torn-down gate refuses it (build a new frame).
      if (renderer !== undefined && started !== undefined) return started
      const preparation = screen.prepare()
      if (!preparation.ok) return preparation
      try {
        // Activation mutates the host terminal (signal binds, raw mode,
        // input modes, the buffer switch) after flipping its phase to
        // active, so a fault in its writes strands the terminal exactly
        // like a first-frame fault — it belongs under the same guard.
        screen.activate()
        dispatchLayout()
        renderer = renderFrame(rootElement(), {
          stdin: inertStdin,
          stdout,
          maxFps: 30,
          exitOnCtrlC: false,
          patchConsole: false,
          alternateScreen: false,
          interactive: true,
        })
      } catch (fault) {
        // The terminal is already raw on the alternate buffer here: a
        // fault in the first layout or render must not strand it — the
        // frame restores the terminal in this stack, then the fault
        // rethrows to the starter.
        void stopFrames({ diagnostics: `fatal: tui first frame fault: ${String(fault)}\r\n` }).catch(() => {})
        throw fault
      }
      // A first-frame write fault already tore the frame down inside
      // the render call above: bind nothing on a dead frame — flush()
      // is holding the fault for the host.
      if (writeFault === undefined) {
        bindWindowExpiry()
        started = preparation
      }
      return preparation
    },
    stop(stopOptions) {
      return stopFrames(stopOptions)
    },
    setTheme(next) {
      if (theme === next) return
      theme = next
      // A live frame re-renders in place; one that never started (or
      // already stopped) renders nothing now and picks the theme up at
      // its next build.
      if (renderBlocked) themeDirty = true
      else renderer?.rerender(rootElement())
    },
    async flush() {
      // Capture the renderer before yielding: a stop() landing in the
      // tick window unmounts and detaches it, and a dead renderer must
      // not be awaited.
      const current = renderer
      if (current === undefined) {
        if (stopPromise !== undefined) await stopPromise
        if (writeFault !== undefined) throw writeFault
        return
      }
      // Store notifications schedule the re-render asynchronously; yield
      // one tick so the update commits before waiting on Ink's flush.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (renderer !== current) {
        if (writeFault !== undefined) throw writeFault
        return
      }
      while (renderer === current) {
        const renderFlush = current.waitUntilRenderFlush().then(
          () => ({ kind: "flushed" as const }),
          (fault: unknown) => ({ kind: "error" as const, fault }),
        )
        const outcome = await Promise.race([renderFlush, stopStarted.then(() => ({ kind: "stopped" as const }))])
        if (outcome.kind === "stopped") {
          await stopPromise
          if (writeFault !== undefined) throw writeFault
          return
        }
        if (outcome.kind === "error") {
          failFrame(outcome.fault)
          await stopPromise?.catch(() => {})
          throw writeFault ?? outcome.fault
        }
        if (writeFault !== undefined) throw writeFault
        if (renderer !== current) return
        if (renderBlocked) {
          await awaitDrain()
          continue
        }
        // Ink 8's public waitUntilRenderFlush() includes the stdout write
        // callback barrier. The proxy maps that empty write into Screen's
        // FIFO, so a second Screen.flush() would enqueue a duplicate barrier.
        return
      }
      if (writeFault !== undefined) throw writeFault
    },
  }
}
