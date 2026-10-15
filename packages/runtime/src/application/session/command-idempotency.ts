import type { AgentEvent } from "@ag2cli/core/events/event.js"

/**
 * Shared commandId-based deduplication for durable Session use cases.
 *
 * Every durable-commandId use case (run, plan, shell, compact, goal,
 * permission, context-window, update-agent, add-additional-directory,
 * create-task) independently re-implemented the same "have I seen this
 * commandId before, and if so does its input still match" check by scanning
 * `eventStore.read()` output for a matching `trace.traceId` or
 * `payload.commandId`. Several of those bespoke checks never compared the
 * recorded input against the retried input at all, so a client retry with a
 * *different* payload under the same commandId would silently return the
 * old result instead of failing loudly.
 *
 * This module centralizes the four-state classification
 * (`new`/`resume`/`replay`/`conflict`) and the fingerprint-equality check.
 * It is intentionally narrow: it never constructs a domain result (a
 * `RunResult`, a `Plan`, ...) and never reads or writes an event store
 * itself. A use case supplies small, family-specific closures (how to find
 * the anchor event for a commandId, how to read its recorded fingerprint,
 * how to find its terminal event if the anchor is not itself terminal) and
 * still does its own domain-specific replay/resume reconstruction from the
 * returned `eventRange` — exactly as before. This keeps the module testable
 * and reusable in complete isolation from any concrete use case, and keeps
 * use cases free to keep whatever resume mechanics their family actually
 * needs (e.g. `run`'s multi-turn tool loop resume is unrelated to this
 * module and is unchanged by it).
 *
 * `rewind`/`preview_rewind` (a dedicated checkpoint transition with its own
 * replay checks) and `resolve_approval`/`session.cancel`/
 * `cancel_task` (resource-key atomicity or convergent no-op semantics) are
 * deliberately *not* built on this module — see the family coverage
 * manifest in `command-idempotency-coverage.test.ts` for the full rationale
 * behind each exclusion.
 */

/** One attempt at a durable commandId, as reported by a transport/use case. */
export interface CommandAttempt<TFingerprint = unknown> {
  /** A stable label for the command family; the resolver rejects a mismatched family strategy. */
  readonly family: string
  /** The identity a family dedupes on. Usually the wire `commandId`, but a family may use
   * a different natural key (e.g. `create_task` dedupes on `taskId`, not a separate commandId). */
  readonly commandId: string
  /** Every input that would produce a materially different durable outcome. Transport-only
   * fields (`expectedRevision`, lease generation, `signal`, `trace`) must never be included:
   * a different transport attempt of the *same* command is not a different command. */
  readonly inputFingerprint: TFingerprint
}

/** The durable record recovered for a previously-seen commandId. */
export interface CommandRecord<TFingerprint = unknown> {
  readonly commandId: string
  readonly family: string
  readonly inputFingerprint: TFingerprint
  /** All durable events from this commandId's anchor event onward (inclusive), in revision order. */
  readonly eventRange: readonly AgentEvent[]
}

export type CommandIdempotencyResult<TFingerprint = unknown> =
  /** No prior attempt with this commandId exists; the use case should execute it fresh. */
  | { readonly status: "new" }
  /** A prior attempt exists with a *different* fingerprint: same commandId, different command. */
  | { readonly status: "conflict"; readonly record: CommandRecord<TFingerprint> }
  /** A prior attempt exists with the same fingerprint but has not reached a terminal event yet. */
  | { readonly status: "resume"; readonly record: CommandRecord<TFingerprint> }
  /** A prior attempt exists with the same fingerprint and already reached a terminal event. */
  | { readonly status: "replay"; readonly record: CommandRecord<TFingerprint>; readonly terminal: AgentEvent }

/** One durable-commandId family's event-shape knowledge, supplied by its use case. */
export interface CommandIdempotencyFamily<TFingerprint = unknown> {
  readonly family: string
  /**
   * Locate the event that first recorded this commandId's attempt, if any, and the
   * fingerprint recorded on it. Must scan from durable events only (never in-memory
   * state) so a fresh resolver instance after a Host restart reaches the same answer.
   */
  findAnchor(
    events: readonly AgentEvent[],
    commandId: string,
  ): { readonly event: AgentEvent; readonly inputFingerprint: TFingerprint } | undefined
  /**
   * Locate this attempt's terminal event, searching `events` (which includes the anchor
   * and everything after it). Omit for a family whose anchor event *is* its own terminal
   * (e.g. `context-window`/`goal`/`update-agent`/`add-additional-directory`/`permission`:
   * one event both records the fingerprint and completes the command).
   */
  findTerminal?(events: readonly AgentEvent[], anchor: AgentEvent): AgentEvent | undefined
  /** Defaults to a deep-equality comparison via JSON serialization. */
  fingerprintsEqual?(recorded: TFingerprint, attempted: TFingerprint): boolean
}

/**
 * Classify one command attempt against durable history. Pure and
 * synchronous: callers pass in whatever `events` they already read from the
 * `EventStore`, so this function carries no state of its own and gives an
 * identical answer whether called from the connection that originated the
 * command, a different connection, or a freshly restarted Host.
 */
export function resolveCommandIdempotency<TFingerprint = unknown>(
  family: CommandIdempotencyFamily<TFingerprint>,
  events: readonly AgentEvent[],
  attempt: CommandAttempt<TFingerprint>,
): CommandIdempotencyResult<TFingerprint> {
  if (attempt.family !== family.family) throw new CommandIdempotencyFamilyMismatchError(family.family, attempt.family)
  const anchor = family.findAnchor(events, attempt.commandId)
  if (anchor === undefined) return { status: "new" }

  const fingerprintsEqual = family.fingerprintsEqual ?? defaultFingerprintsEqual
  const record: CommandRecord<TFingerprint> = {
    commandId: attempt.commandId,
    family: family.family,
    inputFingerprint: anchor.inputFingerprint,
    eventRange: eventRangeFrom(events, anchor.event),
  }
  if (!fingerprintsEqual(anchor.inputFingerprint, attempt.inputFingerprint)) {
    return { status: "conflict", record }
  }

  const terminal = family.findTerminal ? family.findTerminal(record.eventRange, anchor.event) : anchor.event
  if (terminal !== undefined) return { status: "replay", record, terminal }
  return { status: "resume", record }
}

/**
 * Thrown by {@link commandIdempotencyConflictError} for a `conflict` result: the same
 * commandId was already used with a different input. A named subclass (rather than a
 * plain `Error`) lets a transport layer recognize this specific condition and map it to
 * a stable, machine-readable wire error code instead of an undifferentiated internal
 * error.
 */
export class CommandIdempotencyConflictError extends Error {
  readonly family: string
  readonly commandId: string

  constructor(record: CommandRecord<unknown>) {
    super(`commandId was already used for a different ${record.family}: ${record.commandId}`)
    this.name = "CommandIdempotencyConflictError"
    this.family = record.family
    this.commandId = record.commandId
  }
}

/** Thrown when a use case accidentally resolves an attempt with another family's event strategy. */
export class CommandIdempotencyFamilyMismatchError extends Error {
  readonly expectedFamily: string
  readonly actualFamily: string

  constructor(expectedFamily: string, actualFamily: string) {
    super(`commandIdempotency family mismatch: expected ${expectedFamily}, received ${actualFamily}`)
    this.name = "CommandIdempotencyFamilyMismatchError"
    this.expectedFamily = expectedFamily
    this.actualFamily = actualFamily
  }
}

/** Throw a stable, family-labeled error for a `conflict` result. Use cases may throw their
 * own error instead; this is a convenience for the common case. */
export function commandIdempotencyConflictError<TFingerprint>(record: CommandRecord<TFingerprint>): Error {
  return new CommandIdempotencyConflictError(record as CommandRecord<unknown>)
}

function eventRangeFrom(events: readonly AgentEvent[], anchor: AgentEvent): readonly AgentEvent[] {
  const index = events.indexOf(anchor)
  return index === -1 ? [anchor] : events.slice(index)
}

function defaultFingerprintsEqual<TFingerprint>(recorded: TFingerprint, attempted: TFingerprint): boolean {
  return stableStringify(recorded) === stableStringify(attempted)
}

/** JSON.stringify with sorted object keys, so fingerprint equality does not depend on
 * property insertion order (a resolver reading a freshly-decoded event payload versus
 * a use case's freshly-constructed input object could otherwise differ only in key order). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val === null || typeof val !== "object" || Array.isArray(val)) return val
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(val as Record<string, unknown>).sort()) sorted[key] = (val as Record<string, unknown>)[key]
    return sorted
  })
}
