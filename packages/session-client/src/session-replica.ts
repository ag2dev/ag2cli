import type { AgentEvent } from "@ag2cli/core/events/event.js"
import { applySessionEvent, type SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import type { SessionClient, SessionEventListener } from "./session-client.js"
import { getSnapshotCommand, SESSION_PROTOCOL_VERSION } from "@ag2cli/session-protocol/session-command.js"

export interface SessionReplicaOptions {
  readonly onChange?: (snapshot: SessionSnapshot) => void
  readonly onError?: (error: unknown) => void
}

/** Client-side canonical projection. It is disposable and always resyncable. */
export class SessionReplica {
  private unsubscribe?: () => void
  private readonly listeners = new Set<(snapshot: SessionSnapshot) => void>()
  private readonly eventIds = new Map<number, string>()
  private initializing = true
  private bufferedEvents: AgentEvent[] = []

  private constructor(
    private readonly client: SessionClient,
    private readonly options: SessionReplicaOptions,
    private current: SessionSnapshot,
  ) {}

  static async connect(client: SessionClient, options: SessionReplicaOptions = {}): Promise<SessionReplica> {
    const result = await client.execute({
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "get_snapshot",
    })
    if (result.type !== "snapshot") throw new Error("Session replica initialization did not return a snapshot")
    const replica = new SessionReplica(client, options, result.snapshot)
    replica.subscribeToEvents(result.snapshot.lastRevision)

    const catchup = await client.execute({
      protocolVersion: SESSION_PROTOCOL_VERSION,
      type: "read_events",
      afterRevision: result.snapshot.lastRevision,
    })
    if (catchup.type !== "events") throw new Error("Session replica catch-up did not return events")
    replica.initializing = false
    replica.apply([...catchup.events, ...replica.bufferedEvents.splice(0)])
    await replica.waitForResync()
    return replica
  }

  get snapshot(): SessionSnapshot {
    return this.current
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  sync(snapshot: SessionSnapshot): void {
    if (snapshot.sessionId !== this.current.sessionId) throw new Error("Session replica cannot switch sessions")
    if (snapshot.lastRevision < this.current.lastRevision) throw new Error("Session replica cannot move to an earlier revision")
    if (snapshot.lastRevision === this.current.lastRevision) return
    this.current = snapshot
    this.resyncRequired = false
    this.eventIds.clear()
    this.notify()
  }

  close(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  private subscribeToEvents(afterRevision: number): void {
    this.unsubscribe?.()
    const listener: SessionEventListener = (events) => this.apply(events)
    this.unsubscribe = this.client.subscribe(afterRevision, listener, {
      onOverflow: ({ cursor }) => {
        this.requestResync(cursor + 1)
        this.subscribeToEvents(this.current.lastRevision)
      },
    })
  }

  private apply(events: readonly AgentEvent[]): void {
    if (this.initializing || this.resyncRequired) {
      this.bufferEvents(events)
      if (this.resyncRequired) this.requestResync(this.current.lastRevision + 1)
      return
    }
    if (events.some((event) => event.type === "HeadMoved")) {
      this.bufferEvents(events)
      this.requestResync(this.current.lastRevision + 1)
      return
    }
    let next = this.current
    for (const event of events) {
      if (event.revision <= next.lastRevision) {
        const previousEventId = this.eventIds.get(event.revision)
        if (previousEventId !== undefined && previousEventId !== event.eventId) {
          throw new Error(`Session replay has a duplicate revision with a different eventId: ${event.revision}`)
        }
        continue
      }
      if (event.revision > next.lastRevision + 1) {
        this.bufferEvents(events.slice(events.indexOf(event)))
        this.requestResync(next.lastRevision + 1)
        return
      }
      next = applySessionEvent(next, event)
      this.eventIds.set(event.revision, event.eventId)
    }
    if (next.lastRevision === this.current.lastRevision) return
    this.current = next
    this.notify()
  }

  private resyncRequired = false
  private resyncPromise?: Promise<void>

  private requestResync(minRevision: number): void {
    this.resyncRequired = true
    if (this.resyncPromise) return
    this.resyncPromise = this.client
      .execute(getSnapshotCommand())
      .then((result) => {
        if (result.type !== "snapshot") throw new Error("Session replica resync did not return a snapshot")
        if (result.snapshot.lastRevision < minRevision) {
          throw new Error(
            `Session replica resync revision is behind: expected at least ${minRevision}, received ${result.snapshot.lastRevision}`,
          )
        }
        this.current = result.snapshot
        this.resyncRequired = false
        this.eventIds.clear()
        this.notify()
        const buffered = this.bufferedEvents.splice(0)
        if (buffered.length > 0) this.apply(buffered)
      })
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        this.resyncPromise = undefined
      })
  }

  private async waitForResync(): Promise<void> {
    while (this.resyncPromise) await this.resyncPromise
  }

  private bufferEvents(events: readonly AgentEvent[]): void {
    for (const event of events) {
      const duplicate = this.bufferedEvents.some((buffered) => buffered.revision === event.revision && buffered.eventId === event.eventId)
      if (!duplicate) this.bufferedEvents.push(event)
    }
    this.bufferedEvents.sort((left, right) => left.revision - right.revision)
  }

  private notify(): void {
    this.options.onChange?.(this.current)
    for (const listener of [...this.listeners]) listener(this.current)
  }
}
