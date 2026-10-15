/**
 * Resting-screen key policy: the interaction state machine that observes
 * every key before the composer gets it. It owns the double-key exit
 * confirmation (Ctrl+C/Ctrl+D within one shared window), the idle Escape
 * windows (an empty draft chains toward the rewind dialog, a draft clears
 * into the history ring), and Shift+Tab permission-mode rotation. The
 * policy is framework-free and clock-injected; windows expire only
 * through expireWindows() — the host schedules that at the reported
 * deadline, so no timer plumbing lives here. One hint line mirrors the
 * transient confirmation windows: exit hint, then escape hint — the
 * permission mode never reaches it (the footer chip is the mode's only
 * display). A visible card suspends the exit, escape and rotation
 * claims: the interrupt still bubbles, every other key stays with the
 * card.
 */
import type { TuiIntent } from "../keys/index.js"

/** Shared confirmation window for the exit and idle-escape chains. */
export const ROOT_CONFIRM_WINDOW_MS = 800

/** Effects the host executes; the draft clear is applied by the store. */
export type RootKeyHostEffect =
  | { readonly kind: "interrupt" }
  | { readonly kind: "exit" }
  | { readonly kind: "open-rewind" }
  | { readonly kind: "rotate-permission"; readonly mode: string }

/** Everything the policy asks for when it claims a key. */
export type RootKeyEffect = RootKeyHostEffect | { readonly kind: "clear-draft" }

/** The control key that armed an exit confirmation. */
type ExitKey = "c" | "d"

/** What a second Escape within the window does. */
type EscapePending = "clear" | "rewind"

export interface RootKeyPolicyOptions {
  /** Draft emptiness probe; the editor kernel owns the draft. */
  readonly isDraftEmpty: () => boolean
  /**
   * Whether Escape still does editor work (insert-mode switch, operator
   * cancel); the idle-escape chains start only once it does not.
   */
  readonly consumesEscape: () => boolean
  /**
   * Whether a card is currently visible. A visible card owns every key
   * but the interrupt: Ctrl+C/Ctrl+D still report the abort yet never
   * arm the exit confirmation under a modal, and Shift+Tab stays with
   * the card instead of rotating the permission mode above it.
   */
  readonly modalCardOpen?: () => boolean
  /**
   * Canonical rotation sequence injected by the host (core permission
   * modes reach the TUI only through this seam). Absent, Shift+Tab is
   * inert; the policy never owns a second sequence.
   */
  readonly permissionModes?: readonly string[]
  /** Canonical session permission mode; null before the first event. */
  readonly permissionMode?: () => string | null
  readonly now?: () => number
}

/**
 * The exit-control intents this policy claims: Ctrl+C and Ctrl+D. Every
 * press also reports an interrupt so the host can abort an in-flight run
 * and drop queued input — the confirmation machine only decides exit.
 */
function exitControlKeyOf(intent: TuiIntent): ExitKey | null {
  if (intent.kind === "interrupt") return "c"
  if (intent.kind === "input" && intent.event.type === "ctrl" && (intent.event.value === "c" || intent.event.value === "d"))
    return intent.event.value
  return null
}

export class RootKeyPolicy {
  private exitKey: ExitKey | null = null
  private exitArmedAt = 0
  private escapePending: EscapePending | null = null
  private escapeArmedAt = 0
  private stateRevision = 1
  /** The hint line as of the last revision bump; starts hidden. */
  private publishedHint: string | null = null
  private readonly isDraftEmpty: () => boolean
  private readonly consumesEscape: () => boolean
  private readonly modalCardOpen: (() => boolean) | undefined
  private readonly permissionModes: readonly string[] | undefined
  private readonly permissionModeProbe: (() => string | null) | undefined
  private readonly now: () => number

  constructor(options: RootKeyPolicyOptions) {
    this.isDraftEmpty = options.isDraftEmpty
    this.consumesEscape = options.consumesEscape
    this.modalCardOpen = options.modalCardOpen
    this.permissionModes = options.permissionModes
    this.permissionModeProbe = options.permissionMode
    this.now = options.now ?? Date.now
  }

  /**
   * Observe one intent. A non-null result claims the key and carries the
   * effects; null passes the key through to the composer pipeline while
   * cancelling any pending confirmation window (any other key is
   * activity).
   */
  dispatch(intent: TuiIntent): readonly RootKeyEffect[] | null {
    const modal = this.modalCardOpen !== undefined && this.modalCardOpen()
    const exitKey = exitControlKeyOf(intent)
    if (exitKey !== null) {
      if (modal) {
        // The card owns every key but the interrupt: the abort still
        // bubbles, the exit confirmation disarms instead of arming —
        // a pending approval is decided, never escaped.
        this.noteActivity()
        return [{ kind: "interrupt" }]
      }
      return this.pressExit(exitKey)
    }
    if (intent.kind === "input" && intent.event.type === "shift-tab") {
      if (modal) {
        // Rotation is a resting-screen affordance; the visible card
        // takes the key (its own focus or an absorbed stray).
        this.noteActivity()
        return null
      }
      this.disarmAll()
      const modes = this.permissionModes
      if (modes === undefined || modes.length === 0) {
        this.noteHintChange()
        return []
      }
      // The requested mode is the sequence's next after the current
      // canonical mode; the truth reads back from events, and the
      // rotation itself never writes the hint line — the footer chip is
      // the mode's only display. A confirmation window this press
      // disarmed still publishes its cleared line.
      const current = this.permissionMode()
      const index = modes.indexOf(current ?? modes[0]!)
      this.noteHintChange()
      return [{ kind: "rotate-permission", mode: modes[(index + 1) % modes.length]! }]
    }
    if (intent.kind === "back" && (this.consumesEscape() || modal)) {
      // Escape belongs to the editor (an insert-mode switch, an
      // operator cancel) or to a visible card; the idle-escape chains
      // are resting-screen affordances that must not arm under either,
      // and a window armed before the card opened disarms with the
      // same key.
      this.noteActivity()
      return null
    }
    if (intent.kind === "back") return this.pressEscape()
    this.noteActivity()
    return null
  }

  /**
   * Monotone counter over every observable hint change — a window
   * armed, cancelled or expired that the hint line shows. The store
   * commits only when it moved, so a policy move the hint cannot
   * express (a rotation with no window armed) mints nothing.
   */
  get revision(): number {
    return this.stateRevision
  }

  /**
   * One hint line at a time: the exit hint, then the escape hint;
   * nothing else claims the line.
   */
  hint(): string | null {
    if (this.exitKey !== null && this.exitWindowLive()) return `Press Ctrl-${this.exitKey.toUpperCase()} again to exit`
    if (this.escapePending !== null && this.now() - this.escapeArmedAt < ROOT_CONFIRM_WINDOW_MS) {
      return this.escapePending === "rewind" ? "Press Esc again to rewind" : "Press Esc again to clear input"
    }
    return null
  }

  /** When the earliest live confirmation window ends; null when none. */
  nextWindowDeadline(): number | null {
    let deadline: number | null = null
    if (this.exitKey !== null && this.exitWindowLive()) deadline = this.exitArmedAt + ROOT_CONFIRM_WINDOW_MS
    if (this.escapePending !== null && this.now() - this.escapeArmedAt < ROOT_CONFIRM_WINDOW_MS) {
      const escapeDeadline = this.escapeArmedAt + ROOT_CONFIRM_WINDOW_MS
      deadline = deadline === null ? escapeDeadline : Math.min(deadline, escapeDeadline)
    }
    return deadline
  }

  /**
   * Disarm windows whose confirmation time has passed; returns whether
   * the hint changed so the caller commits only real changes. An
   * expired window the clock already hid from the hint cleans up
   * silently — nothing visible changed, so nothing commits.
   */
  expireWindows(): boolean {
    if (this.exitKey !== null && !this.exitWindowLive()) this.exitKey = null
    if (this.escapePending !== null && this.now() - this.escapeArmedAt >= ROOT_CONFIRM_WINDOW_MS) this.escapePending = null
    return this.noteHintChange()
  }

  /**
   * Any key outside the owned vocabulary cancels both confirmation
   * windows; returns whether the hint line changed.
   */
  noteActivity(): boolean {
    this.exitKey = null
    this.escapePending = null
    return this.noteHintChange()
  }

  /**
   * Bump the revision exactly when the hint line the store last
   * published would change: `publishedHint` is the hint as of the last
   * bump, so a window the clock already lapsed still reads as a pending
   * change until some policy action or expiry publishes the cleared
   * line — the view carries committed hints, not live ones.
   */
  private noteHintChange(): boolean {
    if (this.hint() === this.publishedHint) return false
    this.publishedHint = this.hint()
    this.stateRevision += 1
    return true
  }

  /** Canonical session permission mode; null before the first event. */
  private permissionMode(): string | null {
    const current = this.permissionModeProbe?.() ?? null
    return current !== null && current.length > 0 ? current : null
  }

  private exitWindowLive(): boolean {
    return this.now() - this.exitArmedAt < ROOT_CONFIRM_WINDOW_MS
  }

  private pressExit(key: ExitKey): readonly RootKeyEffect[] {
    const armed = this.exitKey === key && this.exitWindowLive()
    this.exitKey = key
    this.exitArmedAt = this.now()
    if (armed) {
      // The confirming press still reports the interrupt first: the host
      // aborts an in-flight run and drops queued input on the way out.
      this.exitKey = null
      this.noteHintChange()
      return [{ kind: "interrupt" }, { kind: "exit" }]
    }
    this.noteHintChange()
    return [{ kind: "interrupt" }]
  }

  private pressEscape(): readonly RootKeyEffect[] {
    // An escape press always cancels the exit confirmation first. The
    // draft state at press time picks the branch: an empty draft chains
    // toward rewind, a draft clears once a window is live.
    this.exitKey = null
    const live = this.escapePending !== null && this.now() - this.escapeArmedAt < ROOT_CONFIRM_WINDOW_MS
    const pending = live ? this.escapePending : null
    this.escapePending = null
    if (this.isDraftEmpty()) {
      if (pending === "rewind") {
        this.noteHintChange()
        return [{ kind: "open-rewind" }]
      }
      this.escapePending = "rewind"
      this.escapeArmedAt = this.now()
      this.noteHintChange()
      return []
    }
    if (pending !== null) {
      this.noteHintChange()
      return [{ kind: "clear-draft" }]
    }
    this.escapePending = "clear"
    this.escapeArmedAt = this.now()
    this.noteHintChange()
    return []
  }

  private disarmAll(): void {
    this.exitKey = null
    this.escapePending = null
  }
}
