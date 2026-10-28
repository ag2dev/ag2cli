import { z } from "zod"
import { publicInteractionResolutionSchema, publicAskUserAnswerSchema } from "./interactions.js"
import { publicMessageSchema } from "./snapshot.js"
import {
  booleanSchema,
  freeformStringArraySchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
} from "./primitives.js"

// v1 params/result schemas for the input write group
// (`session.submit`/`steer`/`cancelRun`/`cancelInput`/`messages`). Acceptance
// is mailbox admission, never a model-turn completion: submit and steer
// return the input identity plus the queued fact, later failures arrive as
// durable `input.failed`. Cancellations report the requested state without
// claiming completion — the terminal fact is `run.updated`/`input.updated`.
// Submit carries no server-owned intent parsing: text is always a prompt and
// slash grammars ride dedicated typed methods.

export const DEFAULT_MESSAGES_LIMIT = 50
export const MAX_MESSAGES_LIMIT = 200

function boundedIntegerSchema(name: string, min: number, max: number): z.ZodNumber {
  const message = `${name} must be an integer between ${min} and ${max}`
  return z.number({ invalid_type_error: message, required_error: message }).int({ message }).min(min, { message }).max(max, { message })
}

const composerLeaseSchema = z
  .object({
    scope: z.literal("composer", { errorMap: () => ({ message: "lease.scope must be composer for session.submit" }) }),
    generation: positiveIntegerSchema("lease.generation"),
  })
  .strict()

const fileReferenceSchema = z
  .object({
    workspaceId: nonEmptyStringSchema("fileReference.workspaceId"),
    path: nonEmptyStringSchema("fileReference.path"),
  })
  .strict()

export const sessionSubmitParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
    commandId: nonEmptyStringSchema("commandId"),
    text: z.string({ invalid_type_error: "text must be a string" }),
    fileReferences: z.array(fileReferenceSchema, { invalid_type_error: "fileReferences must be a file reference array" }).optional(),
    context: freeformStringArraySchema("context").optional(),
    maxTurns: positiveIntegerSchema("maxTurns").optional(),
    expectedRevision: nonNegativeIntegerSchema("expectedRevision").optional(),
    lease: composerLeaseSchema.optional(),
  })
  .strict()
export type SessionSubmitParams = z.infer<typeof sessionSubmitParamsSchema>

export const sessionSteerParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
    runId: nonEmptyStringSchema("runId"),
    commandId: nonEmptyStringSchema("commandId"),
    text: z.string({ invalid_type_error: "text must be a string" }),
  })
  .strict()
export type SessionSteerParams = z.infer<typeof sessionSteerParamsSchema>

export const sessionCancelRunParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
    runId: nonEmptyStringSchema("runId"),
  })
  .strict()
export type SessionCancelRunParams = z.infer<typeof sessionCancelRunParamsSchema>

export const sessionCancelInputParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
    inputId: nonEmptyStringSchema("inputId"),
  })
  .strict()
export type SessionCancelInputParams = z.infer<typeof sessionCancelInputParamsSchema>

export const sessionMessagesParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("sessionId"),
    before: nonEmptyStringSchema("before").optional(),
    limit: boundedIntegerSchema("limit", 1, MAX_MESSAGES_LIMIT).optional(),
  })
  .strict()
export type SessionMessagesParams = z.infer<typeof sessionMessagesParamsSchema>

/** Submit and steer share the admission result; steer's `queued` is always
 * true (it targets a running run), which is a semantic invariant asserted by
 * handler tests, not a schema fact. */
export const sessionInputAdmissionResultSchema = z
  .object({
    accepted: z.literal(true, { errorMap: () => ({ message: "accepted must be literal true" }) }),
    sessionId: nonEmptyStringSchema("result.sessionId"),
    commandId: nonEmptyStringSchema("result.commandId"),
    inputId: nonEmptyStringSchema("result.inputId"),
    queued: booleanSchema("result.queued"),
  })
  .strict()
export type SessionInputAdmissionResult = z.infer<typeof sessionInputAdmissionResultSchema>

export const sessionSubmitResultSchema = sessionInputAdmissionResultSchema
export type SessionSubmitResult = SessionInputAdmissionResult

export const sessionSteerResultSchema = sessionInputAdmissionResultSchema
export type SessionSteerResult = SessionInputAdmissionResult

/** `requested === (state === "requested")` always holds; cancellation states
 * beyond `requested` (`already_terminal`, `not_found`) are facts, not errors. */
export const sessionCancellationResultSchema = z
  .object({
    requested: booleanSchema("result.requested"),
    state: z.enum(["requested", "already_terminal", "not_found"], {
      errorMap: () => ({ message: "state must be requested, already_terminal or not_found" }),
    }),
  })
  .strict()
export type SessionCancellationResult = z.infer<typeof sessionCancellationResultSchema>

export const sessionCancelRunResultSchema = sessionCancellationResultSchema
export type SessionCancelRunResult = SessionCancellationResult

export const sessionCancelInputResultSchema = sessionCancellationResultSchema
export type SessionCancelInputResult = SessionCancellationResult

/**
 * One deep-history page in chronological order: the `limit` messages oldest
 * after the exclusive `before` anchor (or the newest `limit` messages when
 * `before` is absent). `nextBefore` is the oldest messageId of the page and
 * appears exactly when older messages remain.
 */
export const sessionMessagesResultSchema = z
  .object({
    messages: z.array(publicMessageSchema),
    nextBefore: nonEmptyStringSchema("result.nextBefore").optional(),
  })
  .strict()
export type SessionMessagesResult = z.infer<typeof sessionMessagesResultSchema>

// Unified interaction resolution (contract §11.5): one entry point for both
// interaction kinds. The two param variants share only the envelope fields;
// payload fields are never shared, so validation branches on `kind`. The
// `resolutionId` is the client's retry identity — idempotency itself is
// resource-keyed on (interactionId, kind) with canonical first-writer-wins.
export const sessionResolveInteractionParamsSchema = z.discriminatedUnion("kind", [
  z
    .object({
      sessionId: nonEmptyStringSchema("sessionId"),
      resolutionId: nonEmptyStringSchema("resolutionId"),
      kind: z.literal("tool_approval"),
      interactionId: nonEmptyStringSchema("interactionId"),
      optionId: nonEmptyStringSchema("optionId"),
      expectedPolicyRevision: nonNegativeIntegerSchema("expectedPolicyRevision").optional(),
      expectedScopeRevision: nonNegativeIntegerSchema("expectedScopeRevision").optional(),
    })
    .strict(),
  z
    .object({
      sessionId: nonEmptyStringSchema("sessionId"),
      resolutionId: nonEmptyStringSchema("resolutionId"),
      kind: z.literal("ask_user"),
      interactionId: nonEmptyStringSchema("interactionId"),
      answer: publicAskUserAnswerSchema,
    })
    .strict(),
])
export type SessionResolveInteractionParams = z.infer<typeof sessionResolveInteractionParamsSchema>

export const sessionResolveInteractionResultSchema = z
  .object({
    resolved: z.literal(true, { errorMap: () => ({ message: "resolved must be literal true" }) }),
    interactionId: nonEmptyStringSchema("result.interactionId"),
    kind: z.enum(["tool_approval", "ask_user"], {
      errorMap: () => ({ message: "kind must be tool_approval or ask_user" }),
    }),
    resolution: publicInteractionResolutionSchema,
  })
  .strict()
export type SessionResolveInteractionResult = z.infer<typeof sessionResolveInteractionResultSchema>
