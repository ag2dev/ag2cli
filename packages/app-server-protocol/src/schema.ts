import { z, type ZodType } from "zod"
import {
  APP_SERVER_INTERACTION_LEASE_SCOPES,
  APP_SERVER_METHODS,
  APP_SERVER_NOTIFICATION_METHODS,
  type AppServerMethod,
  type AppServerNotificationMethod,
} from "./types.js"
import { publicSessionEventEnvelopeSchema, publicSessionEventSchema } from "./dto/events.js"
import {
  interactionLeaseUpdatedNotificationParamsSchema,
  presenceUpdatedNotificationParamsSchema,
  sessionResyncRequiredNotificationParamsSchema,
  sessionTransientNotificationParamsSchema,
} from "./dto/notifications.js"
import { appServerCapabilitiesSchema } from "./dto/capabilities.js"
import { iso8601TimestampSchema } from "./dto/primitives.js"
import {
  sessionArchiveParamsSchema as sessionCatalogArchiveParamsSchema,
  sessionArchiveResultSchema,
  sessionCreateParamsSchema as sessionCatalogCreateParamsSchema,
  sessionDeleteParamsSchema as sessionCatalogDeleteParamsSchema,
  sessionDeleteResultSchema,
  sessionForkParamsSchema as sessionCatalogForkParamsSchema,
  sessionGetParamsSchema as sessionCatalogGetParamsSchema,
  sessionGetResultSchema,
  sessionListParamsSchema as sessionCatalogListParamsSchema,
  sessionListResultSchema,
  sessionSnapshotResultSchema,
} from "./dto/catalog-methods.js"
import {
  sessionAttachParamsSchema,
  sessionAttachResultSchema,
  sessionDetachParamsSchema,
  sessionDetachResultSchema,
  sessionReplayParamsSchema,
  sessionReplayResultSchema,
  sessionResyncParamsSchema,
  sessionResyncResultSchema,
  sessionSnapshotMethodParamsSchema,
  sessionSnapshotMethodResultSchema,
} from "./dto/recovery-methods.js"
import {
  sessionCancelInputParamsSchema,
  sessionCancelInputResultSchema,
  sessionCancelRunParamsSchema,
  sessionCancelRunResultSchema,
  sessionMessagesParamsSchema,
  sessionMessagesResultSchema,
  sessionResolveInteractionParamsSchema,
  sessionResolveInteractionResultSchema,
  sessionSteerParamsSchema,
  sessionSteerResultSchema,
  sessionSubmitParamsSchema,
  sessionSubmitResultSchema,
} from "./dto/write-methods.js"
import {
  sessionGetPermissionPolicyParamsSchema,
  sessionGetPermissionPolicyResultSchema,
  sessionSetPermissionModeParamsSchema,
  sessionSetPermissionRulesParamsSchema,
} from "./dto/policy.js"
import {
  workspaceDiffParamsSchema,
  workspaceDiffResultSchema,
  workspaceReadFileParamsSchema,
  workspaceReadFileResultSchema,
} from "./dto/workspace.js"
import {
  sessionCreateTaskParamsSchema,
  sessionCreateTaskResultSchema,
  sessionListTasksParamsSchema,
  sessionListTasksResultSchema,
  sessionCancelTaskParamsSchema,
  sessionCancelTaskResultSchema,
  sessionGetTaskLogsParamsSchema,
  sessionGetTaskLogsResultSchema,
  sessionExecuteShellParamsSchema,
  sessionExecuteShellResultSchema,
  sessionExecuteUserShellParamsSchema,
  sessionExecuteUserShellResultSchema,
} from "./dto/task-methods.js"
import {
  sessionCompactParamsSchema,
  sessionCompactResultSchema,
  sessionAddDirectoryParamsSchema,
  sessionAddDirectoryResultSchema,
  sessionSetContextWindowParamsSchema,
  sessionSetContextWindowResultSchema,
  sessionClearContextWindowParamsSchema,
  sessionClearContextWindowResultSchema,
  sessionSelectAgentParamsSchema,
  sessionSelectAgentResultSchema,
  sessionUpdateGoalParamsSchema,
  sessionUpdateGoalResultSchema,
} from "./dto/session-action-methods.js"
import {
  sessionListCheckpointsParamsSchema,
  sessionListCheckpointsResultSchema,
  sessionPreviewRewindParamsSchema,
  sessionPreviewRewindResultSchema,
  sessionRewindParamsSchema,
  sessionRewindResultSchema,
} from "./dto/rewind-methods.js"
import { booleanSchema, clientKindSchema, freeformStringArraySchema, scopeSchema } from "./validation.js"

/**
 * Standalone, purely descriptive Zod schemas for every App Server wire method's params (and the
 * handful of notification payloads that have no runtime parser yet). These schemas describe the
 * *structural* wire contract -- the same "same input, same accept/reject verdict" property the
 * imperative parsers in `validation.ts`/`app-server-rpc.ts` already enforce -- so it can drive
 * JSON Schema generation for non-TypeScript clients via `zod-to-json-schema`.
 *
 * They intentionally do not replace the imperative parsers: a few wire methods reject a
 * shape-correct payload only after cross-referencing runtime business context the bare wire
 * shape cannot see (e.g. `interaction.renew`'s lease-generation requirement, which lives in
 * the RPC handler's per-method dispatch rather than the shared params parser). Those
 * business-rule boundaries are captured precisely where the boundary actually sits:
 * `interactionScopedParamsSchema(method)` requires `leaseGeneration` for
 * `interaction.renew`/`release` (a true wire-level fact, even though the current TypeScript
 * implementation enforces it via a second function call), matching the golden fixtures'
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
// can keep chaining native constraints like `.max()` (e.g. `session.compact`'s `instructions`
// length limit).
const wireString = () => z.string().min(1).regex(/\S/)
const wireNonNegativeInt = () => z.number().int().min(0)
const wirePositiveInt = () => z.number().int().min(1)
const wireStringArray = () => z.array(z.string().min(1).regex(/\S/))
const hostIdSchema = () => z.string().regex(/^ag2cli-host\.v1\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u)
const challengeSchema = () => z.string().regex(/^ag2cli-challenge\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u)
const signatureSchema = () => z.string().regex(/^ag2cli-p256-signature\.[A-Za-z0-9_-]{85}[AQgw]$/u)
const credentialSchema = () => z.string().regex(/^ag2cli-device\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u)
const pairingTokenSchema = () => z.string().regex(/^ag2cli-pairing\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u)
const devicePublicKeySchema = () =>
  z
    .string()
    .regex(
      /^ag2cli-p256-spki\.(?=.{2,342}$)(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048]|[A-Za-z0-9_-]{4})$/u,
    )

const optionalNonEmptyString = (): ZodType<string | undefined> => wireString().optional()
const optionalNonNegativeInteger = (): ZodType<number | undefined> => wireNonNegativeInt().optional()

// ---------------------------------------------------------------------------
// server.* / device.*
// ---------------------------------------------------------------------------

const noParamsSchema = z.unknown()

const clientInfoParamSchema = z
  .object({
    clientId: wireString(),
    clientKind: clientKindSchema,
    name: wireString(),
    version: wireString(),
    capabilities: wireStringArray().optional(),
  })
  .strict()

const serverInitializeParamsSchema = z
  .object({
    appServerProtocolVersion: z.literal(1),
    hostId: hostIdSchema(),
    client: clientInfoParamSchema,
    auth: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("device"),
          device: z
            .object({
              deviceId: wireString(),
              credential: credentialSchema(),
              challenge: challengeSchema(),
              signature: signatureSchema(),
            })
            .strict(),
        })
        .strict(),
      z.object({ type: z.literal("operator"), bearerToken: wireString() }).strict(),
    ]),
    requestedScopes: z.array(scopeSchema).optional(),
    clientCapabilities: appServerCapabilitiesSchema.optional(),
    recovery: z
      .object({
        sessionId: optionalNonEmptyString(),
        afterRevision: optionalNonNegativeInteger(),
      })
      .strict()
      .optional(),
  })
  .strict()

const serverPreflightParamsSchema = z
  .object({
    nonce: challengeSchema(),
    purpose: z.enum(["pairing-link", "admin-pairing", "device-connect"]),
  })
  .strict()

const deviceRevokeParamsSchema = z.object({ deviceId: wireString() })
const pairableScopeSchema = z.enum(["session:read", "session:write", "approval:write", "shell:execute", "session:policy", "workspace:read"])
const pairCreateParamsSchema = z
  .object({
    scopes: z.array(pairableScopeSchema).min(1),
    ttlMs: wirePositiveInt().min(30_000).max(600_000).optional(),
  })
  .strict()
const pairPreviewParamsSchema = z.object({ pairingToken: pairingTokenSchema() }).strict()
const pairClaimParamsSchema = z
  .object({
    pairingToken: pairingTokenSchema(),
    name: wireString(),
    clientKind: z.enum(["web", "mobile"]),
    publicKey: devicePublicKeySchema(),
  })
  .strict()

// ---------------------------------------------------------------------------
// session.* read methods
// ---------------------------------------------------------------------------

const sessionListParamsSchema = sessionCatalogListParamsSchema
const sessionCreateParamsSchema = sessionCatalogCreateParamsSchema
const sessionGetParamsSchema = sessionCatalogGetParamsSchema
const sessionForkParamsSchema = sessionCatalogForkParamsSchema
const sessionArchiveParamsSchema = sessionCatalogArchiveParamsSchema
const sessionDeleteParamsSchema = sessionCatalogDeleteParamsSchema

const sessionIdOnlyParamsSchema = z.object({ sessionId: wireString() })

const sessionModelCallsParamsSchema = z.object({
  sessionId: wireString(),
  includePayload: booleanSchema("includePayload").optional(),
})

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
// Notifications. The five v1 payloads are derived from the dto layer and share
// verdicts with the runtime parsers in `validation.ts`. `session.event` is
// deliberately coarser than its parser: a declarative schema cannot express
// "a known type must match its strict variant", so the lenient envelope branch
// keeps unknown informational events acceptable in the exported artifact.
// ---------------------------------------------------------------------------

const sessionEventNotificationSchema = z
  .object({
    event: z.union([publicSessionEventSchema, publicSessionEventEnvelopeSchema]),
  })
  .strict()

const sessionTransientNotificationSchema = sessionTransientNotificationParamsSchema
const sessionResyncRequiredNotificationSchema = sessionResyncRequiredNotificationParamsSchema
const presenceUpdatedNotificationSchema = presenceUpdatedNotificationParamsSchema
const interactionLeaseUpdatedNotificationSchema = interactionLeaseUpdatedNotificationParamsSchema

// ---------------------------------------------------------------------------
// Public lookup maps.
// ---------------------------------------------------------------------------

export const APP_SERVER_METHOD_PARAM_SCHEMAS: Readonly<Record<AppServerMethod, ZodType<unknown>>> = {
  "server.preflight": serverPreflightParamsSchema,
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
  "session.detach": sessionDetachParamsSchema,
  "session.snapshot": sessionSnapshotMethodParamsSchema,
  "session.plan": sessionPlanParamsSchema,
  "session.compact": sessionCompactParamsSchema,
  "session.addDirectory": sessionAddDirectoryParamsSchema,
  "session.setContextWindow": sessionSetContextWindowParamsSchema,
  "session.clearContextWindow": sessionClearContextWindowParamsSchema,
  "session.selectAgent": sessionSelectAgentParamsSchema,
  "session.updateGoal": sessionUpdateGoalParamsSchema,
  "session.listCheckpoints": sessionListCheckpointsParamsSchema,
  "session.previewRewind": sessionPreviewRewindParamsSchema,
  "session.rewind": sessionRewindParamsSchema,
  "session.submit": sessionSubmitParamsSchema,
  "session.steer": sessionSteerParamsSchema,
  "session.cancelRun": sessionCancelRunParamsSchema,
  "session.cancelInput": sessionCancelInputParamsSchema,
  "session.messages": sessionMessagesParamsSchema,
  "session.resolveInteraction": sessionResolveInteractionParamsSchema,
  "session.getPermissionPolicy": sessionGetPermissionPolicyParamsSchema,
  "session.setPermissionMode": sessionSetPermissionModeParamsSchema,
  "session.setPermissionRules": sessionSetPermissionRulesParamsSchema,
  "session.replay": sessionReplayParamsSchema,
  "session.trace": sessionIdOnlyParamsSchema,
  "session.modelCalls": sessionModelCallsParamsSchema,
  "session.resync": sessionResyncParamsSchema,
  "interaction.acquire": interactionAcquireParamsSchema,
  "interaction.renew": interactionRenewParamsSchema,
  "interaction.release": interactionReleaseParamsSchema,
  "interaction.takeover": interactionTakeoverParamsSchema,
  "pair.create": pairCreateParamsSchema,
  "pair.preview": pairPreviewParamsSchema,
  "pair.claim": pairClaimParamsSchema,
  "device.list": noParamsSchema,
  "device.revoke": deviceRevokeParamsSchema,
  "workspace.diff": workspaceDiffParamsSchema,
  "workspace.readFile": workspaceReadFileParamsSchema,
  "session.createTask": sessionCreateTaskParamsSchema,
  "session.listTasks": sessionListTasksParamsSchema,
  "session.cancelTask": sessionCancelTaskParamsSchema,
  "session.getTaskLogs": sessionGetTaskLogsParamsSchema,
  "session.executeShell": sessionExecuteShellParamsSchema,
  "session.executeUserShell": sessionExecuteUserShellParamsSchema,
}

// ---------------------------------------------------------------------------
// Result schemas. v0 mirrors of the five connection methods' runtime result
// parsers, verdict-for-verdict (a case the parser accepts/rejects is
// accepted/rejected here, including unknown-key rejection via `.strict()`),
// except `expiresAt`: the parsers only require a `Date.parse`-able string
// while these mirrors pin ISO-8601. They are transitional: the
// connection-group milestone replaces them with v1 DTO-derived schemas.
// Registered per method; a method absent from this map has no result schema
// and must not carry `results[]` fixtures.
// ---------------------------------------------------------------------------

const serverDescriptorResultSchema = z
  .object({
    name: wireString(),
    version: wireString(),
    hostId: hostIdSchema(),
    protocolVersion: z.literal(1),
  })
  .strict()

const serverInitializeResultSchema = z
  .object({
    appServerProtocolVersion: z.literal(1),
    server: serverDescriptorResultSchema,
    connection: z
      .object({
        connectionId: wireString(),
        deviceId: optionalNonEmptyString(),
        scopes: z.array(scopeSchema),
      })
      .strict(),
    capabilities: appServerCapabilitiesSchema,
    host: z
      .object({
        profile: z.enum(["durable", "ephemeral"]),
        workspaceRoot: optionalNonEmptyString(),
        workspaces: z
          .array(
            z.object({
              workspaceId: wireString(),
              workspaceRoot: wireString(),
              availability: z.enum(["available", "unavailable"]),
            }),
          )
          .optional(),
        configurationFingerprint: optionalNonEmptyString(),
        workspaceFingerprint: optionalNonEmptyString(),
        securityFingerprint: optionalNonEmptyString(),
      })
      .strict()
      .optional(),
  })
  .strict()

const serverDescribeResultSchema = z
  .object({
    server: serverDescriptorResultSchema,
    capabilities: appServerCapabilitiesSchema,
  })
  .strict()

const serverPreflightResultSchema = z.discriminatedUnion("purpose", [
  z
    .object({
      hostId: hostIdSchema(),
      hostPublicKey: devicePublicKeySchema(),
      nonce: challengeSchema(),
      purpose: z.literal("pairing-link"),
      expiresAt: wireNonNegativeInt(),
      signature: signatureSchema(),
    })
    .strict(),
  z
    .object({
      hostId: hostIdSchema(),
      hostPublicKey: devicePublicKeySchema(),
      nonce: challengeSchema(),
      purpose: z.literal("admin-pairing"),
      expiresAt: wireNonNegativeInt(),
      signature: signatureSchema(),
    })
    .strict(),
  z
    .object({
      hostId: hostIdSchema(),
      hostPublicKey: devicePublicKeySchema(),
      nonce: challengeSchema(),
      purpose: z.literal("device-connect"),
      expiresAt: wireNonNegativeInt(),
      signature: signatureSchema(),
      deviceChallenge: challengeSchema(),
      deviceChallengeExpiresAt: wireNonNegativeInt(),
    })
    .strict(),
])

const pairCreateResultSchema = z
  .object({
    pairingToken: pairingTokenSchema(),
    hostId: hostIdSchema(),
    scopes: z.array(pairableScopeSchema).min(1),
    expiresAt: iso8601TimestampSchema("pair.result.expiresAt"),
  })
  .strict()

const pairPreviewResultSchema = z
  .object({
    hostId: hostIdSchema(),
    scopes: z.array(pairableScopeSchema).min(1),
    expiresAt: iso8601TimestampSchema("pair.result.expiresAt"),
  })
  .strict()

const pairClaimResultSchema = z
  .object({
    credential: credentialSchema(),
    device: z
      .object({
        deviceId: wireString(),
        name: wireString(),
        clientKind: clientKindSchema,
        scopes: z.array(pairableScopeSchema).min(1),
        publicKey: devicePublicKeySchema().optional(),
        createdAt: wireString(),
        revokedAt: wireString().optional(),
      })
      .strict(),
  })
  .strict()

export const APP_SERVER_METHOD_RESULT_SCHEMAS: Readonly<Partial<Record<AppServerMethod, ZodType<unknown>>>> = {
  "server.initialize": serverInitializeResultSchema,
  "server.describe": serverDescribeResultSchema,
  "server.preflight": serverPreflightResultSchema,
  "pair.create": pairCreateResultSchema,
  "pair.preview": pairPreviewResultSchema,
  "pair.claim": pairClaimResultSchema,
  "session.list": sessionListResultSchema,
  "session.create": sessionSnapshotResultSchema,
  "session.get": sessionGetResultSchema,
  "session.fork": sessionSnapshotResultSchema,
  "session.archive": sessionArchiveResultSchema,
  "session.delete": sessionDeleteResultSchema,
  "session.attach": sessionAttachResultSchema,
  "session.detach": sessionDetachResultSchema,
  "session.snapshot": sessionSnapshotMethodResultSchema,
  "session.replay": sessionReplayResultSchema,
  "session.resync": sessionResyncResultSchema,
  "session.submit": sessionSubmitResultSchema,
  "session.steer": sessionSteerResultSchema,
  "session.cancelRun": sessionCancelRunResultSchema,
  "session.cancelInput": sessionCancelInputResultSchema,
  "session.messages": sessionMessagesResultSchema,
  "session.compact": sessionCompactResultSchema,
  "session.addDirectory": sessionAddDirectoryResultSchema,
  "session.setContextWindow": sessionSetContextWindowResultSchema,
  "session.clearContextWindow": sessionClearContextWindowResultSchema,
  "session.selectAgent": sessionSelectAgentResultSchema,
  "session.updateGoal": sessionUpdateGoalResultSchema,
  "session.listCheckpoints": sessionListCheckpointsResultSchema,
  "session.previewRewind": sessionPreviewRewindResultSchema,
  "session.rewind": sessionRewindResultSchema,
  "session.resolveInteraction": sessionResolveInteractionResultSchema,
  "session.getPermissionPolicy": sessionGetPermissionPolicyResultSchema,
  "session.setPermissionMode": sessionGetPermissionPolicyResultSchema,
  "session.setPermissionRules": sessionGetPermissionPolicyResultSchema,
  "workspace.diff": workspaceDiffResultSchema,
  "workspace.readFile": workspaceReadFileResultSchema,
  "session.createTask": sessionCreateTaskResultSchema,
  "session.listTasks": sessionListTasksResultSchema,
  "session.cancelTask": sessionCancelTaskResultSchema,
  "session.getTaskLogs": sessionGetTaskLogsResultSchema,
  "session.executeShell": sessionExecuteShellResultSchema,
  "session.executeUserShell": sessionExecuteUserShellResultSchema,
}

export const APP_SERVER_NOTIFICATION_SCHEMAS: Readonly<Record<AppServerNotificationMethod, ZodType<unknown>>> = {
  "session.event": sessionEventNotificationSchema,
  "session.transient": sessionTransientNotificationSchema,
  "session.resyncRequired": sessionResyncRequiredNotificationSchema,
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
