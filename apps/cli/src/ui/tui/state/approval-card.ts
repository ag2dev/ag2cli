/**
 * Approval card: a pending tool approval as one blocking decision — the
 * request summary as the body, approve/deny as the decision pair. Any
 * cardinal direction flips the decision (the pair is a toggle, not a
 * list to walk); Enter commits it once as an approval effect and closes
 * the card; Escape is claimed but swallowed — a pending approval must
 * be decided, never dismissed by the user. The one exception is
 * supersession: the card surface is one card wide, so a newer card
 * closes a pending approval without deciding it and the host's
 * re-raise re-adopts. Requests adopt by compare-and-swap on
 * version: a lower version, or an exact replay of the current request,
 * is stale; an equal version for a different request is a new approval.
 * The two version spaces never order each other — the parent space
 * counts the session's canonical revisions, the child space counts the
 * host bridge's card versions — so a decided parent approval can never
 * swallow a child raise (or the reverse); a detach resets both
 * baselines across sessions. A decided request stays adopted but
 * inert — re-entering an already-decided approval must never re-fire
 * the port, and an exact replay of it (a resync re-delivering the
 * raise) stays stale. The card holds no approval authority: the host
 * resolves the decision through its approval port.
 */
import type { TuiIntent } from "../keys/index.js"
import { cardAttributionLine, cardSnapshot, type CardAttribution, type CardItemState, type CardSnapshot } from "./card.js"

/** A raised approval; the version carries the host's CAS ordering. */
export interface ApprovalRequestInput {
  readonly requestId: string
  readonly toolName: string
  readonly summary: readonly string[]
  readonly version: number
  /** A bridged child session the decision speaks for; absent = the live session's own ask. */
  readonly attribution?: CardAttribution
}

/** The two ways a pending tool run can settle. */
export type ApprovalDecision = "approved" | "denied"

/** Host-executed resolution; the card keeps no local authority. */
export type ApprovalCardEffect = {
  readonly kind: "approval-decision"
  readonly requestId: string
  readonly decision: ApprovalDecision
}

/** One dispatched key while the card is visible. */
export interface ApprovalCardResult {
  /** Whether the visible card changed; the store repaints only then. */
  readonly changed: boolean
  readonly effects: readonly ApprovalCardEffect[]
}

const APPROVE_LABEL = "approve"
const DENY_LABEL = "deny"

const HINTS: readonly string[] = ["arrows toggle", "enter submit"]

type VersionSpace = "parent" | "child"

const spaceOf = (request: ApprovalRequestInput): VersionSpace => (request.attribution === undefined ? "parent" : "child")

export class ApprovalCard {
  private request: ApprovalRequestInput | null = null
  private readonly baselines: Record<VersionSpace, number> = { parent: 0, child: 0 }
  private decision: ApprovalDecision = "approved"
  private decided = false

  /**
   * Adopt a request by compare-and-swap on its space's version; false
   * means stale. A fresh adoption resets the decision to approved. The
   * last request (decided or pending) stays adopted for the staleness
   * compare, so an exact replay of a decided request cannot re-arm it —
   * and the opposite space's baseline moves not at all.
   */
  open(request: ApprovalRequestInput): boolean {
    const space = spaceOf(request)
    const stale =
      request.version < this.baselines[space] ||
      (request.version === this.baselines[space] &&
        this.request !== null &&
        spaceOf(this.request) === space &&
        this.request.requestId === request.requestId)
    if (stale) return false
    this.baselines[space] = request.version
    this.request = { ...request, summary: [...request.summary] }
    this.decision = "approved"
    this.decided = false
    return true
  }

  /** Claimable while a request is pending and undecided. */
  isVisible(): boolean {
    return this.request !== null && !this.decided
  }

  /**
   * Hide the pending request without deciding it; false when nothing
   * is pending. The card surface is one card wide, so a newer card can
   * supersede an approval — the request clears (the host re-raising it
   * re-adopts; versions keep their ordering) instead of hiding
   * decided-inert, which would strand the decision surface forever.
   */
  close(): boolean {
    if (!this.isVisible()) return false
    this.request = null
    return true
  }

  /**
   * Close only the named pending request (a bridge retract); false when
   * another request holds the surface. The baseline keeps its ordering,
   * so a re-raise of the same entry still adopts.
   */
  closeIfRequest(requestId: string): boolean {
    if (!this.isVisible() || this.request!.requestId !== requestId) return false
    this.request = null
    return true
  }

  /**
   * Drop every trace of the detached session: the pending request
   * closes undecided, and both compare-and-swap baselines reset with it
   * — the parent version is the per-session canonical revision and the
   * child one belongs to the swept bridge, so the incoming session's
   * approvals must adopt however low their revisions read. False when
   * nothing held state.
   */
  detach(): boolean {
    const held = this.request !== null || this.baselines.parent !== 0 || this.baselines.child !== 0
    this.request = null
    this.baselines.parent = 0
    this.baselines.child = 0
    this.decision = "approved"
    this.decided = false
    return held
  }

  /**
   * Route one intent while visible: null when nothing is pending or the
   * pending request was already decided; a visible card claims every
   * key — cardinal directions flip the decision, Enter commits it once,
   * and everything else (Escape included) is absorbed without change.
   */
  dispatch(intent: TuiIntent): ApprovalCardResult | null {
    if (!this.isVisible()) return null
    if (intent.kind === "navigate") {
      if (intent.direction !== "up" && intent.direction !== "down" && intent.direction !== "left" && intent.direction !== "right") {
        return { changed: false, effects: [] }
      }
      this.decision = this.decision === "approved" ? "denied" : "approved"
      return { changed: true, effects: [] }
    }
    if (intent.kind === "activate") {
      const request = this.request!
      // Single shot: the request stays adopted for the staleness
      // compare, but the card goes inert — a re-entered or replayed
      // decided approval must never re-fire the port.
      this.decided = true
      return { changed: true, effects: [{ kind: "approval-decision", requestId: request.requestId, decision: this.decision }] }
    }
    return { changed: false, effects: [] }
  }

  /**
   * Render-ready snapshot of the pending decision; null hides it. The
   * frame title names the tool; a bridged child renders its attribution
   * crumb above the summary; the decision pair renders as radio rows
   * with the focus gutter on the standing decision.
   */
  snapshot(): CardSnapshot | null {
    const request = this.request
    if (request === null || this.decided) return null
    const items: readonly CardItemState[] = [
      { label: APPROVE_LABEL, description: undefined, chosen: this.decision === "approved", disabled: false, digit: null },
      { label: DENY_LABEL, description: undefined, chosen: this.decision === "denied", disabled: false, digit: null },
    ]
    return cardSnapshot({
      tabLabels: ["Approval"],
      activeTabIndex: 0,
      body: request.summary.map((line) => [{ text: line, token: "text" as const }]),
      items,
      focusedIndex: this.decision === "approved" ? 0 : 1,
      focusedKey: this.decision,
      multiSelect: false,
      lastTab: true,
      hints: HINTS,
      markers: "radio",
      title: `approval: ${request.toolName}`,
      ...(request.attribution === undefined ? {} : { breadcrumb: [cardAttributionLine(request.attribution)] }),
    })
  }
}
