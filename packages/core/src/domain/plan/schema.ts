import { z } from "zod/v4"
import type { PlanDraft } from "./plan.js"

const planStepDraftSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  dependencies: z.array(z.string().min(1)).default([]),
})

export const planDraftSchema = z.object({
  goal: z.string().min(1),
  summary: z.string().min(1),
  steps: z.array(planStepDraftSchema).min(1),
  risks: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
})

export function parsePlanDraft(input: unknown): PlanDraft {
  return planDraftSchema.parse(input)
}
