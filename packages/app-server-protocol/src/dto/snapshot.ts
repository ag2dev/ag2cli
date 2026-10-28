import { z } from "zod"
import { publicPendingInteractionSchema } from "./interactions.js"
import { iso8601TimestampSchema, nonEmptyStringSchema, nonNegativeIntegerSchema, positiveIntegerSchema } from "./primitives.js"

// Public session snapshot DTOs. Timestamps are ISO-8601 strings; internal
// facts (writer epochs, hash chains, request fingerprints, provider
// metadata, security preparation records) never appear on these shapes.

export const publicSessionStatusSchema = z.enum(["created", "planning", "plan_ready", "running", "completed", "failed", "cancelled"])
export type PublicSessionStatus = z.infer<typeof publicSessionStatusSchema>

export const publicForegroundStateSchema = z.enum(["idle", "running", "requires_action"])
export type PublicForegroundState = z.infer<typeof publicForegroundStateSchema>

export const publicRunPhaseSchema = z.enum(["thinking", "tool_execution", "waiting_for_approval", "waiting_for_user"])
export type PublicRunPhase = z.infer<typeof publicRunPhaseSchema>

export const publicRunStatusSchema = z.enum(["running", "completed", "failed", "cancelled"])
export type PublicRunStatus = z.infer<typeof publicRunStatusSchema>

export const publicPermissionModeSchema = z.enum(["manual", "accept-edits", "plan", "full-access", "auto"])
export type PublicPermissionModeValue = z.infer<typeof publicPermissionModeSchema>

export const publicWorkspaceAvailabilitySchema = z.enum(["available", "unavailable"])
export type PublicWorkspaceAvailability = z.infer<typeof publicWorkspaceAvailabilitySchema>

export const publicFailureSchema = z.object({
  code: nonEmptyStringSchema("failure.code"),
  message: z.string(),
  retryable: z.boolean(),
})
export type PublicFailure = z.infer<typeof publicFailureSchema>

export const publicInputKindSchema = z.enum(["prompt", "steer", "notification"])
export type PublicInputKind = z.infer<typeof publicInputKindSchema>

export const publicInputStatusSchema = z.enum(["queued", "consumed", "cancelled", "failed"])
export type PublicInputStatus = z.infer<typeof publicInputStatusSchema>

export const publicInputSnapshotSchema = z.object({
  inputId: nonEmptyStringSchema("input.inputId"),
  commandId: nonEmptyStringSchema("input.commandId"),
  kind: publicInputKindSchema,
  status: publicInputStatusSchema,
  acceptedAt: iso8601TimestampSchema("input.acceptedAt"),
  runId: nonEmptyStringSchema("input.runId").optional(),
  // Full mailbox text, never a truncated preview; cancelReason appears only
  // on status "cancelled" (source: InputCancellationRequested.reason).
  text: z.string(),
  cancelReason: z.string().optional(),
})
export type PublicInputSnapshot = z.infer<typeof publicInputSnapshotSchema>

export const publicContentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("file_reference"),
    workspaceId: nonEmptyStringSchema("block.workspaceId"),
    path: nonEmptyStringSchema("block.path"),
    displayName: z.string(),
  }),
])
export type PublicContentBlock = z.infer<typeof publicContentBlockSchema>

/**
 * Lenient counterpart to {@link publicContentBlockSchema}: the block-type
 * directory is closed for v1, but future servers may add block types, and a
 * client must never fail on an unknown block -- it renders placeholder text
 * instead. Unknown `type` values (and malformed payloads) map to a text
 * block carrying a stable, non-localizable placeholder.
 */
export function parsePublicContentBlock(value: unknown): PublicContentBlock {
  const parsed = publicContentBlockSchema.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }
  const type =
    typeof value === "object" && value !== null && "type" in value && typeof (value as { type: unknown }).type === "string"
      ? (value as { type: string }).type
      : "unknown"
  return { type: "text", text: `unsupported content block: ${type}` }
}

export const publicMessageSchema = z.object({
  messageId: nonEmptyStringSchema("message.messageId"),
  role: z.enum(["user", "assistant"]),
  runId: nonEmptyStringSchema("message.runId").optional(),
  createdAt: iso8601TimestampSchema("message.createdAt"),
  content: z.array(publicContentBlockSchema),
  // Turn attribution and model-call duration; assistant messages only.
  turn: positiveIntegerSchema("message.turn").optional(),
  durationMs: nonNegativeIntegerSchema("message.durationMs").optional(),
})
export type PublicMessage = z.infer<typeof publicMessageSchema>

export const publicToolCallStatusSchema = z.enum(["requested", "awaiting_approval", "running", "completed", "failed", "denied"])
export type PublicToolCallStatus = z.infer<typeof publicToolCallStatusSchema>

// Structured patch facts: counts plus a rendered unified-diff-style text.
// `truncated` reports the source cap when the preview omits hunks.
export const publicToolDiffSchema = z.object({
  additions: nonNegativeIntegerSchema("toolCall.diff.additions"),
  deletions: nonNegativeIntegerSchema("toolCall.diff.deletions"),
  sites: nonNegativeIntegerSchema("toolCall.diff.sites"),
  patch: z.string(),
  truncated: z.boolean().optional(),
})
export type PublicToolDiff = z.infer<typeof publicToolDiffSchema>

// Structured denial: a stable machine code plus optional bounded display reason.
export const publicToolDenialSchema = z.object({
  code: nonEmptyStringSchema("toolCall.denial.code"),
  reason: z.string().optional(),
})
export type PublicToolDenial = z.infer<typeof publicToolDenialSchema>

export const publicToolCallSchema = z.object({
  toolCallId: nonEmptyStringSchema("toolCall.toolCallId"),
  runId: nonEmptyStringSchema("toolCall.runId"),
  toolName: nonEmptyStringSchema("toolCall.toolName"),
  title: z.string(),
  status: publicToolCallStatusSchema,
  turn: positiveIntegerSchema("toolCall.turn").optional(),
  startedAt: iso8601TimestampSchema("toolCall.startedAt").optional(),
  completedAt: iso8601TimestampSchema("toolCall.completedAt").optional(),
  interactionId: nonEmptyStringSchema("toolCall.interactionId").optional(),
  // Server-rendered full input (JSON.stringify(input, null, 2)) and full
  // result text; resultSummary stays for compact listings.
  input: z.string().optional(),
  result: z.string().optional(),
  resultSummary: z.string().optional(),
  diff: publicToolDiffSchema.optional(),
  denial: publicToolDenialSchema.optional(),
  isError: z.boolean().optional(),
  questionOutcome: z.string().optional(),
  // Delegation lineage from ToolResult.metadata; childRunId absent on an
  // async spawn's immediate handle result.
  childSessionId: nonEmptyStringSchema("toolCall.childSessionId").optional(),
  childRunId: nonEmptyStringSchema("toolCall.childRunId").optional(),
})
export type PublicToolCall = z.infer<typeof publicToolCallSchema>

export const publicPlanStatusSchema = z.enum(["proposed", "active", "completed", "abandoned"])
export type PublicPlanStatus = z.infer<typeof publicPlanStatusSchema>

// Identity mapping of the internal PlanStepStatus closure; the runtime has
// no step-completion lifecycle, so no completion value exists to invent.
export const publicPlanStepStatusSchema = z.enum(["pending", "blocked", "ready"])
export type PublicPlanStepStatus = z.infer<typeof publicPlanStepStatusSchema>

export const publicPlanStepSchema = z.object({
  order: nonNegativeIntegerSchema("plan.step.order"),
  title: z.string(),
  status: publicPlanStepStatusSchema,
  description: z.string().optional(),
})
export type PublicPlanStep = z.infer<typeof publicPlanStepSchema>

export const publicPlanSummarySchema = z.object({
  planId: nonEmptyStringSchema("plan.planId"),
  title: z.string().optional(),
  status: publicPlanStatusSchema,
  totalSteps: nonNegativeIntegerSchema("plan.totalSteps"),
  completedSteps: nonNegativeIntegerSchema("plan.completedSteps"),
  steps: z.array(publicPlanStepSchema).optional(),
  updatedAt: iso8601TimestampSchema("plan.updatedAt"),
})
export type PublicPlanSummary = z.infer<typeof publicPlanSummarySchema>

export const publicTaskKindSchema = z.enum(["agent", "shell", "user_shell"])
export type PublicTaskKind = z.infer<typeof publicTaskKindSchema>

export const publicTaskStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"])
export type PublicTaskStatus = z.infer<typeof publicTaskStatusSchema>

export const publicTaskSummarySchema = z.object({
  taskId: nonEmptyStringSchema("task.taskId"),
  kind: publicTaskKindSchema,
  title: z.string(),
  status: publicTaskStatusSchema,
  progress: z.number().optional(),
  updatedAt: iso8601TimestampSchema("task.updatedAt"),
})
export type PublicTaskSummary = z.infer<typeof publicTaskSummarySchema>

// Derived usage aggregate from the last committed model response — not raw
// provider metadata (no request ids ride on this shape).
export const publicRunUsageSchema = z.object({
  model: z.string().optional(),
  inputTokens: nonNegativeIntegerSchema("run.usage.inputTokens").optional(),
  estimated: z.boolean().optional(),
})
export type PublicRunUsage = z.infer<typeof publicRunUsageSchema>

export const publicRunSnapshotSchema = z.object({
  runId: nonEmptyStringSchema("run.runId"),
  status: publicRunStatusSchema,
  turn: positiveIntegerSchema("run.turn"),
  startedAt: iso8601TimestampSchema("run.startedAt"),
  completedAt: iso8601TimestampSchema("run.completedAt").optional(),
  // The run's pending goal; a leading "!" is the client-side shell-run
  // convention (the wire carries the raw goal text).
  goal: z.string().optional(),
  phase: publicRunPhaseSchema,
  activeTool: z
    .object({
      toolCallId: nonEmptyStringSchema("run.activeTool.toolCallId"),
      toolName: nonEmptyStringSchema("run.activeTool.toolName"),
      title: z.string(),
      startedAt: iso8601TimestampSchema("run.activeTool.startedAt").optional(),
    })
    .optional(),
  usage: publicRunUsageSchema.optional(),
  failure: publicFailureSchema.optional(),
})
export type PublicRunSnapshot = z.infer<typeof publicRunSnapshotSchema>

export const publicSessionSnapshotSchema = z.object({
  sessionId: nonEmptyStringSchema("snapshot.sessionId"),
  // Canonical cursor: a session that has not appended any event yet sits at 0.
  asOfRevision: nonNegativeIntegerSchema("snapshot.asOfRevision"),
  status: publicSessionStatusSchema,
  title: z.string().optional(),
  updatedAt: iso8601TimestampSchema("snapshot.updatedAt"),
  foreground: z.object({
    state: publicForegroundStateSchema,
    runId: nonEmptyStringSchema("snapshot.foreground.runId").optional(),
    phase: publicRunPhaseSchema.optional(),
  }),
  workspace: z.object({
    workspaceId: nonEmptyStringSchema("snapshot.workspace.workspaceId"),
    displayName: z.string(),
    availability: publicWorkspaceAvailabilitySchema,
    // Workspace-relative additional directories; the absolute root never
    // rides the wire.
    additionalDirectories: z.array(z.string()).optional(),
  }),
  security: z.object({
    permissionMode: publicPermissionModeSchema,
    policyRevision: nonNegativeIntegerSchema("snapshot.security.policyRevision"),
    hasCustomRules: z.boolean(),
    selectableModes: z.array(publicPermissionModeSchema),
  }),
  currentRun: publicRunSnapshotSchema.optional(),
  inputs: z
    .array(publicInputSnapshotSchema)
    .describe("Session mailbox projection in FIFO consumption order: queued inputs first, then bounded recently terminated inputs."),
  pendingInteractions: z.array(publicPendingInteractionSchema),
  activePlan: publicPlanSummarySchema.optional(),
  activeTasks: z.array(publicTaskSummarySchema),
  recentMessages: z.array(publicMessageSchema).optional(),
  lastError: publicFailureSchema.optional(),
})
export type PublicSessionSnapshot = z.infer<typeof publicSessionSnapshotSchema>

export const publicSessionSummarySchema = z.object({
  sessionId: nonEmptyStringSchema("summary.sessionId"),
  title: z.string().optional(),
  status: publicSessionStatusSchema,
  workspace: z.object({
    workspaceId: nonEmptyStringSchema("summary.workspace.workspaceId"),
    displayName: z.string(),
    availability: publicWorkspaceAvailabilitySchema,
  }),
  updatedAt: iso8601TimestampSchema("summary.updatedAt"),
  archivedAt: iso8601TimestampSchema("summary.archivedAt").optional(),
})
export type PublicSessionSummary = z.infer<typeof publicSessionSummarySchema>
