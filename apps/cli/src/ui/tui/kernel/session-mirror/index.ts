/**
 * Session-mirror owner: presentation-only projections of telemetry,
 * queue, plan and agents state, plus query results keyed by request
 * id. Mirror facts never take part in adjudication — a mirror may say
 * a permission was applied, but the ruling reads the ports, not the
 * picture.
 */
export type MirrorFile = {
  readonly path: string
  readonly description?: string
  readonly detail?: readonly string[]
}

/**
 * A query cache entry's lineage, graded like operation origins: client
 * and workspace entries survive session switches, session entries die
 * with their binding. Structural shape only — typed locally so this
 * owner imports no sibling.
 */
export type MirrorQueryScope =
  | { readonly scope: "client" }
  | { readonly scope: "workspace"; readonly workspaceId: string }
  | { readonly scope: "session"; readonly sessionId: string; readonly generation: number }

/** One resumable session row as the entry maps it from the catalog. */
export type MirrorSessionRow = {
  readonly sessionId: string
  readonly title?: string
  readonly lastRevision: number
  readonly createdAt: string
}

/**
 * One queued input's preview row. The kind is derived at the
 * composition seam that maps the public mailbox: prompts keep their
 * raw text and notifications carry the derived task headline. Slash
 * rows are minted kernel-side from run-queue parks and never appear in
 * a mirror fact.
 */
export type TuiQueueRow = {
  readonly inputId: string
  readonly text: string
  readonly kind: "prompt" | "notification" | "slash"
}

/**
 * One plan's chrome row. The composition seam maps the public plan
 * summary (dropping its step detail and update stamp); the kernel
 * upserts the rows by plan id and owns their first-appearance order.
 */
export type TuiPlanRow = {
  readonly planId: string
  readonly title?: string
  readonly status: "proposed" | "active" | "completed" | "abandoned"
  readonly completedSteps: number
  readonly totalSteps: number
}

export type MirrorFact =
  /**
   * The still-queued mailbox rows in acceptance order, kind already
   * derived by the composition seam that reads the public mailbox; the
   * kernel upserts them by id and merges its own parked slash rows
   * into the frame's preview.
   */
  | { readonly source: "queue"; readonly rows: readonly TuiQueueRow[] }
  | { readonly source: "plan"; readonly rows: readonly TuiPlanRow[] }
  | { readonly source: "agents" | "telemetry" }
  | {
      readonly source: "resume-sessions"
      readonly requestId: string
      readonly rows: readonly MirrorSessionRow[]
      readonly scope: MirrorQueryScope
    }
  | {
      readonly source: "query-result"
      readonly requestId: string
      readonly scope: MirrorQueryScope
      readonly files?: readonly MirrorFile[]
    }

export { MirrorStore } from "./store.js"
