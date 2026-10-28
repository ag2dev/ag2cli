import { z } from "zod"
import { iso8601TimestampSchema, nonEmptyStringSchema, nonNegativeIntegerSchema, positiveIntegerSchema } from "./primitives.js"

// Unified pending-interaction DTOs: tool approvals and ask_user cards share
// only the envelope fields below; payload fields are never shared, so the
// two kinds are two independent object schemas rather than a merged base
// class with refinements.

export const publicClientKindSchema = z.enum(["tui", "web", "mobile", "desktop", "acp", "script", "unknown"])
export type PublicClientKind = z.infer<typeof publicClientKindSchema>

const interactionEnvelope = {
  interactionId: nonEmptyStringSchema("interaction.interactionId"),
  sessionId: nonEmptyStringSchema("interaction.sessionId"),
  runId: nonEmptyStringSchema("interaction.runId"),
  turn: positiveIntegerSchema("interaction.turn"),
  createdAt: iso8601TimestampSchema("interaction.createdAt"),
}

export const publicApprovalOptionSchema = z.object({
  optionId: nonEmptyStringSchema("interaction.option.optionId"),
  label: z.string(),
  outcome: z.enum(["approve_once", "deny"]),
})
export type PublicApprovalOption = z.infer<typeof publicApprovalOptionSchema>

// Delegation spawn profile for agent-tool approvals.
export const publicAgentProfileSchema = z.object({
  subagentType: nonEmptyStringSchema("interaction.subject.agentProfile.subagentType"),
  model: z.string().optional(),
})
export type PublicAgentProfile = z.infer<typeof publicAgentProfileSchema>

export const publicApprovalSubjectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_call"),
    toolName: nonEmptyStringSchema("interaction.subject.toolName"),
    summary: z.string(),
    command: z.string().optional(),
    workspaceId: nonEmptyStringSchema("interaction.subject.workspaceId").optional(),
    path: z.string().optional(),
    diff: z.string().optional(),
    pattern: z.string().optional(),
    url: z.string().optional(),
    agentProfile: publicAgentProfileSchema.optional(),
    // Bounded pre-decision prompt excerpt for delegation asks.
    inputExcerpt: z.string().max(600).optional(),
  }),
  z.object({
    type: z.literal("command"),
    command: nonEmptyStringSchema("interaction.subject.command"),
    workspaceId: nonEmptyStringSchema("interaction.subject.workspaceId"),
    cwdRelative: nonEmptyStringSchema("interaction.subject.cwdRelative"),
  }),
])
export type PublicApprovalSubject = z.infer<typeof publicApprovalSubjectSchema>

export const publicToolApprovalInteractionSchema = z.object({
  ...interactionEnvelope,
  kind: z.literal("tool_approval"),
  toolCallId: nonEmptyStringSchema("interaction.toolCallId"),
  title: z.string(),
  description: z.string().optional(),
  subject: publicApprovalSubjectSchema,
  options: z.array(publicApprovalOptionSchema),
  policyRevision: nonNegativeIntegerSchema("interaction.policyRevision"),
  scopeRevision: nonNegativeIntegerSchema("interaction.scopeRevision"),
  // Who owns answering; guardian-held approvals raise no human card.
  ownedBy: z.enum(["user", "guardian"]).optional(),
})
export type PublicToolApprovalInteraction = z.infer<typeof publicToolApprovalInteractionSchema>

// Reserved discriminator for free-text / form elicitation. v1 always behaves
// as "selection"; the field is omitted on the wire and defaults to selection
// when parsed.
export const publicAskUserInputModeSchema = z.enum(["selection", "text", "form"])
export type PublicAskUserInputMode = z.infer<typeof publicAskUserInputModeSchema>

export const publicAskUserOptionSchema = z.object({
  optionId: nonEmptyStringSchema("interaction.option.optionId"),
  label: z.string(),
  description: z.string().optional(),
})
export type PublicAskUserOption = z.infer<typeof publicAskUserOptionSchema>

export const publicAskUserQuestionSchema = z.object({
  questionId: nonEmptyStringSchema("interaction.question.questionId"),
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean(),
  options: z.array(publicAskUserOptionSchema),
})
export type PublicAskUserQuestion = z.infer<typeof publicAskUserQuestionSchema>

export const publicAskUserInteractionSchema = z.object({
  ...interactionEnvelope,
  kind: z.literal("ask_user"),
  questions: z.array(publicAskUserQuestionSchema),
  inputMode: publicAskUserInputModeSchema.optional(),
})
export type PublicAskUserInteraction = z.infer<typeof publicAskUserInteractionSchema>

export const publicPendingInteractionSchema = z.discriminatedUnion("kind", [
  publicToolApprovalInteractionSchema,
  publicAskUserInteractionSchema,
])
export type PublicPendingInteraction = z.infer<typeof publicPendingInteractionSchema>

export const publicInteractionOutcomeSchema = z.enum(["approved", "denied", "answered", "chat", "declined", "expired"])
export type PublicInteractionOutcome = z.infer<typeof publicInteractionOutcomeSchema>

export const publicInteractionResolverSchema = z.object({
  clientName: z.string(),
  clientKind: publicClientKindSchema,
})
export type PublicInteractionResolver = z.infer<typeof publicInteractionResolverSchema>

// Free-text answers accompany per-question selections on answered and chat outcomes.
export const publicAskUserFreeTextSchema = z.object({
  questionId: nonEmptyStringSchema("answer.freeText.questionId"),
  text: z.string(),
})
export type PublicAskUserFreeText = z.infer<typeof publicAskUserFreeTextSchema>

export const publicAskUserSelectionSchema = z.object({
  questionId: nonEmptyStringSchema("answer.selection.questionId"),
  selectedOptionIds: z.array(nonEmptyStringSchema("answer.selectedOptionId")),
})
export type PublicAskUserSelection = z.infer<typeof publicAskUserSelectionSchema>

// Attribution of the resolving party; the client identity (`resolvedBy`)
// is legal only when resolver is "client".
export const publicInteractionResolverKindSchema = z.enum(["client", "guardian", "system"])
export type PublicInteractionResolverKind = z.infer<typeof publicInteractionResolverKindSchema>

export const publicInteractionResolutionSchema = z.object({
  interactionId: nonEmptyStringSchema("resolution.interactionId"),
  kind: z.enum(["tool_approval", "ask_user"]),
  outcome: publicInteractionOutcomeSchema,
  resolvedAt: iso8601TimestampSchema("resolution.resolvedAt"),
  resolver: publicInteractionResolverKindSchema.optional(),
  resolvedBy: publicInteractionResolverSchema.optional(),
  // Per-question selections; present only on answered ask_user resolutions.
  answers: z.array(publicAskUserSelectionSchema).optional(),
  freeText: z.array(publicAskUserFreeTextSchema).optional(),
  // Chat carries an independently partial, ID-addressed context answer set.
  contextAnswers: z.array(publicAskUserSelectionSchema).optional(),
  contextFreeText: z.array(publicAskUserFreeTextSchema).optional(),
})
export type PublicInteractionResolution = z.infer<typeof publicInteractionResolutionSchema>

export const publicAskUserAnswerSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("answered"),
    answers: z.array(publicAskUserSelectionSchema),
    freeText: z.array(publicAskUserFreeTextSchema).optional(),
  }),
  z.object({
    outcome: z.literal("chat"),
    answers: z.array(publicAskUserSelectionSchema).optional(),
    freeText: z.array(publicAskUserFreeTextSchema).optional(),
  }),
  z.object({ outcome: z.literal("declined") }),
])
export type PublicAskUserAnswer = z.infer<typeof publicAskUserAnswerSchema>
