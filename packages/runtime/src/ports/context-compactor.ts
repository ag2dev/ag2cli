import type { SessionId, RunId } from "@ag2cli/core/ids.js"
import type { Message } from "@ag2cli/core/message.js"
import type { ContextCompactionBoundary } from "./context-builder.js"
import type { ModelCallObservation } from "@ag2cli/core/model/observation.js"

export interface ContextSummaryInput {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly messages: readonly Message[]
  readonly signal?: AbortSignal
}

export interface ContextSummaryResult {
  readonly text: string
  readonly observation?: ModelCallObservation
}

export type ContextSummarizer = (input: ContextSummaryInput) => Promise<string | ContextSummaryResult>

/** Runtime capability used by explicit session-level context compaction. */
export interface ContextCompactor {
  compact(input: {
    readonly sessionId: SessionId
    readonly runId: RunId
    readonly messages: readonly Message[]
    readonly instructions?: string
    readonly signal?: AbortSignal
  }): Promise<ContextCompactionResult>
}

export interface ContextCompactionResult extends ContextCompactionBoundary {
  /** Present only when local-full observability is enabled. */
  readonly modelObservation?: ModelCallObservation
}
