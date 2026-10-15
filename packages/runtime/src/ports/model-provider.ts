import type { SessionId } from "@ag2cli/core/ids.js"
import type { PlanDraft } from "@ag2cli/core/plan/plan.js"
import type { ModelCallObservation } from "@ag2cli/core/model/observation.js"

export interface PlanGenerationInput {
  readonly sessionId: SessionId
  readonly goal: string
  readonly context: readonly string[]
  readonly signal?: AbortSignal
}

export type PlanGenerationResult = PlanDraft & {
  readonly modelCall?: ModelCallObservation
}

/**
 * The first provider port is intentionally plan-only.  Completion/tool
 * execution ports will be added when that part of the runtime is migrated.
 */
export interface PlanProvider {
  generatePlan(input: PlanGenerationInput): Promise<PlanGenerationResult>
}
