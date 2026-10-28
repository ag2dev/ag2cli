import { isAppServerTransientEventKind } from "@ag2cli/app-server-protocol/types.js"

/**
 * Storage lifecycle for one Session's live transient events: a bounded,
 * deduplicated, sequence-ordered buffer plus the durable-fact replacement
 * rules that retire transients once a canonical fact supersedes them. Only
 * storage lives here -- projection and rendering stay with the app, which is
 * why child-attributed events are kept and any display decision is theirs.
 */

/** Minimum surface of a transient event this store depends on. */
export interface TransientEventEnvelope {
  readonly eventId: string
  readonly sequence: number
  readonly kind: string
  readonly runId: string
  readonly toolCallId?: string
}

/**
 * Minimum surface of a durable session event that drives replacement. The
 * protocol package's typed event union satisfies this structurally, so callers
 * pass their parsed events through unchanged.
 */
export interface DurableReplacementEvent {
  readonly type: string
  readonly run?: { readonly runId: string; readonly status: string }
  readonly message?: { readonly role: string; readonly runId?: string }
  readonly toolCall?: { readonly toolCallId: string }
}

export interface LiveTransientStoreOptions {
  /** Maximum retained transients; the lowest sequences are evicted first. */
  readonly capacity?: number
}

const DEFAULT_CAPACITY = 512
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

export class LiveTransientStore<T extends TransientEventEnvelope> {
  private readonly events = new Map<string, T>()
  private readonly terminalRuns = new Set<string>()
  private readonly durableAssistantRuns = new Set<string>()
  private readonly durableToolCalls = new Set<string>()
  private readonly capacity: number

  constructor(options: LiveTransientStoreOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY
    if (!Number.isInteger(this.capacity) || this.capacity <= 0) {
      throw new RangeError("capacity must be a positive integer")
    }
  }

  /**
   * Admits one transient event. Kinds outside the shipped catalog are ignored
   * rather than stored: the wire contract lets the Host add kinds freely, and
   * keeping them out means no consumer ever needs its own kind whitelist to
   * skip them again. A re-delivered eventId replaces its earlier payload.
   */
  applyTransient(event: T): void {
    if (!isAppServerTransientEventKind(event.kind)) return
    this.events.set(event.eventId, event)
    if (this.events.size > this.capacity) this.evictToCapacity()
  }

  /**
   * Records one durable session event and retires the transients it
   * supersedes: a terminal `run.updated` drops the run's entire stream, a
   * durable assistant `message.upserted` drops that run's `model_text_delta`,
   * and a `tool_call.upserted` drops that tool call's keyed stream. The facts
   * only ever accumulate, so incremental application matches rescanning the
   * full durable history.
   */
  applyDurable(event: DurableReplacementEvent): void {
    if (event.type === "run.updated" && event.run !== undefined && TERMINAL_RUN_STATUSES.has(event.run.status)) {
      this.terminalRuns.add(event.run.runId)
    }
    if (
      event.type === "message.upserted" &&
      event.message !== undefined &&
      event.message.role === "assistant" &&
      event.message.runId !== undefined
    ) {
      this.durableAssistantRuns.add(event.message.runId)
    }
    if (event.type === "tool_call.upserted" && event.toolCall !== undefined) {
      this.durableToolCalls.add(event.toolCall.toolCallId)
    }
    for (const [eventId, stored] of this.events) {
      if (this.isReplaced(stored)) this.events.delete(eventId)
    }
  }

  /** The retained transients in sequence order; a fresh array on every call. */
  transientEvents(): readonly T[] {
    return [...this.events.values()].sort((left, right) => left.sequence - right.sequence)
  }

  /**
   * Drops every retained transient and accumulated replacement fact, for every
   * entry point that rebuilds the projection from an authoritative snapshot:
   * switching sessions, resyncing, or recovering after an unsupported event.
   */
  reset(): void {
    this.events.clear()
    this.terminalRuns.clear()
    this.durableAssistantRuns.clear()
    this.durableToolCalls.clear()
  }

  private isReplaced(event: T): boolean {
    if (this.terminalRuns.has(event.runId)) return true
    if (event.kind === "model_text_delta" && this.durableAssistantRuns.has(event.runId)) return true
    return event.toolCallId !== undefined && this.durableToolCalls.has(event.toolCallId)
  }

  /** Eviction is determinate under out-of-order arrival: sort by sequence, drop the head. */
  private evictToCapacity(): void {
    const sorted = [...this.events.values()].sort((left, right) => left.sequence - right.sequence)
    let evict = sorted.length - this.capacity
    for (const event of sorted) {
      if (evict <= 0) break
      this.events.delete(event.eventId)
      evict -= 1
    }
  }
}
