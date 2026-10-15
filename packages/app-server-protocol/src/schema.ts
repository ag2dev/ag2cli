import { z, type ZodType } from "zod"
import {
  APP_SERVER_INTERACTION_LEASE_SCOPES,
  APP_SERVER_METHODS,
  APP_SERVER_NOTIFICATION_METHODS,
  type AppServerMethod,
  type AppServerNotificationMethod,
} from "./types.js"
import { APP_SERVER_ERROR_CODES } from "./error-codes.js"
import { booleanSchema, clientKindSchema, freeformStringArraySchema, permissionModeSchema, scopeSchema } from "./validation.js"

/**
 * Standalone, purely descriptive Zod schemas for every App Server wire method's params (and the
 * handful of notification payloads that have no runtime parser yet). These schemas describe the
 * *structural* wire contract -- the same "same input, same accept/reject verdict" property the
 * imperative parsers in `validation.ts`/`app-server-rpc.ts` already enforce -- so it can drive
 * JSON Schema generation for non-TypeScript clients via `zod-to-json-schema`.
 *
 * They intentionally do not replace the imperative parsers: a few wire methods reject a
 * shape-correct payload only after cross-referencing runtime business context the bare wire
 * shape cannot see (e.g. `session.command`'s action-to-scope matrix, or `interaction.renew`'s
 * lease-generation requirement, which lives in the RPC handler's per-method dispatch rather than
 * the shared params parser). Those business-rule boundaries are captured precisely where the
 * boundary actually sits: `interactionScopedParamsSchema(method)` requires `leaseGeneration` for
 * `interaction.renew`/`release` (a true wire-level fact, even though the current TypeScript
 * implementation enforces it via a second function call), while the `session.command` schema
 * deliberately does NOT encode the scope matrix, matching the golden fixtures'
 * `rejectedBy: "handler"` cases.
 */

// `validation.ts`'s `nonEmptyStringSchema`/`nonNegativeIntegerSchema`/`positiveIntegerSchema`/
// `nonEmptyStringArraySchema` express their constraints via `.refine()` (and, for the array
// case, `.transform()`), which `zod-to-json-schema` cannot translate into a JSON Schema
// constraint -- it silently degrades a refined `z.string()` to a bare `{"type": "string"}`,
// losing "must be non-empty" entirely. This module intentionally defines its own equivalents
// using Zod's *native* `.min()`/`.max()`/`.int()`/`.regex()` constraints, which
// `zod-to-json-schema` maps to real JSON Schema keywords (`minLength`, `minimum`, `pattern`,
// etc). The `\\S` pattern mirrors the runtime parsers' `trim().length > 0` verdict, including
// rejection of whitespace-only strings.
// Concrete Zod subtypes (not the generic `ZodType` base) are returned deliberately, so callers
// can keep chaining native constraints like `.max()` (e.g. `session.command`'s `compact`
// action's `instructions` length limit).
const wireString = () => z.string().min(1).regex(/\S/)
const wireNonNegativeInt = () => z.number().int().min(0)
const wirePositiveInt = () => z.number().int().min(1)
const wireStringArray = () => z.array(z.string().min(1).regex(/\S/))

const optionalNonEmptyString = (): ZodType<string | undefined> => wireString().optional()
const optionalNonNegativeInteger = (): ZodType<number | undefined> => wireNonNegativeInt().optional()

// ---------------------------------------------------------------------------
// server.* / device.*
// ---------------------------------------------------------------------------

const noParamsSchema = z.unknown()

const clientInfoParamSchema = z.object({
  clientId: wireString(),
  clientKind: clientKindSchema,
  name: wireString(),
  version: wireString(),
  capabilities: wireStringArray().optional(),
})

const serverInitializeParamsSchema = z.object({
  appServerProtocolVersion: z.literal(1),
  client: clientInfoParamSchema,
  device: z
    .object({
      deviceId: wireString(),
      challenge: optionalNonEmptyString(),
      signature: optionalNonEmptyString(),
    })
    .optional(),
  requestedScopes: z.array(scopeSchema).optional(),
  serverFingerprint: optionalNonEmptyString(),
  recovery: z
    .object({
      sessionId: optionalNonEmptyString(),
      afterRevision: optionalNonNegativeInteger(),
    })
    .optional(),
})

const deviceRevokeParamsSchema = z.object({ deviceId: wireString() })

// ---------------------------------------------------------------------------
// session.* read methods
// ---------------------------------------------------------------------------

const sessionListParamsSchema = z.object({ includeArchived: booleanSchema("includeArchived").optional() }).optional()

const sessionCreateParamsSchema = z.object({
  sessionId: optionalNonEmptyString(),
  workspaceId: wireString(),
  title: optionalNonEmptyString(),
})

const sessionGetParamsSchema = z.object({
  sessionId: wireString(),
  includeArchived: booleanSchema("includeArchived").optional(),
})

const sessionHistoryCursorSchema = z
  .object({
    sessionId: wireString(),
    branchId: wireString(),
    nodeId: wireString(),
    physicalRevision: wirePositiveInt(),
    recordHash: wireString(),
  })
  .strict()

/** Shared by `session.fork`/`session.archive`/`session.delete`; the scope is always fixed to
 * `session-control` at the wire level (a client sending any other scope here is always wrong,
 * independent of the action-to-scope matrix that governs `session.command`). */
const sessionControlLeaseSchema = z
  .object({
    scope: z.literal("session-control").optional(),
    generation: wireNonNegativeInt(),
  })
  .strict()

const sessionForkParamsSchema = z.object({
  sourceSessionId: wireString(),
  targetSessionId: optionalNonEmptyString(),
  cursor: sessionHistoryCursorSchema.optional(),
  title: optionalNonEmptyString(),
  lease: sessionControlLeaseSchema.optional(),
})

const sessionArchiveParamsSchema = z.object({
  sessionId: wireString(),
  lease: sessionControlLeaseSchema.optional(),
})

const sessionDeleteParamsSchema = z.object({
  sessionId: wireString(),
  lease: sessionControlLeaseSchema.optional(),
})

const sessionAttachParamsSchema = z.object({
  sessionId: wireString(),
  afterRevision: optionalNonNegativeInteger(),
  includeTransient: booleanSchema("includeTransient").optional(),
})

const sessionIdOnlyParamsSchema = z.object({ sessionId: wireString() })

const sessionReplayParamsSchema = z.object({
  sessionId: wireString(),
  afterRevision: optionalNonNegativeInteger(),
})

const sessionResyncParamsSchema = sessionReplayParamsSchema

const sessionModelCallsParamsSchema = z.object({
  sessionId: wireString(),
  includePayload: booleanSchema("includePayload").optional(),
})

// ---------------------------------------------------------------------------
// session.command action discriminated union
// ---------------------------------------------------------------------------

const permissionRuleSchema = z.object({
  // Ingest bound mirrored from core's SESSION_PERMISSION_RULE_NAME_MAX (128);
  // this package deliberately carries no @ag2cli/core dependency, so the
  // schema test pins the literal against drift.
  name: wireString().max(128),
  behavior: z.enum(["allow", "ask", "deny"]),
})

const goalUpdateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), text: wireString() }),
  z.object({ action: z.enum(["clear", "pause", "resume"]) }),
])

const argvSchema = z.array(z.string()).min(1)

/**
 * The v1 contract explicitly rejects the retired permission-profile fields instead of silently
 * dropping them: a client upgrading from the old vocabulary would otherwise believe it took
 * effect. `z.never().optional()` rejects the key when present, stays absent otherwise, and
 * exports to JSON Schema as `{"not":{}}` so the rejection survives zod-to-json-schema.
 */
const retiredPermissionKeys = {
  permissionProfile: z.never().optional(),
  permissionProfiles: z.never().optional(),
} as const

const sessionCommandActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("addDirectory"),
    directory: wireString(),
    workspaceRoot: optionalNonEmptyString(),
    expectedScopeRevision: optionalNonNegativeInteger(),
    ...retiredPermissionKeys,
  }),
  z.object({
    type: z.literal("setPermissionMode"),
    mode: permissionModeSchema,
    expectedPolicyRevision: optionalNonNegativeInteger(),
    ...retiredPermissionKeys,
  }),
  z.object({
    type: z.literal("setPermissionRules"),
    rules: z.array(permissionRuleSchema),
    expectedPolicyRevision: optionalNonNegativeInteger(),
    ...retiredPermissionKeys,
  }),
  z.object({
    type: z.literal("compact"),
    instructions: wireString().max(4_096).optional(),
    ...retiredPermissionKeys,
  }),
  z.object({
    type: z.literal("setContextWindow"),
    contextWindow: wirePositiveInt(),
    ...retiredPermissionKeys,
  }),
  z.object({ type: z.literal("clearContextWindow"), ...retiredPermissionKeys }),
  z.object({
    type: z.literal("setAgent"),
    agentName: optionalNonEmptyString(),
    ...retiredPermissionKeys,
  }),
  z.object({ type: z.literal("updateGoal"), update: goalUpdateSchema, ...retiredPermissionKeys }),
  z.object({
    type: z.literal("createTask"),
    taskType: z.enum(["agent", "shell", "loop"]),
    title: wireString(),
    prompt: optionalNonEmptyString(),
    argv: argvSchema.optional(),
    intervalMs: wirePositiveInt().optional(),
    maxRuns: wirePositiveInt().optional(),
    workspace: optionalNonEmptyString(),
    parentRunId: optionalNonEmptyString(),
    ...retiredPermissionKeys,
  }),
  z.object({ type: z.literal("listTasks"), ...retiredPermissionKeys }),
  z.object({
    type: z.literal("cancelTask"),
    taskId: wireString(),
    reason: optionalNonEmptyString(),
    ...retiredPermissionKeys,
  }),
  z.object({ type: z.literal("listCheckpoints"), ...retiredPermissionKeys }),
  z.object({
    type: z.literal("previewRewind"),
    checkpointId: wireString(),
    ...retiredPermissionKeys,
  }),
  z.object({
    type: z.literal("rewind"),
    checkpointId: wireString(),
    ...retiredPermissionKeys,
  }),
  z.object({
    type: z.literal("steer"),
    runId: wireString(),
    text: wireString(),
    ...retiredPermissionKeys,
  }),
  z.object({
    type: z.literal("cancelInput"),
    inputId: wireString(),
    reason: optionalNonEmptyString(),
    ...retiredPermissionKeys,
  }),
  z.object({
    type: z.literal("executeShell"),
    argv: argvSchema,
    cwd: optionalNonEmptyString(),
    timeoutMs: wirePositiveInt().optional(),
    ...retiredPermissionKeys,
  }),
  z.object({
    type: z.literal("executeUserShell"),
    command: wireString(),
    cwd: optionalNonEmptyString(),
    timeoutMs: wirePositiveInt().optional(),
    ...retiredPermissionKeys,
  }),
])

/** Deliberately permissive: this mirrors `parseSessionCommandParams`, which does not know about
 * the action-to-scope matrix (that check lives in the RPC handler), so a shape-correct `lease`
 * with the "wrong" scope for a given action is a `rejectedBy: "handler"` golden-fixture case,
 * not a schema-level rejection. */
const sessionCommandLeaseSchema = z
  .object({
    scope: z.enum(APP_SERVER_INTERACTION_LEASE_SCOPES),
    generation: wireNonNegativeInt(),
  })
  .strict()

const sessionCommandParamsSchema = z.object({
  sessionId: wireString(),
  commandId: wireString(),
  action: sessionCommandActionSchema,
  expectedRevision: optionalNonNegativeInteger(),
  lease: sessionCommandLeaseSchema.optional(),
  ...retiredPermissionKeys,
})

const sessionPlanParamsSchema = z.object({
  sessionId: wireString(),
  commandId: wireString(),
  text: wireString(),
  context: freeformStringArraySchema("context").optional(),
  workspace: optionalNonEmptyString(),
  expectedRevision: optionalNonNegativeInteger(),
  // `session.plan`'s lease scope is always fixed to `composer`.
  lease: z
    .object({
      scope: z.literal("composer").optional(),
      generation: wireNonNegativeInt(),
    })
    .strict()
    .optional(),
  ...retiredPermissionKeys,
})

const sessionSubmitParamsSchema = z.object({
  sessionId: wireString(),
  commandId: wireString(),
  text: wireString(),
  context: freeformStringArraySchema("context").optional(),
  fileReferences: freeformStringArraySchema("fileReferences").optional(),
  workspace: optionalNonEmptyString(),
  expectedRevision: optionalNonNegativeInteger(),
  lease: z
    .object({
      composer: wireNonNegativeInt().optional(),
      "session-control": wireNonNegativeInt().optional(),
    })
    .strict()
    .optional(),
  ...retiredPermissionKeys,
})

const sessionCancelParamsSchema = z.object({
  sessionId: wireString(),
  commandId: optionalNonEmptyString(),
  runId: optionalNonEmptyString(),
})

const sessionResolveApprovalParamsSchema = z.object({
  sessionId: wireString(),
  runId: wireString(),
  turn: wireNonNegativeInt(),
  toolUseId: wireString(),
  preparedEventId: wireString(),
  expectedScopeRevision: wireNonNegativeInt(),
  expectedPolicyRevision: wireNonNegativeInt(),
  decision: z.enum(["approved", "denied"]),
})

// ---------------------------------------------------------------------------
// interaction.* -- one schema per method, since `leaseGeneration` requiredness genuinely
// differs by method even though the current implementation enforces it via a second function
// (`requireLeaseGeneration`) called from the RPC handler's per-method switch, not from the
// shared `parseInteractionRequest`.
// ---------------------------------------------------------------------------

function interactionParamsSchema(leaseGenerationRequired: boolean): ZodType<unknown> {
  return z.object({
    sessionId: wireString(),
    scope: z.enum(APP_SERVER_INTERACTION_LEASE_SCOPES),
    leaseGeneration: leaseGenerationRequired ? wireNonNegativeInt() : wireNonNegativeInt().optional(),
    ttlMs: wireNonNegativeInt().optional(),
  })
}

const interactionAcquireParamsSchema = interactionParamsSchema(false)
const interactionRenewParamsSchema = interactionParamsSchema(true)
const interactionReleaseParamsSchema = interactionParamsSchema(true)
const interactionTakeoverParamsSchema = interactionParamsSchema(false)

// ---------------------------------------------------------------------------
// Notifications are descriptive JSON Schema deliverables.
// ---------------------------------------------------------------------------

const presenceClientSchema = z.object({
  connectionId: wireString(),
  deviceId: wireString(),
  clientId: wireString(),
  clientKind: clientKindSchema,
  name: wireString(),
  version: optionalNonEmptyString(),
})

const leaseHolderSchema = z.object({
  connectionId: wireString(),
  deviceId: wireString(),
  clientId: wireString(),
  clientKind: clientKindSchema,
  name: wireString(),
})

const leaseSnapshotSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    generation: wireNonNegativeInt(),
  }),
  z.object({
    status: z.literal("held"),
    generation: wireNonNegativeInt(),
    holder: leaseHolderSchema,
    expiresAt: wireString(),
  }),
])

const sessionEventNotificationSchema = z.object({
  sessionId: wireString(),
  revision: wireNonNegativeInt(),
  event: z.record(z.string(), z.unknown()),
})

const sessionTransientNotificationSchema = z.object({
  sessionId: wireString(),
  event: z.record(z.string(), z.unknown()),
})

const sessionResyncRequiredNotificationSchema = z.object({
  sessionId: wireString(),
  minimumRevision: wireNonNegativeInt(),
  reason: z.enum(["queue_overflow", "revision_gap", "rewind", "restart"]),
})

const sessionOperationFailedNotificationSchema = z.object({
  sessionId: wireString(),
  commandId: wireString(),
  intent: z.enum(["prompt", "mention", "shell"]),
  message: wireString(),
  code: z.enum(APP_SERVER_ERROR_CODES).optional(),
})

const presenceUpdatedNotificationSchema = z.object({
  sessionId: wireString(),
  clients: z.array(presenceClientSchema),
})

const interactionLeaseUpdatedNotificationSchema = z.object({
  sessionId: wireString(),
  leases: z.object({
    composer: leaseSnapshotSchema,
    "session-control": leaseSnapshotSchema,
  }),
})

// ---------------------------------------------------------------------------
// Public lookup maps.
// ---------------------------------------------------------------------------

export const APP_SERVER_METHOD_PARAM_SCHEMAS: Readonly<Record<AppServerMethod, ZodType<unknown>>> = {
  "server.initialize": serverInitializeParamsSchema,
  "server.describe": noParamsSchema,
  "server.health": noParamsSchema,
  "session.list": sessionListParamsSchema,
  "session.create": sessionCreateParamsSchema,
  "session.get": sessionGetParamsSchema,
  "session.fork": sessionForkParamsSchema,
  "session.archive": sessionArchiveParamsSchema,
  "session.delete": sessionDeleteParamsSchema,
  "session.attach": sessionAttachParamsSchema,
  "session.detach": sessionIdOnlyParamsSchema,
  "session.snapshot": sessionIdOnlyParamsSchema,
  "session.command": sessionCommandParamsSchema,
  "session.plan": sessionPlanParamsSchema,
  "session.submit": sessionSubmitParamsSchema,
  "session.cancel": sessionCancelParamsSchema,
  "session.resolveApproval": sessionResolveApprovalParamsSchema,
  "session.replay": sessionReplayParamsSchema,
  "session.trace": sessionIdOnlyParamsSchema,
  "session.modelCalls": sessionModelCallsParamsSchema,
  "session.resync": sessionResyncParamsSchema,
  "interaction.acquire": interactionAcquireParamsSchema,
  "interaction.renew": interactionRenewParamsSchema,
  "interaction.release": interactionReleaseParamsSchema,
  "interaction.takeover": interactionTakeoverParamsSchema,
  "device.list": noParamsSchema,
  "device.revoke": deviceRevokeParamsSchema,
}

export const APP_SERVER_NOTIFICATION_SCHEMAS: Readonly<Record<AppServerNotificationMethod, ZodType<unknown>>> = {
  "session.event": sessionEventNotificationSchema,
  "session.transient": sessionTransientNotificationSchema,
  "session.resyncRequired": sessionResyncRequiredNotificationSchema,
  "session.operation.failed": sessionOperationFailedNotificationSchema,
  "presence.updated": presenceUpdatedNotificationSchema,
  "interaction.lease.updated": interactionLeaseUpdatedNotificationSchema,
}

/** Fail fast if the schema map drifts from the public method contracts. */
function checkSchemaCompleteness(): void {
  const methods = new Set(Object.keys(APP_SERVER_METHOD_PARAM_SCHEMAS))
  const missing = APP_SERVER_METHODS.filter((method) => !methods.has(method))
  if (missing.length > 0) throw new Error(`missing App Server method schemas: ${missing.join(", ")}`)
  const notifications = new Set(Object.keys(APP_SERVER_NOTIFICATION_SCHEMAS))
  const missingNotifications = APP_SERVER_NOTIFICATION_METHODS.filter((method) => !notifications.has(method))
  if (missingNotifications.length > 0) throw new Error(`missing App Server notification schemas: ${missingNotifications.join(", ")}`)
}
checkSchemaCompleteness()
