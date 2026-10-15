import { BackgroundTaskRegistry } from "./task-registry.js"
import type { SessionId, TaskId } from "@ag2cli/core/ids.js"
import type { TaskSnapshot } from "@ag2cli/core/task/task.js"
import type { BackgroundTaskExecutor } from "../../ports/background-task-executor.js"
import type { SessionExecutionReservation } from "../../ports/session-execution-reservation.js"
import { SessionExecutionReservationConflictError } from "../../ports/session-execution-reservation.js"
import { BackgroundTaskScheduler } from "./task-scheduler.js"

/** Coordinates task lifecycle and execution without owning persistence. */
export class BackgroundTaskManager {
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly registry: BackgroundTaskRegistry,
    private readonly executor?: BackgroundTaskExecutor,
    private readonly scheduler = new BackgroundTaskScheduler(),
    private readonly coordination?: {
      readonly executionReservation?: SessionExecutionReservation
      readonly reservationOwnerId?: string
    },
  ) {}

  async create(sessionId: SessionId, input: Parameters<BackgroundTaskRegistry["create"]>[1]): Promise<TaskSnapshot> {
    // Background execution is unavailable in this assembly; creating a task
    // that could never run must fail closed instead of queueing silently.
    if (this.executor === undefined) throw new Error("Background task execution is unavailable")
    const task = await this.registry.create(sessionId, input)
    if (this.executor && task.type === "loop") {
      this.scheduleLoop(sessionId, task)
    } else if (this.executor) {
      this.launch(sessionId, task)
    }
    return task
  }

  async list(sessionId: SessionId): Promise<readonly TaskSnapshot[]> {
    await this.recoverOrphaned(sessionId)
    const tasks = await this.registry.list(sessionId)
    if (this.executor) {
      for (const task of tasks) {
        if (task.status !== "queued") continue
        if (task.type === "loop" && task.nextRunAt) this.scheduleLoop(sessionId, task)
        else if (task.type !== "loop") this.launch(sessionId, task)
      }
    }
    return tasks
  }

  get(sessionId: SessionId, taskId: TaskId): Promise<TaskSnapshot | undefined> {
    return this.registry.get(sessionId, taskId)
  }

  async cancel(sessionId: SessionId, taskId: TaskId, reason = "\u7528\u6237\u53d6\u6d88"): Promise<TaskSnapshot> {
    this.controllers.get(key(sessionId, taskId))?.abort(reason)
    this.scheduler.cancel(key(sessionId, taskId))
    return this.registry.cancel(sessionId, taskId, reason)
  }

  close(): void {
    for (const controller of this.controllers.values()) controller.abort("server closed")
    this.controllers.clear()
    this.scheduler.close()
  }

  private launch(sessionId: SessionId, task: TaskSnapshot): void {
    const taskKey = key(sessionId, task.id)
    if (this.controllers.has(taskKey)) return
    const controller = new AbortController()
    this.controllers.set(taskKey, controller)
    void this.run(sessionId, task, controller, taskKey)
  }

  private scheduleLoop(sessionId: SessionId, task: TaskSnapshot): void {
    const runAt = task.nextRunAt ?? this.scheduler.nextRunAt(task.intervalMs!)
    this.scheduler.schedule(key(sessionId, task.id), runAt, () => this.launch(sessionId, task))
  }

  private async run(sessionId: SessionId, task: TaskSnapshot, controller: AbortController, taskKey: string): Promise<void> {
    let reservation: Awaited<ReturnType<SessionExecutionReservation["acquire"]>> | undefined
    let executionStarted = false
    let executionCompleted = false
    try {
      const current = await this.registry.get(sessionId, task.id)
      if (!current || current.status !== "queued") return
      const runNumber = current.runCount + 1
      if (this.coordination?.executionReservation !== undefined) {
        try {
          reservation = await this.coordination.executionReservation.acquire({
            sessionId,
            commandId: `task:${task.id}:run:${runNumber}`,
            ownerId: this.coordination.reservationOwnerId ?? `pid-${process.pid}`,
            baseRevision: await this.registry.revision(sessionId),
          })
        } catch (error) {
          if (error instanceof SessionExecutionReservationConflictError) return
          throw error
        }
      }
      const started = await this.registry.start(sessionId, task.id, runNumber)
      executionStarted = true
      const result = await this.executor!.execute({
        sessionId,
        task: started,
        runNumber,
        signal: controller.signal,
        onOutput: (text) => this.registry.appendOutput(sessionId, task.id, text).then(() => undefined),
      })
      if (result.output) await this.registry.appendOutput(sessionId, task.id, result.output)
      const after = await this.registry.get(sessionId, task.id)
      if (after?.status === "cancelled") return
      const nextRunAt =
        task.type === "loop" && (task.maxRuns === undefined || runNumber < task.maxRuns)
          ? this.scheduler.nextRunAt(task.intervalMs!)
          : undefined
      const completed = await this.registry.complete(sessionId, task.id, runNumber, nextRunAt)
      executionCompleted = true
      if (completed.status === "queued" && completed.nextRunAt) this.scheduleLoop(sessionId, completed)
    } catch (error) {
      const current = await this.registry.get(sessionId, task.id).catch(() => undefined)
      if (current?.status === "cancelled") return
      const message = error instanceof Error ? error.message : String(error)
      await this.registry.fail(sessionId, task.id, message).catch(() => undefined)
    } finally {
      const releaseStatus = controller.signal.aborted ? "aborted" : "released"
      await reservation?.release(releaseStatus).catch(() => undefined)
      if (this.controllers.get(taskKey) === controller) this.controllers.delete(taskKey)
    }
  }

  /**
   * A hard process loss cannot safely replay a task whose external side effect
   * may have happened. Recover only tasks with no live in-process controller
   * and no competing cross-process reservation, then make the result visible
   * as failed so the user can explicitly recreate it.
   */
  private async recoverOrphaned(sessionId: SessionId): Promise<void> {
    const tasks = await this.registry.list(sessionId)
    for (const task of tasks) {
      if (task.status !== "running" || this.controllers.has(key(sessionId, task.id))) continue
      let reservation: Awaited<ReturnType<SessionExecutionReservation["acquire"]>> | undefined
      try {
        if (this.coordination?.executionReservation !== undefined) {
          try {
            reservation = await this.coordination.executionReservation.acquire({
              sessionId,
              commandId: `task:${task.id}:run:${task.runCount}`,
              ownerId: this.coordination.reservationOwnerId ?? `pid-${process.pid}`,
              baseRevision: await this.registry.revision(sessionId),
            })
          } catch (error) {
            if (error instanceof SessionExecutionReservationConflictError) continue
            throw error
          }
        }
        await this.registry.fail(
          sessionId,
          task.id,
          "The background task owner exited; the task was not retried to avoid repeating side effects.",
        )
      } finally {
        await reservation?.release("released").catch(() => undefined)
      }
    }
  }
}

function key(sessionId: SessionId, taskId: TaskId): string {
  return `${sessionId}:${taskId}`
}
