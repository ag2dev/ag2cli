import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { RunId, SessionId } from "@ag2cli/core/ids.js"
import type { EventStore } from "../../ports/event-store.js"
import type { AskExpirySweeper } from "./ask-resolution.js"

export interface AskExpirySweepResult {
  /** Asks this sweep converged to a fresh expired resolution. */
  readonly expired: number
}

export interface AskExpirySweepDependencies {
  readonly eventStore: EventStore
  readonly sweeper: AskExpirySweeper
}

interface DanglingAsk {
  readonly runId: RunId
  readonly turn: number
  readonly toolUseId: string
}

/**
 * First-serve convergence for ask_user interactions. A run that ended
 * without its pending ask being answered leaves the canonical stream in a
 * legal but dangling state; the sweep nominates exactly those asks and the
 * resolution service writes the system expired outcome. A live run's ask is
 * never nominated — run recovery owns it.
 */
export class AskExpirySweepUseCase {
  constructor(private readonly deps: AskExpirySweepDependencies) {}

  async execute(sessionId: SessionId): Promise<AskExpirySweepResult> {
    const events = await this.deps.eventStore.read(sessionId)
    let expired = 0
    for (const ask of danglingAsks(events)) {
      try {
        const outcome = await this.deps.sweeper.expire({
          sessionId,
          runId: ask.runId,
          turn: ask.turn,
          toolUseId: ask.toolUseId,
        })
        if (outcome.status === "committed") expired += 1
      } catch {
        // The canonical stream arbitrates: a racing answer, a terminal
        // tool result, or a foreign commit makes this refusal the correct
        // outcome for this ask.
      }
    }
    return { expired }
  }
}

/**
 * An ask dangles when its request exists, no resolution exists for it, and
 * its run already ended. Terminal tool results are left to the service's
 * own guards; its refusal is the correct convergence for those too.
 */
function danglingAsks(events: readonly AgentEvent[]): readonly DanglingAsk[] {
  const endedRuns = new Set<string>()
  const resolved = new Set<string>()
  const requested: DanglingAsk[] = []
  for (const event of events) {
    if (event.type === "RunCompleted" || event.type === "RunFailed" || event.type === "RunCancelled") {
      endedRuns.add(String(event.payload.runId))
    } else if (event.type === "AskUserRequested") {
      requested.push({ runId: event.payload.runId, turn: event.payload.turn, toolUseId: event.payload.toolUseId })
    } else if (event.type === "AskUserResolved") {
      resolved.add(askKey(event.payload.runId, event.payload.turn, event.payload.toolUseId))
    }
  }
  return requested.filter((ask) => endedRuns.has(String(ask.runId)) && !resolved.has(askKey(ask.runId, ask.turn, ask.toolUseId)))
}

function askKey(runId: RunId, turn: number, toolUseId: string): string {
  return `${String(runId)}:${turn}:${toolUseId}`
}
