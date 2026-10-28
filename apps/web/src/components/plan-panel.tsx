import type { PublicPlanSummary } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import { Badge } from "./ui/badge"

const STATUS_LABELS: Record<PublicPlanSummary["status"], string> = {
  proposed: "Proposed",
  active: "Active",
  completed: "Completed",
  abandoned: "Abandoned",
}

const STEP_STATUS_LABELS: Record<NonNullable<PublicPlanSummary["steps"]>[number]["status"], string> = {
  pending: "Pending",
  blocked: "Blocked",
  ready: "Ready",
}

/** plan.updated is informational tracking, so the panel is read-only: each
 * plan renders its own status and counters as-is and no step is ever marked
 * done — the protocol has no step-completion lifecycle to derive one from. */
export function PlanPanel({ plans }: { plans: readonly PublicPlanSummary[] }) {
  if (plans.length === 0) return null
  return (
    <section aria-label="Plan progress" className="mb-3 max-h-56 space-y-2 overflow-y-auto rounded-xl border bg-card px-3.5 py-3">
      {plans.map((plan) => (
        <article key={plan.planId} aria-label={plan.title ?? plan.planId}>
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-medium">{plan.title ?? "Plan"}</span>
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {STATUS_LABELS[plan.status]}
            </Badge>
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {plan.completedSteps}/{plan.totalSteps} steps
            </span>
          </div>
          {plan.steps ? (
            <ol className="mt-1.5 space-y-1">
              {plan.steps.map((step) => (
                <li key={step.order} className="flex items-center gap-2 text-[11px]">
                  <span className="text-muted-foreground">{step.order}.</span>
                  <span className="min-w-0 truncate">{step.title}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">{STEP_STATUS_LABELS[step.status]}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </article>
      ))}
    </section>
  )
}
