import type { HeadlessOutputFormat } from "../../config/output-format.js"
import { successEnvelope, type HeadlessCommand, type HeadlessEnvelope } from "./headless-contract.js"
import { readEventsCommand } from "@ag2cli/protocol/session-command.js"
import type { SessionClient } from "@ag2cli/client/session-client.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { Plan } from "@ag2cli/core/plan/plan.js"
import type { RunResult } from "@ag2cli/core/execution/run.js"

export function serializeHeadless<T>(envelope: HeadlessEnvelope<T>, format: HeadlessOutputFormat, text: string): string {
  if (format === "text") return `${text}\n`
  return `${JSON.stringify(envelope)}\n`
}

export function planText(plan: Plan): string {
  const lines = [`Goal: ${plan.goal}`, `Summary: ${plan.summary}`]
  for (const step of plan.steps) {
    lines.push(`${step.order}. ${step.title} [${step.status}]`)
    lines.push(`   ${step.description}`)
  }
  return lines.join("\n")
}

export function runText(result: RunResult): string {
  if (result.finalText) return result.finalText
  if (result.error) return result.error
  return result.status
}

export function serializeHeadlessEvent(command: HeadlessCommand, requestId: string, event: AgentEvent): string {
  return `${JSON.stringify({
    ...successEnvelope(command, requestId, event, {
      sessionId: event.sessionId,
      meta: { revision: event.revision },
    }),
  })}\n`
}

export interface HeadlessJsonlEventWriter {
  readonly revision: number
  start(signal?: AbortSignal): Promise<void>
  flush(signal?: AbortSignal): Promise<void>
  close(): void
}

/**
 * Projects durable session events to JSONL while a headless operation runs.
 * The final catch-up read closes the subscription race for remote clients;
 * revision de-duplication keeps the output exactly once per durable event.
 */
export function createHeadlessJsonlEventWriter(
  client: SessionClient,
  command: HeadlessCommand,
  requestId: string,
  sink: (line: string) => void = (line) => process.stdout.write(line),
): HeadlessJsonlEventWriter {
  let cursor = 0
  let unsubscribe: (() => void) | undefined

  const emit = (events: readonly AgentEvent[]): void => {
    for (const event of events) {
      if (event.revision <= cursor) continue
      if (event.revision !== cursor + 1) {
        throw new Error(`Headless event revision gap: expected ${cursor + 1}, received ${event.revision}`)
      }
      cursor = event.revision
      sink(serializeHeadlessEvent(command, requestId, event))
    }
  }

  return {
    get revision() {
      return cursor
    },
    async start(signal) {
      if (unsubscribe) return
      const result = await client.execute(readEventsCommand(), { signal })
      if (result.type !== "events") throw new Error("Session did not return events")
      cursor = result.events.at(-1)?.revision ?? 0
      unsubscribe = client.subscribe(cursor, emit)
    },
    async flush(signal) {
      const result = await client.execute(readEventsCommand(cursor), { signal })
      if (result.type !== "events") throw new Error("Session did not return events")
      emit(result.events)
    },
    close() {
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}
