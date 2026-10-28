import type { RunId } from "../ids.js"

export type RunStatus = "running" | "completed" | "failed" | "cancelled"

/** Stable client-visible fallback for a completed run with no renderable text. */
export const EMPTY_MODEL_RESPONSE_FALLBACK = "The model returned no displayable text response."

/** Reconstructable execution summary exposed to every client. */
export interface RunSnapshot {
  readonly id: RunId
  readonly commandId: string
  readonly status: RunStatus
  readonly turn: number
  readonly startedAt: string
  readonly completedAt?: string
  readonly finalText?: string
  readonly lastError?: string
}

/** Transport-neutral terminal outcome returned by a run command. */
export interface RunResult {
  readonly runId: RunId
  readonly status: "completed" | "failed" | "cancelled"
  readonly turns: number
  readonly finalText?: string
  readonly error?: string
  /** Stable classification of the failure; set when the cause is a terminal interaction outcome. */
  readonly failureCode?: "approval_required" | "interaction_expired"
}
