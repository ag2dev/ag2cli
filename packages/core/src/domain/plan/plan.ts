import type { PlanId, SessionId } from "../ids.js"

export type PlanStepStatus = "pending" | "blocked" | "ready"

export interface PlanStep {
  readonly id: string
  readonly order: number
  readonly title: string
  readonly description: string
  readonly dependencies: readonly string[]
  readonly status: PlanStepStatus
}

export interface Plan {
  readonly id: PlanId
  readonly sessionId: SessionId
  readonly revision: number
  readonly goal: string
  readonly summary: string
  readonly steps: readonly PlanStep[]
  readonly risks: readonly string[]
  readonly assumptions: readonly string[]
  readonly createdAt: string
}

/** Model-facing input. It deliberately has no provider-specific fields. */
export interface PlanDraft {
  readonly goal: string
  readonly summary: string
  readonly steps: readonly PlanStepDraft[]
  readonly risks: readonly string[]
  readonly assumptions: readonly string[]
}

export interface PlanStepDraft {
  readonly id?: string
  readonly title: string
  readonly description: string
  readonly dependencies: readonly string[]
}
