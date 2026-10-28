import type { AgentEvent, EventTrace } from "@ag2cli/core/events/event.js"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import { DEFAULT_SESSION_PERMISSION_MODE } from "@ag2cli/core/session/session-security.js"
import type { SessionId, TaskId } from "@ag2cli/core/ids.js"
import type { EventStore } from "../../ports/event-store.js"
import { OrderedLane } from "../../concurrency/ordered-lane.js"
import { MAX_TASK_OUTPUT_BYTES, MAX_TASK_OUTPUT_CHUNK, type BackgroundTaskType, type TaskSnapshot } from "@ag2cli/core/task/task.js"
import {
  commandIdempotencyConflictError,
  resolveCommandIdempotency,
  type CommandIdempotencyFamily,
} from "../session/command-idempotency.js"
import { commitSessionEvents, SessionAuthority } from "../session/session-authority.js"

interface CreateTaskFingerprint {
  readonly type: BackgroundTaskType
  readonly title: string
  readonly prompt?: string
  readonly argv?: readonly string[]
  readonly command?: string
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly intervalMs?: number
  readonly maxRuns?: number
}

export const CREATE_TASK_FAMILY: CommandIdempotencyFamily<CreateTaskFingerprint> = {
  family: "create_task",
  findAnchor: (events, taskId) => {
    const anchor = events.find(
      (event): event is Extract<AgentEvent, { type: "BackgroundTaskCreated" }> =>
        event.type === "BackgroundTaskCreated" && event.payload.task.id === taskId,
    )
    return anchor === undefined
      ? undefined
      : {
          event: anchor,
          inputFingerprint: taskDefinitionFingerprint(anchor.payload.task),
        }
  },
}

export type CreateTaskInput = {
  readonly taskId: TaskId
  readonly type: BackgroundTaskType
  readonly title: string
  readonly workspace?: string
  readonly prompt?: string
  readonly argv?: readonly string[]
  readonly command?: string
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly intervalMs?: number
  readonly maxRuns?: number
  readonly parentRunId?: import("@ag2cli/core/ids.js").RunId
}

export interface TaskRegistryDependencies {
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly identity: {
    nextEventId(): string
    now(): string
  }
  readonly onEventsAppended?: (events: readonly AgentEvent[], replayed: boolean) => Promise<void> | void
}

/**
 * Server-authoritative task state transitions. Execution is deliberately
 * outside this class; this boundary only validates and persists state.
 */
export class BackgroundTaskRegistry {
  private readonly lane = new OrderedLane<string>()
  private readonly authority: SessionAuthority

  constructor(private readonly deps: TaskRegistryDependencies) {
    this.authority = deps.authority ?? new SessionAuthority(deps.eventStore)
  }

  async create(sessionId: SessionId, input: CreateTaskInput): Promise<TaskSnapshot> {
    return this.serial(sessionId, async () => {
      const events = await this.deps.eventStore.read(sessionId)
      const task = createSnapshot(input, this.deps.identity.now())
      const idempotency = resolveCommandIdempotency(CREATE_TASK_FAMILY, events, {
        family: CREATE_TASK_FAMILY.family,
        commandId: input.taskId.toString(),
        inputFingerprint: taskDefinitionFingerprint(task),
      })
      if (idempotency.status === "conflict") throw commandIdempotencyConflictError(idempotency.record)
      if (idempotency.status === "replay") {
        const existing = replaySession(events).tasks?.find((item) => item.id === input.taskId)
        if (existing !== undefined) return existing
        throw new Error(`taskId is recorded but the session has no task projection: ${input.taskId}`)
      }
      const revision = events.length + 1
      const trace = this.trace(input.taskId)
      const created: AgentEvent = this.event(sessionId, revision, "BackgroundTaskCreated", { task }, trace)
      const batch: AgentEvent[] = []
      if (events.length === 0) {
        batch.push(
          this.event(
            sessionId,
            1,
            "SessionCreated",
            {
              workspaceRoot: input.workspace ?? ".",
              permissionMode: DEFAULT_SESSION_PERMISSION_MODE,
              permissionRules: [],
              policyRevision: 0,
              scopeRevision: 0,
            },
            trace,
          ),
        )
        batch.push({ ...created, revision: 2 })
      } else {
        batch.push(created)
      }
      await this.append(batch)
      return task
    })
  }

  async list(sessionId: SessionId): Promise<readonly TaskSnapshot[]> {
    const events = await this.deps.eventStore.read(sessionId)
    return events.length === 0 ? [] : (replaySession(events).tasks ?? [])
  }

  async revision(sessionId: SessionId): Promise<number> {
    const events = await this.deps.eventStore.read(sessionId)
    return events.at(-1)?.revision ?? 0
  }

  async get(sessionId: SessionId, id: TaskId): Promise<TaskSnapshot | undefined> {
    return (await this.list(sessionId)).find((task) => task.id === id)
  }

  async start(sessionId: SessionId, id: TaskId, runNumber: number): Promise<TaskSnapshot> {
    return this.transition(sessionId, id, (snapshot, events) => {
      const task = requireTask(snapshot, id)
      if (task.status !== "queued") throw new Error(`background task cannot start: ${id}`)
      if (!Number.isSafeInteger(runNumber) || runNumber < 1 || runNumber !== task.runCount + 1) {
        throw new Error(`background task runNumber is not sequential: ${id}`)
      }
      return {
        type: "BackgroundTaskStarted",
        payload: { taskId: id, runNumber },
        nextRevision: events.length + 1,
      }
    })
  }

  async appendOutput(sessionId: SessionId, id: TaskId, chunk: string): Promise<TaskSnapshot> {
    if (chunk.length === 0) return this.require(sessionId, id)
    return this.transition(sessionId, id, (snapshot, events) => {
      const task = requireTask(snapshot, id)
      if (task.status !== "running") throw new Error(`background task is not running: ${id}`)
      const remaining = MAX_TASK_OUTPUT_BYTES - task.outputBytes
      const bounded = truncateUtf8(chunk, Math.min(MAX_TASK_OUTPUT_CHUNK, remaining))
      if (bounded.length === 0) return undefined
      const previous = [...events].reverse().find((event) => event.type === "BackgroundTaskOutputAppended" && event.payload.taskId === id)
      const sequence = previous?.type === "BackgroundTaskOutputAppended" ? previous.payload.sequence + 1 : 1
      return {
        type: "BackgroundTaskOutputAppended",
        payload: {
          taskId: id,
          sequence,
          chunk: bounded,
          totalBytes: task.outputBytes + utf8ByteLength(bounded),
        },
        nextRevision: events.length + 1,
      }
    })
  }

  async complete(sessionId: SessionId, id: TaskId, runNumber: number, nextRunAt?: string): Promise<TaskSnapshot> {
    return this.transition(sessionId, id, (snapshot, events) => {
      const task = requireTask(snapshot, id)
      if (task.status !== "running") throw new Error(`background task is not running: ${id}`)
      if (task.runCount !== runNumber) throw new Error(`background task runNumber mismatch: ${id}`)
      return {
        type: "BackgroundTaskCompleted",
        payload: {
          taskId: id,
          runNumber,
          ...(nextRunAt === undefined ? {} : { nextRunAt }),
        },
        nextRevision: events.length + 1,
      }
    })
  }

  async fail(sessionId: SessionId, id: TaskId, message: string): Promise<TaskSnapshot> {
    return this.transition(sessionId, id, (snapshot, events) => {
      const task = requireTask(snapshot, id)
      if (task.status !== "running" && task.status !== "queued") throw new Error(`background task already finished: ${id}`)
      return {
        type: "BackgroundTaskFailed",
        payload: { taskId: id, message },
        nextRevision: events.length + 1,
      }
    })
  }

  async cancel(sessionId: SessionId, id: TaskId, reason?: string): Promise<TaskSnapshot> {
    return this.transition(sessionId, id, (snapshot, events) => {
      const task = requireTask(snapshot, id)
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return undefined
      return {
        type: "BackgroundTaskCancelled",
        payload: { taskId: id, ...(reason === undefined ? {} : { reason }) },
        nextRevision: events.length + 1,
      }
    })
  }

  private async require(sessionId: SessionId, id: TaskId): Promise<TaskSnapshot> {
    const task = await this.get(sessionId, id)
    if (!task) throw new Error(`background task not found: ${id}`)
    return task
  }

  private async transition(
    sessionId: SessionId,
    taskId: TaskId,
    build: (
      snapshot: ReturnType<typeof replaySession>,
      events: readonly AgentEvent[],
    ) =>
      | {
          readonly type: Extract<AgentEvent, { type: `BackgroundTask${string}` }>["type"]
          readonly payload: unknown
          readonly nextRevision: number
        }
      | undefined,
  ): Promise<TaskSnapshot> {
    return this.serial(sessionId, async () => {
      const events = await this.deps.eventStore.read(sessionId)
      if (events.length === 0) throw new Error(`session not found: ${sessionId}`)
      const snapshot = replaySession(events)
      const transition = build(snapshot, events)
      if (!transition) return requireTask(snapshot, taskId)
      const event = this.event(
        sessionId,
        transition.nextRevision,
        transition.type as AgentEvent["type"],
        transition.payload as never,
        this.trace(sessionId),
      )
      await this.append([event])
      const next = replaySession([...events, event])
      return (
        next.currentTask ??
        (() => {
          throw new Error("currentTask missing after task status update")
        })()
      )
    })
  }

  private serial<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    return this.lane.run(sessionId, operation)
  }

  private async append(events: readonly AgentEvent[]): Promise<void> {
    await commitSessionEvents({
      authority: this.authority,
      events,
      onCommitted: this.deps.onEventsAppended,
    })
  }

  private event<T extends AgentEvent["type"]>(
    sessionId: SessionId,
    revision: number,
    type: T,
    payload: Extract<AgentEvent, { type: T }>["payload"],
    trace: EventTrace,
  ): Extract<AgentEvent, { type: T }> {
    return {
      eventId: this.deps.identity.nextEventId(),
      sessionId,
      revision,
      type,
      timestamp: this.deps.identity.now(),
      trace,
      payload,
    } as Extract<AgentEvent, { type: T }>
  }

  private trace(causationId: string): EventTrace {
    return {
      traceId: `task:${causationId}`,
      operationId: `task:${causationId}`,
      causationId,
    }
  }
}

function createSnapshot(input: CreateTaskInput, createdAt: string): TaskSnapshot {
  if (input.title.trim().length === 0) throw new Error("task.title must not be empty")
  if (input.type === "agent" || input.type === "loop") {
    if (!input.prompt || input.prompt.trim().length === 0) throw new Error("agent/loop task.prompt must not be empty")
  }
  if (input.type === "shell" && (!input.argv || input.argv.length === 0)) throw new Error("shell task.argv must not be empty")
  if (input.type === "user_shell" && (!input.command || input.command.trim().length === 0)) {
    throw new Error("user_shell task.command must not be empty")
  }
  if (input.type === "loop" && input.intervalMs === undefined) throw new Error("loop task.intervalMs must not be empty")
  return {
    id: input.taskId,
    type: input.type,
    title: input.title.trim(),
    status: "queued",
    createdAt,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.argv ? { argv: [...input.argv] } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    ...(input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns }),
    runCount: 0,
    outputBytes: 0,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
  }
}

function requireTask(snapshot: ReturnType<typeof replaySession>, id: TaskId): TaskSnapshot {
  const task = snapshot.tasks?.find((item) => item.id === id)
  if (!task) throw new Error(`background task not found: ${id}`)
  return task
}

function taskDefinitionFingerprint(task: TaskSnapshot): CreateTaskFingerprint {
  return {
    type: task.type,
    title: task.title,
    ...(task.prompt === undefined ? {} : { prompt: task.prompt }),
    ...(task.argv === undefined ? {} : { argv: [...task.argv] }),
    ...(task.command === undefined ? {} : { command: task.command }),
    ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
    ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
    ...(task.intervalMs === undefined ? {} : { intervalMs: task.intervalMs }),
    ...(task.maxRuns === undefined ? {} : { maxRuns: task.maxRuns }),
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && utf8ByteLength(value.slice(0, end)) > maxBytes) end--
  return value.slice(0, end)
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
