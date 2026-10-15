import type { AgentEvent, EventTrace, HistoryCursor } from "@ag2cli/core/events/event.js"
import { isHistoryAncestor, reduceCanonicalSession, sameHistoryCursor } from "@ag2cli/core/session/canonical-session.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import { projectSessionTimeline, type SessionCheckpoint } from "@ag2cli/core/session/session-timeline.js"
import { replaySession, type SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import type { EventStore } from "../../ports/event-store.js"
import type { SessionExecutionReservation } from "../../ports/session-execution-reservation.js"
import { commitSessionEvents, SessionAuthority } from "./session-authority.js"

export interface RewindSessionIdentity {
  nextEventId(): string
  now(): string
}

export interface RewindSessionDependencies {
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly identity: RewindSessionIdentity
  readonly executionReservation?: SessionExecutionReservation
  readonly reservationOwnerId?: string
  readonly onEventsAppended?: (events: readonly AgentEvent[]) => Promise<void> | void
}

export interface ListCheckpointsInput {
  readonly sessionId: SessionId
}

export interface RewindPreviewInput {
  readonly sessionId: SessionId
  readonly checkpointId: string
  readonly expectedRevision?: number
  readonly signal?: AbortSignal
}

export interface RewindPreview {
  readonly checkpoint: SessionCheckpoint
  readonly currentRevision: number
  readonly currentGeneration: number
  readonly staleRevision: boolean
  readonly canCommit: boolean
}

export interface RewindSessionInput extends RewindPreviewInput {
  readonly rewindId: string
  readonly trace?: EventTrace
}

export type RewindSessionResult = {
  readonly status: "rewound" | "already_rewound"
  readonly rewindId: string
  readonly snapshot: SessionSnapshot
}

/** Rewind atomically appends BranchCreated and HeadMoved to update the active history head. */
export class RewindSessionUseCase {
  private readonly authority: SessionAuthority

  constructor(private readonly deps: RewindSessionDependencies) {
    this.authority = deps.authority ?? new SessionAuthority(deps.eventStore)
  }

  async listCheckpoints(input: ListCheckpointsInput): Promise<readonly SessionCheckpoint[]> {
    const events = await this.deps.eventStore.read(input.sessionId)
    return checkpointsForEvents(events)
  }

  async recover(_sessionId: SessionId): Promise<void> {
    // The canonical rewind transition has no separate recovery state.
  }

  async preview(input: RewindPreviewInput): Promise<RewindPreview> {
    throwIfAborted(input.signal)
    const events = await this.deps.eventStore.read(input.sessionId)
    const timeline = projectSessionTimeline(events)
    const checkpoint = requireCheckpoint(checkpointsForEvents(events), input.checkpointId)
    const currentRevision = events.at(-1)?.revision ?? 0
    const staleRevision = input.expectedRevision !== undefined && input.expectedRevision !== currentRevision
    return {
      checkpoint,
      currentRevision,
      currentGeneration: timeline.snapshot.generation,
      staleRevision,
      canCommit: !staleRevision,
    }
  }

  async execute(input: RewindSessionInput): Promise<RewindSessionResult> {
    throwIfAborted(input.signal)
    if (input.rewindId.trim().length === 0) throw new Error("rewindId must not be empty")
    if (this.deps.executionReservation === undefined) return this.executeNow(input)
    const existing = await this.deps.eventStore.read(input.sessionId)
    const lease = await this.deps.executionReservation.acquire({
      sessionId: input.sessionId,
      commandId: `rewind:${input.rewindId}`,
      ownerId: this.deps.reservationOwnerId ?? `pid-${process.pid}`,
      baseRevision: existing.length,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    try {
      return await this.executeNow(input)
    } finally {
      await lease.release(input.signal?.aborted ? "aborted" : "released").catch(() => {})
    }
  }

  private async executeNow(input: RewindSessionInput): Promise<RewindSessionResult> {
    const events = await this.deps.eventStore.read(input.sessionId)
    const commandId = `rewind:${input.rewindId}`
    const checkpoint = requireCheckpoint(checkpointsForEvents(events), input.checkpointId)
    const existing = [...events]
      .reverse()
      .find(
        (event): event is Extract<AgentEvent, { type: "HeadMoved" }> => event.type === "HeadMoved" && event.payload.commandId === commandId,
      )
    if (existing !== undefined) {
      if (!sameHistoryCursor(existing.payload.to, checkpoint.head)) {
        throw new Error(`rewindId was already used for a different checkpoint: ${input.rewindId}`)
      }
      return {
        status: "already_rewound",
        rewindId: input.rewindId,
        snapshot: replaySession(events),
      }
    }
    const currentRevision = events.at(-1)?.revision ?? 0
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      throw new Error(`stale_revision: expected ${input.expectedRevision}, received ${currentRevision}`)
    }
    const state = reduceCanonicalSession(events)
    const currentHead = state.activeHead
    if (currentHead === undefined) throw new Error("Session has no active history head")
    if (!isHistoryAncestor(state, currentHead, checkpoint.head)) {
      throw new Error(`rewind target is not an active-head ancestor: ${input.checkpointId}`)
    }
    const branchId = commandId
    if (state.branches.has(branchId)) throw new Error(`rewind branch identity reused: ${branchId}`)
    const trace = createTrace(input, events)
    const branchEventId = this.deps.identity.nextEventId()
    const head: HistoryCursor = {
      sessionId: input.sessionId,
      branchId,
      nodeId: `head:${input.rewindId}`,
      physicalRevision: currentRevision + 1,
      recordHash: branchEventId,
    }
    const branchEvent = makeEventWithId(
      branchEventId,
      this.deps.identity,
      input.sessionId,
      currentRevision + 1,
      "BranchCreated",
      {
        commandId,
        branchId,
        parentBranchId: currentHead.branchId,
        parentCursor: checkpoint.head,
        head,
      },
      trace,
    )
    const movedEvent = makeEvent(
      this.deps.identity,
      input.sessionId,
      currentRevision + 2,
      "HeadMoved",
      {
        commandId,
        from: currentHead,
        to: checkpoint.head,
        branchId,
        head,
        executionGeneration: state.executionGeneration + 1,
      },
      trace,
    )
    await commitSessionEvents({
      authority: this.authority,
      events: [branchEvent, movedEvent],
      expectedRevision: currentRevision,
      transitionId: commandId,
      onCommitted: this.deps.onEventsAppended,
    })
    return {
      status: "rewound",
      rewindId: input.rewindId,
      snapshot: replaySession(await this.deps.eventStore.read(input.sessionId)),
    }
  }
}

function requireCheckpoint(checkpoints: readonly SessionCheckpoint[], checkpointId: string): SessionCheckpoint {
  const checkpoint = checkpoints.find((candidate) => candidate.checkpointId === checkpointId)
  if (!checkpoint) throw new Error(`Checkpoint not found: ${checkpointId}`)
  return checkpoint
}

/**
 * Older sessions may predate durable prompt checkpoints. Their consumed
 * message inputs still record the exact parent cursor, so expose a stable
 * derived checkpoint for those prompts without rewriting their event log.
 */
function checkpointsForEvents(events: readonly AgentEvent[]): readonly SessionCheckpoint[] {
  const checkpoints = [...projectSessionTimeline(events).snapshot.checkpoints]
  const promptCheckpoints = checkpoints.filter((checkpoint) => checkpoint.kind === "prompt")
  for (const event of events) {
    if (event.type !== "InputConsumed" || event.payload.kind !== "message") continue
    if (promptCheckpoints.some((checkpoint) => sameHistoryCursor(checkpoint.head, event.payload.parent))) continue
    const checkpointId = `legacy-prompt:${event.payload.inputId}`
    if (checkpoints.some((checkpoint) => checkpoint.checkpointId === checkpointId)) continue
    checkpoints.push({
      checkpointId,
      kind: "prompt",
      headRevision: event.payload.parent.physicalRevision,
      generation: event.payload.executionGeneration,
      createdAt: event.timestamp,
      head: event.payload.parent,
    })
  }
  return checkpoints
}

function createTrace(input: RewindSessionInput, events: readonly AgentEvent[]): TraceCursor {
  return {
    traceId: input.trace?.traceId ?? input.rewindId,
    operationId: input.trace?.operationId ?? input.rewindId,
    causationId: input.trace?.causationId ?? events.at(-1)?.eventId,
  }
}

interface TraceCursor {
  readonly traceId: string
  readonly operationId: string
  causationId?: string
}

function makeEvent<TType extends AgentEvent["type"]>(
  identity: RewindSessionIdentity,
  sessionId: SessionId,
  revision: number,
  type: TType,
  payload: Extract<AgentEvent, { type: TType }>["payload"],
  trace: TraceCursor,
): Extract<AgentEvent, { type: TType }> {
  const eventId = identity.nextEventId()
  const event = {
    eventId,
    sessionId,
    revision,
    timestamp: identity.now(),
    trace: {
      traceId: trace.traceId,
      operationId: trace.operationId,
      ...(trace.causationId === undefined ? {} : { causationId: trace.causationId }),
    },
    type,
    payload,
  } as Extract<AgentEvent, { type: TType }>
  trace.causationId = eventId
  return event
}

function makeEventWithId<TType extends AgentEvent["type"]>(
  eventId: string,
  identity: RewindSessionIdentity,
  sessionId: SessionId,
  revision: number,
  type: TType,
  payload: Extract<AgentEvent, { type: TType }>["payload"],
  trace: TraceCursor,
): Extract<AgentEvent, { type: TType }> {
  const event = {
    eventId,
    sessionId,
    revision,
    timestamp: identity.now(),
    trace: {
      traceId: trace.traceId,
      operationId: trace.operationId,
      ...(trace.causationId === undefined ? {} : { causationId: trace.causationId }),
    },
    type,
    payload,
  } as Extract<AgentEvent, { type: TType }>
  trace.causationId = eventId
  return event
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException("rewind cancelled", "AbortError")
}
