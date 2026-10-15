import type { AgentEvent } from "@ag2cli/core/events/event.js"

export type ResumableRun = Extract<AgentEvent, { readonly type: "RunStarted" }>

/** Return the newest run that has no durable terminal event yet. */
export function findResumableRun(events: readonly AgentEvent[]): ResumableRun | undefined {
  const starts = events.filter((event): event is ResumableRun => event.type === "RunStarted").reverse()
  for (const start of starts) {
    const terminal = events.some(
      (event) =>
        (event.type === "RunCompleted" || event.type === "RunFailed" || event.type === "RunCancelled") &&
        event.payload.runId === start.payload.runId,
    )
    if (!terminal) return start
  }
  return undefined
}
