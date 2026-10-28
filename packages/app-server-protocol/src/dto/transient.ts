import { z } from "zod"
import { iso8601TimestampSchema, nonEmptyStringSchema, positiveIntegerSchema } from "./primitives.js"

// Transient streaming events: best-effort, live-only, never replayed. The
// `sequence` counter is independent of the canonical revision and monotonic
// within a live stream. Unknown kinds are safely ignorable by design.

const transientEnvelope = {
  eventId: nonEmptyStringSchema("transient.eventId"),
  sessionId: nonEmptyStringSchema("transient.sessionId"),
  sequence: positiveIntegerSchema("transient.sequence"),
  timestamp: iso8601TimestampSchema("transient.timestamp"),
}

// Child attribution on the model stream kinds: present when the delta came
// from a delegated child session, absent on the parent's own stream.
const childAttribution = {
  childSessionId: nonEmptyStringSchema("transient.childSessionId").optional(),
}

export const publicTransientEventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...transientEnvelope,
    kind: z.literal("model_text_delta"),
    runId: nonEmptyStringSchema("transient.runId"),
    turn: positiveIntegerSchema("transient.turn"),
    text: z.string(),
    ...childAttribution,
  }),
  z.object({
    ...transientEnvelope,
    kind: z.literal("model_tool_call_start"),
    runId: nonEmptyStringSchema("transient.runId"),
    toolCallId: nonEmptyStringSchema("transient.toolCallId"),
    toolName: nonEmptyStringSchema("transient.toolName"),
    title: z.string(),
    ...childAttribution,
  }),
  z.object({
    ...transientEnvelope,
    kind: z.literal("model_tool_call_delta"),
    runId: nonEmptyStringSchema("transient.runId"),
    toolCallId: nonEmptyStringSchema("transient.toolCallId"),
    inputDelta: z.string(),
    ...childAttribution,
  }),
  z.object({
    ...transientEnvelope,
    kind: z.literal("model_tool_call_end"),
    runId: nonEmptyStringSchema("transient.runId"),
    toolCallId: nonEmptyStringSchema("transient.toolCallId"),
    ...childAttribution,
  }),
  z.object({
    ...transientEnvelope,
    kind: z.literal("tool_output_delta"),
    runId: nonEmptyStringSchema("transient.runId"),
    toolCallId: nonEmptyStringSchema("transient.toolCallId"),
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
  }),
  z.object({
    ...transientEnvelope,
    kind: z.literal("child_agent_started"),
    runId: nonEmptyStringSchema("transient.runId"),
    childSessionId: nonEmptyStringSchema("transient.childSessionId"),
    title: z.string().optional(),
    subagentType: nonEmptyStringSchema("transient.subagentType").optional(),
    toolUseId: nonEmptyStringSchema("transient.toolUseId").optional(),
  }),
])
export type PublicTransientEvent = z.infer<typeof publicTransientEventSchema>

export const publicTransientKindSchema = z.enum([
  "model_text_delta",
  "model_tool_call_start",
  "model_tool_call_delta",
  "model_tool_call_end",
  "tool_output_delta",
  "child_agent_started",
])
export type PublicTransientKind = z.infer<typeof publicTransientKindSchema>

// Reserved names for future kinds. Held so later additions cannot collide
// with an already-shipped meaning; no implementation is promised.
export const RESERVED_TRANSIENT_KINDS = ["model_thought_delta", "task_output_delta"] as const
export type ReservedTransientKind = (typeof RESERVED_TRANSIENT_KINDS)[number]
