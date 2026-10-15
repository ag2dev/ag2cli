import type { PlanId, SessionId } from "@ag2cli/core/ids.js"
import { planDraftSchema } from "@ag2cli/core/plan/schema.js"
import type { Plan, PlanDraft } from "@ag2cli/core/plan/plan.js"

export interface PlanIdentity {
  nextPlanId(): PlanId
  now(): string
}

/**
 * Converts validated model output into a domain Plan.
 * Model/provider details stay outside this service.
 */
export class PlanService {
  constructor(private readonly identity: PlanIdentity) {}

  create(sessionId: SessionId, revision: number, input: unknown): Plan {
    const draft = planDraftSchema.parse(input) as PlanDraft
    const steps = draft.steps.map((step, index) => ({
      id: step.id ?? `step-${index + 1}`,
      order: index + 1,
      title: step.title,
      description: step.description,
      dependencies: [...step.dependencies],
      status: step.dependencies.length === 0 ? ("ready" as const) : ("blocked" as const),
    }))

    const stepIds = new Set(steps.map((step) => step.id))
    if (stepIds.size !== steps.length) {
      throw new Error("Plan step id is duplicated")
    }
    for (const step of steps) {
      for (const dependency of step.dependencies) {
        if (!stepIds.has(dependency)) {
          throw new Error(`Plan dependency does not exist: ${step.id} -> ${dependency}`)
        }
      }
    }

    return {
      id: this.identity.nextPlanId(),
      sessionId,
      revision,
      goal: draft.goal,
      summary: draft.summary,
      steps,
      risks: [...draft.risks],
      assumptions: [...draft.assumptions],
      createdAt: this.identity.now(),
    }
  }
}
