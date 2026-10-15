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
import type { ContextBuilder } from "../../ports/context-builder.js"
import type { ContextCompactor, ContextSummarizer } from "../../ports/context-compactor.js"
import type { ModelCallObservation } from "@ag2cli/core/model/observation.js"
import { safeTraceSink, type TraceSink } from "../../ports/trace-sink.js"
import type { DefaultContextBuilderOptions } from "./default-context-builder.js"
import { defaultContextBuilder } from "./default-context-builder.js"
import { modelMessagesForRequest } from "../prompt/assembly.js"
import { defaultRuntimeIdentity, type RuntimeIdentity } from "../../ports/identity.js"

export interface CompactContextBuilderOptions extends DefaultContextBuilderOptions {
  readonly enable?: boolean
  readonly thresholds?: CompactThresholds
  readonly summarize: ContextSummarizer
  readonly traceSink?: TraceSink
  readonly identity?: RuntimeIdentity
}

/** Reuse the same summary contract for explicit session-level compaction. */
export function contextCompactor(options: {
  readonly summarize: ContextSummarizer
  readonly identity?: RuntimeIdentity
}): ContextCompactor {
  const identity = options.identity ?? defaultRuntimeIdentity
  return {
    async compact(input) {
      let modelObservation: ModelCallObservation | undefined
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
        { keepTail: 2, ...(input.instructions === undefined ? {} : { instructions: input.instructions }) },
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
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS
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
              status: "disabled",
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
      const activeThresholds =
        input.contextWindowOverride === undefined ? thresholds : thresholdsForContextWindow(input.contextWindowOverride)
      const assessed = assessRequest(usage, built.messages.length, activeThresholds)
      if (assessed.isBlockingLimit) {
        throw new Error(`Context exceeds the blocking limit (${assessed.tokens} tokens)`)
      }
      if (!assessed.shouldCompact) {
        return {
          ...built,
          provenance: {
            ...(built.provenance ?? emptyProvenance(input.context.length + (input.attachments?.length ?? 0))),
            compact: {
              status: "not-needed",
              inputMessageCount: built.messages.length,
              outputMessageCount: built.messages.length,
              inputTokens: assessed.tokens,
            },
          },
        }
      }

      const key = `${input.sessionId}:${input.runId}`
      const breaker = breakers.get(key) ?? newBreaker()
      if (!breakerCanAttempt(breaker)) {
        throw new Error(`Auto-compaction circuit breaker opened after ${breaker.consecutiveFailures} consecutive failures`)
      }
      const startedAt = performance.now()
      const trace = {
        traceId: input.trace?.traceId ?? `compact-${identity.nextId()}`,
        operationId: `compact-${identity.nextId()}`,
        ...(input.trace?.causationId ? { causationId: input.trace.causationId } : {}),
      }
      traceSink.record({
        name: "execution.context",
        phase: "started",
        sessionId: input.sessionId,
        trace,
        timestamp: new Date().toISOString(),
        attributes: { stage: "compact" },
      })
      try {
        let summaryObservation: ModelCallObservation | undefined
        const messages = await compactHistory([...built.messages], async (summaryMessages) => {
          const result = await options.summarize({
            sessionId: input.sessionId,
            runId: input.runId,
            messages: summaryMessages,
            signal: input.signal,
          })
          if (typeof result === "string") return result
          summaryObservation = result.observation
          return result.text
        })
        breakers.set(key, breakerOnSuccess())
        traceSink.record({
          name: "execution.context",
          phase: "succeeded",
          sessionId: input.sessionId,
          trace,
          timestamp: new Date().toISOString(),
          durationMs: Math.round(performance.now() - startedAt),
          attributes: { stage: "compact" },
        })
        const compactId = identity.nextId()
        return {
          ...built,
          messages,
          provenance: {
            ...(built.provenance ?? emptyProvenance(input.context.length + (input.attachments?.length ?? 0))),
            compact: {
              status: "applied",
              inputMessageCount: built.messages.length,
              outputMessageCount: messages.length,
              inputTokens: assessed.tokens,
            },
          },
          compaction: {
            compactId,
            inputMessageCount: built.messages.length,
            outputMessageCount: messages.length,
            messages,
            inputTokens: assessed.tokens,
          },
          ...(summaryObservation ? { modelObservations: [summaryObservation] } : {}),
        }
      } catch (error) {
        breakers.set(key, breakerOnFailure(breaker))
        traceSink.record({
          name: "execution.context",
          phase: "failed",
          sessionId: input.sessionId,
          trace,
          timestamp: new Date().toISOString(),
          durationMs: Math.round(performance.now() - startedAt),
          attributes: { stage: "compact" },
        })
        throw error
      }
    },
  }
}

function emptyProvenance(requestContextCount: number) {
  return { requestContextCount, memoryNames: [], skillNames: [] }
}
