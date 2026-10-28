/**
 * Declarative input adjudication: the routing order lives in one
 * ordered owner table instead of an implicit dispatch chain. The
 * resolver is a pure function over one InputWorld — the coordinator
 * builds that world once per dispatch so adjudication and snapshot
 * rendering always see the same facts. Routing decides only who owns
 * an input; whether a business claim may execute is a separate
 * verdict (executionGate) over the binding the surface mints.
 */
import type { TuiIntent } from "../../keys/index.js"

/** The declared routing order; earlier owners win. */
export const OWNER_ORDER = [
  "quit",
  "permission-cycle",
  "reader",
  "decision",
  "companion",
  "task",
  "focus-cycle",
  "panel",
  "viewport",
  "resting",
  "editor",
] as const
export type OwnerId = (typeof OWNER_ORDER)[number]

/**
 * Binding identity: what a business claim executes. The epoch advances
 * only with the semantic target (new request, changed disclosure, new
 * save target) — never with stream tokens, spinners, or plain view
 * revisions — so an armed binding survives cosmetic churn and dies on
 * real change.
 */
export interface BindingIdentity {
  readonly owner: OwnerId
  readonly action: string
  readonly target: string
  readonly epoch: number
}

/**
 * Navigation claims never reach an executor. Business claims from the
 * quit owner (interrupt, quit) are exempt from the activation barrier;
 * every other business claim must pass executionGate before its
 * command is emitted.
 */
export type ClaimClass = "business" | "navigation"

export interface OwnerClaim {
  readonly owner: OwnerId
  readonly class: ClaimClass
}

export type Resolution = OwnerClaim | { readonly unhandled: true }

/**
 * Routing facts only, one read per dispatch. Validity: the composer
 * holds input (editor.active) exactly while no surface holds it — an
 * open task parks the composer, and the support-floor fallback routes
 * a below-floor surface's input back to the composer. Arming and write
 * eligibility are execution concerns; they never influence who claims.
 */
export interface InputWorld {
  readonly layout: { readonly columns: number; readonly rows: number }
  readonly supportFloor: { readonly columns: number; readonly rows: number }
  readonly reader: { readonly open: boolean }
  readonly peers: { readonly count: number; readonly taskHoldsInput: boolean }
  /**
   * The children board's routing facts: entry count feeds the Alt ring,
   * and a resolved focus seats the panel owner. Focus derives from the
   * live entries, so a dangling id is unrepresentable.
   */
  readonly children: { readonly count: number; readonly focused: boolean }
  /** The completion companion serves the resting composer, never an open task's fields. */
  readonly companion: { readonly visible: boolean; readonly kind: "command" | "path" }
  readonly task: { readonly open: boolean }
  /** A presenting decision is a modal surface: it parks the composer exactly like a task. */
  readonly decision: { readonly presenting: boolean }
  /** Shift+Tab is question navigation only for an Ask surface. */
  readonly askPresenting?: boolean
  readonly editor: { readonly active: boolean }
}

interface OwnerEntry {
  readonly id: OwnerId
  readonly claim: (intent: TuiIntent, world: InputWorld) => OwnerClaim | null
}

const aboveFloor = (world: InputWorld): boolean =>
  world.layout.columns >= world.supportFloor.columns && world.layout.rows >= world.supportFloor.rows

const quitEntry = (intent: TuiIntent): boolean =>
  intent.kind === "interrupt" || (intent.kind === "input" && intent.event.type === "ctrl" && intent.event.value === "d")

/**
 * Control keys the editor owns: multiline Ctrl+J, the readline line
 * edges, and its own undo/redo. Every other ctrl key belongs to app
 * owners, and an intent no owner claims is dropped before
 * editor.dispatch ever runs — so an editor shortcut missing from this
 * set is dead end-to-end.
 */
const EDITOR_CTRL_KEYS = new Set(["a", "e", "j", "z", "y"])

const editorTextEvent = (intent: TuiIntent): boolean =>
  intent.kind === "input" && !(intent.event.type === "ctrl" && !EDITOR_CTRL_KEYS.has(intent.event.value))

const OWNER_TABLE: readonly OwnerEntry[] = [
  {
    // App-level actions outrank every surface and are never blocked by
    // the activation barrier.
    id: "quit",
    claim: (intent) => (quitEntry(intent) ? { owner: "quit", class: "business" } : null),
  },
  {
    // Shift+Tab cycles permission mode globally, except that Ask uses it
    // to move to the previous question while its modal surface holds input.
    id: "permission-cycle",
    claim: (intent, world) => {
      if (intent.kind !== "permission-cycle") return null
      if (world.askPresenting && aboveFloor(world)) return null
      return { owner: "permission-cycle", class: "business" }
    },
  },
  {
    // The reader owns its navigation and its declared return; list
    // navigation never penetrates to a parent surface. Ctrl+O toggles
    // it whether open or closed, so the reader is always reachable.
    id: "reader",
    claim: (intent, world) => {
      if (intent.kind === "tool-details") return { owner: "reader", class: "navigation" }
      if (!world.reader.open || !aboveFloor(world)) return null
      if (intent.kind === "navigate" || intent.kind === "wheel" || intent.kind === "back") {
        return { owner: "reader", class: "navigation" }
      }
      return null
    },
  },
  {
    // A presenting decision owns its choice keys above the floor:
    // navigation and Enter resolve, Back is handled by the modal's
    // local flow, and text/paste never leak into the parked composer.
    // into the parked composer.
    id: "decision",
    claim: (intent, world) => {
      if (!world.decision.presenting || !aboveFloor(world)) return null
      if (intent.kind === "activate") return { owner: "decision", class: "business" }
      if (
        intent.kind === "navigate" ||
        intent.kind === "wheel" ||
        intent.kind === "back" ||
        intent.kind === "paste" ||
        intent.kind === "advance" ||
        intent.kind === "permission-cycle" ||
        intent.kind === "input"
      ) {
        return { owner: "decision", class: "navigation" }
      }
      return null
    },
  },
  {
    // A visible companion outranks the global Enter/Tab semantics: Esc
    // collapses only the companion, Tab inserts, and Enter executes a
    // command candidate exactly once (a path candidate only inserts).
    // It never claims while a decision presents — one modal business
    // claimant at a time.
    id: "companion",
    claim: (intent, world) => {
      if (!world.companion.visible || world.task.open || world.decision.presenting || !aboveFloor(world)) return null
      if (intent.kind === "back" || intent.kind === "advance" || intent.kind === "navigate") {
        return { owner: "companion", class: "navigation" }
      }
      if (intent.kind === "activate") {
        return world.companion.kind === "command" ? { owner: "companion", class: "business" } : { owner: "companion", class: "navigation" }
      }
      return null
    },
  },
  {
    // The open task owns its modal keys; below its row floor it loses
    // them to the composer fallback. It never claims while a decision
    // presents — one modal business claimant at a time.
    id: "task",
    claim: (intent, world) => {
      if (!world.task.open || world.decision.presenting || !aboveFloor(world)) return null
      if (
        intent.kind === "activate" ||
        intent.kind === "back" ||
        intent.kind === "navigate" ||
        intent.kind === "wheel" ||
        intent.kind === "paste" ||
        intent.kind === "advance" ||
        intent.kind === "focus-cycle" ||
        intent.kind === "input"
      ) {
        return intent.kind === "activate" ? { owner: "task", class: "business" } : { owner: "task", class: "navigation" }
      }
      return null
    },
  },
  {
    // The traversal ring: Tab walks forward and Shift+Tab/Alt+arrows
    // walk back over composer, actions and panels — an empty board
    // still cycles composer and actions. Peer switching rides the same
    // intents ahead of the ring but never steals a caller's input
    // while a task holds it; the task itself sits ahead of this entry
    // so its form focus wins the gesture, and modal cards plus the
    // fullscreen reader freeze the ring. Below the floor nothing here
    // claims — the composer fallback keeps the keys.
    id: "focus-cycle",
    claim: (intent, world) => {
      if (intent.kind !== "focus-cycle" && intent.kind !== "advance") return null
      if (!aboveFloor(world)) return null
      if (world.peers.count >= 2 && !world.peers.taskHoldsInput) return { owner: "focus-cycle", class: "navigation" }
      if (world.decision.presenting || world.task.open || world.reader.open) return null
      return { owner: "focus-cycle", class: "navigation" }
    },
  },
  {
    // The focused child panel owns its stage navigation above the
    // viewport: paging walks the panel's ring (never the transcript
    // beneath it) and Esc returns to the main conversation. Below the
    // floor it claims nothing — the composer fallback keeps the keys.
    id: "panel",
    claim: (intent, world) => {
      if (!world.children.focused || !aboveFloor(world)) return null
      if (intent.kind === "navigate" || intent.kind === "wheel" || intent.kind === "back") {
        return { owner: "panel", class: "navigation" }
      }
      return null
    },
  },
  {
    // The transcript viewport owns free-stage paging: wheel and the
    // page keys scroll the transcript while no reader, modal or
    // companion surface holds them. It never touches arrow keys, so
    // the composer's caret movement survives beside it.
    id: "viewport",
    claim: (intent, world) => {
      if (world.reader.open || world.task.open || world.decision.presenting || world.companion.visible) return null
      if (!aboveFloor(world)) return null
      if (intent.kind === "wheel") return { owner: "viewport", class: "navigation" }
      if (intent.kind === "navigate" && (intent.direction === "page-up" || intent.direction === "page-down")) {
        return { owner: "viewport", class: "navigation" }
      }
      return null
    },
  },
  {
    // Resting-screen Escape behavior exists only on an empty stage; modal
    // surfaces own Back before this entry.
    id: "resting",
    claim: (intent, world) => {
      if (world.reader.open || world.companion.visible || world.task.open || world.decision.presenting) return null
      if (!aboveFloor(world)) return null
      if (intent.kind === "back") return { owner: "resting", class: "navigation" }
      return null
    },
  },
  {
    // The composer is the transparent fallback: text and paste always
    // have a home, and Enter submits an armed draft.
    id: "editor",
    claim: (intent, world) => {
      if (!world.editor.active) return null
      // Arrows are caret movement when the composer holds input; wheel
      // stays out — mouse scroll is surface navigation, never a caret
      // edit.
      if (editorTextEvent(intent) || intent.kind === "paste" || intent.kind === "navigate" || intent.kind === "prompt-history") {
        return { owner: "editor", class: "navigation" }
      }
      // Tab survives here only when the ring cannot claim it — under
      // the reader or below the floor — and is indent, a caret edit.
      if (intent.kind === "advance") {
        return { owner: "editor", class: "navigation" }
      }
      // A visible companion owns the Enter semantics (insert or execute
      // the candidate); the composer's submit must not double-claim it.
      if (intent.kind === "activate" && !world.companion.visible) {
        return { owner: "editor", class: "business" }
      }
      return null
    },
  },
]

/** First claim walking the declared order; the walk is exhaustive and side-effect free. */
export function resolveIntent(intent: TuiIntent, world: InputWorld): Resolution {
  for (const owner of OWNER_TABLE) {
    const claim = owner.claim(intent, world)
    if (claim !== null) return claim
  }
  return { unhandled: true }
}

/**
 * Every owner evaluated independently. This exists for the priority
 * partition property: over valid worlds at most one owner returns a
 * business claim, so first-wins routing never silently outranks a
 * rejected claimant.
 */
export function allClaims(intent: TuiIntent, world: InputWorld): readonly OwnerClaim[] {
  const claims: OwnerClaim[] = []
  for (const owner of OWNER_TABLE) {
    const claim = owner.claim(intent, world)
    if (claim !== null) claims.push(claim)
  }
  return claims
}
