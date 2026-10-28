import type { SessionId } from "@ag2cli/core/ids.js"
import type { BackgroundTaskRegistry } from "./task-registry.js"
import type { PolicySerialPoint } from "../../ports/policy-serial-point.js"

/**
 * A cancelled task whose owner died with its process is honest attribution,
 * not a task-side failure.
 */
export const CHILD_TASK_RECOVERY_REASON = "process restarted"

export interface OrphanedAgentTaskRecoveryDeps {
  readonly registry: BackgroundTaskRegistry
  readonly sessionId: SessionId
  /**
   * Serial point sharing the host's "child-task" section so the cancels
   * cannot interleave with a live settle projection on the same task.
   */
  readonly serialPoint?: PolicySerialPoint
}

/**
 * First-serve convergence for orphaned durable agent tasks. Spawns only
 * reach a runner through server command routing, so an agent task still
 * without a terminal when its session is first served was owned by a
 * process that died: each lands one cancelled terminal carrying the
 * restart reason. Idempotent by construction — registry cancel is a no-op
 * on terminal states. Non-agent tasks stay untouched; their executor world
 * remains fail-closed.
 */
export async function cancelOrphanedAgentTasks(deps: OrphanedAgentTaskRecoveryDeps): Promise<void> {
  const tasks = await deps.registry.list(deps.sessionId)
  for (const task of tasks) {
    if (task.type !== "agent") continue
    // A crash can strand a child between Created and Started, so both
    // non-terminal agent statuses are orphans, not just running ones.
    if (task.status !== "queued" && task.status !== "running") continue
    const guarded = (): Promise<unknown> => deps.registry.cancel(deps.sessionId, task.id, CHILD_TASK_RECOVERY_REASON).catch(() => undefined)
    await (deps.serialPoint?.critical(deps.sessionId, `child-task:${task.id}`, "child-task", guarded) ?? guarded())
  }
}
