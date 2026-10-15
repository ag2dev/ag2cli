/**
 * Child-task settle assembly (E1, D-E1-4/5/6): the composition projection
 * behind the runner's `onChildSettled`. One async child settle becomes,
 * on the parent session's canonical stream inside one `"child-task"`
 * serial section, the bounded append sequence BackgroundTaskCreated →
 * Started → OutputAppended(final report) → terminal → one pending
 * notification `InputAccepted(kind: "notification")` whose text is the
 * byte-exact task-notification marker the TUI parser already consumes.
 *
 * The projector is late-bound: the runner assembles before its owning
 * server exists, so `project` stays silent until composition installs the
 * server-minted recorder, serial point, and notification sink (the
 * `onTransientEvent` precedent; no spawn can settle before the server,
 * because spawns only reach the runner through the server's runs). The
 * projection is best-effort — a failed append sequence is dropped and
 * never changes the child's terminal.
 */
import { runId, sessionId, taskId, type SessionId } from "@ag2cli/core/ids.js"
import type { BackgroundTaskRegistry } from "@ag2cli/runtime/application/task/task-registry.js"
import type { PolicySerialPoint } from "@ag2cli/runtime/ports/policy-serial-point.js"
import type { ChildAgentSettled } from "../capabilities/execution/child-agent-runner.js"
import type { ChildTaskRecordInput, ChildTaskRecorder } from "../capabilities/execution/child-task-recorder.js"

/** Notification status words: the attr and headline differ only on completion. */
const NOTIFICATION_WORDS = {
  completed: { attr: "finished", headline: "completed" },
  failed: { attr: "failed", headline: "failed" },
  cancelled: { attr: "cancelled", headline: "cancelled" },
} as const

/**
 * Byte-exact task-notification marker text (D-E1-4): the TUI's existing
 * `NOTIFICATION_MARKER`/`NOTIFICATION_HEADLINE` grammar — the status
 * attribute, the `<description> <status> after <N> turns` headline, and
 * the child handle on the second body line where no parser looks.
 */
export function buildChildTaskNotificationText(settled: {
  readonly status: "completed" | "failed" | "cancelled"
  readonly turns: number
  readonly description: string
  readonly childSessionId: string
}): string {
  const words = NOTIFICATION_WORDS[settled.status]
  return `<task-notification status="${words.attr}">\n${settled.description} ${words.headline} after ${settled.turns} turns\nchild: ${settled.childSessionId}\n</task-notification>`
}

export interface BackgroundChildTaskRecorderDeps {
  /** The parent host's per-session task registry (server-minted). */
  readonly registry: BackgroundTaskRegistry
}

/** ChildTaskRecorder over a real task registry: plain transitions, no ordering. */
export function createBackgroundChildTaskRecorder(deps: BackgroundChildTaskRecorderDeps): ChildTaskRecorder {
  return {
    async created(input: ChildTaskRecordInput) {
      await deps.registry.create(input.parentSessionId, {
        taskId: taskId(input.taskId),
        type: "agent",
        title: input.title,
        prompt: input.prompt,
        ...(input.parentRunId === undefined ? {} : { parentRunId: runId(input.parentRunId) }),
      })
    },
    async started(parent: SessionId, id: string, runNumber: number) {
      await deps.registry.start(parent, taskId(id), runNumber)
    },
    async output(parent: SessionId, id: string, chunk: string) {
      await deps.registry.appendOutput(parent, taskId(id), chunk)
    },
    async terminal(parent: SessionId, id: string, terminal) {
      if (terminal.kind === "completed") {
        await deps.registry.complete(parent, taskId(id), terminal.runNumber)
      } else if (terminal.kind === "failed") {
        await deps.registry.fail(parent, taskId(id), terminal.message)
      } else {
        await deps.registry.cancel(parent, taskId(id), terminal.reason)
      }
    },
  }
}

/** The server-minted pieces the settle projection binds after construction. */
export interface ChildTaskSettleAssembly {
  readonly recorder: ChildTaskRecorder
  readonly serialPoint: PolicySerialPoint
  readonly notify: (sessionId: SessionId, text: string) => Promise<unknown>
}

/**
 * Recovery reason pinned by D-E1-8: a cancelled task whose owner died with
 * the process is honest attribution, not a task-side failure.
 */
export const CHILD_TASK_RECOVERY_REASON = "process restarted"

export interface OrphanedChildTaskRecoveryDeps {
  /** Candidate sessions in this host's durable scope. */
  readonly sessions: () => Promise<readonly SessionId[]>
  /**
   * Registry face for one session; undefined (or a rejection) skips that
   * session — recovery is a best-effort observability correction and must
   * not block host startup.
   */
  readonly registryFor: (sessionId: SessionId) => Promise<BackgroundTaskRegistry | undefined>
  /**
   * Serial point sharing the host's `"child-task"` section. Absent when the
   * section's owner does not exist yet (serve workspace runtimes are lazy);
   * startup there is writer-exclusive anyway, and each registry serializes
   * its own session appends.
   */
  readonly serialPoint?: PolicySerialPoint
}

/**
 * Host-startup orphan recovery (D-E1-8): every durable agent-type task
 * without a terminal was owned by a previous process — spawns only reach a
 * runner through server command routing, which cannot exist before the
 * host build returns — so each lands one cancelled terminal carrying the
 * restart reason. Idempotent by construction: registry cancel is a no-op
 * on terminal states. Non-agent tasks stay untouched; their executor
 * world remains fail-closed.
 */
export async function recoverOrphanedChildTasks(deps: OrphanedChildTaskRecoveryDeps): Promise<void> {
  for (const id of await deps.sessions()) {
    const registry = await deps.registryFor(id).catch(() => undefined)
    if (registry === undefined) continue
    const tasks = await registry.list(id).catch(() => undefined)
    if (tasks === undefined) continue
    for (const task of tasks) {
      if (task.type !== "agent") continue
      if (task.status !== "queued" && task.status !== "running") continue
      // A crash can strand a child between Created and Started, so both
      // non-terminal agent statuses are orphans, not just running ones.
      const cancel = (): Promise<unknown> => registry.cancel(id, task.id, CHILD_TASK_RECOVERY_REASON)
      const guarded = (): Promise<unknown> => cancel().catch(() => undefined)
      await (deps.serialPoint?.critical(id, `child-task:${task.id}`, "child-task", guarded) ?? guarded())
    }
  }
}

export interface ChildTaskSettleProjector {
  /**
   * Runner `onChildSettled` seam: silent until `install` ran. The returned
   * promise (rejections swallowed) settles once the whole projection —
   * task events plus notification — has landed, so awaiting it bounds the
   * caller's quiescence observation.
   */
  project(settled: ChildAgentSettled): void | Promise<void>
  /** Composition installs the server-minted assembly after construction. */
  install(assembly: ChildTaskSettleAssembly): void
}

/** Late-binding holder that wires the runner's settle callback to the host projection. */
export function createChildTaskSettleProjector(): ChildTaskSettleProjector {
  let assembly: ChildTaskSettleAssembly | undefined
  return {
    project(settled) {
      const bound = assembly
      const parent = settled.parentSessionId === undefined ? undefined : sessionId(settled.parentSessionId)
      const child = settled.outcome.childSessionId
      if (bound === undefined || parent === undefined || child === undefined) return
      const { outcome } = settled
      // Return the section promise (never its rejection): the runner awaits
      // it before dropping the registry entry, so an emptied running map
      // implies the notification already landed.
      return bound.serialPoint
        .critical(parent, `child-task:${child}`, "child-task", async () => {
          await bound.recorder.created({
            parentSessionId: parent,
            taskId: child,
            title: settled.description,
            prompt: settled.prompt,
            ...(settled.parentRunId === undefined ? {} : { parentRunId: settled.parentRunId }),
          })
          await bound.recorder.started(parent, child, 1)
          if (outcome.finalText !== undefined && outcome.finalText.length > 0) {
            await bound.recorder.output(parent, child, outcome.finalText)
          }
          if (outcome.status === "completed") {
            await bound.recorder.terminal(parent, child, { kind: "completed", runNumber: 1 })
          } else if (outcome.status === "failed") {
            await bound.recorder.terminal(parent, child, { kind: "failed", message: outcome.error ?? "unknown error" })
          } else {
            await bound.recorder.terminal(parent, child, { kind: "cancelled" })
          }
          await bound.notify(
            parent,
            buildChildTaskNotificationText({
              status: outcome.status,
              turns: outcome.turns,
              description: settled.description,
              childSessionId: child,
            }),
          )
        })
        .catch(() => {
          // Best-effort projection (D-E1-4): a dropped append sequence must
          // never resurface inside the runner's settle path.
        })
    },
    install(next) {
      assembly = next
    },
  }
}
