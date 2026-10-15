import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import { DEFAULT_SESSION_PERMISSION_MODE } from "@ag2cli/core/session/session-security.js"
import type { EventStore } from "../../ports/event-store.js"
import type { AgentProfileResolver } from "../../ports/agent-profile.js"
import { commandIdempotencyConflictError, resolveCommandIdempotency, type CommandIdempotencyFamily } from "./command-idempotency.js"
import { appendSessionEventsIfRevision } from "./revision-conflict.js"
import type { SessionAuthority } from "./session-authority.js"

export const AGENT_FAMILY: CommandIdempotencyFamily<string | undefined> = {
  family: "update_agent",
  findAnchor: (events, commandId) => {
    const anchor = events.find(
      (event): event is Extract<AgentEvent, { type: "SessionAgentSelected" }> =>
        event.type === "SessionAgentSelected" && event.trace.traceId === `session-agent:${commandId}`,
    )
    return anchor === undefined ? undefined : { event: anchor, inputFingerprint: anchor.payload.agentName }
  },
}

export interface UpdateSessionAgentInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly agentName?: string
}

export interface UpdateSessionAgentResult {
  readonly changed: boolean
  readonly agentName?: string
}

export interface UpdateSessionAgentDependencies {
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly agents?: AgentProfileResolver
  /** Canonical composition-time workspace used when the first event is created. */
  readonly workspaceRoot?: string
  readonly identity: { nextEventId(): string; now(): string }
  readonly onEventsAppended?: (events: readonly AgentEvent[]) => Promise<void> | void
}

/** Persist the selected main-session agent as canonical session state. */
export class UpdateSessionAgentUseCase {
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly deps: UpdateSessionAgentDependencies) {}

  async execute(input: UpdateSessionAgentInput): Promise<UpdateSessionAgentResult> {
    validateCommandId(input.commandId)
    const name = normalizeName(input.agentName)
    if (name !== undefined) {
      if (this.deps.agents === undefined) throw new Error("The current session agent directory is not configured; cannot switch agents")
      if (!this.deps.agents.resolve(name)) throw new Error(`Unknown agent: ${name}`)
    }
    const key = input.sessionId.toString()
    const previous = this.pending.get(key)
    const operation = (previous ?? Promise.resolve()).then(() => this.executeNow(input, name))
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    )
    this.pending.set(key, tracked)
    try {
      return await operation
    } finally {
      if (this.pending.get(key) === tracked) this.pending.delete(key)
    }
  }

  private async executeNow(input: UpdateSessionAgentInput, agentName: string | undefined): Promise<UpdateSessionAgentResult> {
    const events = await this.deps.eventStore.read(input.sessionId)
    const idempotency = resolveCommandIdempotency(AGENT_FAMILY, events, {
      family: AGENT_FAMILY.family,
      commandId: input.commandId,
      inputFingerprint: agentName,
    })
    if (idempotency.status === "conflict") throw commandIdempotencyConflictError(idempotency.record)
    if (idempotency.status === "replay")
      return {
        changed: true,
        ...(agentName === undefined ? {} : { agentName }),
      }
    if (events.length === 0) {
      // Agent selection is a session preference and is valid before the first
      // model turn. Keep it durable without making the TUI own hidden state.
      if (agentName === undefined) return { changed: false }
      const createdEventId = this.deps.identity.nextEventId()
      const selectedEventId = this.deps.identity.nextEventId()
      const traceId = `session-agent:${input.commandId}`
      const createdEvent: AgentEvent = {
        eventId: createdEventId,
        sessionId: input.sessionId,
        revision: 1,
        type: "SessionCreated",
        timestamp: this.deps.identity.now(),
        trace: { traceId, operationId: traceId },
        payload: {
          workspaceRoot: this.deps.workspaceRoot ?? ".",
          permissionMode: DEFAULT_SESSION_PERMISSION_MODE,
          permissionRules: [],
          policyRevision: 0,
          scopeRevision: 0,
        },
      }
      const selectedEvent: AgentEvent = {
        eventId: selectedEventId,
        sessionId: input.sessionId,
        revision: 2,
        type: "SessionAgentSelected",
        timestamp: this.deps.identity.now(),
        trace: { traceId, operationId: traceId, causationId: createdEventId },
        payload: { agentName },
      }
      const created = [createdEvent, selectedEvent]
      await appendSessionEventsIfRevision({
        eventStore: this.deps.eventStore,
        authority: this.deps.authority,
        sessionId: input.sessionId,
        expectedRevision: events.length,
        events: created,
        onEventsAppended: this.deps.onEventsAppended,
      })
      return { changed: true, agentName }
    }
    const snapshot = replaySession(events)
    if (snapshot.currentRun?.status === "running") throw new Error("The current Session is running; the agent cannot be changed")
    if (snapshot.activeAgent === agentName)
      return {
        changed: false,
        ...(agentName === undefined ? {} : { agentName }),
      }

    const eventId = this.deps.identity.nextEventId()
    const event: AgentEvent = {
      eventId,
      sessionId: input.sessionId,
      revision: events.length + 1,
      type: "SessionAgentSelected",
      timestamp: this.deps.identity.now(),
      trace: {
        traceId: `session-agent:${input.commandId}`,
        operationId: `session-agent:${input.commandId}`,
      },
      payload: agentName === undefined ? {} : { agentName },
    }
    await appendSessionEventsIfRevision({
      eventStore: this.deps.eventStore,
      authority: this.deps.authority,
      sessionId: input.sessionId,
      expectedRevision: events.length,
      events: [event],
      onEventsAppended: this.deps.onEventsAppended,
    })
    return { changed: true, ...(agentName === undefined ? {} : { agentName }) }
  }
}

function validateCommandId(commandId: string): void {
  if (commandId.trim().length === 0) throw new Error("commandId must not be empty")
}

function normalizeName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const name = value.trim()
  if (name.length === 0 || name.length > 128) throw new Error("agent name must be 1 to 128 characters long")
  return name
}
