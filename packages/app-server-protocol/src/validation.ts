import { z, ZodError, type ZodType } from "zod"
import {
  APP_SERVER_METHODS,
  APP_SERVER_NOTIFICATION_METHODS,
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_SCOPES,
  type AppServerClientInfo,
  type AppServerDeviceRecord,
  type AppServerDeviceChallenge,
  type AppServerHostProofPurpose,
  type AppServerMethod,
  type AppServerNotificationMethod,
  type AppServerPairCreateParams,
  type AppServerPairCreateResult,
  type AppServerPairPreviewParams,
  type AppServerPairPreviewResult,
  type AppServerPairClaimParams,
  type AppServerPairClaimResult,
  type AppServerScope,
  type JsonValue,
  type ServerDescribeResult,
  type ServerInitializeResult,
  type ServerInitializeParams,
  type ServerPreflightParams,
  type ServerPreflightResult,
} from "./types.js"
import { isJsonValue } from "./json-rpc.js"
import {
  decodeBase64Url,
  isAppServerDeviceChallenge,
  isAppServerDevicePublicKey,
  isAppServerDeviceSignature,
  isValidAppServerDeviceChallenge,
} from "./device-proof.js"
import {
  decodeAppServerHostProofSignature,
  decodeAppServerHostPublicKey,
  isAppServerHostId,
  isAppServerHostProofPurpose,
  isValidAppServerHostProofNonce,
} from "./host-proof.js"
import {
  booleanSchema,
  freeformStringArraySchema,
  nonEmptyStringArraySchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
} from "./dto/primitives.js"
import { isKnownPublicSessionEventType, publicSessionEventEnvelopeSchema, publicSessionEventSchema } from "./dto/events.js"
import { appServerCapabilitiesSchema } from "./dto/capabilities.js"
import {
  sessionArchiveParamsSchema,
  sessionArchiveResultSchema,
  sessionCreateParamsSchema,
  sessionDeleteParamsSchema,
  sessionDeleteResultSchema,
  sessionForkParamsSchema,
  sessionGetParamsSchema,
  sessionGetResultSchema,
  sessionListParamsSchema,
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
import {
  interactionLeaseUpdatedNotificationParamsSchema,
  presenceUpdatedNotificationParamsSchema,
  sessionResyncRequiredNotificationParamsSchema,
  sessionTransientNotificationParamsSchema,
  type AppServerSessionEventNotificationParams,
  type InteractionLeaseUpdatedNotificationParams,
  type PresenceUpdatedNotificationParams,
  type SessionResyncRequiredNotificationParams,
  type SessionTransientNotificationParams,
} from "./dto/notifications.js"

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

// The shared building blocks below are defined in `dto/primitives.js` with
// Zod-native constraints (`.min()`/`.int()`/`.regex()`) so JSON Schema
// generation preserves them; per-field error messages are unchanged. They are
// re-exported here because method params schemas and external consumers have
// historically imported them from this module.
export {
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
  booleanSchema,
  nonEmptyStringArraySchema,
  freeformStringArraySchema,
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

export function asRecord(value: unknown, name: string, errorKind = "invalid_params"): Record<string, unknown> {
  return zodParse(
    z.record(z.string(), z.unknown(), {
      invalid_type_error: `${name} must be an object`,
      required_error: `${name} must be an object`,
    }),
    value,
    errorKind,
  )
}

export const scopeSchema = z.enum(APP_SERVER_SCOPES as unknown as readonly [AppServerScope, ...AppServerScope[]], {
  message: "scope is invalid",
})

function parseScopes(value: unknown, errorKind = "invalid_params", fieldName = "requestedScopes"): readonly AppServerScope[] {
  const scopes = zodParse(z.array(scopeSchema, { invalid_type_error: `${fieldName} must be an array` }), value, errorKind)
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
  rejectUnknownFields(
    record,
    ["appServerProtocolVersion", "hostId", "client", "auth", "requestedScopes", "clientCapabilities", "recovery"],
    "server.initialize.params",
  )
  if (record.appServerProtocolVersion !== APP_SERVER_PROTOCOL_VERSION) {
    throw new AppServerProtocolError(
      "protocol_version_mismatch",
      `App Server protocol major version is unsupported: ${String(record.appServerProtocolVersion)}`,
      { details: { supported: APP_SERVER_PROTOCOL_VERSION } },
    )
  }
  const hostId = parseNonEmptyString(record.hostId, "hostId")
  if (!isAppServerHostId(hostId)) throw new AppServerProtocolError("invalid_params", "hostId has an invalid format")
  const client = parseClientInfo(record.client)
  const auth = parseServerInitializeAuth(record.auth)
  const requestedScopes = record.requestedScopes === undefined ? undefined : parseScopes(record.requestedScopes)
  const clientCapabilities =
    record.clientCapabilities === undefined ? undefined : zodParse(appServerCapabilitiesSchema, record.clientCapabilities, "invalid_params")
  const recovery = record.recovery === undefined ? undefined : parseRecovery(record.recovery)
  return {
    appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
    hostId,
    client,
    auth,
    ...(requestedScopes === undefined ? {} : { requestedScopes }),
    ...(clientCapabilities === undefined ? {} : { clientCapabilities }),
    ...(recovery === undefined ? {} : { recovery }),
  }
}

function parseServerInitializeAuth(value: unknown): ServerInitializeParams["auth"] {
  const record = asRecord(value, "server.initialize.params.auth")
  if (record.type === "device") {
    rejectUnknownFields(record, ["type", "device"], "server.initialize.params.auth")
    const device = asRecord(record.device, "server.initialize.params.auth.device")
    rejectUnknownFields(device, ["deviceId", "credential", "challenge", "signature"], "server.initialize.params.auth.device")
    const parsed = {
      deviceId: parseNonEmptyString(device.deviceId, "deviceId"),
      credential: parseNonEmptyString(device.credential, "credential"),
      challenge: parseNonEmptyString(device.challenge, "challenge"),
      signature: parseNonEmptyString(device.signature, "signature"),
    }
    if (!isEncoded32ByteToken(parsed.credential, "ag2cli-device.")) {
      throw new AppServerProtocolError("invalid_params", "credential has an invalid format")
    }
    if (!isAppServerDeviceChallenge(parsed.challenge)) throw new AppServerProtocolError("invalid_params", "challenge has an invalid format")
    if (!isAppServerDeviceSignature(parsed.signature)) throw new AppServerProtocolError("invalid_params", "signature has an invalid format")
    return { type: "device", device: parsed }
  }
  if (record.type === "operator") {
    rejectUnknownFields(record, ["type", "bearerToken"], "server.initialize.params.auth")
    return { type: "operator", bearerToken: parseNonEmptyString(record.bearerToken, "bearerToken") }
  }
  throw new AppServerProtocolError("invalid_params", "auth.type must be device or operator")
}

export function parseServerPreflightParams(value: unknown): ServerPreflightParams {
  const record = asRecord(value, "server.preflight.params")
  rejectUnknownFields(record, ["nonce", "purpose"], "server.preflight.params")
  const nonce = parseNonEmptyString(record.nonce, "nonce")
  if (!isValidAppServerHostProofNonce(nonce)) {
    throw new AppServerProtocolError("invalid_params", "nonce has an invalid format")
  }
  return {
    nonce,
    purpose: parseHostProofPurpose(record.purpose, "invalid_params"),
  }
}

export function parseServerPreflightResult(value: unknown): ServerPreflightResult {
  const record = zodParse(
    z.record(z.string(), z.unknown(), {
      invalid_type_error: "server.preflight.result must be an object",
      required_error: "server.preflight.result must be an object",
    }),
    value,
    "invalid_result",
  )
  rejectUnknownFields(
    record,
    ["hostId", "hostPublicKey", "nonce", "purpose", "expiresAt", "signature", "deviceChallenge", "deviceChallengeExpiresAt"],
    "server.preflight.result",
    "invalid_result",
  )
  const hostId = parseResultNonEmptyString(record.hostId, "hostId")
  const hostPublicKey = parseResultNonEmptyString(record.hostPublicKey, "hostPublicKey")
  const nonce = parseResultNonEmptyString(record.nonce, "nonce")
  const purpose = parseHostProofPurpose(record.purpose, "invalid_result")
  const expiresAt = parseResultNonNegativeInteger(record.expiresAt, "expiresAt")
  const signature = parseResultNonEmptyString(record.signature, "signature")
  const deviceChallenge =
    record.deviceChallenge === undefined ? undefined : parseResultNonEmptyString(record.deviceChallenge, "deviceChallenge")
  const deviceChallengeExpiresAt =
    record.deviceChallengeExpiresAt === undefined
      ? undefined
      : parseResultNonNegativeInteger(record.deviceChallengeExpiresAt, "deviceChallengeExpiresAt")

  if (!isAppServerHostId(hostId)) throw new AppServerProtocolError("invalid_result", "hostId has an invalid format")
  if (decodeAppServerHostPublicKey(hostPublicKey) === undefined) {
    throw new AppServerProtocolError("invalid_result", "hostPublicKey has an invalid format")
  }
  if (!isValidAppServerHostProofNonce(nonce)) throw new AppServerProtocolError("invalid_result", "nonce has an invalid format")
  if (decodeAppServerHostProofSignature(signature) === undefined) {
    throw new AppServerProtocolError("invalid_result", "signature has an invalid format")
  }
  const common = { hostId, hostPublicKey, nonce, expiresAt, signature }
  if (purpose === "device-connect") {
    if (deviceChallenge === undefined || deviceChallengeExpiresAt === undefined) {
      throw new AppServerProtocolError("invalid_result", "device-connect preflight requires a device challenge and expiry")
    }
    if (!isValidAppServerHostProofNonce(deviceChallenge)) {
      throw new AppServerProtocolError("invalid_result", "deviceChallenge has an invalid format")
    }
    return { ...common, purpose, deviceChallenge, deviceChallengeExpiresAt }
  }
  if (deviceChallenge !== undefined || deviceChallengeExpiresAt !== undefined) {
    throw new AppServerProtocolError("invalid_result", "only device-connect preflight may include a device challenge")
  }
  return { ...common, purpose }
}

function parseHostProofPurpose(value: unknown, errorKind: string): AppServerHostProofPurpose {
  if (typeof value === "string" && isAppServerHostProofPurpose(value)) return value
  throw new AppServerProtocolError(errorKind, "purpose is invalid")
}

const clientInfoSchema = z.object({
  clientId: nonEmptyStringSchema("client.clientId"),
  name: nonEmptyStringSchema("client.name"),
  version: nonEmptyStringSchema("client.version"),
  capabilities: nonEmptyStringArraySchema("client.capabilities").optional(),
})

function parseClientInfo(value: unknown): AppServerClientInfo {
  const record = asRecord(value, "server.initialize.params.client")
  rejectUnknownFields(record, ["clientId", "clientKind", "name", "version", "capabilities"], "server.initialize.params.client")
  const parsed = zodParse(clientInfoSchema, record)
  return {
    clientId: parsed.clientId,
    clientKind: parseClientKind(record.clientKind, "client.clientKind"),
    name: parsed.name,
    version: parsed.version,
    ...(parsed.capabilities === undefined ? {} : { capabilities: parsed.capabilities }),
  }
}

function parseRecovery(value: unknown): NonNullable<ServerInitializeParams["recovery"]> {
  const record = asRecord(value, "server.initialize.params.recovery")
  rejectUnknownFields(record, ["sessionId", "afterRevision"], "server.initialize.params.recovery")
  const sessionId = record.sessionId === undefined ? undefined : parseNonEmptyString(record.sessionId, "recovery.sessionId")
  const afterRevision =
    record.afterRevision === undefined ? undefined : parseNonNegativeInteger(record.afterRevision, "recovery.afterRevision")
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(afterRevision === undefined ? {} : { afterRevision }),
  }
}

export function parseServerInitializeResult(value: unknown): ServerInitializeResult {
  const record = asRecord(value, "server.initialize.result", "invalid_result")
  if (record.appServerProtocolVersion !== APP_SERVER_PROTOCOL_VERSION) {
    throw new AppServerProtocolError(
      "protocol_version_mismatch",
      `App Server protocol major version is unsupported: ${String(record.appServerProtocolVersion)}`,
      { details: { supported: APP_SERVER_PROTOCOL_VERSION } },
    )
  }
  const server = asRecord(record.server, "server.initialize.result.server", "invalid_result")
  rejectUnknownFields(server, ["name", "version", "hostId", "protocolVersion"], "server.initialize.result.server", "invalid_result")
  if (server.protocolVersion !== APP_SERVER_PROTOCOL_VERSION) {
    throw new AppServerProtocolError(
      "protocol_version_mismatch",
      `Server descriptor protocol major version is unsupported: ${String(server.protocolVersion)}`,
      { details: { supported: APP_SERVER_PROTOCOL_VERSION } },
    )
  }
  const hostId = parseResultNonEmptyString(server.hostId, "server.hostId")
  if (!isAppServerHostId(hostId)) throw new AppServerProtocolError("invalid_result", "server.hostId has an invalid format")
  const connection = asRecord(record.connection, "server.initialize.result.connection", "invalid_result")
  rejectUnknownFields(connection, ["connectionId", "deviceId", "scopes"], "server.initialize.result.connection", "invalid_result")
  const host = record.host === undefined ? undefined : asRecord(record.host, "server.initialize.result.host", "invalid_result")
  const profile = host?.profile
  if (host !== undefined && profile !== "durable" && profile !== "ephemeral") {
    throw new AppServerProtocolError("invalid_result", "server.initialize.result.host.profile is invalid")
  }
  rejectUnknownFields(
    record,
    ["appServerProtocolVersion", "server", "connection", "capabilities", "host"],
    "server.initialize.result",
    "invalid_result",
  )
  if (host !== undefined) {
    rejectUnknownFields(
      host,
      ["profile", "workspaceRoot", "workspaces", "configurationFingerprint", "workspaceFingerprint", "securityFingerprint"],
      "server.initialize.result.host",
      "invalid_result",
    )
  }
  return {
    appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
    server: {
      name: parseResultNonEmptyString(server.name, "server.name"),
      version: parseResultNonEmptyString(server.version, "server.version"),
      hostId,
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    },
    connection: {
      connectionId: parseResultNonEmptyString(connection.connectionId, "connection.connectionId"),
      ...(connection.deviceId === undefined ? {} : { deviceId: parseResultNonEmptyString(connection.deviceId, "connection.deviceId") }),
      scopes: parseScopes(connection.scopes, "invalid_result", "connection.scopes"),
    },
    capabilities: zodParse(appServerCapabilitiesSchema, record.capabilities, "invalid_result"),
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

export function parseServerDescribeResult(value: unknown): ServerDescribeResult {
  const record = asRecord(value, "server.describe.result", "invalid_result")
  rejectUnknownFields(record, ["server", "capabilities"], "server.describe.result", "invalid_result")
  const server = asRecord(record.server, "server.describe.result.server", "invalid_result")
  rejectUnknownFields(server, ["name", "version", "hostId", "protocolVersion"], "server.describe.result.server", "invalid_result")
  if (server.protocolVersion !== APP_SERVER_PROTOCOL_VERSION) {
    throw new AppServerProtocolError(
      "protocol_version_mismatch",
      `Server descriptor protocol major version is unsupported: ${String(server.protocolVersion)}`,
      { details: { supported: APP_SERVER_PROTOCOL_VERSION } },
    )
  }
  const hostId = parseResultNonEmptyString(server.hostId, "server.hostId")
  if (!isAppServerHostId(hostId)) throw new AppServerProtocolError("invalid_result", "server.hostId has an invalid format")
  return {
    server: {
      name: parseResultNonEmptyString(server.name, "server.name"),
      version: parseResultNonEmptyString(server.version, "server.version"),
      hostId,
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    },
    capabilities: zodParse(appServerCapabilitiesSchema, record.capabilities, "invalid_result"),
  }
}

function parseResultNonEmptyString(value: unknown, name: string): string {
  return zodParse(nonEmptyStringSchema(name), value, "invalid_result")
}

function parseResultNonNegativeInteger(value: unknown, name: string): number {
  return zodParse(nonNegativeIntegerSchema(name), value, "invalid_result")
}

// ---------------------------------------------------------------------------
// pairing / device
// ---------------------------------------------------------------------------

const pairingTokenSchema = nonEmptyStringSchema("pairingToken")
  .refine((value) => /^ag2cli-pairing\.[A-Za-z0-9_-]{43}$/u.test(value), {
    message: "pairingToken has an invalid format",
  })
  .refine((value) => isEncoded32ByteToken(value, "ag2cli-pairing."), { message: "pairingToken has an invalid format" })

function isEncoded32ByteToken(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) return false
  return decodeBase64Url(value.slice(prefix.length))?.byteLength === 32
}

const PAIRING_SCOPES = new Set<AppServerScope>([
  "session:read",
  "session:write",
  "approval:write",
  "shell:execute",
  "session:policy",
  "workspace:read",
])

function parsePairingScopes(value: unknown, errorKind = "invalid_params"): readonly AppServerScope[] {
  const scopes = parseScopes(value, errorKind, "scopes")
  if (scopes.length === 0 || scopes.some((scope) => !PAIRING_SCOPES.has(scope))) {
    throw new AppServerProtocolError(errorKind, "scopes must contain only pairable scopes")
  }
  return scopes
}

function parsePairingExpiry(value: unknown, errorKind: string): string {
  const expiresAt = errorKind === "invalid_result" ? parseResultNonEmptyString(value, "expiresAt") : parseNonEmptyString(value, "expiresAt")
  if (!Number.isFinite(Date.parse(expiresAt))) throw new AppServerProtocolError(errorKind, "expiresAt must be a valid date")
  return expiresAt
}

export function parsePairCreateParams(value: unknown): AppServerPairCreateParams {
  const record = asRecord(value, "pair.create.params")
  rejectUnknownFields(record, ["scopes", "ttlMs"], "pair.create.params")
  const scopes = parsePairingScopes(record.scopes)
  const ttlMs = record.ttlMs === undefined ? undefined : parsePositiveInteger(record.ttlMs, "ttlMs")
  if (ttlMs !== undefined && (ttlMs < 30_000 || ttlMs > 600_000)) {
    throw new AppServerProtocolError("invalid_params", "ttlMs must be between 30000 and 600000")
  }
  return { scopes, ...(ttlMs === undefined ? {} : { ttlMs }) }
}

export function parsePairPreviewParams(value: unknown): AppServerPairPreviewParams {
  const record = asRecord(value, "pair.preview.params")
  rejectUnknownFields(record, ["pairingToken"], "pair.preview.params")
  return { pairingToken: zodParse(pairingTokenSchema, record.pairingToken) }
}

export function parsePairClaimParams(value: unknown): AppServerPairClaimParams {
  const record = asRecord(value, "pair.claim.params")
  rejectUnknownFields(record, ["pairingToken", "name", "clientKind", "publicKey"], "pair.claim.params")
  if (record.clientKind !== "mobile" && record.clientKind !== "web") {
    throw new AppServerProtocolError("invalid_params", "clientKind must be web or mobile")
  }
  const publicKey = parseNonEmptyString(record.publicKey, "publicKey")
  if (!isAppServerDevicePublicKey(publicKey)) throw new AppServerProtocolError("invalid_params", "publicKey has an invalid format")
  return {
    pairingToken: zodParse(pairingTokenSchema, record.pairingToken),
    name: parseNonEmptyString(record.name, "name"),
    clientKind: record.clientKind,
    publicKey,
  }
}

export function parseAppServerPairCreateResult(value: unknown): AppServerPairCreateResult {
  const record = asRecord(value, "pair.create.result", "invalid_result")
  rejectUnknownFields(record, ["pairingToken", "hostId", "scopes", "expiresAt"], "pair.create.result", "invalid_result")
  const hostId = parseResultNonEmptyString(record.hostId, "hostId")
  if (!isAppServerHostId(hostId)) throw new AppServerProtocolError("invalid_result", "hostId has an invalid format")
  const pairingToken = zodParse(pairingTokenSchema, record.pairingToken, "invalid_result")
  const scopes = parsePairingScopes(record.scopes, "invalid_result")
  const expiresAt = parsePairingExpiry(record.expiresAt, "invalid_result")
  return { pairingToken, hostId, scopes, expiresAt }
}

export function parseAppServerPairPreviewResult(value: unknown): AppServerPairPreviewResult {
  const record = asRecord(value, "pair.preview.result", "invalid_result")
  rejectUnknownFields(record, ["hostId", "scopes", "expiresAt"], "pair.preview.result", "invalid_result")
  const hostId = parseResultNonEmptyString(record.hostId, "hostId")
  if (!isAppServerHostId(hostId)) throw new AppServerProtocolError("invalid_result", "hostId has an invalid format")
  return {
    hostId,
    scopes: parsePairingScopes(record.scopes, "invalid_result"),
    expiresAt: parsePairingExpiry(record.expiresAt, "invalid_result"),
  }
}

export function parseAppServerPairClaimResult(value: unknown): AppServerPairClaimResult {
  const record = asRecord(value, "pair.claim.result", "invalid_result")
  rejectUnknownFields(record, ["device", "credential"], "pair.claim.result", "invalid_result")
  const credential = parseResultNonEmptyString(record.credential, "credential")
  if (!isEncoded32ByteToken(credential, "ag2cli-device.")) {
    throw new AppServerProtocolError("invalid_result", "credential has an invalid format")
  }
  const device = parseDeviceRecord(record.device)
  parsePairingScopes(device.scopes, "invalid_result")
  if (device.publicKey !== undefined && !isAppServerDevicePublicKey(device.publicKey)) {
    throw new AppServerProtocolError("invalid_result", "device.publicKey has an invalid format")
  }
  return {
    device,
    credential,
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
  const record = asRecord(value, "server.preflight.deviceChallenge", "invalid_result")
  rejectUnknownFields(record, ["challenge", "hostId", "expiresAt"], "server.preflight.deviceChallenge", "invalid_result")
  const challenge = parseResultNonEmptyString(record.challenge, "challenge")
  const hostId = parseResultNonEmptyString(record.hostId, "hostId")
  const expiresAt = parseResultNonNegativeInteger(record.expiresAt, "expiresAt")
  if (
    !isValidAppServerDeviceChallenge({
      challenge,
      hostId,
      expiresAt,
    })
  ) {
    throw new AppServerProtocolError("invalid_result", "server.preflight.deviceChallenge has an invalid structure")
  }
  return { challenge, hostId, expiresAt }
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

export function parseSessionListParams(value: unknown): import("./types.js").SessionListParams {
  return zodParse(sessionListParamsSchema, value)
}

export function parseSessionCreateParams(value: unknown): import("./types.js").SessionCreateParams {
  return zodParse(sessionCreateParamsSchema, value)
}

export function parseSessionGetParams(value: unknown): import("./types.js").SessionGetParams {
  return zodParse(sessionGetParamsSchema, value)
}

export function parseSessionForkParams(value: unknown): import("./types.js").SessionForkParams {
  return zodParse(sessionForkParamsSchema, value)
}

export function parseSessionArchiveParams(value: unknown): import("./types.js").SessionArchiveParams {
  return zodParse(sessionArchiveParamsSchema, value)
}

export function parseSessionDeleteParams(value: unknown): import("./types.js").SessionDeleteParams {
  return zodParse(sessionDeleteParamsSchema, value)
}

export function parseSessionListResult(value: unknown): import("./types.js").SessionListResult {
  return zodParse(sessionListResultSchema, value, "invalid_result")
}

export function parseSessionCreateResult(value: unknown): import("./types.js").SessionSnapshotResult {
  return zodParse(sessionSnapshotResultSchema, value, "invalid_result")
}

export function parseSessionGetResult(value: unknown): import("./types.js").SessionGetResult {
  return zodParse(sessionGetResultSchema, value, "invalid_result")
}

export function parseSessionForkResult(value: unknown): import("./types.js").SessionSnapshotResult {
  return zodParse(sessionSnapshotResultSchema, value, "invalid_result")
}

export function parseSessionArchiveResult(value: unknown): import("./types.js").SessionArchiveResult {
  return zodParse(sessionArchiveResultSchema, value, "invalid_result")
}

export function parseSessionDeleteResult(value: unknown): import("./types.js").SessionDeleteResult {
  return zodParse(sessionDeleteResultSchema, value, "invalid_result")
}

export function parseSessionAttachParams(value: unknown): import("./types.js").SessionAttachParams {
  return zodParse(sessionAttachParamsSchema, value)
}

export function parseSessionAttachResult(value: unknown): import("./types.js").SessionAttachResult {
  return zodParse(sessionAttachResultSchema, value, "invalid_result")
}

export function parseSessionDetachParams(value: unknown): import("./types.js").SessionDetachParams {
  return zodParse(sessionDetachParamsSchema, value)
}

export function parseSessionDetachResult(value: unknown): import("./types.js").SessionDetachResult {
  return zodParse(sessionDetachResultSchema, value, "invalid_result")
}

export function parseSessionSnapshotParams(value: unknown): import("./types.js").SessionSnapshotMethodParams {
  return zodParse(sessionSnapshotMethodParamsSchema, value)
}

export function parseSessionSnapshotMethodResult(value: unknown): import("./types.js").SessionSnapshotMethodResult {
  return zodParse(sessionSnapshotMethodResultSchema, value, "invalid_result")
}

export function parseSessionSubmitParams(value: unknown): import("./types.js").SessionSubmitParams {
  return zodParse(sessionSubmitParamsSchema, value)
}

export function parseSessionSubmitResult(value: unknown): import("./types.js").SessionSubmitResult {
  return zodParse(sessionSubmitResultSchema, value, "invalid_result")
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
  return zodParse(sessionReplayParamsSchema, value)
}

export function parseSessionReplayResult(value: unknown): import("./types.js").SessionReplayResult {
  return zodParse(sessionReplayResultSchema, value, "invalid_result")
}

export function parseSessionResyncParams(value: unknown): import("./types.js").SessionResyncParams {
  return zodParse(sessionResyncParamsSchema, value)
}

export function parseSessionResyncResult(value: unknown): import("./types.js").SessionResyncResult {
  return zodParse(sessionResyncResultSchema, value, "invalid_result")
}

export function parseSessionSteerParams(value: unknown): import("./types.js").SessionSteerParams {
  return zodParse(sessionSteerParamsSchema, value)
}

export function parseSessionSteerResult(value: unknown): import("./types.js").SessionSteerResult {
  return zodParse(sessionSteerResultSchema, value, "invalid_result")
}

export function parseSessionCancelRunParams(value: unknown): import("./types.js").SessionCancelRunParams {
  return zodParse(sessionCancelRunParamsSchema, value)
}

export function parseSessionCancelRunResult(value: unknown): import("./types.js").SessionCancelRunResult {
  return zodParse(sessionCancelRunResultSchema, value, "invalid_result")
}

export function parseSessionCancelInputParams(value: unknown): import("./types.js").SessionCancelInputParams {
  return zodParse(sessionCancelInputParamsSchema, value)
}

export function parseSessionCancelInputResult(value: unknown): import("./types.js").SessionCancelInputResult {
  return zodParse(sessionCancelInputResultSchema, value, "invalid_result")
}

export function parseSessionMessagesParams(value: unknown): import("./types.js").SessionMessagesParams {
  return zodParse(sessionMessagesParamsSchema, value)
}

export function parseSessionResolveInteractionParams(value: unknown): import("./types.js").SessionResolveInteractionParams {
  return zodParse(sessionResolveInteractionParamsSchema, value)
}

export function parseSessionResolveInteractionResult(value: unknown): import("./types.js").SessionResolveInteractionResult {
  return zodParse(sessionResolveInteractionResultSchema, value, "invalid_result")
}

export function parseSessionGetPermissionPolicyParams(value: unknown): import("./types.js").SessionGetPermissionPolicyParams {
  return zodParse(sessionGetPermissionPolicyParamsSchema, value)
}

/** Reads and writes share one result parser: the full policy document. */
export function parseSessionPermissionPolicyResult(value: unknown): import("./types.js").SessionGetPermissionPolicyResult {
  return zodParse(sessionGetPermissionPolicyResultSchema, value, "invalid_result")
}

export function parseSessionSetPermissionModeParams(value: unknown): import("./types.js").SessionSetPermissionModeParams {
  return zodParse(sessionSetPermissionModeParamsSchema, value)
}

export function parseSessionSetPermissionRulesParams(value: unknown): import("./types.js").SessionSetPermissionRulesParams {
  return zodParse(sessionSetPermissionRulesParamsSchema, value)
}

export function parseWorkspaceDiffParams(value: unknown): import("./types.js").WorkspaceDiffParams {
  return zodParse(workspaceDiffParamsSchema, value)
}

export function parseWorkspaceDiffResult(value: unknown): import("./types.js").WorkspaceDiffResult {
  return zodParse(workspaceDiffResultSchema, value, "invalid_result")
}

export function parseWorkspaceReadFileParams(value: unknown): import("./types.js").WorkspaceReadFileParams {
  return zodParse(workspaceReadFileParamsSchema, value)
}

export function parseWorkspaceReadFileResult(value: unknown): import("./types.js").WorkspaceReadFileResult {
  return zodParse(workspaceReadFileResultSchema, value, "invalid_result")
}

export function parseSessionCreateTaskParams(value: unknown): import("./types.js").SessionCreateTaskParams {
  return zodParse(sessionCreateTaskParamsSchema, value)
}

export function parseSessionCompactParams(value: unknown): import("./types.js").SessionCompactParams {
  return zodParse(sessionCompactParamsSchema, value)
}

export function parseSessionCompactResult(value: unknown): import("./types.js").SessionCompactResult {
  return zodParse(sessionCompactResultSchema, value, "invalid_result")
}

export function parseSessionAddDirectoryParams(value: unknown): import("./types.js").SessionAddDirectoryParams {
  return zodParse(sessionAddDirectoryParamsSchema, value)
}

export function parseSessionAddDirectoryResult(value: unknown): import("./types.js").SessionAddDirectoryResult {
  return zodParse(sessionAddDirectoryResultSchema, value, "invalid_result")
}

export function parseSessionSetContextWindowParams(value: unknown): import("./types.js").SessionSetContextWindowParams {
  return zodParse(sessionSetContextWindowParamsSchema, value)
}

export function parseSessionSetContextWindowResult(value: unknown): import("./types.js").SessionSetContextWindowResult {
  return zodParse(sessionSetContextWindowResultSchema, value, "invalid_result")
}

export function parseSessionClearContextWindowParams(value: unknown): import("./types.js").SessionClearContextWindowParams {
  return zodParse(sessionClearContextWindowParamsSchema, value)
}

export function parseSessionClearContextWindowResult(value: unknown): import("./types.js").SessionClearContextWindowResult {
  return zodParse(sessionClearContextWindowResultSchema, value, "invalid_result")
}

export function parseSessionSelectAgentParams(value: unknown): import("./types.js").SessionSelectAgentParams {
  return zodParse(sessionSelectAgentParamsSchema, value)
}

export function parseSessionSelectAgentResult(value: unknown): import("./types.js").SessionSelectAgentResult {
  return zodParse(sessionSelectAgentResultSchema, value, "invalid_result")
}

export function parseSessionUpdateGoalParams(value: unknown): import("./types.js").SessionUpdateGoalParams {
  return zodParse(sessionUpdateGoalParamsSchema, value)
}

export function parseSessionUpdateGoalResult(value: unknown): import("./types.js").SessionUpdateGoalResult {
  return zodParse(sessionUpdateGoalResultSchema, value, "invalid_result")
}

export function parseSessionListCheckpointsParams(value: unknown): import("./types.js").SessionListCheckpointsParams {
  return zodParse(sessionListCheckpointsParamsSchema, value)
}

export function parseSessionListCheckpointsResult(value: unknown): import("./types.js").SessionListCheckpointsResult {
  return zodParse(sessionListCheckpointsResultSchema, value, "invalid_result")
}

export function parseSessionPreviewRewindParams(value: unknown): import("./types.js").SessionPreviewRewindParams {
  return zodParse(sessionPreviewRewindParamsSchema, value)
}

export function parseSessionPreviewRewindResult(value: unknown): import("./types.js").SessionPreviewRewindResult {
  return zodParse(sessionPreviewRewindResultSchema, value, "invalid_result")
}

export function parseSessionRewindParams(value: unknown): import("./types.js").SessionRewindParams {
  return zodParse(sessionRewindParamsSchema, value)
}

export function parseSessionRewindResult(value: unknown): import("./types.js").SessionRewindResult {
  // Cross-field rule: `error` is a fact of failure and travels only with
  // failed statuses. This refinement is a runtime-only guard — superRefine
  // does not survive the zod-to-json-schema export in schema.ts.
  const schema = sessionRewindResultSchema.superRefine((result, ctx) => {
    const failed = result.status === "failed" || result.status === "already_failed"
    if (failed && result.error === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "session.rewind.result.error is required for a failed rewind" })
    }
    if (!failed && result.error !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "session.rewind.result.error is only valid for a failed rewind" })
    }
  })
  return zodParse(schema, value, "invalid_result")
}

export function parseSessionCreateTaskResult(value: unknown): import("./types.js").SessionCreateTaskResult {
  return zodParse(sessionCreateTaskResultSchema, value, "invalid_result")
}

export function parseSessionListTasksParams(value: unknown): import("./types.js").SessionListTasksParams {
  return zodParse(sessionListTasksParamsSchema, value)
}

export function parseSessionListTasksResult(value: unknown): import("./types.js").SessionListTasksResult {
  return zodParse(sessionListTasksResultSchema, value, "invalid_result")
}

export function parseSessionCancelTaskParams(value: unknown): import("./types.js").SessionCancelTaskParams {
  return zodParse(sessionCancelTaskParamsSchema, value)
}

export function parseSessionCancelTaskResult(value: unknown): import("./types.js").SessionCancelTaskResult {
  return zodParse(sessionCancelTaskResultSchema, value, "invalid_result")
}

export function parseSessionGetTaskLogsParams(value: unknown): import("./types.js").SessionGetTaskLogsParams {
  return zodParse(sessionGetTaskLogsParamsSchema, value)
}

export function parseSessionGetTaskLogsResult(value: unknown): import("./types.js").SessionGetTaskLogsResult {
  return zodParse(sessionGetTaskLogsResultSchema, value, "invalid_result")
}

export function parseSessionExecuteShellParams(value: unknown): import("./types.js").SessionExecuteShellParams {
  return zodParse(sessionExecuteShellParamsSchema, value)
}

export function parseSessionExecuteShellResult(value: unknown): import("./types.js").SessionExecuteShellResult {
  return zodParse(sessionExecuteShellResultSchema, value, "invalid_result")
}

export function parseSessionExecuteUserShellParams(value: unknown): import("./types.js").SessionExecuteUserShellParams {
  return zodParse(sessionExecuteUserShellParamsSchema, value)
}

export function parseSessionExecuteUserShellResult(value: unknown): import("./types.js").SessionExecuteUserShellResult {
  return zodParse(sessionExecuteUserShellResultSchema, value, "invalid_result")
}

export function parseSessionMessagesResult(value: unknown): import("./types.js").SessionMessagesResult {
  return zodParse(sessionMessagesResultSchema, value, "invalid_result")
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

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
  errorKind = "invalid_params",
): void {
  const allowedFields = new Set(allowed)
  const unknownField = Object.keys(record).find((field) => !allowedFields.has(field))
  if (unknownField !== undefined) {
    throw new AppServerProtocolError(errorKind, `${name}.${unknownField} is an unknown field`)
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

export type AppServerMethodParamParser = (value: unknown) => unknown

/**
 * The single runtime-parser registry for method params. `undefined` is intentional for methods
 * whose handlers ignore params entirely; keeping those entries explicit makes additions to
 * `APP_SERVER_METHODS` fail at compile time here instead of silently losing parser coverage.
 * Interaction methods use per-method wrappers because renew/release require a generation while
 * acquire/takeover do not.
 */
export const APP_SERVER_METHOD_PARAM_PARSERS: Readonly<Record<AppServerMethod, AppServerMethodParamParser | undefined>> = {
  "server.preflight": parseServerPreflightParams,
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
  "session.plan": parseSessionPlanParams,
  "session.compact": parseSessionCompactParams,
  "session.addDirectory": parseSessionAddDirectoryParams,
  "session.setContextWindow": parseSessionSetContextWindowParams,
  "session.clearContextWindow": parseSessionClearContextWindowParams,
  "session.selectAgent": parseSessionSelectAgentParams,
  "session.updateGoal": parseSessionUpdateGoalParams,
  "session.listCheckpoints": parseSessionListCheckpointsParams,
  "session.previewRewind": parseSessionPreviewRewindParams,
  "session.rewind": parseSessionRewindParams,
  "session.submit": parseSessionSubmitParams,
  "session.steer": parseSessionSteerParams,
  "session.cancelRun": parseSessionCancelRunParams,
  "session.cancelInput": parseSessionCancelInputParams,
  "session.messages": parseSessionMessagesParams,
  "session.resolveInteraction": parseSessionResolveInteractionParams,
  "session.getPermissionPolicy": parseSessionGetPermissionPolicyParams,
  "session.setPermissionMode": parseSessionSetPermissionModeParams,
  "session.setPermissionRules": parseSessionSetPermissionRulesParams,
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
  "pair.create": parsePairCreateParams,
  "pair.preview": parsePairPreviewParams,
  "pair.claim": parsePairClaimParams,
  "device.list": undefined,
  "device.revoke": parseDeviceRevokeParams,
  "workspace.diff": parseWorkspaceDiffParams,
  "workspace.readFile": parseWorkspaceReadFileParams,
  "session.createTask": parseSessionCreateTaskParams,
  "session.listTasks": parseSessionListTasksParams,
  "session.cancelTask": parseSessionCancelTaskParams,
  "session.getTaskLogs": parseSessionGetTaskLogsParams,
  "session.executeShell": parseSessionExecuteShellParams,
  "session.executeUserShell": parseSessionExecuteUserShellParams,
}

/** Client-side result parsers, one per method with a registered result schema
 * (`APP_SERVER_METHOD_RESULT_SCHEMAS`); keep both maps in lockstep. */
export const APP_SERVER_METHOD_RESULT_PARSERS: Readonly<Record<string, (value: unknown) => unknown>> = {
  "server.initialize": parseServerInitializeResult,
  "server.describe": parseServerDescribeResult,
  "server.preflight": parseServerPreflightResult,
  "pair.create": parseAppServerPairCreateResult,
  "pair.preview": parseAppServerPairPreviewResult,
  "pair.claim": parseAppServerPairClaimResult,
  "session.list": parseSessionListResult,
  "session.create": parseSessionCreateResult,
  "session.get": parseSessionGetResult,
  "session.fork": parseSessionForkResult,
  "session.archive": parseSessionArchiveResult,
  "session.delete": parseSessionDeleteResult,
  "session.attach": parseSessionAttachResult,
  "session.detach": parseSessionDetachResult,
  "session.snapshot": parseSessionSnapshotMethodResult,
  "session.replay": parseSessionReplayResult,
  "session.resync": parseSessionResyncResult,
  "session.submit": parseSessionSubmitResult,
  "session.steer": parseSessionSteerResult,
  "session.cancelRun": parseSessionCancelRunResult,
  "session.cancelInput": parseSessionCancelInputResult,
  "session.messages": parseSessionMessagesResult,
  "session.resolveInteraction": parseSessionResolveInteractionResult,
  "session.getPermissionPolicy": parseSessionPermissionPolicyResult,
  "session.setPermissionMode": parseSessionPermissionPolicyResult,
  "session.setPermissionRules": parseSessionPermissionPolicyResult,
  "workspace.diff": parseWorkspaceDiffResult,
  "workspace.readFile": parseWorkspaceReadFileResult,
  "session.createTask": parseSessionCreateTaskResult,
  "session.listTasks": parseSessionListTasksResult,
  "session.cancelTask": parseSessionCancelTaskResult,
  "session.getTaskLogs": parseSessionGetTaskLogsResult,
  "session.executeShell": parseSessionExecuteShellResult,
  "session.executeUserShell": parseSessionExecuteUserShellResult,
  "session.compact": parseSessionCompactResult,
  "session.addDirectory": parseSessionAddDirectoryResult,
  "session.setContextWindow": parseSessionSetContextWindowResult,
  "session.clearContextWindow": parseSessionClearContextWindowResult,
  "session.selectAgent": parseSessionSelectAgentResult,
  "session.updateGoal": parseSessionUpdateGoalResult,
  "session.listCheckpoints": parseSessionListCheckpointsResult,
  "session.previewRewind": parseSessionPreviewRewindResult,
  "session.rewind": parseSessionRewindResult,
}

// ---------------------------------------------------------------------------
// Notification params parsers.
// ---------------------------------------------------------------------------

/**
 * `session.event` is the one notification with a dual-state parse: a known
 * `type` must satisfy its strict variant (a malformed payload is a wire
 * violation), while an unknown `type` is tolerated as envelope + raw payload
 * so clients can skip unknown informational events without dropping the
 * connection.
 */
export function parseSessionEventNotificationParams(value: unknown): AppServerSessionEventNotificationParams {
  const record = asRecord(value, "session.event.params")
  rejectUnknownFields(record, ["event"], "session.event.params")
  const event = record.event
  if (event === undefined) throw new AppServerProtocolError("invalid_params", "session.event.params.event is required")
  const strict = publicSessionEventSchema.safeParse(event)
  if (strict.success) return { event: strict.data }
  if (isKnownPublicSessionEventType((event as { type?: unknown }).type)) {
    throw new AppServerProtocolError("invalid_params", strict.error.issues[0]?.message ?? "session.event.event is invalid")
  }
  const envelope = zodParse(publicSessionEventEnvelopeSchema, event, "invalid_params")
  return { envelope, raw: assertJsonValue(event, "session.event.params.event") }
}

export function parseSessionTransientNotificationParams(value: unknown): SessionTransientNotificationParams {
  return zodParse(sessionTransientNotificationParamsSchema, value, "invalid_params")
}

export function parseSessionResyncRequiredNotificationParams(value: unknown): SessionResyncRequiredNotificationParams {
  return zodParse(sessionResyncRequiredNotificationParamsSchema, value, "invalid_params")
}

export function parsePresenceUpdatedNotificationParams(value: unknown): PresenceUpdatedNotificationParams {
  return zodParse(presenceUpdatedNotificationParamsSchema, value, "invalid_params")
}

export function parseInteractionLeaseUpdatedNotificationParams(value: unknown): InteractionLeaseUpdatedNotificationParams {
  return zodParse(interactionLeaseUpdatedNotificationParamsSchema, value, "invalid_params")
}

export type AppServerNotificationParamParser = (value: unknown) => unknown

/**
 * The single runtime-parser registry for notification params. Every v1
 * notification has a concrete shape, so no entry may stay `undefined`.
 */
export const APP_SERVER_NOTIFICATION_PARAM_PARSERS: Readonly<Record<AppServerNotificationMethod, AppServerNotificationParamParser>> = {
  "session.event": parseSessionEventNotificationParams,
  "session.transient": parseSessionTransientNotificationParams,
  "session.resyncRequired": parseSessionResyncRequiredNotificationParams,
  "presence.updated": parsePresenceUpdatedNotificationParams,
  "interaction.lease.updated": parseInteractionLeaseUpdatedNotificationParams,
}

export function parseAppServerNotificationParams(method: string, value: unknown): unknown {
  if (!(APP_SERVER_NOTIFICATION_METHODS as readonly string[]).includes(method)) {
    throw new AppServerProtocolError("method_not_found", `${method} is not an App Server notification`)
  }
  const parser = APP_SERVER_NOTIFICATION_PARAM_PARSERS[method as AppServerNotificationMethod]
  if (parser === undefined) {
    throw new AppServerProtocolError("invalid_params", `${method} has no v1 notification parser`)
  }
  return parser(value)
}

// ---------------------------------------------------------------------------
// Generic JSON value passthrough.
// ---------------------------------------------------------------------------

export function assertJsonValue(value: unknown, name: string): JsonValue {
  if (!isJsonValue(value)) throw new AppServerProtocolError("invalid_params", `${name} must be a JSON value`)
  return value
}
