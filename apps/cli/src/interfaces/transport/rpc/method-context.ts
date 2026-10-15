import {
  APP_SERVER_INTERACTION_LEASE_SCOPES,
  type AppServerDescriptor,
  type AppServerDeviceRegistry,
  type AppServerScope,
  type AppServerInteractionLease,
  type AppServerClientInfo,
  type AppServerInteractionLeases,
  type JsonRpcNotification,
  type JsonValue,
  type InteractionLeaseScope,
} from "@ag2cli/app-server-protocol/types.js"
import { assertJsonValue } from "@ag2cli/app-server-protocol/validation.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { SessionServer } from "@ag2cli/client/session-client.js"
import type { SessionCatalog } from "@ag2cli/runtime/ports/session-catalog.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import { AppServerOperationRegistry } from "../app-server-operation-registry.js"
import { AppServerPresenceRegistry, type AppServerPresenceRegistration, type AppServerWriteAccess } from "../app-server-presence.js"
import type { AppServerDeviceProofVerifier } from "../app-server-device-proof.js"

export interface ServeWorkspaceRegistration {
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Transport-facing registry port; persistence stays in composition/infrastructure. */
export interface ServeWorkspaceRegistry {
  list(): Promise<readonly ServeWorkspaceRegistration[]>
  get(workspaceId: string): Promise<ServeWorkspaceRegistration | undefined>
}

export interface RpcSubscription {
  readonly unsubscribe: () => void
  readonly unsubscribeTransient: () => void
}

export class RpcApplicationError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly details?: JsonValue,
  ) {
    super(message)
    this.name = "RpcApplicationError"
  }
}

/**
 * Verified connection dependencies shared by the RPC method groups.
 *
 * The context is deliberately capability-shaped: groups can ask for the
 * session/catalog/lease operation they own, but cannot reach the connection
 * object's private fields or call another method group directly.
 */
export interface MethodContext {
  readonly sessionServer: SessionServer
  readonly catalog?: SessionCatalog
  readonly descriptor: AppServerDescriptor
  readonly profile: "durable" | "ephemeral"
  readonly workspaceRoot?: string
  readonly configurationFingerprint?: string
  readonly workspaceFingerprint?: string
  readonly securityFingerprint?: string
  readonly grantedScopes: readonly AppServerScope[]
  readonly capabilities?: readonly string[]
  readonly deviceRegistry?: AppServerDeviceRegistry
  readonly connectionId: string
  readonly deviceId: string
  readonly clientKind: AppServerClientInfo["clientKind"]
  readonly authenticatedDeviceId?: string
  readonly authenticatedDevicePublicKey?: string
  readonly deviceProofVerifier?: AppServerDeviceProofVerifier
  readonly operationRegistry: AppServerOperationRegistry
  readonly presenceRegistry?: AppServerPresenceRegistry
  /** Serve-only identity registry. Local embedded Hosts leave this undefined. */
  readonly workspaceRegistry?: ServeWorkspaceRegistry
  /**
   * Injected workspace identity derivation (owner: capabilities/security +
   * composition). Transport must not import the implementation; assemblies
   * pass it at connection construction.
   */
  readonly workspaceIdForRoot: (workspaceRoot: string) => string
  /** Injected classifier for the workspace-unavailable domain error. */
  readonly isWorkspaceUnavailableError: (error: unknown) => error is { readonly message: string; readonly workspaceRoot: string }
  readonly readTransient?: (sessionId: SessionId) => readonly TransientStreamEvent[]
  readonly subscriptions: Map<string, RpcSubscription>
  readonly scopes: readonly AppServerScope[]
  readonly presenceRegistration?: AppServerPresenceRegistration
  readonly initialized: boolean
  readonly setScopes: (scopes: readonly AppServerScope[]) => void
  readonly setPresenceRegistration: (registration: AppServerPresenceRegistration | undefined) => void
  readonly markInitialized: () => void
  readonly setClientKind: (clientKind: AppServerClientInfo["clientKind"]) => void
  readonly requireScope: (scope: AppServerScope) => void
  readonly requireCatalog: () => SessionCatalog
  readonly requireDeviceRegistry: () => AppServerDeviceRegistry
  readonly requireExistingSession: (id: SessionId) => Promise<void>
  readonly requireRevision: (id: SessionId, expectedRevision: number) => Promise<void>
  readonly readSnapshot: (id: SessionId) => Promise<SessionSnapshot>
  readonly readEvents: (id: SessionId, afterRevision: number) => Promise<readonly AgentEvent[]>
  readonly assertWriteAccess: (
    id: SessionId,
    scope: InteractionLeaseScope | "none",
    generation: number | undefined,
  ) => AppServerWriteAccess | undefined
  readonly releaseWriteAccess: (id: SessionId, access: AppServerWriteAccess | undefined) => void
  readonly detachSession: (id: SessionId) => void
  readonly emit: (method: string, params: Record<string, unknown>) => void
}

export function toJson(value: unknown): JsonValue {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown
  return assertJsonValue(normalized, "App Server value")
}

export function defaultLeases(): AppServerInteractionLeases {
  return Object.fromEntries(
    APP_SERVER_INTERACTION_LEASE_SCOPES.map((scope) => [scope, { status: "available" as const, generation: 0 }]),
  ) as AppServerInteractionLeases
}

export type { AppServerClientInfo, AppServerInteractionLease, AppServerInteractionLeases, JsonRpcNotification }
