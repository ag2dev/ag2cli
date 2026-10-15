import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { Plan } from "@ag2cli/core/plan/plan.js"

export interface AcpTextContent {
  readonly type: "text"
  readonly text: string
}

export interface AcpSessionUpdate {
  readonly sessionId: string
  readonly update: {
    readonly sessionUpdate: "agent_message_chunk"
    readonly content: AcpTextContent
  }
}

/** Project canonical plan results into ACP's streaming agent message update. */
export function projectAgentEventToAcp(event: AgentEvent): readonly AcpSessionUpdate[] {
  switch (event.type) {
    case "PlanCreated":
      return [textUpdate(event.sessionId, renderPlan(event.payload))]
    case "PlanGenerationFailed":
      return [textUpdate(event.sessionId, `Plan generation failed: ${event.payload.message}`)]
    case "PlanGenerationCancelled":
      return [textUpdate(event.sessionId, `Plan generation cancelled: ${event.payload.reason ?? "User cancelled"}`)]
    default:
      return []
  }
}

function textUpdate(sessionId: string, text: string): AcpSessionUpdate {
  return { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }
}

function renderPlan(plan: Plan): string {
  return JSON.stringify(plan)
}
