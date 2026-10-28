import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicPendingInteraction } from "@ag2cli/app-server-protocol/dto/interactions.js"
import type {
  PublicInputSnapshot,
  PublicPermissionModeValue,
  PublicPlanSummary,
  PublicSessionSnapshot,
  PublicTaskSummary,
} from "@ag2cli/app-server-protocol/dto/snapshot.js"

// Session mirrors derive the M2 faces (queue, interactions, plan, security)
// from the snapshot seed plus durable events. Event batches are applied in
// revision order (live singles and replay pages both arrive ascending).

/** Queue mirror rules, same source as the TUI mailbox: seed from snapshot
 * queued inputs, park on input.accepted, drain on input.updated with a
 * non-queued status and on input.failed. FIFO order comes from acceptedAt —
 * consumption priority belongs to the server, the client never reorders. */
export function seedQueuedInputs(inputs: readonly PublicInputSnapshot[]): readonly PublicInputSnapshot[] {
  return sortQueue(inputs.filter((input) => input.status === "queued"))
}

export function applyQueueEvents(
  queue: readonly PublicInputSnapshot[],
  events: readonly PublicSessionEvent[],
): readonly PublicInputSnapshot[] {
  const byInputId = new Map(queue.map((input) => [input.inputId, input]))
  for (const event of events) {
    if (event.type === "input.accepted" || event.type === "input.updated") {
      const input = event.input
      if (input.status === "queued") byInputId.set(input.inputId, input)
      else byInputId.delete(input.inputId)
    }
    if (event.type === "input.failed") byInputId.delete(event.inputId)
  }
  return sortQueue([...byInputId.values()])
}

function sortQueue(inputs: readonly PublicInputSnapshot[]): readonly PublicInputSnapshot[] {
  return [...inputs].sort((left, right) => {
    if (left.acceptedAt !== right.acceptedAt) return left.acceptedAt < right.acceptedAt ? -1 : 1
    return left.inputId < right.inputId ? -1 : 1
  })
}

/** A card never outlives its interaction: interaction.resolved closes the
 * card for any outcome and any resolver; the mirror only tracks what is
 * still pending, for both kinds. */
export function seedPendingInteractions(pending: readonly PublicPendingInteraction[]): readonly PublicPendingInteraction[] {
  return [...pending]
}

export function applyInteractionEvents(
  pending: readonly PublicPendingInteraction[],
  events: readonly PublicSessionEvent[],
): readonly PublicPendingInteraction[] {
  const byInteractionId = new Map(pending.map((interaction) => [interaction.interactionId, interaction]))
  for (const event of events) {
    if (event.type === "interaction.requested") byInteractionId.set(event.interaction.interactionId, event.interaction)
    if (event.type === "interaction.resolved") byInteractionId.delete(event.resolution.interactionId)
  }
  return [...byInteractionId.values()]
}

/** plan.updated is informational; keep the latest summary per planId, in
 * updatedAt order (the TUI plan map precedent). */
export function seedPlans(activePlan: PublicPlanSummary | undefined): readonly PublicPlanSummary[] {
  return activePlan === undefined ? [] : [activePlan]
}

export function applyPlanEvents(plans: readonly PublicPlanSummary[], events: readonly PublicSessionEvent[]): readonly PublicPlanSummary[] {
  const byPlanId = new Map(plans.map((plan) => [plan.planId, plan]))
  for (const event of events) {
    if (event.type === "plan.updated") byPlanId.set(event.plan.planId, event.plan)
  }
  return [...byPlanId.values()].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? -1 : 1
    return left.planId < right.planId ? -1 : 1
  })
}

/** Console mirror entry: the task summary plus the output state the paged
 * `getTaskLogs` pulls have accumulated; task.updated carries no output. */
export interface BrowserShellTask {
  readonly taskId: string
  readonly kind: "shell" | "user_shell"
  readonly title: string
  readonly status: PublicTaskSummary["status"]
  readonly updatedAt: string
  readonly output: string
  /** Highest chunk sequence already folded into output. */
  readonly pulledThrough?: number
  readonly outputBytes?: number
}

const asShellTaskSummary = (task: PublicTaskSummary): BrowserShellTask | undefined =>
  task.kind === "shell" || task.kind === "user_shell"
    ? { taskId: task.taskId, kind: task.kind, title: task.title, status: task.status, updatedAt: task.updatedAt, output: "" }
    : undefined

/** task.updated mirrors keep the latest summary per taskId in first-seen
 * order; the shell kinds only. Pulled output survives status transitions. */
export function seedShellTasks(activeTasks: readonly PublicTaskSummary[]): readonly BrowserShellTask[] {
  return activeTasks.flatMap((task) => {
    const seeded = asShellTaskSummary(task)
    return seeded === undefined ? [] : [seeded]
  })
}

export function applyTaskEvents(tasks: readonly BrowserShellTask[], events: readonly PublicSessionEvent[]): readonly BrowserShellTask[] {
  const byTaskId = new Map(tasks.map((task) => [task.taskId, task]))
  for (const event of events) {
    if (event.type !== "task.updated" && event.type !== "background_task.updated") continue
    const summary = asShellTaskSummary(event.task)
    if (summary === undefined) continue
    const previous = byTaskId.get(summary.taskId)
    byTaskId.set(summary.taskId, {
      ...summary,
      output: previous?.output ?? "",
      ...(previous?.pulledThrough === undefined ? {} : { pulledThrough: previous.pulledThrough }),
      ...(previous?.outputBytes === undefined ? {} : { outputBytes: previous.outputBytes }),
    })
  }
  return [...byTaskId.values()]
}

export interface SessionSecurity {
  readonly permissionMode: PublicPermissionModeValue
  readonly policyRevision: number
  readonly hasCustomRules: boolean
  readonly selectableModes: readonly PublicPermissionModeValue[]
  /** Event revision this mirror reflects; older or equal events never regress it. */
  readonly revision: number
}

/** security.updated carries only mode + policyRevision; selectableModes and
 * hasCustomRules stay from the snapshot seed until a resync replaces them. */
export function seedSessionSecurity(security: PublicSessionSnapshot["security"], asOfRevision: number): SessionSecurity {
  return {
    permissionMode: security.permissionMode,
    policyRevision: security.policyRevision,
    hasCustomRules: security.hasCustomRules,
    selectableModes: [...security.selectableModes],
    revision: asOfRevision,
  }
}

export function applySecurityEvents(security: SessionSecurity, events: readonly PublicSessionEvent[]): SessionSecurity {
  let mirror = security
  for (const event of events) {
    if (event.type !== "security.updated") continue
    if (event.revision <= mirror.revision) continue
    mirror = {
      ...mirror,
      permissionMode: event.permissionMode,
      policyRevision: event.policyRevision,
      revision: event.revision,
    }
  }
  return mirror
}
