import {
  assessRequest,
  breakerCanAttempt,
  breakerOnFailure,
  breakerOnSuccess,
  compactHistory,
  estimateTokens,
  estimateRequestUsage,
  newBreaker,
} from "./compact.js"
import { DEFAULT_THRESHOLDS, thresholdsForContextWindow, type CompactThresholds } from "@ag2cli/core/model/limits.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { ContextBuilder } from "../../ports/context-builder.js"
import type { ContextCompactor, ContextSummarizer } from "../../ports/context-compactor.js"
import type { ModelCallObservation } from "@ag2cli/core/model/observation.js"
import { safeTraceSink, type TraceSink } from "../../ports/trace-sink.js"
import type { DefaultContextBuilderOptions } from "./default-context-builder.js"
import { defaultContextBuilder } from "./default-context-builder.js"
import { modelMessagesForRequest } from "../prompt/assembly.js"
import { defaultRuntimeIdentity, type RuntimeIdentity } from "../../ports/identity.js"
import type { SessionNotesStore, SessionNotesUpdater } from "../../ports/session-notes-store.js"
import { prepareSessionNotes, readNotesForAssembly, type NotesTrace } from "./session-notes.js"

/** The three-piece session notes wiring; notes are disabled unless all three are present. */
export interface SessionNotesWiring {
  readonly store: SessionNotesStore
  readonly updater: SessionNotesUpdater
  /** Full-stream read per session; one builder serves many sessions. */
  readonly eventsSource: (sessionId: SessionId) => Promise<readonly AgentEvent[]>
  readonly timeoutMs?: number
}

export interface CompactContextBuilderOptions extends DefaultContextBuilderOptions {
  readonly enable?: boolean
  readonly thresholds?: CompactThresholds
  readonly summarize: ContextSummarizer
  readonly traceSink?: TraceSink
  readonly identity?: RuntimeIdentity
  /**
   * Request-side output-token fact of the model this builder serves. It
   * narrows the effective window when thresholds derive from a context
   * window; explicitly injected thresholds are unaffected.
   */
  readonly maxOutputTokens?: number
  /** Window fact used to derive thresholds when none are injected. */
  readonly contextWindow?: number
  readonly sessionNotes?: SessionNotesWiring
  /** Resolves the durable transcript path stamped into every boundary block this builder emits. */
  readonly transcriptPathFor?: (sessionId: SessionId) => string
}

/** Reuse the same summary contract for explicit session-level compaction. */
export function contextCompactor(options: {
  readonly summarize: ContextSummarizer
  readonly identity?: RuntimeIdentity
  readonly thresholds?: CompactThresholds
  readonly toolTokensEstimate?: number
  readonly sessionNotes?: SessionNotesWiring
  readonly transcriptPathFor?: (sessionId: SessionId) => string
}): ContextCompactor {
  const identity = options.identity ?? defaultRuntimeIdentity
  return {
    async compact(input) {
      let modelObservation: ModelCallObservation | undefined
      // The explicit chain has no circuit breaker and no structural
      // fallback, so the refresh outcome is used directly; its trace has
      // no sink here and is dropped by design.
      const notesWiring = options.sessionNotes
      const notesOutcome =
        notesWiring === undefined
          ? undefined
          : await prepareSessionNotes({
              sessionId: input.sessionId,
              store: notesWiring.store,
              updater: notesWiring.updater,
              eventsSource: () => notesWiring.eventsSource(input.sessionId),
              thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
              ...(notesWiring.timeoutMs === undefined ? {} : { timeoutMs: notesWiring.timeoutMs }),
            })
      const messages = await compactHistory(
        [...input.messages],
        async (summaryMessages) => {
          const result = await options.summarize({
            sessionId: input.sessionId,
            runId: input.runId,
            messages: summaryMessages,
            signal: input.signal,
          })
          if (typeof result === "string") return result
          modelObservation = result.observation
          return result.text
        },
        {
          ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
          ...(options.toolTokensEstimate === undefined ? {} : { fragmentsTokens: options.toolTokensEstimate }),
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          ...(notesOutcome?.content === undefined ? {} : { notes: notesOutcome.content }),
          ...(options.transcriptPathFor === undefined ? {} : { transcriptPath: options.transcriptPathFor(input.sessionId) }),
        },
      )
      return {
        compactId: identity.nextId(),
        inputMessageCount: input.messages.length,
        outputMessageCount: messages.length,
        messages,
        inputTokens: estimateTokens(input.messages),
        ...(modelObservation ? { modelObservation } : {}),
      }
    },
  }
}

/** Adds bounded auto-compact behavior to the ordinary prompt/context adapter. */
export function compactContextBuilder(options: CompactContextBuilderOptions): ContextBuilder {
  const base = defaultContextBuilder(options)
  const injectedThresholds = options.thresholds
  const derivedThresholds =
    options.contextWindow === undefined ? undefined : thresholdsForContextWindow(options.contextWindow, options.maxOutputTokens)
  const thresholds = injectedThresholds ?? derivedThresholds ?? DEFAULT_THRESHOLDS
  const breakers = new Map<string, ReturnType<typeof newBreaker>>()
  const traceSink = safeTraceSink(options.traceSink)
  const identity = options.identity ?? defaultRuntimeIdentity

  return {
    async build(input) {
      const built = await base.build(input)
      if (options.enable === false) {
        return {
          ...built,
          provenance: {
            ...(built.provenance ?? emptyProvenance(input.context.length + (input.attachments?.length ?? 0))),
            compact: {
              status: "disabled" as const,
              inputMessageCount: built.messages.length,
              outputMessageCount: built.messages.length,
            },
          },
        }
      }

      const usage = estimateRequestUsage({
        messages: modelMessagesForRequest(built.contextMessages, built.messages),
        systemPrompt: built.systemPrompt,
        tools: input.tools,
      })
      // A per-session window override always re-derives, mirroring how the
      // override supersedes every other threshold source.
      const activeThresholds =
        input.contextWindowOverride === undefined
          ? thresholds
          : thresholdsForContextWindow(input.contextWindowOverride, options.maxOutputTokens)
      const assessed = assessRequest(usage, activeThresholds)
      if (!assessed.shouldCompact && !assessed.isBlockingLimit) {
        return {
          ...built,
          provenance: {
            ...(built.provenance ?? emptyProvenance(input.context.length + (input.attachments?.length ?? 0))),
            compact: {
              status: "not-needed" as const,
              inputMessageCount: built.messages.length,
              outputMessageCount: built.messages.length,
              inputTokens: assessed.tokens,
            },
          },
        }
      }

      const contextFragmentTokens = estimateTokens(modelMessagesForRequest(built.contextMessages, []))
      const fragmentsTokens = usage.totalTokens - usage.messageTokens + contextFragmentTokens
      const includeHistoryGuidance = input.tools.some((tool) => tool.name === "session_history")
      const transcriptPath = options.transcriptPathFor?.(input.sessionId)
      const compactOptions = {
        thresholds: activeThresholds,
        fragmentsTokens,
        includeHistoryGuidance,
        ...(transcriptPath === undefined ? {} : { transcriptPath }),
      } as const
      const notesWiring = options.sessionNotes
      const directNotesRead = () =>
        notesWiring === undefined ? undefined : readNotesForAssembly({ sessionId: input.sessionId, store: notesWiring.store })

      const key = input.sessionId
      const breaker = breakers.get(key) ?? newBreaker()
      const startedAt = performance.now()
      const trace = {
        traceId: input.trace?.traceId ?? `compact-${identity.nextId()}`,
        operationId: `compact-${identity.nextId()}`,
        ...(input.trace?.causationId ? { causationId: input.trace.causationId } : {}),
      }
      const recordTrace = (phase: "succeeded" | "failed", tier: number, notes?: NotesTrace) => {
        traceSink.record({
          name: "execution.context",
          phase,
          sessionId: input.sessionId,
          trace,
          timestamp: new Date().toISOString(),
          durationMs: Math.round(performance.now() - startedAt),
          attributes: { stage: "compact", tier, ...(notes === undefined ? {} : { notes }) },
        })
      }
      const applied = (messages: typeof built.messages, modelObservations?: readonly ModelCallObservation[]) => ({
        ...built,
        messages,
        provenance: {
          ...(built.provenance ?? emptyProvenance(input.context.length + (input.attachments?.length ?? 0))),
          compact: {
            status: "applied" as const,
            inputMessageCount: built.messages.length,
            outputMessageCount: messages.length,
            inputTokens: assessed.tokens,
          },
        },
        compaction: {
          compactId: identity.nextId(),
          inputMessageCount: built.messages.length,
          outputMessageCount: messages.length,
          messages,
          inputTokens: assessed.tokens,
        },
        ...(modelObservations === undefined || modelObservations.length === 0 ? {} : { modelObservations }),
      })

      traceSink.record({
        name: "execution.context",
        phase: "started",
        sessionId: input.sessionId,
        trace,
        timestamp: new Date().toISOString(),
        attributes: { stage: "compact" },
      })

      // Over the blocking limit the deterministic structural ladder runs
      // first; only a product that still cannot fit throws. The notes side
      // is read-only here: the refresh chain never runs past this point.
      if (assessed.isBlockingLimit) {
        const notesOutcome = await directNotesRead()
        try {
          const messages = await compactHistory(
            [...built.messages],
            async () => {
              throw new Error("unreachable: the structural tier never summarizes")
            },
            { ...compactOptions, tier: 2, ...(notesOutcome?.content === undefined ? {} : { notes: notesOutcome.content }) },
          )
          recordTrace("succeeded", 2, notesOutcome?.trace)
          return applied(messages)
        } catch (error) {
          recordTrace("failed", 2, notesOutcome?.trace)
          throw error
        }
      }

      const tier1 = async (notes?: string): Promise<{ messages: typeof built.messages; observation?: ModelCallObservation }> => {
        let summaryObservation: ModelCallObservation | undefined
        const messages = await compactHistory(
          [...built.messages],
          async (summaryMessages) => {
            const result = await options.summarize({
              sessionId: input.sessionId,
              runId: input.runId,
              messages: summaryMessages,
              signal: input.signal,
            })
            if (typeof result === "string") return result
            summaryObservation = result.observation
            return result.text
          },
          { ...compactOptions, ...(notes === undefined ? {} : { notes }) },
        )
        return { messages, ...(summaryObservation ? { observation: summaryObservation } : {}) }
      }
      const tier2 = async (notes?: string): Promise<typeof built.messages> =>
        compactHistory(
          [...built.messages],
          async () => {
            throw new Error("unreachable: the structural tier never summarizes")
          },
          { ...compactOptions, tier: 2, ...(notes === undefined ? {} : { notes }) },
        )

      if (!breakerCanAttempt(breaker)) {
        // The summarizer is known-bad; degrade straight to the structural tier.
        const notesOutcome = await directNotesRead()
        const messages = await tier2(notesOutcome?.content)
        recordTrace("succeeded", 2, notesOutcome?.trace)
        return applied(messages)
      }

      const notesPrepared =
        notesWiring === undefined
          ? undefined
          : await prepareSessionNotes({
              sessionId: input.sessionId,
              store: notesWiring.store,
              updater: notesWiring.updater,
              eventsSource: () => notesWiring.eventsSource(input.sessionId),
              thresholds: activeThresholds,
              ...(notesWiring.timeoutMs === undefined ? {} : { timeoutMs: notesWiring.timeoutMs }),
            })

      try {
        const { messages, observation } = await tier1(notesPrepared?.content)
        breakers.set(key, breakerOnSuccess())
        recordTrace("succeeded", 1, notesPrepared?.trace)
        return applied(messages, observation === undefined ? undefined : [observation])
      } catch (error) {
        breakers.set(key, breakerOnFailure(breaker))
        // The fallback block re-reads the file at its own assembly time and
        // echoes the refresh trace instead of re-deriving it from presence.
        const notesOutcome =
          notesWiring === undefined
            ? undefined
            : await readNotesForAssembly({
                sessionId: input.sessionId,
                store: notesWiring.store,
                refreshTrace: notesPrepared?.trace,
              })
        try {
          const messages = await tier2(notesOutcome?.content)
          recordTrace("succeeded", 2, notesOutcome?.trace)
          return applied(messages)
        } catch (fallbackError) {
          recordTrace("failed", 2, notesOutcome?.trace)
          throw fallbackError
        }
      }
    },
  }
}

function emptyProvenance(requestContextCount: number) {
  return { requestContextCount, memoryNames: [], skillNames: [] }
}
