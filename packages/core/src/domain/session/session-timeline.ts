import type { AgentEvent, HistoryCursor } from "../events/event.js"
import { reduceCanonicalSession, type CanonicalCheckpointState } from "./canonical-session.js"
import { projectActiveSessionEvents } from "./session-projection.js"

export interface SessionCheckpoint {
  readonly checkpointId: string
  readonly kind: "prompt" | "manual"
  /** Physical canonical revision of the active head captured by the checkpoint. */
  readonly headRevision: number
  readonly generation: number
  readonly createdAt: string
  readonly head: HistoryCursor
}

export interface SessionTimelineSnapshot {
  /** Increments after a successful conversation rewind. */
  readonly generation: number
  /** Physical revision of the current active head, not the physical log tail. */
  readonly headRevision: number
  readonly checkpoints: readonly SessionCheckpoint[]
}

/**
 * Project the active logical timeline and checkpoint metadata from a durable
 * canonical prefix. Physical JSONL order is intentionally not the active
 * conversation order after a head move.
 */
export function projectSessionTimeline(events: readonly AgentEvent[]): {
  readonly activeEvents: readonly AgentEvent[]
  readonly snapshot: SessionTimelineSnapshot
} {
  if (events.length === 0) {
    return {
      activeEvents: [],
      snapshot: { generation: 0, headRevision: 0, checkpoints: [] },
    }
  }
  const state = reduceCanonicalSession(events)
  return {
    activeEvents: projectActiveSessionEvents(events),
    snapshot: {
      generation: state.executionGeneration,
      headRevision: state.activeHead?.physicalRevision ?? 0,
      checkpoints: [...state.checkpoints.values()].map(toCheckpoint),
    },
  }
}

function toCheckpoint(checkpoint: CanonicalCheckpointState): SessionCheckpoint {
  return {
    checkpointId: checkpoint.checkpointId,
    kind: checkpoint.kind,
    headRevision: checkpoint.headRevision,
    generation: checkpoint.generation,
    createdAt: checkpoint.createdAt,
    head: checkpoint.head,
  }
}
