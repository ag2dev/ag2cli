import { z, ZodError, type ZodType } from "zod"
import {
  APP_SERVER_METHODS,
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_SCOPES,
  isSessionCommandActionType,
  PERMISSION_MODES,
  PERMISSION_RULE_BEHAVIORS,
  TASK_TYPES,
  type AppServerClientInfo,
  type AppServerDeviceRecord,
  type AppServerDeviceRegistration,
  type AppServerDeviceChallenge,
  type AppServerMethod,
  type AppServerPairingChallenge,
  type AppServerScope,
  type AppServerGoalUpdate,
  type AppServerPermissionMode,
  type AppServerPermissionRule,
  type AppServerPermissionRuleBehavior,
  type AppServerTaskType,
  type AppServerSessionCommandAction,
  type SessionHistoryCursor,
  type InteractionLeaseScope,
  type SessionCommandParams,
  type JsonValue,
  type ServerInitializeResult,
  type ServerInitializeParams,
} from "./types.js"
import { isJsonValue } from "./json-rpc.js"
import { isAppServerDeviceSignature, isValidAppServerDeviceChallenge } from "./device-proof.js"

export class AppServerProtocolError extends Error {
  readonly kind: string
  readonly retryable: boolean
  readonly details?: JsonValue

  constructor(
    kind: string,
    message: string,
    options: {
      readonly retryable?: boolean
      readonly details?: JsonValue
    } = {},
  ) {
    super(message)
    this.name = "AppServerProtocolError"
    this.kind = kind
    this.retryable = options.retryable ?? false
    this.details = options.details
  }
}

export function isAppServerMethod(value: string): value is AppServerMethod {
  return (APP_SERVER_METHODS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Zod schema building blocks.
//
// Every wire params/result type below is expressed as a Zod schema so the
// same declarative definitions can drive JSON Schema generation. `zodParse`
// is the single place that adapts a `ZodError` into this module's stable
// `AppServerProtocolError` shape (defaulting to the `invalid_params` kind
// used for all client-supplied params; result-shaped parsers below pass
// `invalid_result` explicitly), always surfacing the first issue's message
// so callers keep getting one specific, actionable string instead of a
// batch of issues.
// ---------------------------------------------------------------------------

function zodParse<T>(schema: ZodType<T, z.ZodTypeDef, unknown>, value: unknown, kind: string = "invalid_params"): T {
  try {
    return schema.parse(value)
  } catch (error) {
    if (error instanceof ZodError) {
      const message = error.issues[0]?.message ?? error.message
      throw new AppServerProtocolError(kind, message)
    }
    throw error
  }
}

export function nonEmptyStringSchema(name: string): ZodType<string> {
  return z
    .string({
      invalid_type_error: `${name} must be a non-empty string`,
      required_error: `${name} must be a non-empty string`,
    })
    .refine((value) => value.trim().length > 0, {
      message: `${name} must be a non-empty string`,
    })
}

export function nonNegativeIntegerSchema(name: string): ZodType<number> {
  return z
    .number({
      invalid_type_error: `${name} must be a non-negative integer`,
      required_error: `${name} must be a non-negative integer`,
    })
    .refine((value) => Number.isSafeInteger(value) && value >= 0, {
      message: `${name} must be a non-negative integer`,
    })
}

export function positiveIntegerSchema(name: string): ZodType<number> {
  return z
    .number({
      invalid_type_error: `${name} must be a positive integer`,
      required_error: `${name} must be a positive integer`,
    })
    .refine((value) => Number.isSafeInteger(value) && value >= 1, {
      message: `${name} must be a positive integer`,
    })
}

export function booleanSchema(name: string): ZodType<boolean> {
  return z.boolean({ invalid_type_error: `${name} must be a boolean` })
}

/** Rejects empty-string items, e.g. for `capabilities`. */
export function nonEmptyStringArraySchema(name: string): ZodType<string[], z.ZodTypeDef, unknown> {
  return z
    .array(z.unknown(), { invalid_type_error: `${name} must be a non-empty string array` })
    .refine((items) => items.every((item) => typeof item === "string" && item.trim().length > 0), {
      message: `${name} must be a non-empty string array`,
    })
    .transform((items) => items as string[])
}

/** Unlike {@link nonEmptyStringArraySchema}, `session.submit`/`session.plan`'s free-form
 * `context`/`fileReferences` arrays have always allowed empty-string entries. */
export function freeformStringArraySchema(name: string): z.ZodType<readonly string[]> {
  return z.array(z.string({ invalid_type_error: `${name} must be a string array` }), {
    invalid_type_error: `${name} must be a string array`,
  })
}

export function parseNonEmptyString(value: unknown, name: string): string {
  return zodParse(nonEmptyStringSchema(name), value)
}

export function parseNonNegativeInteger(value: unknown, name: string): number {
  return zodParse(nonNegativeIntegerSchema(name), value)
}

function parsePositiveInteger(value: unknown, name: string): number {
  return zodParse(positiveIntegerSchema(name), value)
}

export function asRecord(value: unknown, name: string): Record<string, unknown> {
  return zodParse(
    z.record(z.string(), z.unknown(), {
      invalid_type_error: `${name} must be an object`,
      required_error: `${name} must be an object`,
    }),
    value,
  )
}

export const scopeSchema = z.enum(APP_SERVER_SCOPES as unknown as readonly [AppServerScope, ...AppServerScope[]], {
  message: "scope is invalid",
})

function parseScopes(value: unknown): readonly AppServerScope[] {
  const scopes = zodParse(z.array(scopeSchema, { invalid_type_error: "requestedScopes must be an array" }), value)
  return [...new Set(scopes)]
}

export const clientKindSchema = z.enum(["tui", "web", "mobile", "desktop", "acp", "script", "unknown"])

function parseClientKind(value: unknown, name: string): AppServerClientInfo["clientKind"] {
  return zodParse(z.enum(clientKindSchema.options, { message: `${name} is invalid` }), value)
}

// ---------------------------------------------------------------------------
// server.initialize / server.describe / server.health
// ---------------------------------------------------------------------------

export function parseServerInitializeParams(value: unknown): ServerInitializeParams {
  const record = asRecord(value, "server.initialize.params")
  if (record.appServerProtocolVersion !== APP_SERVER_PROTOCOL_VERSION) {
    throw new AppServerProtocolError(
      "protocol_version_mismatch",
      `App Server protocol major version is unsupported: ${String(record.appServerProtocolVersion)}`,
      { details: { supported: APP_SERVER_PROTOCOL_VERSION } },
    )
  }
  const client = parseClientInfo(record.client)
  const device = record.device === undefined ? undefined : parseDevice(record.device)
  const requestedScopes = record.requestedScopes === undefined ? undefined : parseScopes(record.requestedScopes)
  const recovery = record.recovery === undefined ? undefined : parseRecovery(record.recovery)
  const serverFingerprint =
    record.serverFingerprint === undefined ? undefined : parseNonEmptyString(record.serverFingerprint, "serverFingerprint")
  return {
    appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
    client,
    ...(device === undefined ? {} : { device }),
    ...(requestedScopes === undefined ? {} : { requestedScopes }),
    ...(serverFingerprint === undefined ? {} : { serverFingerprint }),
    ...(recovery === undefined ? {} : { recovery }),
  }
}

const clientInfoSchema = z.object({
  clientId: nonEmptyStringSchema("client.clientId"),
  name: nonEmptyStringSchema("client.name"),
  version: nonEmptyStringSchema("client.version"),
  capabilities: nonEmptyStringArraySchema("client.capabilities").optional(),
})

function parseClientInfo(value: unknown): AppServerClientInfo {
  const record = asRecord(value, "server.initialize.params.client")
  const parsed = zodParse(clientInfoSchema, record)
  return {
    clientId: parsed.clientId,
    clientKind: parseClientKind(record.clientKind, "client.clientKind"),
    name: parsed.name,
    version: parsed.version,
    ...(parsed.capabilities === undefined ? {} : { capabilities: parsed.capabilities }),
  }
}

function parseDevice(value: unknown): NonNullable<ServerInitializeParams["device"]> {
  const record = asRecord(value, "server.initialize.params.device")
  const deviceId = parseNonEmptyString(record.deviceId, "device.deviceId")
  const challenge = record.challenge === undefined ? undefined : parseNonEmptyString(record.challenge, "device.challenge")
  const signature = record.signature === undefined ? undefined : parseNonEmptyString(record.signature, "device.signature")
  if (signature !== undefined && !isAppServerDeviceSignature(signature)) {
    throw new AppServerProtocolError("invalid_params", "device.signature has an invalid format")
  }
  return {
    deviceId,
    ...(challenge === undefined ? {} : { challenge }),
    ...(signature === undefined ? {} : { signature }),
  }
}

function parseRecovery(value: unknown): NonNullable<ServerInitializeParams["recovery"]> {
  const record = asRecord(value, "server.initialize.params.recovery")
  const sessionId = record.sessionId === undefined ? undefined : parseNonEmptyString(record.sessionId, "recovery.sessionId")
  const afterRevision =
    record.afterRevision === undefined ? undefined : parseNonNegativeInteger(record.afterRevision, "recovery.afterRevision")
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(afterRevision === undefined ? {} : { afterRevision }),
  }
}

export function parseServerInitializeResult(value: unknown): ServerInitializeResult {
  const record = asRecord(value, "server.initialize.result")
  if (record.appServerProtocolVersion !== APP_SERVER_PROTOCOL_VERSION) {
    throw new AppServerProtocolError(
      "protocol_version_mismatch",
      `App Server protocol major version is unsupported: ${String(record.appServerProtocolVersion)}`,
      { details: { supported: APP_SERVER_PROTOCOL_VERSION } },
    )
  }
  const server = asRecord(record.server, "server.initialize.result.server")
  const connection = asRecord(record.connection, "server.initialize.result.connection")
  const host = record.host === undefined ? undefined : asRecord(record.host, "server.initialize.result.host")
  const profile = host?.profile
  if (host !== undefined && profile !== "durable" && profile !== "ephemeral") {
    throw new AppServerProtocolError("invalid_result", "server.initialize.result.host.profile is invalid")
  }
  return {
    appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
    server: {
      name: parseResultNonEmptyString(server.name, "server.name"),
      version: parseResultNonEmptyString(server.version, "server.version"),
      fingerprint: parseResultNonEmptyString(server.fingerprint, "server.fingerprint"),
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    },
    connection: {
      connectionId: parseResultNonEmptyString(connection.connectionId, "connection.connectionId"),
      deviceId: parseResultNonEmptyString(connection.deviceId, "connection.deviceId"),
      scopes: parseScopes(connection.scopes),
    },
    capabilities: zodParse(nonEmptyStringArraySchema("capabilities"), record.capabilities, "invalid_result"),
    ...(host === undefined
      ? {}
      : {
          host: {
            profile: profile as "durable" | "ephemeral",
            ...(host.workspaceRoot === undefined
              ? {}
              : {
                  workspaceRoot: parseResultNonEmptyString(host.workspaceRoot, "host.workspaceRoot"),
                }),
            ...(host.workspaces === undefined
              ? {}
              : {
                  workspaces: zodParse(
                    z.array(
                      z.object({
                        workspaceId: nonEmptyStringSchema("workspaceId"),
                        workspaceRoot: nonEmptyStringSchema("workspaceRoot"),
                        availability: z.enum(["available", "unavailable"]),
                      }),
                    ),
                    host.workspaces,
                    "invalid_result",
                  ),
                }),
            ...(host.configurationFingerprint === undefined
              ? {}
              : {
                  configurationFingerprint: parseResultNonEmptyString(host.configurationFingerprint, "host.configurationFingerprint"),
                }),
            ...(host.workspaceFingerprint === undefined
              ? {}
              : {
                  workspaceFingerprint: parseResultNonEmptyString(host.workspaceFingerprint, "host.workspaceFingerprint"),
                }),
            ...(host.securityFingerprint === undefined
              ? {}
              : {
                  securityFingerprint: parseResultNonEmptyString(host.securityFingerprint, "host.securityFingerprint"),
                }),
          },
        }),
  }
}

function parseResultNonEmptyString(value: unknown, name: string): string {
  return zodParse(nonEmptyStringSchema(name), value, "invalid_result")
}

// ---------------------------------------------------------------------------
// pairing / device
// ---------------------------------------------------------------------------

const pairingTokenSchema = nonEmptyStringSchema("pairingToken").refine((value) => /^ag2cli-pairing\.[A-Za-z0-9_-]{43}$/u.test(value), {
  message: "pairingToken has an invalid format",
})

export function parseAppServerPairingChallenge(value: unknown): AppServerPairingChallenge {
  const record = asRecord(value, "pairing.start.result")
  const pairingToken = zodParse(pairingTokenSchema, record.pairingToken, "invalid_result")
  const scopes = parseScopes(record.scopes)
  if (scopes.length === 0) throw new AppServerProtocolError("invalid_result", "pairing.start.result.scopes must not be empty")
  const expiresAt = parseResultNonEmptyString(record.expiresAt, "expiresAt")
  if (Number.isNaN(Date.parse(expiresAt))) throw new AppServerProtocolError("invalid_result", "expiresAt must be a valid date")
  return { pairingToken, scopes, expiresAt }
}

export function parseAppServerDeviceRegistration(value: unknown): AppServerDeviceRegistration {
  const record = asRecord(value, "pairing.claim.result")
  return {
    device: parseDeviceRecord(record.device),
    credential: parseResultNonEmptyString(record.credential, "credential"),
  }
}

function parseDeviceRecord(value: unknown): AppServerDeviceRecord {
  const record = asRecord(value, "device")
  const publicKey = record.publicKey === undefined ? undefined : parseResultNonEmptyString(record.publicKey, "device.publicKey")
  const revokedAt = record.revokedAt === undefined ? undefined : parseResultNonEmptyString(record.revokedAt, "device.revokedAt")
  return {
    deviceId: parseResultNonEmptyString(record.deviceId, "device.deviceId"),
    name: parseResultNonEmptyString(record.name, "device.name"),
    clientKind: parseClientKind(record.clientKind, "device.clientKind"),
    scopes: parseScopes(record.scopes),
    ...(publicKey === undefined ? {} : { publicKey }),
    createdAt: parseResultNonEmptyString(record.createdAt, "device.createdAt"),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  }
}

export function parseAppServerDeviceChallenge(value: unknown): AppServerDeviceChallenge {
  const record = asRecord(value, "pairing.challenge.result")
  const challenge = parseResultNonEmptyString(record.challenge, "challenge")
  const deviceId = parseResultNonEmptyString(record.deviceId, "deviceId")
  const serverFingerprint = parseResultNonEmptyString(record.serverFingerprint, "serverFingerprint")
  const expiresAt = parseResultNonEmptyString(record.expiresAt, "expiresAt")
  if (
    !isValidAppServerDeviceChallenge({
      deviceId,
      challenge,
      serverFingerprint,
      expiresAt,
    })
  ) {
    throw new AppServerProtocolError("invalid_result", "pairing.challenge.result has an invalid structure")
  }
  return { deviceId, challenge, serverFingerprint, expiresAt }
}

export function parseDeviceRevokeParams(value: unknown): {
  readonly deviceId: string
} {
  const record = asRecord(value, "device.revoke.params")
  return { deviceId: parseNonEmptyString(record.deviceId, "deviceId") }
}

// ---------------------------------------------------------------------------
// session.* read/write methods
// ---------------------------------------------------------------------------

export function parseSessionListParams(value: unknown): {
  readonly includeArchived: boolean
} {
  const record = value === undefined ? {} : asRecord(value, "session.list.params")
  const includeArchived =
    record.includeArchived === undefined ? undefined : zodParse(booleanSchema("includeArchived"), record.includeArchived)
  return { includeArchived: includeArchived === true }
}

export function parseSessionCreateParams(value: unknown): import("./types.js").SessionCreateParams {
  const record = asRecord(value, "session.create.params")
  return {
    ...(record.sessionId === undefined ? {} : { sessionId: parseNonEmptyString(record.sessionId, "sessionId") }),
    workspaceId: parseNonEmptyString(record.workspaceId, "workspaceId"),
    ...(record.title === undefined ? {} : { title: parseNonEmptyString(record.title, "title") }),
  }
}

export function parseSessionGetParams(value: unknown): import("./types.js").SessionGetParams {
  const record = asRecord(value, "session.get.params")
  const includeArchived =
    record.includeArchived === undefined ? undefined : zodParse(booleanSchema("includeArchived"), record.includeArchived)
  return {
    sessionId: parseNonEmptyString(record.sessionId, "sessionId"),
    ...(includeArchived === undefined ? {} : { includeArchived }),
  }
}

/** Fixed single-scope lease reference shared by `session.fork`/`session.archive`/
 * `session.delete` (see {@link import("./types.js").SessionControlLeaseRef}). */
function parseSessionControlLease(value: unknown, name: string): import("./types.js").SessionControlLeaseRef {
  const record = asRecord(value, name)
  rejectUnknownFields(record, ["scope", "generation"], name)
  if (record.scope !== undefined && record.scope !== "session-control") {
    throw new AppServerProtocolError("invalid_params", `${name}.scope must be session-control`)
  }
  return {
    scope: "session-control",
    generation: parseNonNegativeInteger(record.generation, `${name}.generation`),
  }
}

export function parseSessionForkParams(value: unknown): import("./types.js").SessionForkParams {
  const record = asRecord(value, "session.fork.params")
  const cursor = record.cursor === undefined ? undefined : parseSessionHistoryCursor(record.cursor, "cursor")
  return {
    sourceSessionId: parseNonEmptyString(record.sourceSessionId, "sourceSessionId"),
    ...(record.targetSessionId === undefined
      ? {}
      : {
          targetSessionId: parseNonEmptyString(record.targetSessionId, "targetSessionId"),
        }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(record.title === undefined ? {} : { title: parseNonEmptyString(record.title, "title") }),
    ...(record.lease === undefined
      ? {}
      : {
          lease: parseSessionControlLease(record.lease, "session.fork.lease"),
        }),
  }
}

function parseSessionHistoryCursor(value: unknown, name: string): SessionHistoryCursor {
  const record = asRecord(value, `session.fork.${name}`)
  rejectUnknownFields(record, ["sessionId", "branchId", "nodeId", "physicalRevision", "recordHash"], `session.fork.${name}`)
  return {
    sessionId: parseNonEmptyString(record.sessionId, `${name}.sessionId`),
    branchId: parseNonEmptyString(record.branchId, `${name}.branchId`),
    nodeId: parseNonEmptyString(record.nodeId, `${name}.nodeId`),
    physicalRevision: parsePositiveInteger(record.physicalRevision, `${name}.physicalRevision`),
    recordHash: parseNonEmptyString(record.recordHash, `${name}.recordHash`),
  }
}

export function parseSessionArchiveParams(value: unknown): import("./types.js").SessionArchiveParams {
  const record = asRecord(value, "session.archive.params")
  return {
    sessionId: parseNonEmptyString(record.sessionId, "sessionId"),
    ...(record.lease === undefined
      ? {}
      : {
          lease: parseSessionControlLease(record.lease, "session.archive.lease"),
        }),
  }
}

export function parseSessionDeleteParams(value: unknown): import("./types.js").SessionDeleteParams {
  const record = asRecord(value, "session.delete.params")
  return {
    sessionId: parseNonEmptyString(record.sessionId, "sessionId"),
    ...(record.lease === undefined
      ? {}
      : {
          lease: parseSessionControlLease(record.lease, "session.delete.lease"),
        }),
  }
}

export function parseSessionAttachParams(value: unknown): import("./types.js").SessionAttachParams {
  const record = asRecord(value, "session.attach.params")
  const includeTransient =
    record.includeTransient === undefined ? undefined : zodParse(booleanSchema("includeTransient"), record.includeTransient)
  return {
    sessionId: parseNonEmptyString(record.sessionId, "sessionId"),
    ...(record.afterRevision === undefined
      ? {}
      : {
          afterRevision: parseNonNegativeInteger(record.afterRevision, "afterRevision"),
        }),
    ...(includeTransient === undefined ? {} : { includeTransient }),
  }
}

export function parseSessionDetachParams(value: unknown): import("./types.js").SessionDetachParams {
  const record = asRecord(value, "session.detach.params")
  return { sessionId: parseNonEmptyString(record.sessionId, "sessionId") }
}

export function parseSessionSnapshotParams(value: unknown): import("./types.js").SessionSnapshotParams {
  const record = asRecord(value, "session.snapshot.params")
  return { sessionId: parseNonEmptyString(record.sessionId, "sessionId") }
}

/** `session.submit`'s partial map of scope generations the caller currently holds. */
function parseSubmitLease(value: unknown): Partial<Record<InteractionLeaseScope, number>> {
  const record = asRecord(value, "lease")
  rejectUnknownFields(record, ["composer", "session-control"], "lease")
  const result: Partial<Record<InteractionLeaseScope, number>> = {}
  if (record.composer !== undefined) result.composer = parseNonNegativeInteger(record.composer, "lease.composer")
  if (record["session-control"] !== undefined) {
    result["session-control"] = parseNonNegativeInteger(record["session-control"], "lease.session-control")
  }
  return result
}

export function parseSessionSubmitParams(value: unknown): import("./types.js").SessionSubmitParams {
  const record = asRecord(value, "session.submit.params")
  rejectRetiredPermissionKeys(record, "session.submit.params")
  return {
    sessionId: parseNonEmptyString(record.sessionId, "sessionId"),
    commandId: parseNonEmptyString(record.commandId, "commandId"),
    text: parseNonEmptyString(record.text, "text"),
    ...(record.context === undefined
      ? {}
      : {
          context: zodParse(freeformStringArraySchema("context"), record.context),
        }),
    ...(record.fileReferences === undefined
      ? {}
      : {
          fileReferences: zodParse(freeformStringArraySchema("fileReferences"), record.fileReferences),
        }),
    ...(record.workspace === undefined ? {} : { workspace: parseNonEmptyString(record.workspace, "workspace") }),
    ...(record.expectedRevision === undefined
      ? {}
      : {
          expectedRevision: parseNonNegativeInteger(record.expectedRevision, "expectedRevision"),
        }),
    ...(record.lease === undefined ? {} : { lease: parseSubmitLease(record.lease) }),
  }
}

/** `session.plan`'s lease reference is fixed to the `composer` scope. */
function parsePlanLease(value: unknown): {
  readonly scope: "composer"
  readonly generation: number
} {
  const record = asRecord(value, "lease")
  rejectUnknownFields(record, ["scope", "generation"], "lease")
  if (record.scope !== undefined && record.scope !== "composer") {
    throw new AppServerProtocolError("invalid_params", "session.plan.lease.scope must be composer")
  }
  return {
    scope: "composer",
    generation: parseNonNegativeInteger(record.generation, "lease.generation"),
  }
}

export function parseSessionPlanParams(value: unknown): import("./types.js").SessionPlanParams {
  const record = asRecord(value, "session.plan.params")
  rejectRetiredPermissionKeys(record, "session.plan.params")
  return {
    sessionId: parseNonEmptyString(record.sessionId, "sessionId"),
    commandId: parseNonEmptyString(record.commandId, "commandId"),
    text: parseNonEmptyString(record.text, "text"),
    ...(record.context === undefined
      ? {}
      : {
          context: zodParse(freeformStringArraySchema("context"), record.context),
        }),
    ...(record.workspace === undefined ? {} : { workspace: parseNonEmptyString(record.workspace, "workspace") }),
    ...(record.expectedRevision === undefined
      ? {}
      : {
          expectedRevision: parseNonNegativeInteger(record.expectedRevision, "expectedRevision"),
        }),
    ...(record.lease === undefined ? {} : { lease: parsePlanLease(record.lease) }),
  }
}

export function parseSessionReplayParams(value: unknown): import("./types.js").SessionReplayParams {
  const record = asRecord(value, "session.replay.params")
  return {
    sessionId: parseNonEmptyString(record.sessionId, "sessionId"),
    ...(record.afterRevision === undefined
      ? {}
      : {
          afterRevision: parseNonNegativeInteger(record.afterRevision, "afterRevision"),
        }),
  }
}

export function parseSessionResyncParams(value: unknown): import("./types.js").SessionResyncParams {
  const record = asRecord(value, "session.resync.params")
  return {
    sessionId: parseNonEmptyString(record.sessionId, "sessionId"),
    ...(record.afterRevision === undefined
      ? {}
      : {
          afterRevision: parseNonNegativeInteger(record.afterRevision, "afterRevision"),
        }),
  }
}

export function parseSessionTraceParams(value: unknown): import("./types.js").SessionTraceParams {
  const record = asRecord(value, "session.trace.params")
  return { sessionId: parseNonEmptyString(record.sessionId, "sessionId") }
}

export function parseSessionModelCallsParams(value: unknown): import("./types.js").SessionModelCallsParams {
  const record = asRecord(value, "session.modelCalls.params")
  const includePayload = record.includePayload === undefined ? undefined : zodParse(booleanSchema("includePayload"), record.includePayload)
  return {
    sessionId: parseNonEmptyString(record.sessionId, "sessionId"),
    ...(includePayload === undefined ? {} : { includePayload }),
  }
}

export function parseSessionResolveApprovalParams(value: unknown): import("./types.js").SessionResolveApprovalParams {
  const record = asRecord(value, "session.resolveApproval.params")
  const decision = zodParse(
    z.enum(["approved", "denied"], {
      message: "decision must be approved or denied",
    }),
    record.decision,
  )
  return {
    sessionId: parseNonEmptyString(record.sessionId, "sessionId"),
    runId: parseNonEmptyString(record.runId, "runId"),
    turn: parseNonNegativeInteger(record.turn, "turn"),
    toolUseId: parseNonEmptyString(record.toolUseId, "toolUseId"),
    preparedEventId: parseNonEmptyString(record.preparedEventId, "preparedEventId"),
    expectedScopeRevision: parseNonNegativeInteger(record.expectedScopeRevision, "expectedScopeRevision"),
    expectedPolicyRevision: parseNonNegativeInteger(record.expectedPolicyRevision, "expectedPolicyRevision"),
    decision,
  }
}

// ---------------------------------------------------------------------------
// interaction.* (composer / session-control lease acquire/renew/release/takeover)
// ---------------------------------------------------------------------------

export function parseInteractionRequest(value: unknown, method: string): import("./types.js").InteractionParams {
  const record = asRecord(value, `${method}.params`)
  const scope = record.scope === "composer" || record.scope === "session-control" ? record.scope : undefined
  if (scope === undefined) throw new AppServerProtocolError("invalid_params", `${method}.scope must be composer or session-control`)
  return {
    sessionId: parseNonEmptyString(record.sessionId, `${method}.sessionId`),
    scope,
    ...(record.leaseGeneration === undefined
      ? {}
      : {
          leaseGeneration: parseNonNegativeInteger(record.leaseGeneration, `${method}.leaseGeneration`),
        }),
    ...(record.ttlMs === undefined ? {} : { ttlMs: parseNonNegativeInteger(record.ttlMs, `${method}.ttlMs`) }),
  }
}

export function requireLeaseGeneration(params: import("./types.js").InteractionParams): number {
  if (params.leaseGeneration === undefined) throw new AppServerProtocolError("invalid_params", "leaseGeneration is required")
  return params.leaseGeneration
}

// ---------------------------------------------------------------------------
// session.command action discriminated union
// ---------------------------------------------------------------------------

export const permissionModeSchema = z.enum(
  PERMISSION_MODES as unknown as readonly [AppServerPermissionMode, ...AppServerPermissionMode[]],
  {
    message: "session.command.action.mode is invalid",
  },
)
function parsePermissionRules(value: unknown, name: string): readonly AppServerPermissionRule[] {
  if (!Array.isArray(value)) throw new AppServerProtocolError("invalid_params", `${name} must be an array`)
  const rulesSchema = z.object({
    // Ingest bound mirrored from core's SESSION_PERMISSION_RULE_NAME_MAX (128);
    // this package deliberately carries no @ag2cli/core dependency, so the
    // protocol test pins the literal against drift.
    name: z
      .string({
        invalid_type_error: `${name}[].name must be a non-empty string`,
        required_error: `${name}[].name must be a non-empty string`,
      })
      .refine((value) => value.trim().length > 0, { message: `${name}[].name must be a non-empty string` })
      .refine((value) => value.trim().length <= 128, { message: `${name}[].name must be 1 to 128 characters long` }),
    behavior: z.enum(
      PERMISSION_RULE_BEHAVIORS as unknown as readonly [AppServerPermissionRuleBehavior, ...AppServerPermissionRuleBehavior[]],
      {
        message: `${name}[].behavior is invalid`,
      },
    ),
  })
  // First release: only Deny(bash) is a legal bash permission rule. This
  // refinement is a runtime-only guard — superRefine does not survive the
  // zod-to-json-schema export in schema.ts.
  const schema = rulesSchema.superRefine((rule, ctx) => {
    if (rule.name.trim() === "bash" && rule.behavior !== "deny") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name}[]: bash rules only support behavior deny (allow/ask are rejected)` })
    }
  })
  return value.map((item, index) => {
    try {
      return schema.parse(item)
    } catch (error) {
      if (error instanceof ZodError) {
        throw new AppServerProtocolError("invalid_params", (error.issues[0]?.message ?? error.message).replace("[]", `[${index}]`))
      }
      throw error
    }
  })
}

function parseGoalUpdate(value: unknown): AppServerGoalUpdate {
  const update = asRecord(value, "session.command.action.update")
  if (update.action === "set")
    return {
      action: "set",
      text: parseNonEmptyString(update.text, "session.command.action.update.text"),
    }
  if (update.action === "clear" || update.action === "pause" || update.action === "resume") return { action: update.action }
  throw new AppServerProtocolError("invalid_params", "session.command.action.update.action is invalid")
}

function parseArgv(value: unknown): readonly string[] {
  const message = "session.command.action.argv must be a non-empty string array"
  return zodParse(
    z
      .array(z.string({ invalid_type_error: message }), {
        invalid_type_error: message,
      })
      .min(1, { message }),
    value,
  )
}

function parseCreateTaskAction(record: Record<string, unknown>): Extract<AppServerSessionCommandAction, { readonly type: "createTask" }> {
  const taskType = zodParse(
    z.enum(TASK_TYPES as unknown as readonly [AppServerTaskType, ...AppServerTaskType[]], {
      message: "session.command.action.taskType is invalid",
    }),
    record.taskType,
  )
  const argv = record.argv === undefined ? undefined : parseArgv(record.argv)
  return {
    type: "createTask",
    taskType,
    title: parseNonEmptyString(record.title, "session.command.action.title"),
    ...(record.prompt === undefined
      ? {}
      : {
          prompt: parseNonEmptyString(record.prompt, "session.command.action.prompt"),
        }),
    ...(argv === undefined ? {} : { argv }),
    ...(record.intervalMs === undefined
      ? {}
      : {
          intervalMs: parsePositiveInteger(record.intervalMs, "session.command.action.intervalMs"),
        }),
    ...(record.maxRuns === undefined
      ? {}
      : {
          maxRuns: parsePositiveInteger(record.maxRuns, "session.command.action.maxRuns"),
        }),
    ...(record.workspace === undefined
      ? {}
      : {
          workspace: parseNonEmptyString(record.workspace, "session.command.action.workspace"),
        }),
    ...(record.parentRunId === undefined
      ? {}
      : {
          parentRunId: parseNonEmptyString(record.parentRunId, "session.command.action.parentRunId"),
        }),
  }
}

function parseSessionCommandAction(value: unknown): AppServerSessionCommandAction {
  const record = asRecord(value, "session.command.action")
  rejectRetiredPermissionKeys(record, "session.command.action")
  const rawType = parseNonEmptyString(record.type, "session.command.action.type")
  if (!isSessionCommandActionType(rawType)) {
    throw new AppServerProtocolError("invalid_params", `Unknown session.command action: ${rawType}`)
  }
  const type = rawType
  switch (type) {
    case "addDirectory":
      return {
        type,
        directory: parseNonEmptyString(record.directory, "session.command.action.directory"),
        ...(record.workspaceRoot === undefined
          ? {}
          : {
              workspaceRoot: parseNonEmptyString(record.workspaceRoot, "session.command.action.workspaceRoot"),
            }),
        ...(record.expectedScopeRevision === undefined
          ? {}
          : {
              expectedScopeRevision: parseNonNegativeInteger(record.expectedScopeRevision, "session.command.action.expectedScopeRevision"),
            }),
      }
    case "setPermissionMode": {
      const mode = zodParse(permissionModeSchema, record.mode, "invalid_params") as AppServerPermissionMode
      return {
        type,
        mode,
        ...(record.expectedPolicyRevision === undefined
          ? {}
          : {
              expectedPolicyRevision: parseNonNegativeInteger(
                record.expectedPolicyRevision,
                "session.command.action.expectedPolicyRevision",
              ),
            }),
      }
    }
    case "setPermissionRules":
      return {
        type,
        rules: parsePermissionRules(record.rules, "session.command.action.rules"),
        ...(record.expectedPolicyRevision === undefined
          ? {}
          : {
              expectedPolicyRevision: parseNonNegativeInteger(
                record.expectedPolicyRevision,
                "session.command.action.expectedPolicyRevision",
              ),
            }),
      }
    case "compact": {
      const instructions =
        record.instructions === undefined ? undefined : parseNonEmptyString(record.instructions, "session.command.action.instructions")
      if (instructions !== undefined && instructions.length > 4_096) {
        throw new AppServerProtocolError("invalid_params", "instructions must not exceed 4096 characters")
      }
      return { type, ...(instructions === undefined ? {} : { instructions }) }
    }
    case "setContextWindow":
      return {
        type,
        contextWindow: parsePositiveInteger(record.contextWindow, "session.command.action.contextWindow"),
      }
    case "clearContextWindow":
      return { type }
    case "setAgent":
      return {
        type,
        ...(record.agentName === undefined
          ? {}
          : {
              agentName: parseNonEmptyString(record.agentName, "session.command.action.agentName"),
            }),
      }
    case "updateGoal":
      return { type, update: parseGoalUpdate(record.update) }
    case "createTask":
      return parseCreateTaskAction(record)
    case "listTasks":
      return { type }
    case "cancelTask":
      return {
        type,
        taskId: parseNonEmptyString(record.taskId, "session.command.action.taskId"),
        ...(record.reason === undefined
          ? {}
          : {
              reason: parseNonEmptyString(record.reason, "session.command.action.reason"),
            }),
      }
    case "listCheckpoints":
      return { type }
    case "previewRewind":
    case "rewind":
      return {
        type,
        checkpointId: parseNonEmptyString(record.checkpointId, "session.command.action.checkpointId"),
      }
    case "steer":
      return {
        type,
        runId: parseNonEmptyString(record.runId, "session.command.action.runId"),
        text: parseNonEmptyString(record.text, "session.command.action.text"),
      }
    case "cancelInput":
      return {
        type,
        inputId: parseNonEmptyString(record.inputId, "session.command.action.inputId"),
        ...(record.reason === undefined
          ? {}
          : {
              reason: parseNonEmptyString(record.reason, "session.command.action.reason"),
            }),
      }
    case "executeShell":
      return {
        type,
        argv: parseArgv(record.argv),
        ...(record.cwd === undefined
          ? {}
          : {
              cwd: parseNonEmptyString(record.cwd, "session.command.action.cwd"),
            }),
        ...(record.timeoutMs === undefined
          ? {}
          : {
              timeoutMs: parsePositiveInteger(record.timeoutMs, "session.command.action.timeoutMs"),
            }),
      }
    case "executeUserShell":
      return {
        type,
        command: parseNonEmptyString(record.command, "session.command.action.command"),
        ...(record.cwd === undefined
          ? {}
          : {
              cwd: parseNonEmptyString(record.cwd, "session.command.action.cwd"),
            }),
        ...(record.timeoutMs === undefined
          ? {}
          : {
              timeoutMs: parsePositiveInteger(record.timeoutMs, "session.command.action.timeoutMs"),
            }),
      }
  }
}

function parseLease(value: unknown): {
  readonly scope: InteractionLeaseScope
  readonly generation: number
} {
  const record = asRecord(value, "session.command.lease")
  rejectUnknownFields(record, ["scope", "generation"], "session.command.lease")
  const scope = record.scope
  if (scope !== "composer" && scope !== "session-control") {
    throw new AppServerProtocolError("invalid_params", "session.command.lease.scope must be composer or session-control")
  }
  return {
    scope,
    generation: parseNonNegativeInteger(record.generation, "session.command.lease.generation"),
  }
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedFields = new Set(allowed)
  const unknownField = Object.keys(record).find((field) => !allowedFields.has(field))
  if (unknownField !== undefined) {
    throw new AppServerProtocolError("invalid_params", `${name}.${unknownField} is an unknown field`)
  }
}

/**
 * Retired permission-profile vocabulary is rejected instead of silently dropped:
 * a client upgrading from the old field would otherwise believe it took effect.
 */
function rejectRetiredPermissionKeys(record: Record<string, unknown>, name: string): void {
  for (const key of ["permissionProfile", "permissionProfiles"] as const) {
    if (Object.hasOwn(record, key)) {
      throw new AppServerProtocolError(
        "invalid_params",
        `${name}.${key} is a removed permission field; permissions are determined by the session permission mode`,
      )
    }
  }
}

export function parseSessionCommandParams(value: unknown): SessionCommandParams {
  const record = asRecord(value, "session.command.params")
  rejectRetiredPermissionKeys(record, "session.command.params")
  const commandId = parseNonEmptyString(record.commandId, "session.command.commandId")
  const expectedRevision =
    record.expectedRevision === undefined ? undefined : parseNonNegativeInteger(record.expectedRevision, "session.command.expectedRevision")
  const lease = record.lease === undefined ? undefined : parseLease(record.lease)
  return {
    sessionId: parseNonEmptyString(record.sessionId, "session.command.sessionId"),
    commandId,
    action: parseSessionCommandAction(record.action),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(lease === undefined ? {} : { lease }),
  }
}

export type AppServerMethodParamParser = (value: unknown) => unknown

/**
 * The single runtime-parser registry for method params. `undefined` is intentional for methods
 * whose handlers ignore params entirely; keeping those entries explicit makes additions to
 * `APP_SERVER_METHODS` fail at compile time here instead of silently losing parser coverage.
 * Interaction methods use per-method wrappers because renew/release require a generation while
 * acquire/takeover do not.
 */
export const APP_SERVER_METHOD_PARAM_PARSERS: Readonly<Record<AppServerMethod, AppServerMethodParamParser | undefined>> = {
  "server.initialize": parseServerInitializeParams,
  "server.describe": undefined,
  "server.health": undefined,
  "session.list": parseSessionListParams,
  "session.create": parseSessionCreateParams,
  "session.get": parseSessionGetParams,
  "session.fork": parseSessionForkParams,
  "session.archive": parseSessionArchiveParams,
  "session.delete": parseSessionDeleteParams,
  "session.attach": parseSessionAttachParams,
  "session.detach": parseSessionDetachParams,
  "session.snapshot": parseSessionSnapshotParams,
  "session.command": parseSessionCommandParams,
  "session.plan": parseSessionPlanParams,
  "session.submit": parseSessionSubmitParams,
  "session.cancel": undefined,
  "session.resolveApproval": parseSessionResolveApprovalParams,
  "session.replay": parseSessionReplayParams,
  "session.trace": parseSessionTraceParams,
  "session.modelCalls": parseSessionModelCallsParams,
  "session.resync": parseSessionResyncParams,
  "interaction.acquire": (value) => parseInteractionRequest(value, "interaction.acquire"),
  "interaction.renew": (value) => {
    const params = parseInteractionRequest(value, "interaction.renew")
    requireLeaseGeneration(params)
    return params
  },
  "interaction.release": (value) => {
    const params = parseInteractionRequest(value, "interaction.release")
    requireLeaseGeneration(params)
    return params
  },
  "interaction.takeover": (value) => parseInteractionRequest(value, "interaction.takeover"),
  "device.list": undefined,
  "device.revoke": parseDeviceRevokeParams,
}

// ---------------------------------------------------------------------------
// Generic JSON value passthrough.
// ---------------------------------------------------------------------------

export function assertJsonValue(value: unknown, name: string): JsonValue {
  if (!isJsonValue(value)) throw new AppServerProtocolError("invalid_params", `${name} must be a JSON value`)
  return value
}
