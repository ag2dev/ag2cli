/**
 * Permissions card: the /permissions umbrella as six horizontal tabs
 * (Mode | Recently denied | Allow | Ask | Deny | Workspace). The card
 * holds no permission authority — the mode options, the current mode,
 * the rule set, the denial ledger and the workspace root arrive through
 * injected probes, and the rows reseed from them whenever the active
 * tab's fingerprint changes (focus preserved by key, or by ordinal
 * when the key vanished), so canonical echoes resync without a frame
 * of stale
 * optimism: the chosen marker mirrors the canonical mode as an external
 * choice, and no key records it.
 *
 * Focus is two-level and card-internal (the shared shell machine's
 * contract stays untouched): the header owns ←/→ tab switching and ↓
 * into the list, the list owns row focus — ↑ on the first row (or a
 * tab with nothing focusable) returns to the header — Enter acts per
 * tab (mode commit, rule cycle; view-only tabs absorb), x/d delete and
 * a seeds the add-rule draft on the rule tabs only, digits address the
 * executable tabs, and Escape closes from either level.
 *
 * The machine is loaded with exactly the ACTIVE tab's model:
 * machine.load() resets its own tab cursor, so loading all six at once
 * would yank the user back to Mode on every canonical echo; the card
 * composes the six tab labels into the snapshot itself, and the
 * user-visible contract is identical to a six-tab load. View-only rows
 * (denials, the workspace root) and empty-set placeholders render as
 * plain rows — no marker, no digit — and every empty tab still carries
 * a placeholder ITEM so the tab strip never disappears.
 */
import type { TuiIntent } from "../keys/index.js"
import { CardShellMachine, cardSnapshot, type CardItemModel, type CardItemState, type CardSnapshot, type CardTabModel } from "./card.js"

/** One converged tool denial as the Recently denied ledger accumulates it. */
export interface TuiDeniedCall {
  readonly toolCallId: string
  readonly name: string
  readonly code: string
  readonly reason?: string
}

/** One selectable mode row: chip label plus a one-line blast radius. */
export interface PermissionModeOption {
  readonly mode: string
  readonly label: string
  readonly description: string
}

/** Canonical permission rule row as the TUI sees it: tool name + behavior id. */
export interface PermissionRule {
  readonly name: string
  readonly behavior: string
}

/** Host-executed commits; the card keeps no local authority. */
export type PermissionsCardEffect =
  | { readonly kind: "permission-mode"; readonly mode: string }
  | {
      readonly kind: "permission-rules"
      readonly rules: readonly PermissionRule[]
      readonly tool: string
      readonly action: "cycle" | "remove"
    }

/**
 * Store-internal request the `a` key issues: seed the rules-add draft.
 * Never host-facing — the store consumes it in the same dispatch.
 */
export interface PermissionRuleAddSignal {
  readonly kind: "permission-rule-add"
}

/** One dispatched key while the card is visible. */
export interface PermissionsCardResult {
  /** Whether the visible card changed; the store repaints only then. */
  readonly changed: boolean
  readonly effects: readonly (PermissionsCardEffect | PermissionRuleAddSignal)[]
}

/** Canonical probes the composition root injects. */
export interface PermissionsCardOptions {
  readonly modes: () => readonly PermissionModeOption[]
  readonly currentMode: () => string | null
  readonly rules: () => readonly PermissionRule[]
  /** Newest-first denial ledger — the store's Recently denied state. */
  readonly denials: () => readonly TuiDeniedCall[]
  /**
   * Authorized workspace root plus the canonical additional directories
   * (the Workspace tab's view-only rows); null root until a
   * SessionCreated was observed.
   */
  readonly workspace: {
    readonly root: () => string | null
    readonly additionalDirectories?: () => readonly string[]
  }
}

/**
 * Warning line: bash rules have no pattern granularity, so the override
 * order is the rule tabs' most decision-relevant fact.
 */
const WARNING_LINE = "deny rules and the plan read-only floor override allow rules"

/** Draft the add-rule path seeds the composer with. */
export const PERMISSIONS_RULE_ADD_DRAFT = "/permissions rules add "

/** Rule behavior cycle order for the rule tabs' Enter key. */
const RULE_BEHAVIOR_CYCLE: Readonly<Record<string, string>> = {
  allow: "ask",
  ask: "deny",
  deny: "allow",
}

/** Tab labels verbatim from the governing ADR (order included). */
const TAB_LABELS = ["Mode", "Recently denied", "Allow", "Ask", "Deny", "Workspace"] as const

/** Tab ids the card's callers address (open() and the slash digest). */
export type PermissionsCardTab = "mode" | "denied" | "rules-allow" | "rules-ask" | "rules-deny" | "workspace"

type TabKind = PermissionsCardTab

const TAB_KINDS: readonly TabKind[] = ["mode", "denied", "rules-allow", "rules-ask", "rules-deny", "workspace"]

const MODE_TAB = 0

/** The behavior each rule tab filters its rows by. */
const RULE_TAB_BEHAVIORS: Readonly<Record<string, string>> = {
  "rules-allow": "allow",
  "rules-ask": "ask",
  "rules-deny": "deny",
}

/** One operable unit of the active tab: a mode row or a canonical rule row. */
interface PermissionUnit {
  readonly kind: "mode" | "rule"
  readonly key: string
  readonly mode?: string
  readonly rule?: PermissionRule
}

const MODE_KEY_PREFIX = "mode:"
const RULE_KEY_PREFIX = "rule:"
const DENIAL_KEY_PREFIX = "denial:"
const DENIALS_PLACEHOLDER_KEY = "denials:empty"
const rulesPlaceholderKey = (behavior: string): string => `rules:empty:${behavior}`
const WORKSPACE_PLACEHOLDER_KEY = "workspace:unknown"
const WORKSPACE_ROOT_KEY = "workspace:root"
const additionalDirectoryKey = (canonical: string): string => `workspace:additional:${canonical}`

/** Frozen: one shared answer for every absorbed key, never mutated. */
const ABSORBED: PermissionsCardResult = Object.freeze({ changed: false, effects: Object.freeze([]) })

export class PermissionsCard {
  private readonly machine = new CardShellMachine({ itemWindow: 9 })
  private unitsByKey: ReadonlyMap<string, PermissionUnit> = new Map()
  private readonly options: PermissionsCardOptions
  /** Ordered item keys of the active tab as it was last loaded. */
  private tabKeys: readonly string[] = []
  private fingerprint = ""
  private opened = false
  private error: string | null = null
  private activeTab = MODE_TAB
  private level: "header" | "list" = "list"

  constructor(options: PermissionsCardOptions) {
    this.options = options
  }

  /**
   * Open onto the given tab (Mode by default) at list level with focus
   * seeded onto the tab's natural row (the canonical mode; the Workspace
   * tab's root row); errors reset. Tab position and focus level are
   * card state — reopening starts fresh.
   */
  open(tab?: PermissionsCardTab): void {
    this.opened = true
    this.error = null
    this.activeTab = tab === undefined ? MODE_TAB : TAB_KINDS.indexOf(tab)
    this.level = "list"
    this.reload(this.naturalFocusKey())
  }

  /** Close the visible card; false when it was already hidden. */
  close(): boolean {
    if (!this.opened) return false
    this.opened = false
    return true
  }

  /** Claimable while open with at least one mode row to show. */
  isVisible(): boolean {
    return this.opened && this.options.modes().length > 0
  }

  /**
   * A landed commit clears the stale feedback: the rows reseed from the
   * canonical probes, so a retried action that succeeds must not keep
   * the previous race's error line on screen. False when nothing held.
   */
  clearError(): boolean {
    if (this.error === null) return false
    this.error = null
    return true
  }

  /**
   * Stale-commit feedback: keep the card open, surface the inline error
   * in the ACTIVE tab's body, and keep the user's place — the Mode
   * tab's canonical marker already shows what actually holds.
   */
  reportStale(message: string): void {
    this.error = message
  }

  /**
   * Route one intent while visible: null only when the card is not
   * visible; a visible card claims every key (an unhandled one is
   * absorbed with changed false — the draft never moves under a modal).
   */
  dispatch(intent: TuiIntent): PermissionsCardResult | null {
    if (!this.isVisible()) return null
    if (intent.kind === "back") {
      // Cancel keeps every state untouched: closing is display-only, and
      // both focus levels mean the same thing by it (ADR "Esc cancels").
      this.opened = false
      return { changed: true, effects: [] }
    }
    return this.level === "header" ? this.dispatchHeader(intent) : this.dispatchList(intent)
  }

  /** Header level: ←/→ switch tabs (clamped, no wrap), ↓ enters the list, the rest absorbs. */
  private dispatchHeader(intent: TuiIntent): PermissionsCardResult {
    if (intent.kind === "navigate" && (intent.direction === "left" || intent.direction === "right")) {
      const target = this.activeTab + (intent.direction === "right" ? 1 : -1)
      if (target < 0 || target >= TAB_KINDS.length) return ABSORBED
      this.activeTab = target
      this.reload(this.naturalFocusKey())
      return { changed: true, effects: [] }
    }
    if (intent.kind === "navigate" && intent.direction === "down") {
      if (!this.tabHasFocusableRow()) return ABSORBED
      this.level = "list"
      return { changed: true, effects: [] }
    }
    return ABSORBED
  }

  /** List level: ↑ escapes to the header at the top; movement and per-tab actions otherwise. */
  private dispatchList(intent: TuiIntent): PermissionsCardResult {
    const tab = TAB_KINDS[this.activeTab]!
    if (intent.kind === "navigate") {
      // Tab switching is header-exclusive; the machine holds one tab and
      // its own ←/→ would be inert anyway, but the card owns the veto.
      if (intent.direction === "left" || intent.direction === "right") return ABSORBED
      if (intent.direction === "up") {
        const focus = this.machine.snapshot()
        // The list's first row — or a tab with nothing focusable (an echo
        // deleted the last rule while it was focused) — hands the key back
        // to the header; the user is never stranded below a placeholder.
        // focusedIndex is window-relative (a sticky window can show slot 0
        // well past the list head), so the first-row test reads the loaded
        // key order instead.
        if (focus.focusedKey === null || this.tabKeys.indexOf(focus.focusedKey) === 0) {
          this.level = "header"
          return { changed: true, effects: [] }
        }
      }
      // Page keys ride the machine's own arithmetic: they move focus in
      // list-sized jumps and never hand the key back to the header —
      // only plain ↑ at the first row exits.
      const result = this.machine.dispatch(intent)
      return { changed: result.changed, effects: [] }
    }
    if (intent.kind === "activate") {
      const unit = this.focusedUnit()
      if (tab === "mode" && unit?.kind === "mode" && unit.mode !== undefined) {
        // Deliberately not self-closing: the host resolves the canonical
        // commit and either closes the card or reports stale; an
        // unconfirmed full-access commit is intercepted store-side and
        // swapped for the confirmation card.
        return { changed: false, effects: [{ kind: "permission-mode", mode: unit.mode }] }
      }
      if (this.isRuleTab(tab) && unit?.kind === "rule" && unit.rule !== undefined) {
        // Enter on a rule row cycles its behavior and sends the complete
        // next set; the row leaves this tab when the canonical echo lands.
        // Rule-tab rows are pre-filtered to the three behaviors, so the
        // cycle map always resolves.
        const next = RULE_BEHAVIOR_CYCLE[unit.rule.behavior]!
        const rules = this.options
          .rules()
          .map((candidate) => (candidate.name === unit.rule!.name ? { name: candidate.name, behavior: next } : candidate))
        return { changed: false, effects: [{ kind: "permission-rules", rules, tool: unit.rule.name, action: "cycle" }] }
      }
      return ABSORBED
    }
    if (intent.kind === "input" && intent.event.type === "char") {
      const value = intent.event.value
      if (this.isRuleTab(tab) && value === "a") {
        // Close first, then let the store seed the add-rule draft — no
        // frame renders the card and the seeded draft together.
        this.opened = false
        this.error = null
        return { changed: true, effects: [{ kind: "permission-rule-add" }] }
      }
      if (this.isRuleTab(tab) && (value === "x" || value === "d")) {
        const rule = this.focusedUnit()?.rule
        if (rule === undefined) return ABSORBED
        // Match by name, not identity: canonical rows are name-deduped,
        // and the probe contract never promises a reference-stable array.
        const rules = this.options.rules().filter((candidate) => candidate.name !== rule.name)
        return { changed: true, effects: [{ kind: "permission-rules", rules, tool: rule.name, action: "remove" }] }
      }
      // Digits address the executable tabs only (view-only rows never
      // advertise a gutter); the machine keeps the window arithmetic.
      if (value >= "1" && value <= "9" && (tab === "mode" || this.isRuleTab(tab))) {
        const result = this.machine.dispatch(intent)
        return { changed: result.changed, effects: [] }
      }
      return ABSORBED
    }
    return ABSORBED
  }

  /**
   * Reseed the rows when the active tab's probe data moved since the
   * last load (an out-of-band echo); true when a reload happened — the
   * active tab's rows, markers or focus seeds changed — so a caller
   * mints a revision only for a real visible change.
   */
  refresh(): boolean {
    if (this.activeTabFingerprint() === this.fingerprint) return false
    this.reload(this.preservedFocusKey())
    return true
  }

  /**
   * Render-ready snapshot of the visible card; null hides it. Canonical
   * echoes move the probes between frames, so this re-derives the rows
   * whenever the active tab's fingerprint changed (focus preserved),
   * then composes the six-tab chrome: the card-held tab labels and
   * index, the level's focus encoding (header forces no list focus),
   * per-tab hints and markers, and digit-stripped view-only and
   * placeholder rows.
   */
  snapshot(): CardSnapshot | null {
    if (!this.isVisible()) return null
    this.refresh()
    const tab = TAB_KINDS[this.activeTab]!
    const viewOnly = tab === "denied" || tab === "workspace"
    const header = this.level === "header"
    const state = this.machine.snapshot()
    // View-only rows and placeholder rows never advertise a digit, and
    // the header absorbs digits, so a header frame strips the gutter
    // from the executable rows too — the rendered digits always match
    // what the keys do at the level that rendered them.
    const items: readonly CardItemState[] = state.items.map((item) =>
      viewOnly || header || item.disabled ? { ...item, digit: null } : item,
    )
    const body: (readonly { readonly text: string; readonly token: "muted" | "error" }[])[] = []
    if (this.isRuleTab(tab)) body.push([{ text: WARNING_LINE, token: "muted" }])
    if (this.error !== null) body.push([{ text: this.error, token: "error" }])
    return cardSnapshot({
      ...state,
      tabLabels: TAB_LABELS,
      activeTabIndex: this.activeTab,
      items,
      body,
      hints: header ? this.headerHints() : this.listHints(tab),
      markers: tab === "mode" ? ("radio" as const) : ("none" as const),
      title: "Permissions",
      ...(header ? { focusedIndex: null, focusedKey: null } : {}),
    })
  }

  /** The unit under the machine's focus, by its stable key. */
  private focusedUnit(): PermissionUnit | undefined {
    const key = this.machine.snapshot().focusedKey
    return key === null ? undefined : this.unitsByKey.get(key)
  }

  private isRuleTab(tab: TabKind): boolean {
    return tab === "rules-allow" || tab === "rules-ask" || tab === "rules-deny"
  }

  /** Header hints never advertise a ↓ the active tab cannot take. */
  private headerHints(): readonly string[] {
    return ["←→ tabs", ...(this.tabHasFocusableRow() ? ["↓ list"] : []), "esc close"]
  }

  private listHints(tab: TabKind): readonly string[] {
    // An echo can empty the focused tab while the user sits in its list:
    // every action key is dead until ↑ returns to the header, so the
    // hints degrade instead of advertising them.
    if (!this.tabHasFocusableRow()) return ["↑ header", "esc close"]
    if (tab === "mode") return ["↑↓ select", "enter apply mode", "esc close"]
    if (this.isRuleTab(tab)) return ["↑↓ select", "enter cycle", "x/d delete", "a add", "esc close"]
    return ["↑↓ browse", "esc close"]
  }

  /** Whether the active tab's fresh probes carry any focusable row. */
  private tabHasFocusableRow(): boolean {
    return this.freshTabItems().some((item) => item.disabled !== true)
  }

  /**
   * Focus key for a fingerprint resync: the same row when it survives
   * the fresh probes, the row at the focused ordinal in the survivor
   * list when it vanished (a deleted rule; the clamp lands the last row
   * when the whole section went). Keys are stable across canonical
   * echoes, so key matching keeps the user's place where label matching
   * would have lost it.
   */
  private preservedFocusKey(): string | null {
    const focused = this.machine.snapshot().focusedKey
    if (focused === null) return null
    const survivors = this.freshTabKeys()
    if (survivors.has(focused)) return focused
    const ordinal = this.tabKeys.indexOf(focused)
    if (ordinal < 0) return null
    const next = this.tabKeys.filter((key) => survivors.has(key))
    return next[Math.min(ordinal, next.length - 1)] ?? null
  }

  /** Item keys the fresh probes carry for the active tab — the survivor set. */
  private freshTabKeys(): Set<string> {
    return new Set(this.freshTabItems().map((item) => item.key))
  }

  /** Items the active tab derives from the probes right now. */
  private freshTabItems(): readonly CardItemModel[] {
    return this.tabModel(TAB_KINDS[this.activeTab]!, null).model.items
  }

  /**
   * Natural focus seed when a tab becomes active: the Mode tab keeps the
   * canonical row; the Workspace tab seeds onto its first row (the root
   * when known, else the first additional directory).
   */
  private naturalFocusKey(): string | null {
    const tab = TAB_KINDS[this.activeTab]!
    if (tab === "mode") return this.canonicalModeKey()
    if (tab === "workspace") return this.workspaceFocusSeed()
    return null
  }

  private workspaceFocusSeed(): string | null {
    const root = this.options.workspace.root()
    if (root !== null && root.length > 0) return WORKSPACE_ROOT_KEY
    const first = this.workspaceAdditionalDirectories()[0]
    return first === undefined ? null : additionalDirectoryKey(first)
  }

  private workspaceAdditionalDirectories(): readonly string[] {
    return this.options.workspace.additionalDirectories?.() ?? []
  }

  private canonicalModeKey(): string | null {
    const current = this.options.currentMode()
    if (current !== null && this.options.modes().some((option) => option.mode === current)) {
      return `${MODE_KEY_PREFIX}${current}`
    }
    return null
  }

  /**
   * Fingerprint of the probe data the ACTIVE tab renders — its rows,
   * markers and focus seeds, field for field. A canonical echo outside
   * that derivation (a rules echo while the Mode tab is up) leaves the
   * rendered card identical, so no reload runs and no caller mints a
   * revision for it. JSON encoding keeps free-text reasons, tool names
   * and roots from aliasing distinct probe states through delimiter
   * collisions; only the machine holds the active tab, and every tab
   * switch reloads from the probes, so no cached row can go stale.
   */
  private activeTabFingerprint(): string {
    const tab = TAB_KINDS[this.activeTab]!
    if (tab === "mode") {
      return JSON.stringify([
        this.options.currentMode(),
        this.options.modes().map((option) => [option.mode, option.label, option.description]),
      ])
    }
    if (tab === "denied") return JSON.stringify(this.options.denials())
    if (this.isRuleTab(tab)) {
      return JSON.stringify(this.options.rules().filter((rule) => rule.behavior === RULE_TAB_BEHAVIORS[tab]!))
    }
    const root = this.options.workspace.root()
    return JSON.stringify([root === null || root.length === 0 ? null : root, this.workspaceAdditionalDirectories()])
  }

  /**
   * Rebuild the ACTIVE tab's model from the probes and reload the
   * machine with exactly that one tab (load() resets the machine's own
   * tab cursor, and the card composes the six labels itself). Every tab
   * is an external-choice tab: no key the user presses records a
   * choice, and the canonical mode marker seeds solely from the probes.
   */
  private reload(focusKey: string | null): void {
    const { model, units } = this.tabModel(TAB_KINDS[this.activeTab]!, focusKey)
    this.tabKeys = model.items.map((item) => item.key)
    // Only a reload registers units: probe reads (hint and survivor
    // derivation) reuse tabModel without touching the live unit map, so
    // a read can never leave another tab's units under the focus.
    this.unitsByKey = units
    this.machine.load([model])
    this.fingerprint = this.activeTabFingerprint()
  }

  /**
   * Derive one tab's model and its unit map from the probes; an empty
   * set carries one disabled placeholder item. Pure with respect to the
   * card's state — the caller decides whether the units become live.
   */
  private tabModel(
    tab: TabKind,
    focusKey: string | null,
  ): { readonly model: CardTabModel; readonly units: ReadonlyMap<string, PermissionUnit> } {
    const label = TAB_LABELS[TAB_KINDS.indexOf(tab)]!
    const base = { key: tab, label, externalChoice: true as const, ...(focusKey === null ? {} : { focus: focusKey }) }
    const units = new Map<string, PermissionUnit>()
    if (tab === "mode") {
      const current = this.options.currentMode()
      const canonical = this.canonicalModeKey()
      const items = this.options.modes().map((option) => {
        const key = `${MODE_KEY_PREFIX}${option.mode}`
        units.set(key, { kind: "mode", key, mode: option.mode })
        return {
          key,
          label: `${option.label}${option.mode === current ? "  · current" : ""}`,
          description: option.description,
        }
      })
      return { model: { ...base, items, ...(canonical === null ? {} : { chosen: [canonical] }) }, units }
    }
    if (tab === "denied") {
      const denials = this.options.denials()
      const items =
        denials.length === 0
          ? [{ key: DENIALS_PLACEHOLDER_KEY, label: "no denials", disabled: true }]
          : denials.map((call) => ({
              // Key mirrors the ledger identity (name + call id): two
              // rows may share a call id under different tool names.
              // NUL joins the pair — neither field can contain it, so
              // distinct pairs can never alias into one key.
              key: `${DENIAL_KEY_PREFIX}${call.name}\u0000${call.toolCallId}`,
              label: `${call.name} · ${call.code}`,
              ...(call.reason === undefined ? {} : { description: call.reason }),
            }))
      return { model: { ...base, items }, units }
    }
    if (this.isRuleTab(tab)) {
      const behavior = RULE_TAB_BEHAVIORS[tab]!
      const rows = this.options.rules().filter((rule) => rule.behavior === behavior)
      const items =
        rows.length === 0
          ? [{ key: rulesPlaceholderKey(behavior), label: "no rules", disabled: true }]
          : rows.map((rule) => {
              const key = `${RULE_KEY_PREFIX}${rule.name}`
              units.set(key, { kind: "rule", key, rule })
              return { key, label: `${rule.name} · ${rule.behavior}` }
            })
      return { model: { ...base, items }, units }
    }
    const root = this.options.workspace.root()
    return {
      model: {
        ...base,
        items: [
          root === null || root.length === 0
            ? { key: WORKSPACE_PLACEHOLDER_KEY, label: "workspace root unknown", disabled: true }
            : { key: WORKSPACE_ROOT_KEY, label: root },
          ...this.workspaceAdditionalDirectories().map((canonical) => ({
            key: additionalDirectoryKey(canonical),
            label: canonical,
          })),
        ],
      },
      units,
    }
  }
}
