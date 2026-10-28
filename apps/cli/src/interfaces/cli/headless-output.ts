import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type {
  PublicFailure,
  PublicInputSnapshot,
  PublicInputStatus,
  PublicMessage,
  PublicRunSnapshot,
  PublicRunStatus,
  PublicSessionSnapshot,
} from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type { HeadlessOutputFormat } from "../../config/output-format.js"
import { successEnvelope, type HeadlessCommand, type HeadlessEnvelope } from "./headless-contract.js"

export function serializeHeadless<T>(envelope: HeadlessEnvelope<T>, format: HeadlessOutputFormat, text: string): string {
  if (format === "text") return `${text}\n`
  return `${JSON.stringify(envelope)}\n`
}

/** The durable run terminal the CLI envelope reports, assembled from public projection facts only. */
export interface HeadlessRunOutcome {
  readonly runId: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly turns: number
  readonly finalText?: string
  readonly error?: string
  readonly failureCode?: string
}

export function runText(result: HeadlessRunOutcome): string {
  if (result.finalText) return result.finalText
  if (result.error) return result.error
  return result.status
}

export function serializeHeadlessEvent(command: HeadlessCommand, requestId: string, event: PublicSessionEvent): string {
  return `${JSON.stringify({
    ...successEnvelope(command, requestId, event, {
      sessionId: event.sessionId,
      meta: { revision: event.revision },
    }),
  })}\n`
}

export interface HeadlessJsonlEventWriter {
  readonly revision: number
  apply(events: readonly PublicSessionEvent[]): void
}

/**
 * JSONL projection of public session events. Public revisions are a subset
 * of canonical revisions (internal events without a public mapping drop
 * out), so the invariant is non-decreasing order with exactly-once output
 * per delivered event.
 */
export function createHeadlessJsonlEventWriter(
  command: HeadlessCommand,
  requestId: string,
  fromRevision = 0,
  sink: (line: string) => void = (line) => process.stdout.write(line),
): HeadlessJsonlEventWriter {
  let cursor = fromRevision
  return {
    get revision() {
      return cursor
    },
    apply(events) {
      for (const event of events) {
        if (event.revision < cursor) continue
        cursor = event.revision
        sink(serializeHeadlessEvent(command, requestId, event))
      }
    },
  }
}

interface TrackedInput {
  readonly status: PublicInputStatus
  readonly runId?: string
  readonly failure?: PublicFailure
}

interface TrackedRun {
  readonly status: PublicRunStatus
  readonly turn: number
  readonly failure?: PublicFailure
}

export interface HeadlessRunTracker {
  /** Merge snapshot facts (barrier, post-submit refresh, replay recovery). */
  refresh(snapshot: PublicSessionSnapshot): void
  apply(events: readonly PublicSessionEvent[]): void
  /** Terminal outcome of the input submitted under commandId; undefined while it can still settle. */
  outcomeFor(commandId: string): HeadlessRunOutcome | undefined
  activeRunId(): string | undefined
  queuedInputCount(): number
}

function messageText(message: PublicMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
}

/**
 * Folds the public event stream into per-input run outcomes. Submit returns
 * at admission while the facade drives the run in the background; this
 * tracker is how the entrypoint learns each input settled.
 */
export function createHeadlessRunTracker(): HeadlessRunTracker {
  const inputs = new Map<string, TrackedInput>()
  const runs = new Map<string, TrackedRun>()
  const assistantText = new Map<string, string>()
  let latest: PublicSessionSnapshot | undefined

  const rememberInput = (input: PublicInputSnapshot): void => {
    const previous = inputs.get(input.commandId)
    inputs.set(input.commandId, {
      status: input.status,
      ...(input.runId !== undefined ? { runId: input.runId } : previous?.runId !== undefined ? { runId: previous.runId } : {}),
      ...(previous?.failure !== undefined && input.status === "failed" ? { failure: previous.failure } : {}),
    })
  }

  const rememberRun = (run: PublicRunSnapshot): void => {
    runs.set(run.runId, {
      status: run.status,
      turn: run.turn,
      ...(run.failure !== undefined ? { failure: run.failure } : {}),
    })
  }

  const outcomeFromRun = (run: PublicRunSnapshot, text: string | undefined): HeadlessRunOutcome => ({
    runId: run.runId,
    status: run.status === "running" ? "cancelled" : run.status,
    turns: run.turn,
    ...(run.status === "completed" && text !== undefined && text !== "" ? { finalText: text } : {}),
    ...(run.failure !== undefined ? { error: run.failure.message, failureCode: run.failure.code } : {}),
  })

  return {
    refresh(snapshot) {
      latest = snapshot
      for (const input of snapshot.inputs) rememberInput(input)
      if (snapshot.currentRun !== undefined) rememberRun(snapshot.currentRun)
      for (const message of snapshot.recentMessages ?? []) {
        if (message.role === "assistant" && message.runId !== undefined) assistantText.set(message.runId, messageText(message))
      }
    },
    apply(events) {
      for (const event of events) {
        if (event.type === "input.accepted" || event.type === "input.updated") {
          rememberInput(event.input)
        } else if (event.type === "input.failed") {
          const previous = inputs.get(event.commandId)
          inputs.set(event.commandId, {
            status: "failed",
            ...(previous?.runId !== undefined ? { runId: previous.runId } : {}),
            failure: event.failure,
          })
        } else if (event.type === "run.updated") {
          rememberRun(event.run)
        } else if (event.type === "message.upserted") {
          if (event.message.role === "assistant" && event.message.runId !== undefined) {
            assistantText.set(event.message.runId, messageText(event.message))
          }
        }
      }
    },
    outcomeFor(commandId) {
      const input = inputs.get(commandId)
      if (input === undefined) {
        // Ancient replay: the terminal predates attachment, so the
        // refreshed snapshot's currentRun is the only surviving fact.
        const run = latest?.currentRun
        if (run !== undefined && run.status !== "running") {
          return outcomeFromRun(run, assistantText.get(run.runId))
        }
        return undefined
      }
      if (input.status === "queued") return undefined
      const run = input.runId !== undefined ? runs.get(input.runId) : undefined
      if (input.status === "failed") {
        return {
          runId: input.runId ?? commandId,
          status: "failed",
          turns: run?.turn ?? 0,
          error: input.failure?.message ?? "input failed",
          ...(input.failure !== undefined ? { failureCode: input.failure.code } : {}),
        }
      }
      if (input.status === "cancelled") {
        return { runId: input.runId ?? commandId, status: "cancelled", turns: run?.turn ?? 0 }
      }
      if (input.runId === undefined) return undefined
      if (run === undefined || run.status === "running") return undefined
      return {
        runId: input.runId,
        status: run.status,
        turns: run.turn,
        ...(run.status === "completed" ? { finalText: assistantText.get(input.runId) ?? "" } : {}),
        ...(run.failure !== undefined ? { error: run.failure.message, failureCode: run.failure.code } : {}),
      }
    },
    activeRunId() {
      for (const [runId, run] of runs) {
        if (run.status === "running") return runId
      }
      return undefined
    },
    queuedInputCount() {
      let count = 0
      for (const input of inputs.values()) {
        if (input.status === "queued") count++
      }
      return count
    },
  }
}
