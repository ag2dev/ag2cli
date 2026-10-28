import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { ContentBlock } from "@ag2cli/core/message.js"
import { projectActiveSessionEvents } from "@ag2cli/core/session/session-projection.js"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import type { BackgroundTaskType } from "@ag2cli/core/task/task.js"

export type SessionViewEvent =
  | {
      readonly type: "input_queued"
      readonly eventId: string
      readonly revision: number
      readonly timestamp: string
      readonly inputId: string
      readonly commandId: string
      readonly kind: "message" | "steer" | "notification"
      readonly text: string
      readonly delivery: "fifo" | "safe-boundary"
      readonly targetRunId?: string
    }
  | {
      readonly type: "input_cancelled"
      readonly eventId: string
      readonly revision: number
      readonly timestamp: string
      readonly inputId: string
      readonly commandId: string
      readonly text?: string
      readonly reason?: string
    }
  | {
      readonly type: "input"
      readonly eventId: string
      readonly revision: number
      readonly timestamp: string
      readonly inputId: string
      readonly commandId: string
      /** Input class at consumption: notifications render as status, not user rows. */
      readonly kind: "message" | "steer" | "notification"
      readonly text: string
      readonly delivery: "fifo" | "safe-boundary"
      readonly runId?: string
    }
  | {
      readonly type: "run_started"
      readonly eventId: string
      readonly revision: number
      readonly runId: string
      readonly goal: string
      readonly timestamp: string
    }
  | {
      readonly type: "assistant"
      readonly eventId: string
      readonly revision: number
      readonly runId: string
      readonly turn: number
      readonly content: readonly ContentBlock[]
      readonly timestamp: string
      readonly durationMs?: number
      readonly metadata?: Record<string, unknown>
    }
  | {
      readonly type: "tool_result"
      readonly eventId: string
      readonly revision: number
      readonly runId: string
      readonly turn: number
      readonly toolUseId: string
      readonly result: ToolResult
      readonly timestamp: string
    }
  | {
      readonly type: "run_terminal"
      readonly eventId: string
      readonly revision: number
      readonly runId: string
      readonly status: "completed" | "failed" | "cancelled"
      readonly turns: number
      readonly timestamp: string
      readonly text?: string
      readonly reason?: string
      readonly error?: string
      readonly failureCode?: "approval_required" | "interaction_expired"
    }
  | {
      readonly type: "history_reset"
      readonly eventId: string
      readonly revision: number
      readonly timestamp: string
      readonly events: readonly SessionViewEvent[]
    }
  | {
      /** Durable task record opened (agent children and any future task family). */
      readonly type: "background_task_created"
      readonly eventId: string
      readonly revision: number
      readonly timestamp: string
      readonly taskId: string
      readonly taskType: BackgroundTaskType
      readonly title: string
    }
  | {
      /** Durable task terminal; the type comes from the seen creation fact. */
      readonly type: "background_task_terminal"
      readonly eventId: string
      readonly revision: number
      readonly timestamp: string
      readonly taskId: string
      readonly taskType: BackgroundTaskType | undefined
      readonly status: "completed" | "failed" | "cancelled"
      readonly message?: string
      readonly reason?: string
    }

/**
 * Transport-neutral semantic view of canonical session facts.
 *
 * The view owns active-history replacement. Consumers never need to know that
 * a rewind is represented by a physical BranchCreated/HeadMoved pair.
 */
export interface SessionView {
  apply(event: AgentEvent): readonly SessionViewEvent[]
  reset(): void
}

interface InputState {
  readonly commandId: string
  readonly kind: "message" | "steer" | "notification"
  readonly text: string
  readonly delivery: "fifo" | "safe-boundary"
  status: "pending" | "consumed" | "cancelled"
  readonly targetRunId?: string
}

interface ViewState {
  readonly history: AgentEvent[]
  inputs: Map<string, InputState>
  tasks: Map<string, BackgroundTaskType>
}

export function createSessionView(): SessionView {
  const state: ViewState = { history: [], inputs: new Map(), tasks: new Map() }

  const project = (event: AgentEvent): readonly SessionViewEvent[] => {
    switch (event.type) {
      case "InputAccepted": {
        const input: InputState = {
          commandId: event.payload.commandId,
          kind: event.payload.kind,
          text: event.payload.text,
          delivery: event.payload.delivery,
          status: "pending",
          ...(event.payload.targetRunId === undefined ? {} : { targetRunId: String(event.payload.targetRunId) }),
        }
        state.inputs.set(event.payload.inputId, input)
        // Steer inputs target a running loop; everything else starts a run and
        // is observed through run lifecycle, not as a queued input.
        if (event.payload.targetRunId === undefined && event.payload.kind !== "steer") return []
        return [
          {
            type: "input_queued",
            eventId: event.eventId,
            revision: event.revision,
            timestamp: event.timestamp,
            inputId: event.payload.inputId,
            commandId: event.payload.commandId,
            kind: event.payload.kind,
            text: event.payload.text,
            delivery: event.payload.delivery,
            ...(event.payload.targetRunId === undefined ? {} : { targetRunId: String(event.payload.targetRunId) }),
          },
        ]
      }
      case "InputCancellationRequested": {
        const input = state.inputs.get(event.payload.inputId)
        if (input === undefined || input.status !== "pending") return []
        input.status = "cancelled"
        return [
          {
            type: "input_cancelled",
            eventId: event.eventId,
            revision: event.revision,
            timestamp: event.timestamp,
            inputId: event.payload.inputId,
            commandId: event.payload.commandId,
            text: input.text,
            ...(event.payload.reason === undefined ? {} : { reason: event.payload.reason }),
          },
        ]
      }
      case "InputConsumed": {
        const input = state.inputs.get(event.payload.inputId)
        if (input !== undefined) input.status = "consumed"
        return [
          {
            type: "input",
            eventId: event.eventId,
            revision: event.revision,
            timestamp: event.timestamp,
            inputId: event.payload.inputId,
            commandId: event.payload.commandId,
            kind: event.payload.kind,
            text: event.payload.text,
            delivery: event.payload.delivery,
            runId: String(event.payload.runId),
          },
        ]
      }
      case "RunStarted":
        return [
          {
            type: "run_started",
            eventId: event.eventId,
            revision: event.revision,
            runId: String(event.payload.runId),
            goal: event.payload.goal,
            timestamp: event.timestamp,
          },
        ]
      case "ModelResponseCommitted":
        return [
          {
            type: "assistant",
            eventId: event.eventId,
            revision: event.revision,
            runId: String(event.payload.runId),
            turn: event.payload.turn,
            content: event.payload.content,
            timestamp: event.timestamp,
            ...(event.payload.durationMs === undefined ? {} : { durationMs: event.payload.durationMs }),
            ...(event.payload.metadata === undefined
              ? {}
              : {
                  metadata: event.payload.metadata as unknown as Record<string, unknown>,
                }),
          },
        ]
      case "ToolResultCommitted":
        return [
          {
            type: "tool_result",
            eventId: event.eventId,
            revision: event.revision,
            runId: String(event.payload.runId),
            turn: event.payload.turn,
            toolUseId: event.payload.toolUseId,
            result: event.payload.result,
            timestamp: event.timestamp,
          },
        ]
      case "RunCompleted":
        return [
          {
            type: "run_terminal",
            eventId: event.eventId,
            revision: event.revision,
            runId: String(event.payload.runId),
            status: "completed",
            turns: event.payload.turns,
            timestamp: event.timestamp,
            text: event.payload.finalText,
          },
        ]
      case "RunFailed":
        return [
          {
            type: "run_terminal",
            eventId: event.eventId,
            revision: event.revision,
            runId: String(event.payload.runId),
            status: "failed",
            turns: event.payload.turns,
            timestamp: event.timestamp,
            error: event.payload.message,
            ...(event.payload.code === undefined ? {} : { failureCode: event.payload.code }),
          },
        ]
      case "RunCancelled":
        return [
          {
            type: "run_terminal",
            eventId: event.eventId,
            revision: event.revision,
            runId: String(event.payload.runId),
            status: "cancelled",
            turns: event.payload.turns,
            timestamp: event.timestamp,
            reason: event.payload.reason,
          },
        ]
      case "BackgroundTaskCreated":
        state.tasks.set(String(event.payload.task.id), event.payload.task.type)
        return [
          {
            type: "background_task_created",
            eventId: event.eventId,
            revision: event.revision,
            timestamp: event.timestamp,
            taskId: String(event.payload.task.id),
            taskType: event.payload.task.type,
            title: event.payload.task.title,
          },
        ]
      case "BackgroundTaskCompleted":
        return [
          {
            type: "background_task_terminal",
            eventId: event.eventId,
            revision: event.revision,
            timestamp: event.timestamp,
            taskId: String(event.payload.taskId),
            taskType: state.tasks.get(String(event.payload.taskId)),
            status: "completed",
          },
        ]
      case "BackgroundTaskFailed":
        return [
          {
            type: "background_task_terminal",
            eventId: event.eventId,
            revision: event.revision,
            timestamp: event.timestamp,
            taskId: String(event.payload.taskId),
            taskType: state.tasks.get(String(event.payload.taskId)),
            status: "failed",
            message: event.payload.message,
          },
        ]
      case "BackgroundTaskCancelled":
        return [
          {
            type: "background_task_terminal",
            eventId: event.eventId,
            revision: event.revision,
            timestamp: event.timestamp,
            taskId: String(event.payload.taskId),
            taskType: state.tasks.get(String(event.payload.taskId)),
            status: "cancelled",
            ...(event.payload.reason === undefined ? {} : { reason: event.payload.reason }),
          },
        ]
      default:
        return []
    }
  }

  return {
    apply(event) {
      state.history.push(event)
      if (event.type !== "HeadMoved") return project(event)

      const activeEvents = projectActiveSessionEvents(state.history)
      const rebuilt: ViewState = { history: [], inputs: new Map(), tasks: new Map() }
      const projected = activeEvents.flatMap((active) => {
        rebuilt.history.push(active)
        return projectWithState(rebuilt, active)
      })
      state.inputs.clear()
      for (const [inputId, input] of rebuilt.inputs) state.inputs.set(inputId, input)
      state.tasks.clear()
      for (const [taskId, taskType] of rebuilt.tasks) state.tasks.set(taskId, taskType)
      return [
        {
          type: "history_reset",
          eventId: event.eventId,
          revision: event.revision,
          timestamp: event.timestamp,
          events: projected,
        },
      ]
    },
    reset() {
      state.history.length = 0
      state.inputs.clear()
      state.tasks.clear()
    },
  }

  function projectWithState(target: ViewState, event: AgentEvent): readonly SessionViewEvent[] {
    const previousInputs = state.inputs
    const previousTasks = state.tasks
    state.inputs = target.inputs
    state.tasks = target.tasks
    const result = project(event)
    state.inputs = previousInputs
    state.tasks = previousTasks
    return result
  }
}
