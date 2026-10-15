/**
 * Model summarizer: wraps a model call as the summarize capability for context compaction.
 *
 * Moved down from composition/agent-server; the observability policy determines
 * whether it returns plain text or includes the full ModelCallObservation.
 */

import type { CanonicalModelRequest } from "@ag2cli/core/model/observation.js"
import type { ExecutionModelProvider } from "../../ports/execution-model-provider.js"
import { ModelCallObservationError, type ObservabilityPolicy } from "../../ports/observability.js"
import type { ContextSummaryInput, ContextSummaryResult } from "../../ports/context-compactor.js"
import { defaultRuntimeIdentity, type RuntimeIdentity } from "../../ports/identity.js"

export type ModelSummarizer = (input: ContextSummaryInput) => Promise<string | ContextSummaryResult>

export function createModelSummarizer(
  model: ExecutionModelProvider,
  observability: ObservabilityPolicy,
  identity: RuntimeIdentity = defaultRuntimeIdentity,
): ModelSummarizer {
  return async ({ sessionId, runId, messages, signal }: ContextSummaryInput): Promise<string | ContextSummaryResult> => {
    const request: CanonicalModelRequest = { messages, tools: [] }
    const callId = `${sessionId}:compact:${identity.nextId()}`
    const startedAt = new Date().toISOString()
    const started = performance.now()
    let response: Awaited<ReturnType<ExecutionModelProvider["generate"]>> | undefined
    try {
      response = await model.generate({ sessionId, runId, messages, tools: [], signal })
      const text = response.message.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("")
      if (!observability.captureModelPayload) return text
      return {
        text,
        observation: {
          callId,
          purpose: "compact" as const,
          request: structuredClone(request),
          status: "succeeded" as const,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
          response: {
            content: structuredClone(response.message.content),
            ...(response.stop_reason ? { stopReason: response.stop_reason } : {}),
            ...(response.modelMetadata ? { metadata: response.modelMetadata } : {}),
          },
        },
      }
    } catch (error) {
      if (!observability.captureModelPayload) throw error
      const cancelled = signal?.aborted || (error instanceof Error && error.name === "AbortError")
      throw new ModelCallObservationError(error instanceof Error ? error.message : String(error), {
        callId,
        purpose: "compact",
        request: structuredClone(request),
        status: cancelled ? "cancelled" : "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        ...(response
          ? {
              response: {
                content: structuredClone(response.message.content),
                ...(response.stop_reason ? { stopReason: response.stop_reason } : {}),
                ...(response.modelMetadata ? { metadata: response.modelMetadata } : {}),
              },
            }
          : {}),
        error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}
