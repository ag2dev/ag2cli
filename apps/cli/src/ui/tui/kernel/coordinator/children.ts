/**
 * The children board: the live model behind the per-child monitoring
 * panel. Entries are id-keyed (the child session id — the async task
 * record binds the same id), so focus can never shift onto another
 * entry through eviction; the ring is the registered tail-200 per
 * child and the cap evicts the oldest terminated entry first. Model
 * deltas are sanitized at ingestion — the ring holds only renderable
 * rows, and the view clips width.
 */
import { sanitizeText } from "../../text/index.js"
import type { ChildrenFact, ChildStatus } from "./contract.js"
import type { ChildrenPanelView, ChildrenView } from "./snapshot.js"

/** Registered per-child ring depth: the retained tail of attributed lines. */
const RING_LINES = 200

/** Registered board cap: at most this many entries, oldest terminated evicted first. */
const PANEL_CAP = 32

/** The focused panel's rendered body window; the page step equals the window. */
export const CHILDREN_PANEL_WINDOW = 8

/** The registered summary row, painted only while at least one child runs. */
export const childrenSummaryRow = (running: number): string => `agents: ${running} running · alt+←/→ to focus`

interface ChildEntry {
  readonly childSessionId: string
  description: string
  subagentType: string | undefined
  status: ChildStatus
  summary: string | null
  lines: readonly string[]
  pending: string
}

interface ToolUseFact {
  readonly description?: string
  readonly subagentType?: string
}

export class ChildrenBoard {
  private entries: readonly ChildEntry[] = []
  private readonly alias = new Map<string, string>()
  private readonly toolUseFacts = new Map<string, ToolUseFact>()
  private focusId: string | null = null
  private page = 0

  /** One delegation fact; true when the board moved. */
  ingest(fact: ChildrenFact): boolean {
    switch (fact.type) {
      case "spawn":
        return this.spawn(fact)
      case "tool-use":
        return this.toolUse(fact.toolUseId, fact)
      case "line":
        return this.appendLine(fact.childSessionId, fact.text)
      case "finalize":
        return this.finalize(fact)
      case "reset":
        return this.reset()
    }
  }

  private spawn(fact: Extract<ChildrenFact, { type: "spawn" }>): boolean {
    const existing = this.entries.find((entry) => entry.childSessionId === fact.childSessionId)
    if (existing !== undefined) {
      // A lineage-only bind (no description) keeps what the live spawn
      // already recorded; a richer fact fills empty fields only.
      const description = fact.description !== undefined && fact.description !== "" ? fact.description : existing.description
      const subagentType = existing.subagentType ?? fact.subagentType
      if (fact.toolUseId !== undefined) this.alias.set(fact.toolUseId, fact.childSessionId)
      if (description === existing.description && subagentType === existing.subagentType) return false
      this.entries = this.entries.map((entry) => (entry === existing ? { ...entry, description, subagentType } : entry))
      return true
    }
    const annotation = fact.toolUseId === undefined ? undefined : this.toolUseFacts.get(fact.toolUseId)
    const description = fact.description !== undefined && fact.description !== "" ? fact.description : (annotation?.description ?? "")
    const subagentType = fact.subagentType ?? annotation?.subagentType
    if (fact.toolUseId !== undefined) {
      this.alias.set(fact.toolUseId, fact.childSessionId)
      this.toolUseFacts.delete(fact.toolUseId)
    }
    this.entries = [
      ...this.entries,
      { childSessionId: fact.childSessionId, description, subagentType, status: "running", summary: null, lines: [], pending: "" },
    ]
    if (this.entries.length > PANEL_CAP) this.evict()
    return true
  }

  /**
   * Over-cap eviction takes the oldest terminated entry; the semaphore
   * bounds concurrent running children well under the cap, so the
   * all-running corner only arises under a pathological registry and
   * then falls back to the oldest entry outright.
   */
  private evict(): void {
    let victim = this.entries.findIndex((entry) => entry.status !== "running")
    if (victim < 0) victim = 0
    const id = this.entries[victim]!.childSessionId
    this.entries = this.entries.filter((entry) => entry.childSessionId !== id)
    for (const [toolUseId, childSessionId] of this.alias) {
      if (childSessionId === id) this.alias.delete(toolUseId)
    }
    // Id-keyed focus: evicting the focused entry returns to main, never onto a neighbor.
    if (this.focusId === id) {
      this.focusId = null
      this.page = 0
    }
  }

  private toolUse(toolUseId: string, fact: ToolUseFact): boolean {
    const childSessionId = this.alias.get(toolUseId)
    if (childSessionId === undefined) {
      this.toolUseFacts.set(toolUseId, fact)
      return false
    }
    const existing = this.entries.find((entry) => entry.childSessionId === childSessionId)
    if (existing === undefined) return false
    const description =
      existing.description === "" && fact.description !== undefined && fact.description !== "" ? fact.description : existing.description
    const subagentType = existing.subagentType ?? fact.subagentType
    if (description === existing.description && subagentType === existing.subagentType) return false
    this.entries = this.entries.map((entry) => (entry === existing ? { ...entry, description, subagentType } : entry))
    return true
  }

  private appendLine(childSessionId: string, text: string): boolean {
    const existing = this.entries.find((entry) => entry.childSessionId === childSessionId)
    if (existing === undefined) return false
    const complete = (existing.pending + text).split("\n")
    const pending = complete.pop()!
    const appended = complete.map((line) => sanitizeText(line)).filter((line) => line !== "")
    // A delta that completes no line only moves the assembly remainder,
    // which renders nowhere — the frame stays until a full row lands.
    if (appended.length === 0) {
      this.entries = this.entries.map((entry) => (entry === existing ? { ...entry, pending } : entry))
      return false
    }
    const lines = [...existing.lines, ...appended].slice(-RING_LINES)
    this.entries = this.entries.map((entry) => (entry === existing ? { ...entry, lines, pending } : entry))
    return true
  }

  private finalize(fact: Extract<ChildrenFact, { type: "finalize" }>): boolean {
    if (fact.toolUseId !== undefined) this.toolUseFacts.delete(fact.toolUseId)
    const childSessionId = fact.childSessionId ?? (fact.toolUseId === undefined ? undefined : this.alias.get(fact.toolUseId))
    if (childSessionId === undefined) return false
    const existing = this.entries.find((entry) => entry.childSessionId === childSessionId)
    if (existing === undefined) return false
    // The terminal flushes the assembly remainder so the retained ring ends at the outcome.
    const tail = existing.pending === "" ? [] : [sanitizeText(existing.pending)]
    const lines = tail[0] === "" ? existing.lines : [...existing.lines, ...tail].slice(-RING_LINES)
    if (existing.status === fact.status && (fact.summary === undefined || existing.summary === fact.summary) && lines === existing.lines) {
      return false
    }
    this.entries = this.entries.map((entry) =>
      entry === existing
        ? { ...entry, status: fact.status, summary: fact.summary === undefined ? entry.summary : fact.summary, lines, pending: "" }
        : entry,
    )
    return true
  }

  private reset(): boolean {
    if (this.entries.length === 0 && this.focusId === null && this.alias.size === 0 && this.toolUseFacts.size === 0 && this.page === 0) {
      return false
    }
    this.entries = []
    this.alias.clear()
    this.toolUseFacts.clear()
    this.focusId = null
    this.page = 0
    return true
  }

  readonly runningCount = (): number => this.entries.reduce((count, entry) => (entry.status === "running" ? count + 1 : count), 0)

  readonly count = (): number => this.entries.length

  /** The focused entry when its id still resolves; a dangling id is unrepresentable. */
  readonly focused = (): { readonly childSessionId: string; readonly status: ChildStatus } | null => {
    if (this.focusId === null) return null
    const entry = this.entries.find((candidate) => candidate.childSessionId === this.focusId)
    return entry === undefined ? null : { childSessionId: entry.childSessionId, status: entry.status }
  }

  /**
   * The panel seats of the traversal ring, in ring order. The caller
   * owns the full ring (composer and actions ride ahead of these); the
   * board only exposes the panel ids so the kernel can compute hops
   * without touching entry internals.
   */
  readonly entryIds = (): readonly string[] => this.entries.map((entry) => entry.childSessionId)

  /**
   * Land the panel stage on one entry: focus mints the stage, the page
   * resets so a fresh panel opens on its newest tail, and landing on
   * the composer seat (a null id) clears it.
   */
  focusChild(childSessionId: string | null): boolean {
    if (childSessionId === this.focusId) return false
    if (childSessionId !== null && !this.entries.some((entry) => entry.childSessionId === childSessionId)) return false
    this.focusId = childSessionId
    this.page = 0
    return true
  }

  /** Esc on the panel: back to the main conversation. */
  clearFocus(): boolean {
    if (this.focusId === null) return false
    this.focusId = null
    this.page = 0
    return true
  }

  /** Panel paging: up walks toward older lines, down toward the newest tail. */
  pagePanel(direction: "up" | "down"): boolean {
    const focused = this.focused()
    if (focused === null) return false
    const entry = this.entries.find((candidate) => candidate.childSessionId === focused.childSessionId)!
    const pageCount = Math.ceil(entry.lines.length / CHILDREN_PANEL_WINDOW)
    const next = direction === "up" ? this.page + 1 : this.page - 1
    const clamped = Math.max(0, Math.min(next, Math.max(0, pageCount - 1)))
    if (clamped === this.page) return false
    this.page = clamped
    return true
  }

  readonly view = (): ChildrenView => {
    const running = this.runningCount()
    const focused = this.focused()
    let panel: ChildrenPanelView | null = null
    if (focused !== null) {
      const entry = this.entries.find((candidate) => candidate.childSessionId === focused.childSessionId)!
      const pageCount = Math.ceil(entry.lines.length / CHILDREN_PANEL_WINDOW)
      const page = Math.min(this.page, Math.max(0, pageCount - 1))
      const end = entry.lines.length - page * CHILDREN_PANEL_WINDOW
      panel = {
        childSessionId: entry.childSessionId,
        description: entry.description,
        ...(entry.subagentType === undefined ? {} : { subagentType: entry.subagentType }),
        status: entry.status,
        summary: entry.summary,
        visibleLines: entry.lines.slice(Math.max(0, end - CHILDREN_PANEL_WINDOW), end),
        page,
        pageCount,
      }
    }
    return {
      entries: this.entries.map((entry) => ({
        childSessionId: entry.childSessionId,
        description: entry.description,
        ...(entry.subagentType === undefined ? {} : { subagentType: entry.subagentType }),
        status: entry.status,
        summary: entry.summary,
        lines: entry.lines,
      })),
      focus: this.focusId,
      runningCount: running,
      summaryRow: running > 0 ? childrenSummaryRow(running) : null,
      panel,
    }
  }
}
