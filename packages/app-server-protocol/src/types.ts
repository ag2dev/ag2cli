import type { AppServerCapabilities } from "./dto/capabilities.js"

/** JSON values are the only values that may cross the App Server boundary. */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[]

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId
  readonly method: string
  readonly params?: JsonValue
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: JsonValue
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId | null
  readonly result: JsonValue
}

export interface JsonRpcErrorData {
  /** Stable machine-readable application error identifier. */
  readonly code: string
  readonly retryable?: boolean
  readonly details?: JsonValue
}

export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: JsonRpcErrorData
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId | null
  readonly error: JsonRpcErrorObject
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export const APP_SERVER_PROTOCOL_VERSION = 1 as const
export type AppServerProtocolVersion = typeof APP_SERVER_PROTOCOL_VERSION

export const APP_SERVER_METHODS = [
  "server.preflight",
  "server.initialize",
  "server.describe",
  "server.health",
  "session.list",
  "session.create",
  "session.get",
  "session.fork",
  "session.archive",
  "session.delete",
  "session.attach",
  "session.detach",
  "session.snapshot",
  "session.plan",
  "session.compact",
  "session.addDirectory",
  "session.setContextWindow",
  "session.clearContextWindow",
  "session.selectAgent",
  "session.updateGoal",
  "session.listCheckpoints",
  "session.previewRewind",
  "session.rewind",
  "session.submit",
  "session.steer",
  "session.cancelRun",
  "session.cancelInput",
  "session.messages",
  "session.resolveInteraction",
  "session.getPermissionPolicy",
  "session.setPermissionMode",
  "session.setPermissionRules",
  "session.replay",
  "session.trace",
  "session.modelCalls",
  "session.resync",
  "session.createTask",
  "session.listTasks",
  "session.cancelTask",
  "session.getTaskLogs",
  "session.executeShell",
  "session.executeUserShell",
  "interaction.acquire",
  "interaction.renew",
  "interaction.release",
  "interaction.takeover",
  "pair.create",
  "pair.preview",
  "pair.claim",
  "device.list",
  "device.revoke",
  "workspace.diff",
  "workspace.readFile",
] as const

export type AppServerMethod = (typeof APP_SERVER_METHODS)[number]

export const APP_SERVER_NOTIFICATION_METHODS = [
  "session.event",
  "session.transient",
  "session.resyncRequired",
  "presence.updated",
  "interaction.lease.updated",
] as const

export type AppServerNotificationMethod = (typeof APP_SERVER_NOTIFICATION_METHODS)[number]

export const APP_SERVER_SCOPES = [
  "session:read",
  "session:write",
  "approval:write",
  "shell:execute",
  "config:read",
  "config:write",
  "device:admin",
  "session:policy",
  "workspace:read",
] as const

export type AppServerScope = (typeof APP_SERVER_SCOPES)[number]

export interface AppServerClientInfo {
  readonly clientId: string
  readonly clientKind: "tui" | "web" | "mobile" | "desktop" | "acp" | "script" | "unknown"
  readonly name: string
  readonly version: string
  readonly capabilities?: readonly string[]
}

export type AppServerHostProofPurpose = "pairing-link" | "admin-pairing" | "device-connect"

/** Server-owned identity signer used by the public WebSocket handshake. */
export interface AppServerHostIdentitySigner {
  readonly hostId: string
  readonly hostPublicKey: string
  sign(message: Uint8Array): Uint8Array
}

export interface ServerPreflightParams {
  readonly nonce: string
  readonly purpose: AppServerHostProofPurpose
}

interface ServerPreflightResultBase {
  readonly hostId: string
  readonly hostPublicKey: string
  readonly nonce: string
  /** Unix epoch milliseconds; the signed proof lifetime is at most 60 seconds. */
  readonly expiresAt: number
  readonly signature: string
}

export type ServerPreflightResult =
  | (ServerPreflightResultBase & {
      readonly purpose: "device-connect"
      /** Bound to this WebSocket connection. */
      readonly deviceChallenge: string
      readonly deviceChallengeExpiresAt: number
    })
  | (ServerPreflightResultBase & {
      readonly purpose: "pairing-link" | "admin-pairing"
      readonly deviceChallenge?: never
      readonly deviceChallengeExpiresAt?: never
    })

export interface AppServerDeviceProof {
  readonly deviceId: string
  readonly challenge: string
  readonly signature: string
}

export interface AppServerDeviceChallenge {
  readonly challenge: string
  readonly hostId: string
  readonly expiresAt: number
}

export interface AppServerDeviceAuth {
  readonly type: "device"
  readonly device: AppServerDeviceProof & { readonly credential: string }
}

export interface AppServerOperatorAuth {
  readonly type: "operator"
  readonly bearerToken: string
}

export type ServerInitializeAuth = AppServerDeviceAuth | AppServerOperatorAuth

/** Device metadata safe to expose to an authenticated device administrator. */
export interface AppServerDeviceRecord {
  readonly deviceId: string
  readonly name: string
  readonly clientKind: AppServerClientInfo["clientKind"]
  readonly scopes: readonly AppServerScope[]
  readonly publicKey?: string
  readonly createdAt: string
  readonly revokedAt?: string
}

export interface RegisterAppServerDeviceInput {
  readonly name: string
  readonly clientKind: AppServerClientInfo["clientKind"]
  readonly scopes: readonly AppServerScope[]
  readonly publicKey?: string
}

export interface AppServerDeviceRegistration {
  readonly device: AppServerDeviceRecord
  /** Returned only at registration time; the registry never exposes it again. */
  readonly credential: string
}

export interface AppServerDevicePrincipal {
  readonly deviceId: string
  readonly scopes: readonly AppServerScope[]
  readonly publicKey?: string
}

/** Server-side port for persistent device credentials; implementations are not part of the wire protocol. */
export interface AppServerDeviceRegistry {
  register(input: RegisterAppServerDeviceInput): Promise<AppServerDeviceRegistration>
  authenticate(credential: string): Promise<AppServerDevicePrincipal | undefined>
  list(): Promise<readonly AppServerDeviceRecord[]>
  revoke(deviceId: string): Promise<boolean>
}

export interface AppServerPairCreateParams {
  readonly scopes: readonly AppServerScope[]
  readonly ttlMs?: number
}

export interface AppServerPairCreateResult {
  readonly pairingToken: string
  readonly hostId: string
  readonly scopes: readonly AppServerScope[]
  readonly expiresAt: string
}

export interface AppServerPairPreviewParams {
  readonly pairingToken: string
}

export interface AppServerPairPreviewResult {
  readonly hostId: string
  readonly scopes: readonly AppServerScope[]
  readonly expiresAt: string
}

export interface AppServerPairClaimParams {
  readonly pairingToken: string
  readonly name: string
  readonly clientKind: "web" | "mobile"
  readonly publicKey: string
}

export type AppServerPairClaimResult = AppServerDeviceRegistration

/** Host-owned pairing authority; ticket state must not share Session persistence. */
export interface AppServerPairingRegistry {
  create(input: AppServerPairCreateParams): Promise<AppServerPairCreateResult>
  preview(pairingToken: string): Promise<AppServerPairPreviewResult | undefined>
  claim(input: AppServerPairClaimParams): Promise<AppServerPairClaimResult | undefined>
  close(): void
}

export interface ServerInitializeParams {
  readonly appServerProtocolVersion: AppServerProtocolVersion
  readonly hostId: string
  readonly client: AppServerClientInfo
  readonly auth: ServerInitializeAuth
  readonly requestedScopes?: readonly AppServerScope[]
  /**
   * Client-side render/input support, declared but never negotiated: the public
   * durable stream is identical for every client and unknown informational
   * events are skippable, so the server must not filter on this field.
   */
  readonly clientCapabilities?: AppServerCapabilities
  readonly recovery?: {
    readonly sessionId?: string
    readonly afterRevision?: number
  }
}

export interface AppServerDescriptor {
  readonly name: string
  readonly version: string
  readonly hostId: string
  readonly protocolVersion: AppServerProtocolVersion
}

/** Authoritative discovery result: the Host descriptor plus its capabilities. */
export interface ServerDescribeResult {
  readonly server: AppServerDescriptor
  readonly capabilities: AppServerCapabilities
}

export interface ServerInitializeResult {
  readonly appServerProtocolVersion: AppServerProtocolVersion
  readonly server: AppServerDescriptor
  readonly connection: {
    readonly connectionId: string
    readonly deviceId?: string
    readonly scopes: readonly AppServerScope[]
  }
  readonly capabilities: AppServerCapabilities
  readonly host?: {
    readonly profile: "durable" | "ephemeral"
    /** Service descriptor only; never the Session routing authority. */
    readonly workspaceRoot?: string
    readonly workspaces?: readonly {
      readonly workspaceId: string
      readonly workspaceRoot: string
      readonly availability: "available" | "unavailable"
    }[]
    readonly configurationFingerprint?: string
    readonly workspaceFingerprint?: string
    readonly securityFingerprint?: string
  }
}

export type {
  SessionListParams,
  SessionCreateParams,
  SessionGetParams,
  SessionForkParams,
  SessionArchiveParams,
  SessionDeleteParams,
  SessionControlLeaseRef,
  SessionListResult,
  SessionSnapshotResult,
  SessionGetResult,
  SessionArchiveResult,
  SessionDeleteResult,
} from "./dto/catalog-methods.js"

export type { AppServerCapabilities } from "./dto/capabilities.js"

export type {
  SessionAttachParams,
  SessionDetachParams,
  SessionSnapshotMethodParams,
  SessionReplayParams,
  SessionResyncParams,
  SessionAttachResult,
  SessionDetachResult,
  SessionSnapshotMethodResult,
  SessionReplayResult,
  SessionResyncResult,
} from "./dto/recovery-methods.js"

export type {
  SessionSubmitParams,
  SessionSubmitResult,
  SessionSteerParams,
  SessionSteerResult,
  SessionCancelRunParams,
  SessionCancelRunResult,
  SessionCancelInputParams,
  SessionCancelInputResult,
  SessionMessagesParams,
  SessionMessagesResult,
  SessionResolveInteractionParams,
  SessionResolveInteractionResult,
} from "./dto/write-methods.js"

export type {
  SessionGetPermissionPolicyParams,
  SessionGetPermissionPolicyResult,
  SessionSetPermissionModeParams,
  SessionSetPermissionModeResult,
  SessionSetPermissionRulesParams,
  SessionSetPermissionRulesResult,
  PublicPermissionPolicy,
  PublicPermissionRule,
} from "./dto/policy.js"

export type {
  WorkspaceDiffParams,
  WorkspaceDiffResult,
  WorkspaceDiffChange,
  WorkspaceChangeOperation,
  WorkspaceFileKind,
  WorkspaceReadFileParams,
  WorkspaceReadFileResult,
} from "./dto/workspace.js"

export type {
  SessionCreateTaskParams,
  SessionCreateTaskResult,
  SessionListTasksParams,
  SessionListTasksResult,
  SessionCancelTaskParams,
  SessionCancelTaskResult,
  SessionGetTaskLogsParams,
  SessionGetTaskLogsResult,
  TaskLogChunk,
  SessionExecuteShellParams,
  SessionExecuteShellResult,
  SessionExecuteUserShellParams,
  SessionExecuteUserShellResult,
  SessionShellAdmissionResult,
} from "./dto/task-methods.js"

export type {
  SessionCompactParams,
  SessionCompactResult,
  SessionAddDirectoryParams,
  SessionAddDirectoryResult,
  SessionSetContextWindowParams,
  SessionSetContextWindowResult,
  SessionClearContextWindowParams,
  SessionClearContextWindowResult,
  SessionSelectAgentParams,
  SessionSelectAgentResult,
  SessionGoalUpdateParams,
  SessionUpdateGoalParams,
  SessionUpdateGoalResult,
  PublicGoal,
} from "./dto/session-action-methods.js"

export type {
  SessionListCheckpointsParams,
  SessionListCheckpointsResult,
  SessionPreviewRewindParams,
  SessionPreviewRewindResult,
  SessionRewindParams,
  SessionRewindResult,
  PublicCheckpoint,
} from "./dto/rewind-methods.js"

export const PERMISSION_MODES = ["accept-edits", "plan", "full-access", "manual"] as const
export type AppServerPermissionMode = (typeof PERMISSION_MODES)[number]

export const PERMISSION_RULE_BEHAVIORS = ["allow", "ask", "deny"] as const
export type AppServerPermissionRuleBehavior = (typeof PERMISSION_RULE_BEHAVIORS)[number]

export interface AppServerPermissionRule {
  readonly name: string
  readonly behavior: AppServerPermissionRuleBehavior
}

export const TASK_TYPES = ["agent", "shell", "loop"] as const
export type AppServerTaskType = (typeof TASK_TYPES)[number]

export type AppServerGoalUpdate = { readonly action: "set"; readonly text: string } | { readonly action: "clear" | "pause" | "resume" }

/** Runtime guards derived from the canonical vocabularies; narrow wire values without bare casts. */
export function isAppServerPermissionMode(value: string): value is AppServerPermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value)
}

export function isPermissionRuleBehavior(value: string): value is AppServerPermissionRuleBehavior {
  return (PERMISSION_RULE_BEHAVIORS as readonly string[]).includes(value)
}

export interface SessionPlanParams {
  readonly sessionId: string
  readonly commandId: string
  readonly text: string
  readonly context?: readonly string[]
  readonly workspace?: string
  readonly expectedRevision?: number
  /** `session.plan` always requires the `composer` scope. */
  readonly lease?: {
    readonly scope: "composer"
    readonly generation: number
  }
}

export interface SessionTraceParams {
  readonly sessionId: string
}

export interface SessionModelCallsParams {
  readonly sessionId: string
  readonly includePayload?: boolean
}

/**
 * Two independently-generationed interaction leases coexist per Session:
 * `composer` governs normal editing/submission ownership, `session-control`
 * governs high-risk control actions (permission, fork/archive/delete,
 * rewind, ...).
 */
export const APP_SERVER_INTERACTION_LEASE_SCOPES = ["composer", "session-control"] as const
export type InteractionLeaseScope = (typeof APP_SERVER_INTERACTION_LEASE_SCOPES)[number]

export interface InteractionParams {
  readonly sessionId: string
  readonly scope: InteractionLeaseScope
  readonly leaseGeneration?: number
  readonly ttlMs?: number
}

export interface AppServerPresenceClient {
  readonly clientId: string
  readonly clientKind: AppServerClientInfo["clientKind"]
  readonly name: string
  readonly version: string
}

export interface AppServerInteractionHolder {
  readonly clientId: string
  readonly clientKind: AppServerClientInfo["clientKind"]
  readonly name: string
}

export interface AppServerInteractionLease {
  readonly status: "available" | "held"
  readonly generation: number
  readonly holder?: AppServerInteractionHolder
  readonly expiresAt?: string
}

/** Both scopes' current lease state, e.g. for `session.attach` presence and `interaction.lease.updated`. */
export type AppServerInteractionLeases = Readonly<Record<InteractionLeaseScope, AppServerInteractionLease>>

export interface DeviceRevokeParams {
  readonly deviceId: string
}

export interface SessionTraceResult {
  readonly sessionId: string
  readonly records: readonly JsonValue[]
}

export interface SessionModelCallsResult {
  readonly sessionId: string
  readonly records: readonly JsonValue[]
}

export interface SessionPlanResult {
  readonly accepted: boolean
  readonly sessionId: string
  readonly commandId: string
  readonly intent: "plan"
  readonly result?: JsonValue
  readonly snapshot?: JsonValue
}

export interface AppServerEventNotification {
  readonly sessionId: string
  readonly revision: number
  readonly event: JsonValue
}

export interface AppServerTransientNotification {
  readonly sessionId: string
  readonly event: JsonValue
}

/**
 * Canonical transient event kind discriminants on the wire. `session.transient`
 * payloads stay opaque `JsonValue` at the schema level; this typed vocabulary
 * is the single comparison anchor for host and client projections (core
 * transient stream events, the TUI presentation contract, web projections).
 */
export const TRANSIENT_EVENT_TYPES = [
  "model_text_delta",
  "model_tool_call_start",
  "model_tool_call_delta",
  "model_tool_call_end",
  "tool_output_delta",
  "child_agent_started",
] as const

export type AppServerTransientEventKind = (typeof TRANSIENT_EVENT_TYPES)[number]

/** Runtime guard derived from the canonical kind list; narrows wire values without a bare cast. */
export function isAppServerTransientEventKind(value: string): value is AppServerTransientEventKind {
  return (TRANSIENT_EVENT_TYPES as readonly string[]).includes(value)
}

export interface AppServerResyncRequiredNotification {
  readonly sessionId: string
  readonly minimumRevision: number
  readonly reason: "queue_overflow" | "revision_gap" | "rewind" | "restart"
}

export interface AppServerPresenceNotification {
  readonly sessionId: string
  readonly clients: readonly AppServerPresenceClient[]
}

export interface AppServerLeaseNotification {
  readonly sessionId: string
  readonly leases: AppServerInteractionLeases
}

export type AppServerNotificationParams =
  | {
      readonly method: "session.event"
      readonly params: AppServerEventNotification
    }
  | {
      readonly method: "session.transient"
      readonly params: AppServerTransientNotification
    }
  | {
      readonly method: "session.resyncRequired"
      readonly params: AppServerResyncRequiredNotification
    }
  | {
      readonly method: "presence.updated"
      readonly params: AppServerPresenceNotification
    }
  | {
      readonly method: "interaction.lease.updated"
      readonly params: AppServerLeaseNotification
    }
