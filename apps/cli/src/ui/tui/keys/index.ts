/**
 * Keys module: raw terminal bytes from
 * the screen's data path are decoded into a closed normalized event
 * vocabulary and mapped to context-free intents. The decoder never
 * interprets scope, focus, or mode: surface-local key semantics ride
 * the `input` payload and are interpreted by the focused view. Keys the
 * vocabulary recognizes never lose data; a well-formed sequence outside
 * it (unknown CSI finals, button mouse reports, CSI-u) drops whole
 * rather than forging a member, and an introducer that cannot complete
 * surfaces as escape plus plain input. Resize is a screen event and
 * never passes through this module. The screen enables wheel-only mouse
 * reporting (SGR), so the vocabulary's one mouse member is the wheel
 * event; other mouse sequences arrive never and decode as unknown
 * input.
 */

/** Normalized input event closed union (baseline key vocabulary). */
export type TuiInputEvent =
  | { readonly type: "char"; readonly value: string }
  | { readonly type: "enter" }
  | { readonly type: "escape" }
  | { readonly type: "backspace" }
  | { readonly type: "delete" }
  | { readonly type: "paste"; readonly value: string }
  | { readonly type: "up" }
  | { readonly type: "down" }
  | { readonly type: "left" }
  | { readonly type: "right" }
  | { readonly type: "alt-left" }
  | { readonly type: "alt-right" }
  | { readonly type: "page-up" }
  | { readonly type: "page-down" }
  | { readonly type: "ctrl"; readonly value: string }
  | { readonly type: "shift-tab" }
  | { readonly type: "wheel"; readonly direction: "up" | "down"; readonly column: number; readonly row: number }

export type NavigateDirection = "up" | "down" | "left" | "right" | "page-up" | "page-down"

/**
 * Closed intent vocabulary. Every input event maps to exactly one intent
 * (totality); the mapping below is the single definition of that mapping.
 */
export type TuiIntent =
  // Reserved for Tab: no input event maps here yet (the routing-model
  // tests already route it so a future mapping lands with the matrix
  // proven); no surface claims it today, so it stays inert end to end.
  | { readonly kind: "advance" }
  | { readonly kind: "activate" }
  | { readonly kind: "back" }
  | { readonly kind: "navigate"; readonly direction: NavigateDirection }
  | { readonly kind: "interrupt" }
  | { readonly kind: "tool-details" }
  // Reserved for Alt+←/→: the store's focus routing claims it once the
  // agents panel exists; until then it flows through the dispatch chain
  // inert, so the mapping lands with the vocabulary already total.
  | { readonly kind: "focus-cycle"; readonly direction: "prev" | "next" }
  | { readonly kind: "paste"; readonly text: string }
  | { readonly kind: "wheel"; readonly direction: "up" | "down"; readonly column: number; readonly row: number }
  | { readonly kind: "input"; readonly event: TuiInputEvent }

export function intentFor(event: TuiInputEvent): TuiIntent {
  switch (event.type) {
    case "enter":
      return { kind: "activate" }
    case "escape":
      return { kind: "back" }
    case "up":
    case "down":
    case "left":
    case "right":
    case "page-up":
    case "page-down":
      return { kind: "navigate", direction: event.type }
    case "alt-left":
      return { kind: "focus-cycle", direction: "prev" }
    case "alt-right":
      return { kind: "focus-cycle", direction: "next" }
    case "ctrl":
      if (event.value === "c") return { kind: "interrupt" }
      return event.value === "o" ? { kind: "tool-details" } : { kind: "input", event }
    case "paste":
      return { kind: "paste", text: event.value }
    case "wheel":
      return { kind: "wheel", direction: event.direction, column: event.column, row: event.row }
    case "char":
    case "backspace":
    case "delete":
    case "shift-tab":
      return { kind: "input", event }
  }
}

/** Decoder facade: one read may produce multiple events. */
export interface TuiInputDecoder {
  decode(raw: string): readonly TuiInputEvent[]
  /**
   * Resolve a held lone ESC, SS3 prefix, or ESC pair after the input
   * ambiguity window expires: the first two surface as escape (plus the
   * literal leader for SS3); an expired ESC pair surfaces as two escape
   * events under the alt-pair convention.
   */
  flushPendingEscape(): readonly TuiInputEvent[]
  /** True while a lone ESC, SS3 prefix, or ESC pair is waiting to complete or expire. */
  hasPendingEscape(): boolean
}

export { createInputDecoder } from "./decoder.js"
