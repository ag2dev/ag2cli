import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import { sessionId, type SessionId } from "@ag2cli/core/ids.js"
import type { SessionCommand, SessionCommandResult } from "@ag2cli/protocol/session-command.js"

export interface SessionEventListener {
  (events: readonly AgentEvent[]): void
}

export interface SessionTransientEventListener {
  (event: TransientStreamEvent): void
}

export interface SessionExecuteOptions {
  readonly signal?: AbortSignal
  /** Optional transport hook invoked once a remote command is accepted. */
  readonly onAccepted?: () => void
  /** Internal host admission mode: durably accept an input without waiting for execution. */
  readonly acceptOnly?: boolean
}

export interface SessionSubscriptionOverflow {
  readonly channel: "durable"
  readonly sessionId: SessionId
  readonly cursor: number
  readonly queued: number
}

export interface SessionSubscriptionOptions {
  readonly maxQueueSize?: number
  readonly onOverflow?: (overflow: SessionSubscriptionOverflow) => void
}

/** Transport boundary implemented by local or remote Host adapters. */
export interface SessionTransport {
  execute(sessionId: SessionId, command: SessionCommand, options?: SessionExecuteOptions): Promise<SessionCommandResult>
  subscribe(sessionId: SessionId, afterRevision: number, listener: SessionEventListener, options?: SessionSubscriptionOptions): () => void
  subscribeTransient?(sessionId: SessionId, listener: SessionTransientEventListener): () => void
}

/** Transport-neutral client boundary shared by TUI, headless and future devices. */
export interface SessionClient {
  readonly sessionId: string
  execute(command: SessionCommand, options?: SessionExecuteOptions): Promise<SessionCommandResult>
  subscribe(afterRevision: number, listener: SessionEventListener, options?: SessionSubscriptionOptions): () => void
  subscribeTransient?(listener: SessionTransientEventListener): () => void
}

export interface SessionServer extends SessionTransport {
  connect(sessionId: string): SessionClient
}

export function createSessionClient(transport: SessionTransport, value: string): SessionClient {
  const id = sessionId(value)
  return {
    sessionId: id,
    execute: (command, options) => transport.execute(id, command, options),
    subscribe: (afterRevision, listener, options) => transport.subscribe(id, afterRevision, listener, options),
    ...(transport.subscribeTransient
      ? {
          subscribeTransient: (listener: SessionTransientEventListener) => transport.subscribeTransient!(id, listener),
        }
      : {}),
  }
}
