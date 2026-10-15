/**
 * Theme card: the /theme panel as a single-tab card over the theme ids.
 * Draft-driven like the completion picker — the store owns the query
 * (characters land in the composer draft, never here) and syncs it in;
 * every sync reloads the filtered item list and preserves focus through
 * the chosen prefill, exactly the seeded default the next open()
 * restores. A query that matches nothing closes the panel: it never
 * lingers opened-but-hidden, and only /theme reopens it. Focus movement
 * previews live (the preview effect re-themes the whole TUI), Enter
 * commits the focused theme, Escape cancels back to the committed one.
 * Digits stay off because the draft owns every printable character.
 */
import type { TuiIntent } from "../keys/index.js"
import { CardShellMachine, type CardSnapshot } from "./card.js"

/** Host-executed outcomes of one theme card interaction. */
export type ThemeCardEffect =
  | { readonly kind: "theme-preview"; readonly themeId: string }
  | { readonly kind: "theme-commit"; readonly themeId: string }
  | { readonly kind: "theme-cancel" }

const TAB_KEY = "theme"
const BODY_LINE = "Preview follows focus · Enter saves · Esc restores"

export class ThemeCard {
  /** Digits off (the draft owns printable chars); the window covers the full palette. */
  private readonly machine = new CardShellMachine({ itemWindow: 8, digits: false })
  private readonly themes: readonly string[]
  private readonly isInteractionEnabled: (() => boolean) | undefined
  private query = ""
  private opened = false
  private dismissed = false
  private focusedKey: string | null = null

  constructor(options: { readonly themes: readonly string[]; readonly isInteractionEnabled?: () => boolean }) {
    this.themes = [...options.themes]
    this.isInteractionEnabled = options.isInteractionEnabled
  }

  /** Open on the full palette with focus seeded onto the committed theme. */
  open(committed: string | null): void {
    this.query = ""
    this.opened = true
    this.dismissed = false
    this.reload(committed === null ? [] : [committed])
  }

  /** Close the panel; preview rollback stays a host concern. */
  close(): void {
    this.opened = false
    this.dismissed = false
    this.query = ""
  }

  /** Claimable while open, not dismissed, and holding at least one match. */
  isVisible(): boolean {
    return this.opened && !this.dismissed && this.matches().length > 0
  }

  /** Draft-driven query sync; never resurrects a dismissed panel. */
  syncQuery(query: string): void {
    if (!this.opened) return
    this.query = query
    // Preserve the focused theme through the reload via the chosen
    // prefill (load homes focus onto it); a vanished key falls to the
    // first match, mirroring the picker's first-enabled fallback.
    this.reload(this.focusedKey === null ? [] : [this.focusedKey])
    // A query that matches nothing leaves the panel nothing to show:
    // close it instead of parking it opened with a stale query — keys
    // return to the composer and /theme reopens the panel fresh.
    if (this.matches().length === 0) this.close()
  }

  /**
   * Route one intent while visible: null hands the key back to the store
   * (an unclaimed or clamped move falls through to the composer).
   */
  dispatch(intent: TuiIntent): readonly ThemeCardEffect[] | null {
    if (!this.isVisible()) return null
    if (this.isInteractionEnabled !== undefined && !this.isInteractionEnabled()) return null
    if (intent.kind === "back") {
      this.dismissed = true
      return [{ kind: "theme-cancel" }]
    }
    const before = this.focusedKey
    const result = this.machine.dispatch(intent)
    if (result.outcome === "confirmed") {
      this.focusedKey = this.focusedKeyOfSnapshot()
      this.dismissed = true
      return this.focusedKey === null ? [] : [{ kind: "theme-commit", themeId: this.focusedKey }]
    }
    if (result.changed) {
      this.focusedKey = this.focusedKeyOfSnapshot()
      // Focus movement previews live; the whole TUI re-themes so the
      // user tries the palette with real colors before committing.
      if (this.focusedKey !== null && this.focusedKey !== before) {
        return [{ kind: "theme-preview", themeId: this.focusedKey }]
      }
      return []
    }
    return null
  }

  /** Render-ready snapshot of the visible card; null hides it. */
  snapshot(): CardSnapshot | null {
    if (!this.isVisible()) return null
    return this.machine.snapshot()
  }

  private reload(chosen: readonly string[]): void {
    this.machine.load([
      {
        key: TAB_KEY,
        label: "Theme",
        items: this.matches().map((themeId) => ({ key: themeId, label: themeId })),
        body: [[{ text: BODY_LINE, token: "muted" }]],
        chosen,
      },
    ])
    this.focusedKey = this.focusedKeyOfSnapshot()
  }

  private matches(): readonly string[] {
    const needle = this.query.toLowerCase()
    return this.themes.filter((themeId) => themeId.includes(needle))
  }

  private focusedKeyOfSnapshot(): string | null {
    return this.machine.snapshot().focusedKey
  }
}
