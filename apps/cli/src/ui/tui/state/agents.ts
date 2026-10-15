/**
 * Child-agents panel: the kanban view state behind the transcript —
 * one bounded entry per delegated child. Live spawn facts and
 * child-attributed stream deltas grow entries; durable replay grows
 * them from the parent's agent tool_use blocks instead, and a fact
 * carrying both identity axes unites whatever parallel entries the
 * two paths grew. A terminal fact seals the entry: late
 * lines drop, and the 32-entry budget reclaims terminal entries
 * first. Focus is one of the frame's surfaces — main or one entry —
 * and survives entry churn by key, falling back to main when its
 * entry leaves. The panel is pure view state: it never speaks for a
 * session, and the host mirrors its revisions into the store.
 */

/** Terminal vocabulary of one delegated child, as the panel shows it. */
export type ChildAgentStatus = "running" | "completed" | "failed" | "cancelled"

/** One delegated child as the panel renders it. */
export interface ChildAgentView {
  /** Stable entry identity: the childSessionId, or the replay tool id until they bind. */
  readonly key: string
  /** Session-scoped cancel address; null until the spawn fact or terminal binds it. */
  readonly childSessionId: string | null
  /** The parent-side toolUseId the delegation rode on, when known. */
  readonly toolUseId: string | null
  readonly subagentType?: string
  readonly description: string
  readonly status: ChildAgentStatus
  /** Bounded line buffer: merged child deltas, tail-kept. */
  readonly lines: readonly string[]
  /** Lines the window sits above the tail; zero follows the tail. */
  readonly scroll: number
}

/** Snapshot view of the panel; identity stable per panel revision. */
export interface TuiAgentsView {
  readonly entries: readonly ChildAgentView[]
  /** Focused entry index; null is the main surface. */
  readonly focusIndex: number | null
  readonly runningCount: number
}

/**
 * The focused child's panel as one frame-painted surface: the header
 * naming the delegation, the read-only buffer rows already wrapped and
 * budgeted to the transcript capacity, and the one hint row carrying
 * the cancel affordance. Derived by the store; the view paints it
 * verbatim.
 */
export interface TuiChildPanelView {
  readonly header: string
  readonly lines: readonly string[]
  readonly hint: string | null
  /** Rows the frame paints for this panel: header and hint included. */
  readonly rows: number
}

/** Entries one session's panel keeps; beyond that terminal entries reclaim first. */
export const MAX_CHILD_ENTRIES = 32

/** Lines one child's buffer keeps; beyond that the tail survives. */
const CHILD_LINE_CAP = 200

/** The view an unwired store carries; one shared empty object keeps references stable. */
export const EMPTY_AGENTS_VIEW: TuiAgentsView = { entries: [], focusIndex: null, runningCount: 0 }

/** One live spawn fact as the runner's transient stream carries it. */
export interface ChildSpawnFact {
  readonly childSessionId: string
  /** Omitted when only lineage binds (a spawn handle or durable task record): keep the entry's description. */
  readonly description?: string
  readonly subagentType?: string
  readonly toolUseId?: string
}

/** One durable replay fact as the parent's agent tool_use block carries it. */
export interface ChildToolUseFact {
  readonly description?: string
  readonly subagentType?: string
}

/** One terminal fact: the tool result's outcome for a delegation. */
export interface ChildFinalizeFact {
  readonly childSessionId?: string
  readonly toolUseId?: string
  readonly status: ChildAgentStatus
  readonly summary?: string
}

interface MutableEntry {
  readonly key: string
  childSessionId: string | null
  toolUseId: string | null
  subagentType?: string
  description: string
  status: ChildAgentStatus
  readonly lines: string[]
  scroll: number
  /** False once a newline sealed the last line; the next delta opens a fresh one. */
  open: boolean
}

const viewOf = (entry: MutableEntry): ChildAgentView => ({
  key: entry.key,
  childSessionId: entry.childSessionId,
  toolUseId: entry.toolUseId,
  ...(entry.subagentType === undefined ? {} : { subagentType: entry.subagentType }),
  description: entry.description,
  status: entry.status,
  lines: entry.lines,
  scroll: entry.scroll,
})

export class ChildAgentsPanel {
  private readonly entries: MutableEntry[] = []
  private focusKey: string | null = null
  private currentRevision = 0
  private cachedView: TuiAgentsView | null = EMPTY_AGENTS_VIEW

  /** Monotone view revision; the store mirrors commits off it. */
  get revision(): number {
    return this.currentRevision
  }

  snapshot(): TuiAgentsView {
    if (this.cachedView !== null) return this.cachedView
    const view: TuiAgentsView = {
      entries: this.entries.map(viewOf),
      focusIndex: this.focusIndex(),
      runningCount: this.entries.filter((entry) => entry.status === "running").length,
    }
    this.cachedView = view
    return view
  }

  /** Upsert one spawn fact; a replay entry with the same toolUseId is adopted, not duplicated. */
  applySpawn(fact: ChildSpawnFact): void {
    const index = this.resolveEntry(fact.childSessionId, fact.toolUseId)
    if (index !== -1) {
      const existing = this.entries[index]!
      let changed = false
      if (existing.childSessionId === null) {
        existing.childSessionId = fact.childSessionId
        changed = true
      }
      if (fact.toolUseId !== undefined && existing.toolUseId === null) {
        existing.toolUseId = fact.toolUseId
        changed = true
      }
      if (fact.description !== undefined && existing.description !== fact.description) {
        existing.description = fact.description
        changed = true
      }
      if (fact.subagentType !== undefined && existing.subagentType !== fact.subagentType) {
        existing.subagentType = fact.subagentType
        changed = true
      }
      if (changed) this.touch()
      return
    }
    this.entries.push({
      key: fact.childSessionId,
      childSessionId: fact.childSessionId,
      toolUseId: fact.toolUseId ?? null,
      ...(fact.subagentType === undefined ? {} : { subagentType: fact.subagentType }),
      description: fact.description ?? "",
      status: "running",
      lines: [],
      scroll: 0,
      open: true,
    })
    this.evict()
    this.touch()
  }

  /** Upsert one durable replay fact: the parent's agent tool_use block, before any spawn binds. */
  applyToolUse(toolUseId: string, fact: ChildToolUseFact): void {
    const existing = this.entries.find((entry) => entry.toolUseId === toolUseId)
    if (existing !== undefined) {
      let changed = false
      if (fact.description !== undefined && existing.description !== fact.description) {
        existing.description = fact.description
        changed = true
      }
      if (fact.subagentType !== undefined && existing.subagentType !== fact.subagentType) {
        existing.subagentType = fact.subagentType
        changed = true
      }
      if (changed) this.touch()
      return
    }
    this.entries.push({
      key: `tool:${toolUseId}`,
      childSessionId: null,
      toolUseId,
      ...(fact.subagentType === undefined ? {} : { subagentType: fact.subagentType }),
      description: fact.description ?? "",
      status: "running",
      lines: [],
      scroll: 0,
      open: true,
    })
    this.evict()
    this.touch()
  }

  /** Merge one child text delta into the addressed running entry's buffer. */
  appendLine(childSessionId: string, text: string): void {
    const entry = this.entries.find((candidate) => candidate.childSessionId === childSessionId)
    if (entry === undefined || entry.status !== "running") return
    const sealed = text.endsWith("\n")
    const fragments = text.split("\n")
    if (sealed) fragments.pop()
    // A leading newline on an empty buffer opens the first line, not a
    // blank one: there is nothing to break yet.
    if (entry.lines.length === 0 && fragments.length > 1 && fragments[0] === "") fragments.shift()
    // The same leading break against an already sealed line is
    // redundant: the next fragment still opens a fresh line.
    else if (fragments[0] === "" && entry.lines.length > 0 && !entry.open && fragments.length > 1) fragments.shift()
    const inert = fragments.length === 0 || (fragments.length === 1 && fragments[0] === "")
    if (inert) {
      // A bare break may still seal the open line; nothing renderable
      // moved, so no revision follows it.
      if (entry.lines.length > 0 && sealed) entry.open = false
      return
    }
    if (entry.lines.length === 0 || !entry.open) entry.lines.push(fragments[0]!)
    else entry.lines[entry.lines.length - 1] = entry.lines[entry.lines.length - 1]! + fragments[0]!
    for (let index = 1; index < fragments.length; index += 1) entry.lines.push(fragments[index]!)
    entry.open = !sealed
    if (entry.lines.length > CHILD_LINE_CAP) entry.lines.splice(0, entry.lines.length - CHILD_LINE_CAP)
    if (entry.scroll > entry.lines.length) entry.scroll = entry.lines.length
    this.touch()
  }

  /** Seal one entry at its terminal; late lines and duplicate terminals drop. */
  finalize(fact: ChildFinalizeFact): void {
    const index = this.resolveEntry(fact.childSessionId, fact.toolUseId)
    if (index !== -1) {
      const entry = this.entries[index]!
      let bound = false
      if (fact.childSessionId !== undefined && entry.childSessionId === null) {
        entry.childSessionId = fact.childSessionId
        bound = true
      }
      if (fact.toolUseId !== undefined && entry.toolUseId === null) {
        entry.toolUseId = fact.toolUseId
        bound = true
      }
      if (entry.status !== "running") {
        // A terminal binding identity onto a sealed entry still moves
        // the view: the committed snapshot would otherwise carry the
        // stale null until an unrelated mutation.
        if (bound) this.touch()
        return
      }
      entry.status = fact.status
      if (fact.summary !== undefined && fact.summary.length > 0) {
        for (const line of fact.summary.split("\n")) entry.lines.push(line)
        if (entry.lines.length > CHILD_LINE_CAP) entry.lines.splice(0, entry.lines.length - CHILD_LINE_CAP)
      }
      if (entry.scroll > entry.lines.length) entry.scroll = entry.lines.length
      this.touch()
      return
    }
    this.entries.push({
      key: fact.childSessionId ?? `tool:${fact.toolUseId}`,
      childSessionId: fact.childSessionId ?? null,
      toolUseId: fact.toolUseId ?? null,
      description: "",
      status: fact.status,
      lines: fact.summary === undefined || fact.summary.length === 0 ? [] : fact.summary.split("\n").slice(-CHILD_LINE_CAP),
      scroll: 0,
      open: false,
    })
    this.evict()
    this.touch()
  }

  /** Cycle focus between main and the entries, wrapping at both ends; false when focus held. */
  cycleFocus(direction: "prev" | "next"): boolean {
    const count = this.entries.length
    if (count === 0) return false
    const current = this.focusIndex()
    const next =
      direction === "next"
        ? current === null
          ? 0
          : current + 1 === count
            ? null
            : current + 1
        : current === null
          ? count - 1
          : current === 0
            ? null
            : current - 1
    if (next === null) {
      if (this.focusKey === null) return false
      this.focusKey = null
    } else {
      const key = this.entries[next]!.key
      if (key === this.focusKey) return false
      this.focusKey = key
    }
    this.touch()
    return true
  }

  /** The focused entry's view; null on main focus. */
  focusedEntry(): ChildAgentView | null {
    const index = this.focusIndex()
    return index === null ? null : viewOf(this.entries[index]!)
  }

  /** The cancel address of a focused running child; null unless focus names one. */
  focusedRunningChild(): string | null {
    const index = this.focusIndex()
    if (index === null) return null
    const entry = this.entries[index]!
    return entry.status === "running" && entry.childSessionId !== null ? entry.childSessionId : null
  }

  /**
   * Move the focused entry's scroll by whole lines within its visible
   * window; false at a clamp. Clamping to the buffer end instead would
   * bank values the painted window cannot show and strand later scrolls
   * crossing back through them.
   */
  scrollFocused(delta: number, visibleLines: number): boolean {
    const index = this.focusIndex()
    if (index === null) return false
    const entry = this.entries[index]!
    const max = Math.max(0, entry.lines.length - Math.max(0, visibleLines))
    const next = Math.min(Math.max(entry.scroll + delta, 0), max)
    if (next === entry.scroll) return false
    entry.scroll = next
    this.touch()
    return true
  }

  /** Drop every entry and return focus to main; an already-clean panel mints nothing. */
  reset(): void {
    if (this.entries.length === 0 && this.focusKey === null) return
    this.entries.length = 0
    this.focusKey = null
    this.touch()
  }

  private focusIndex(): number | null {
    if (this.focusKey === null) return null
    const index = this.entries.findIndex((entry) => entry.key === this.focusKey)
    return index === -1 ? null : index
  }

  /**
   * The entry a fact's identity axes address. One axis may have grown
   * a lineage entry the other axis's tool entry never met — a
   * both-axes fact unites them, so the panel keeps one entry per
   * delegation instead of a running ghost beside the sealed one.
   */
  private resolveEntry(childSessionId: string | undefined, toolUseId: string | undefined): number {
    const childIndex = childSessionId === undefined ? -1 : this.entries.findIndex((entry) => entry.childSessionId === childSessionId)
    const toolIndex = toolUseId === undefined ? -1 : this.entries.findIndex((entry) => entry.toolUseId === toolUseId)
    if (childIndex === -1 || toolIndex === -1 || childIndex === toolIndex) return Math.max(childIndex, toolIndex)
    const kept = Math.min(childIndex, toolIndex)
    this.mergeInto(this.entries[kept]!, this.entries[Math.max(childIndex, toolIndex)]!)
    return kept
  }

  /** Fold a duplicate into its keeper: union the identity and buffer; focus follows the surviving key. */
  private mergeInto(kept: MutableEntry, dropped: MutableEntry): void {
    if (kept.childSessionId === null && dropped.childSessionId !== null) kept.childSessionId = dropped.childSessionId
    if (kept.toolUseId === null && dropped.toolUseId !== null) kept.toolUseId = dropped.toolUseId
    if (kept.subagentType === undefined && dropped.subagentType !== undefined) kept.subagentType = dropped.subagentType
    if (kept.description.length === 0 && dropped.description.length > 0) kept.description = dropped.description
    if (kept.status === "running" && dropped.status !== "running") kept.status = dropped.status
    kept.lines.push(...dropped.lines)
    if (kept.lines.length > CHILD_LINE_CAP) kept.lines.splice(0, kept.lines.length - CHILD_LINE_CAP)
    if (kept.scroll > kept.lines.length) kept.scroll = kept.lines.length
    this.entries.splice(this.entries.indexOf(dropped), 1)
    if (this.focusKey === dropped.key) this.focusKey = kept.key
    this.touch()
  }

  /** Reclaim the entry budget: terminal entries first, oldest first; a running child is the last resort. */
  private evict(): void {
    while (this.entries.length > MAX_CHILD_ENTRIES) {
      const terminal = this.entries.findIndex((entry) => entry.status !== "running")
      const victim = terminal === -1 ? 0 : terminal
      const [evicted] = this.entries.splice(victim, 1)
      if (evicted !== undefined && evicted.key === this.focusKey) this.focusKey = null
    }
  }

  private touch(): void {
    this.currentRevision += 1
    this.cachedView = null
  }
}
