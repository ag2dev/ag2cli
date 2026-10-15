import type { SessionId } from "@ag2cli/core/ids.js"

/** Cross-process guard for commands that may cause model/tool/workspace side effects. */
export interface SessionExecutionReservation {
  acquire(input: {
    readonly sessionId: SessionId
    readonly commandId: string
    readonly ownerId: string
    readonly baseRevision: number
    readonly signal?: AbortSignal
  }): Promise<SessionExecutionReservationLease>
}

export interface SessionExecutionReservationLease {
  readonly reservationId: string
  /** Refresh ownership while a long-running model/tool command is active. */
  renew(): Promise<void>
  release(status?: "released" | "aborted"): Promise<void>
}

export class SessionExecutionReservationConflictError extends Error {
  readonly code = "reservation_conflict"

  constructor(
    readonly sessionId: SessionId,
    readonly commandId: string,
  ) {
    super(`The Session already has an executing command: ${sessionId}`)
    this.name = "SessionExecutionReservationConflictError"
  }
}
