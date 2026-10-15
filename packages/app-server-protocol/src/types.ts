import type { AppServerErrorCode } from "./error-codes.js"

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
  "session.command",
  "session.plan",
  "session.submit",
  "session.cancel",
  "session.resolveApproval",
  "session.replay",
  "session.trace",
  "session.modelCalls",
  "session.resync",
  "interaction.acquire",
  "interaction.renew",
  "interaction.release",
  "interaction.takeover",
  "device.list",
  "device.revoke",
] as const

export type AppServerMethod = (typeof APP_SERVER_METHODS)[number]

export const APP_SERVER_NOTIFICATION_METHODS = [
  "session.event",
  "session.transient",
  "session.resyncRequired",
  "session.operation.failed",
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
] as const

export type AppServerScope = (typeof APP_SERVER_SCOPES)[number]

export interface AppServerClientInfo {
  readonly clientId: string
  readonly clientKind: "tui" | "web" | "mobile" | "desktop" | "acp" | "script" | "unknown"
  readonly name: string
  readonly version: string
  readonly capabilities?: readonly string[]
}

export interface AppServerDeviceProof {
  readonly deviceId: string
  readonly challenge?: string
  readonly signature?: string
}

export interface AppServerDeviceChallenge {
  readonly deviceId: string
  readonly challenge: string
  readonly serverFingerprint: string
  readonly expiresAt: string
}

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

export interface AppServerPairingStartInput {
  readonly scopes: readonly AppServerScope[]
  readonly ttlMs?: number
}

export interface AppServerPairingChallenge {
  /** Short-lived secret returned once to the already-authorized pairing initiator. */
  readonly pairingToken: string
  readonly scopes: readonly AppServerScope[]
  readonly expiresAt: string
}

export interface AppServerPairingClaimInput {
  readonly pairingToken: string
  readonly name: string
  readonly clientKind: AppServerClientInfo["clientKind"]
  readonly publicKey?: string
}

/** Host-owned, in-memory pairing state; it must not share Session persistence. */
export interface AppServerPairingRegistry {
  start(input: AppServerPairingStartInput): Promise<AppServerPairingChallenge>
  claim(input: AppServerPairingClaimInput): Promise<AppServerDeviceRegistration | undefined>
  close(): void
}

export interface ServerInitializeParams {
  readonly appServerProtocolVersion: AppServerProtocolVersion
  readonly client: AppServerClientInfo
  readonly device?: AppServerDeviceProof
  readonly requestedScopes?: readonly AppServerScope[]
  readonly serverFingerprint?: string
  readonly recovery?: {
    readonly sessionId?: string
    readonly afterRevision?: number
  }
}

export interface AppServerDescriptor {
  readonly name: string
  readonly version: string
  readonly fingerprint: string
  readonly protocolVersion: AppServerProtocolVersion
}

export interface ServerInitializeResult {
  readonly appServerProtocolVersion: AppServerProtocolVersion
  readonly server: AppServerDescriptor
  readonly connection: {
    readonly connectionId: string
    readonly deviceId: string
    readonly scopes: readonly AppServerScope[]
  }
  readonly capabilities: readonly string[]
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

export interface SessionListParams {
  readonly includeArchived?: boolean
}

export interface SessionCreateParams {
  readonly sessionId?: string
  /** Stable registry identity; physical paths are never Session routing input. */
  readonly workspaceId: string
  readonly title?: string
}

export interface SessionGetParams {
  readonly sessionId: string
  readonly includeArchived?: boolean
}

/** Immutable logical position used by rewind/fork operations. */
export interface SessionHistoryCursor {
  readonly sessionId: string
  readonly branchId: string
  readonly nodeId: string
  readonly physicalRevision: number
  readonly recordHash: string
}

/** Fixed single-scope lease reference; `session.fork`/`session.archive`/`session.delete`
 * always require `session-control`, so the scope value is carried in the type rather than
 * accepted at runtime. */
export interface SessionControlLeaseRef {
  readonly scope: "session-control"
  readonly generation: number
}

export interface SessionForkParams {
  readonly sourceSessionId: string
  readonly targetSessionId?: string
  readonly cursor?: SessionHistoryCursor
  readonly title?: string
  readonly lease?: SessionControlLeaseRef
}

export interface SessionArchiveParams {
  readonly sessionId: string
  readonly lease?: SessionControlLeaseRef
}

export interface SessionDeleteParams {
  readonly sessionId: string
  readonly lease?: SessionControlLeaseRef
}

export interface SessionAttachParams {
  readonly sessionId: string
  readonly afterRevision?: number
  readonly includeTransient?: boolean
}

export interface SessionDetachParams {
  readonly sessionId: string
}

export interface SessionSnapshotParams {
  readonly sessionId: string
}

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

/**
 * Public semantic actions used by clients for session controls.
 *
 * These names are deliberately independent from the private runtime command
 * discriminants. The App Server adapter owns the mapping on each Host.
 */
export type AppServerSessionCommandAction =
  | {
      readonly type: "addDirectory"
      readonly directory: string
      readonly workspaceRoot?: string
      readonly expectedScopeRevision?: number
    }
  | {
      readonly type: "setPermissionMode"
      readonly mode: AppServerPermissionMode
      readonly expectedPolicyRevision?: number
    }
  | {
      readonly type: "setPermissionRules"
      readonly rules: readonly AppServerPermissionRule[]
      readonly expectedPolicyRevision?: number
    }
  | { readonly type: "compact"; readonly instructions?: string }
  | { readonly type: "setContextWindow"; readonly contextWindow: number }
  | { readonly type: "clearContextWindow" }
  | { readonly type: "setAgent"; readonly agentName?: string }
  | { readonly type: "updateGoal"; readonly update: AppServerGoalUpdate }
  | {
      readonly type: "createTask"
      readonly taskType: AppServerTaskType
      readonly title: string
      readonly prompt?: string
      readonly argv?: readonly string[]
      readonly intervalMs?: number
      readonly maxRuns?: number
      readonly workspace?: string
      readonly parentRunId?: string
    }
  | { readonly type: "listTasks" }
  | {
      readonly type: "cancelTask"
      readonly taskId: string
      readonly reason?: string
    }
  | { readonly type: "listCheckpoints" }
  | {
      readonly type: "previewRewind"
      readonly checkpointId: string
    }
  | {
      readonly type: "rewind"
      readonly checkpointId: string
    }
  | {
      readonly type: "steer"
      readonly runId: string
      readonly text: string
    }
  | {
      readonly type: "cancelInput"
      readonly inputId: string
      readonly reason?: string
    }
  | {
      readonly type: "executeShell"
      readonly argv: readonly string[]
      readonly cwd?: string
      readonly timeoutMs?: number
    }
  | {
      readonly type: "executeUserShell"
      readonly command: string
      readonly cwd?: string
      readonly timeoutMs?: number
    }

/**
 * Canonical action discriminant vocabulary for `session.command`. The union
 * above and this list must stay in lockstep; the symmetric-difference
 * assertion below fails compilation when either side gains an unmirrored
 * entry.
 */

export const SESSION_COMMAND_ACTION_TYPES = [
  "addDirectory",
  "setPermissionMode",
  "setPermissionRules",
  "compact",
  "setContextWindow",
  "clearContextWindow",
  "setAgent",
  "updateGoal",
  "createTask",
  "listTasks",
  "cancelTask",
  "listCheckpoints",
  "previewRewind",
  "rewind",
  "steer",
  "cancelInput",
  "executeShell",
  "executeUserShell",
] as const

export type AppServerSessionCommandActionType = (typeof SESSION_COMMAND_ACTION_TYPES)[number]

type AssertNever<T extends never> = T

/** Adding a union member without extending the vocabulary (or vice versa) fails compilation. */
export type AssertSessionCommandActionVocabulary = AssertNever<
  | Exclude<AppServerSessionCommandAction["type"], AppServerSessionCommandActionType>
  | Exclude<AppServerSessionCommandActionType, AppServerSessionCommandAction["type"]>
>

/** Runtime guards derived from the canonical vocabularies; narrow wire values without bare casts. */
export function isAppServerPermissionMode(value: string): value is AppServerPermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value)
}

export function isPermissionRuleBehavior(value: string): value is AppServerPermissionRuleBehavior {
  return (PERMISSION_RULE_BEHAVIORS as readonly string[]).includes(value)
}

export function isSessionCommandActionType(value: string): value is AppServerSessionCommandActionType {
  return (SESSION_COMMAND_ACTION_TYPES as readonly string[]).includes(value)
}

export interface SessionCommandParams {
  readonly sessionId: string
  readonly commandId: string
  readonly action: AppServerSessionCommandAction
  readonly expectedRevision?: number
  /**
   * Single scope reference: the caller already knows which action it is
   * submitting, so it declares the one scope it believes applies. The Host
   * still recomputes the required scope from the action and rejects a
   * mismatch with `interaction_lease_scope_mismatch`.
   */
  readonly lease?: {
    readonly scope: InteractionLeaseScope
    readonly generation: number
  }
}

export interface SessionSubmitParams {
  readonly sessionId: string
  readonly commandId: string
  /** Raw input is intentionally preserved; the Host owns intent parsing. */
  readonly text: string
  readonly context?: readonly string[]
  readonly fileReferences?: readonly string[]
  readonly workspace?: string
  readonly expectedRevision?: number
  /**
   * Partial map of scope generations the caller currently holds. `submit`
   * only learns the required scope after parsing the `InputIntent`
   * server-side, so it reports every scope it holds and the Host looks up
   * the one it needs.
   */
  readonly lease?: Partial<Record<InteractionLeaseScope, number>>
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

export interface SessionCancelParams {
  readonly sessionId: string
  readonly commandId?: string
  readonly runId?: string
}

export interface SessionResolveApprovalParams {
  readonly sessionId: string
  readonly runId: string
  readonly turn: number
  readonly toolUseId: string
  readonly preparedEventId: string
  readonly expectedScopeRevision: number
  readonly expectedPolicyRevision: number
  readonly decision: "approved" | "denied"
}

export interface SessionReplayParams {
  readonly sessionId: string
  readonly afterRevision?: number
}

export interface SessionTraceParams {
  readonly sessionId: string
}

export interface SessionModelCallsParams {
  readonly sessionId: string
  readonly includePayload?: boolean
}

export interface SessionResyncParams {
  readonly sessionId: string
  readonly afterRevision?: number
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
  readonly connectionId: string
  readonly deviceId: string
  readonly clientId: string
  readonly clientKind: AppServerClientInfo["clientKind"]
  readonly name: string
  readonly version: string
}

export interface AppServerInteractionHolder {
  readonly connectionId: string
  readonly deviceId: string
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

export interface SessionAttachResult {
  readonly sessionId: string
  readonly snapshot: JsonValue
  readonly events: readonly JsonValue[]
  readonly workspace?: {
    readonly workspaceId: string
    readonly workspaceRoot: string
    readonly availability: "available" | "unavailable"
  }
  /** Bounded in-memory live projection; omitted when includeTransient was false. */
  readonly transientEvents?: readonly JsonValue[]
  readonly presence: {
    readonly sessionId: string
    readonly clients: readonly AppServerPresenceClient[]
    readonly leases: AppServerInteractionLeases
  }
}

export interface SessionReplayResult {
  readonly sessionId: string
  readonly events: readonly JsonValue[]
  readonly nextRevision: number
  readonly complete: boolean
}

export interface SessionTraceResult {
  readonly sessionId: string
  readonly records: readonly JsonValue[]
}

export interface SessionModelCallsResult {
  readonly sessionId: string
  readonly records: readonly JsonValue[]
}

export interface SessionSubmitResult {
  readonly accepted: boolean
  readonly sessionId: string
  readonly commandId: string
  readonly intent: "prompt" | "slash" | "mention" | "shell"
  /** Present for synchronous slash commands and uses the session.command action vocabulary. */
  readonly action?: AppServerSessionCommandResultAction
  readonly runId?: string
  readonly result?: JsonValue
  readonly snapshot?: JsonValue
}

export interface SessionPlanResult {
  readonly accepted: boolean
  readonly sessionId: string
  readonly commandId: string
  readonly intent: "plan"
  readonly result?: JsonValue
  readonly snapshot?: JsonValue
}

export type AppServerSessionCommandResultAction =
  | "directoryAdded"
  | "permissionUpdated"
  | "compacted"
  | "contextWindowUpdated"
  | "agentUpdated"
  | "goalUpdated"
  | "taskCreated"
  | "tasksListed"
  | "taskCancelled"
  | "checkpointsListed"
  | "rewindPreviewed"
  | "rewound"
  | "shellResult"

export interface SessionCommandResult {
  readonly accepted: boolean
  readonly sessionId: string
  readonly commandId: string
  readonly action: AppServerSessionCommandResultAction
  readonly result: JsonValue
  readonly snapshot: JsonValue
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

export interface AppServerOperationFailedNotification {
  readonly sessionId: string
  readonly commandId: string
  readonly intent: "prompt" | "mention" | "shell"
  readonly message: string
  /** Stable machine-readable code when the failure has a cataloged cause. */
  readonly code?: AppServerErrorCode
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
      readonly method: "session.operation.failed"
      readonly params: AppServerOperationFailedNotification
    }
  | {
      readonly method: "presence.updated"
      readonly params: AppServerPresenceNotification
    }
  | {
      readonly method: "interaction.lease.updated"
      readonly params: AppServerLeaseNotification
    }

export type InputIntent =
  | {
      readonly kind: "prompt"
      readonly text: string
      readonly fileReferences?: readonly string[]
    }
  | {
      readonly kind: "slash"
      readonly name: string
      readonly args: readonly string[]
      readonly raw: string
    }
  | {
      readonly kind: "mention"
      readonly text: string
      readonly references: readonly string[]
    }
  | { readonly kind: "shell"; readonly command: string; readonly raw: string }
