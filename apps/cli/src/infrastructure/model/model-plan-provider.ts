import { randomUUID } from "node:crypto"
import { flatText, type ModelClient } from "@ag2cli/runtime/ports/model/contract.js"
import { parsePlanDraft } from "@ag2cli/core/plan/schema.js"
import type { PlanGenerationInput, PlanGenerationResult, PlanProvider } from "@ag2cli/runtime/ports/model-provider.js"
import type { CanonicalModelRequest } from "@ag2cli/core/model/observation.js"
import { ModelCallObservationError } from "@ag2cli/runtime/ports/observability.js"
import { userText } from "@ag2cli/core/message.js"

const PLAN_SYSTEM_PROMPT = [
  "You are a model that only generates execution plans; do not run tools or modify code.",
  "Return a JSON object only. Do not include Markdown, explanatory text, or code fences.",
  'The JSON structure must be: {"goal":string,"summary":string,"steps":[{"id"?:string,"title":string,"description":string,"dependencies":string[]}],"risks":string[],"assumptions":string[]}',
  "steps must contain at least one step; dependencies may refer only to the IDs of other steps.",
]

/** Model adapter for the plan-only port. Provider SDK details stay outside the port. */
export class ModelPlanProvider implements PlanProvider {
  constructor(private readonly client: ModelClient) {}

  async generatePlan(input: PlanGenerationInput): Promise<PlanGenerationResult> {
    const request: CanonicalModelRequest = {
      systemPrompt: PLAN_SYSTEM_PROMPT,
      maxTokens: 4000,
      tools: [],
      messages: [
        userText(
          [
            `session_id: ${input.sessionId}`,
            `goal: ${input.goal}`,
            "context:",
            ...input.context.map((item) => `- ${item}`),
            "Generate a structured plan based on the information above.",
          ].join("\n"),
        ),
      ],
    }
    const callId = `${input.sessionId}:plan:${randomUUID()}`
    const startedAt = new Date().toISOString()
    const started = performance.now()
    let response
    try {
      response = await this.client.call({
        ...request,
        // ModelClient accepts readonly canonical messages but owns protocol conversion.
        messages: [...request.messages],
        tools: [...request.tools],
      })
      if (input.signal?.aborted) throw abortError()
      const text = flatText(response.message.content).trim()
      if (text.length === 0) throw new Error("The model returned no plan content")
      const draft = parsePlanDraft(parseJsonObject(text))
      const completedAt = new Date().toISOString()
      return {
        ...draft,
        modelCall: {
          callId,
          purpose: "plan",
          request: structuredClone(request),
          status: "succeeded",
          startedAt,
          completedAt,
          durationMs: Math.round(performance.now() - started),
          response: {
            content: structuredClone(response.message.content),
            ...(response.stop_reason ? { stopReason: response.stop_reason } : {}),
            ...(response.modelMetadata ? { metadata: response.modelMetadata } : {}),
          },
        },
      }
    } catch (error) {
      const cancelled = input.signal?.aborted || isAbortError(error)
      const completedAt = new Date().toISOString()
      const message = error instanceof Error ? error.message : String(error)
      const observation = {
        callId,
        purpose: "plan" as const,
        request: structuredClone(request),
        status: cancelled ? ("cancelled" as const) : ("failed" as const),
        startedAt,
        completedAt,
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
        error: { name: error instanceof Error ? error.name : "Error", message },
      }
      throw new ModelCallObservationError(message, observation)
    }
  }
}

function abortError(): Error {
  const error = new Error("Plan model call was cancelled")
  error.name = "AbortError"
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]
  const candidate = fenced ?? text
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start < 0 || end <= start) {
      throw new Error("The plan returned by the model is not valid JSON")
    }
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      throw new Error("The plan returned by the model is not valid JSON")
    }
  }
}
