import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import type { EventStore } from "../../ports/event-store.js"
import { MAX_CONTEXT_WINDOW_TOKENS } from "@ag2cli/core/model/limits.js"
import { commandIdempotencyConflictError, resolveCommandIdempotency, type CommandIdempotencyFamily } from "./command-idempotency.js"
import { appendSessionEventsIfRevision } from "./revision-conflict.js"
import type { SessionAuthority } from "./session-authority.js"

export const CONTEXT_WINDOW_FAMILY: CommandIdempotencyFamily<ContextWindowUpdate> = {
  family: "set_context_window",
  findAnchor: (events, commandId) => {
    const anchor = events.find(
      (event) =>
        (event.type === "SessionContextWindowSet" || event.type === "SessionContextWindowCleared") &&
        event.trace.traceId === `session-context-window:${commandId}`,
    )
    if (anchor === undefined) return undefined
    const inputFingerprint: ContextWindowUpdate =
      anchor.type === "SessionContextWindowSet" ? { mode: "set", contextWindow: anchor.payload.contextWindow } : { mode: "clear" }
    return { event: anchor, inputFingerprint }
  },
}

export type ContextWindowUpdate = { readonly mode: "set"; readonly contextWindow: number } | { readonly mode: "clear" }

export interface UpdateSessionContextWindowInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly update: ContextWindowUpdate
}

export interface UpdateSessionContextWindowResult {
  readonly changed: boolean
  readonly contextWindowOverride?: number
}

export interface UpdateSessionContextWindowDependencies {
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly identity: {
    nextEventId(): string
    now(): string
  }
  readonly onEventsAppended?: (events: readonly AgentEvent[]) => Promise<void> | void
}

/** Persist a session-scoped context limit without coupling transport clients to event details. */
export class UpdateSessionContextWindowUseCase {
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly deps: UpdateSessionContextWindowDependencies) {}

  async execute(input: UpdateSessionContextWindowInput): Promise<UpdateSessionContextWindowResult> {
    validateCommandId(input.commandId)
    validateUpdate(input.update)
    const previous = this.pending.get(input.sessionId.toString())
    const operation = (previous ?? Promise.resolve()).then(() => this.executeNow(input))
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    )
    this.pending.set(input.sessionId.toString(), tracked)
    try {
      return await operation
    } finally {
      if (this.pending.get(input.sessionId.toString()) === tracked) this.pending.delete(input.sessionId.toString())
    }
  }

  private async executeNow(input: UpdateSessionContextWindowInput): Promise<UpdateSessionContextWindowResult> {
    const events = await this.deps.eventStore.read(input.sessionId)
    if (events.length === 0) {
      throw new Error("The current Session has not been initialized; send a message first")
    }
    const idempotency = resolveCommandIdempotency(CONTEXT_WINDOW_FAMILY, events, {
      family: CONTEXT_WINDOW_FAMILY.family,
      commandId: input.commandId,
      inputFingerprint: input.update,
    })
    if (idempotency.status === "conflict") throw commandIdempotencyConflictError(idempotency.record)
    if (idempotency.status === "replay") {
      const anchor = idempotency.terminal
      if (anchor.type === "SessionContextWindowSet")
        return {
          changed: true,
          contextWindowOverride: anchor.payload.contextWindow,
        }
      return { changed: true }
    }
    const snapshot = replaySession(events)
    if (snapshot.currentRun?.status === "running") {
      throw new Error("The current Session is running; the context window cannot be changed")
    }

    const current = snapshot.contextWindowOverride
    if (input.update.mode === "set") {
      if (current === input.update.contextWindow) return { changed: false, contextWindowOverride: current }
      const event = this.createEvent(
        input.sessionId,
        events.length + 1,
        {
          type: "SessionContextWindowSet",
          payload: { contextWindow: input.update.contextWindow },
        },
        input.commandId,
      )
      await this.append(input.sessionId, events.length, [event])
      return {
        changed: true,
        contextWindowOverride: input.update.contextWindow,
      }
    }

    if (current === undefined) return { changed: false }
    const event = this.createEvent(
      input.sessionId,
      events.length + 1,
      {
        type: "SessionContextWindowCleared",
        payload: {},
      },
      input.commandId,
    )
    await this.append(input.sessionId, events.length, [event])
    return { changed: true }
  }

  private async append(sessionId: SessionId, expectedRevision: number, events: readonly AgentEvent[]): Promise<void> {
    await appendSessionEventsIfRevision({
      eventStore: this.deps.eventStore,
      authority: this.deps.authority,
      sessionId,
      expectedRevision,
      events,
      onEventsAppended: this.deps.onEventsAppended,
    })
  }

  private createEvent(
    sessionId: SessionId,
    revision: number,
    input: {
      readonly type: "SessionContextWindowSet" | "SessionContextWindowCleared"
      readonly payload: { readonly contextWindow: number } | {}
    },
    commandId: string,
  ): AgentEvent {
    const eventId = this.deps.identity.nextEventId()
    const traceId = `session-context-window:${commandId}`
    return {
      eventId,
      sessionId,
      revision,
      type: input.type,
      timestamp: this.deps.identity.now(),
      trace: { traceId, operationId: traceId },
      payload: input.payload,
    } as AgentEvent
  }
}

function validateCommandId(commandId: string): void {
  if (commandId.trim().length === 0) throw new Error("commandId must not be empty")
}

function validateUpdate(update: ContextWindowUpdate): void {
  if (update.mode !== "set") return
  if (!Number.isSafeInteger(update.contextWindow) || update.contextWindow < 1 || update.contextWindow > MAX_CONTEXT_WINDOW_TOKENS) {
    throw new Error(`contextWindow must be an integer between 1 and ${MAX_CONTEXT_WINDOW_TOKENS}`)
  }
}
