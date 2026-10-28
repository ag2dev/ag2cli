import {
  type AppServerCapabilities,
  type AppServerDescriptor,
  type AppServerDeviceRegistry,
  type AppServerScope,
  type AppServerInteractionLease,
  type AppServerClientInfo,
  type AppServerInteractionLeases,
  type JsonRpcNotification,
  type InteractionLeaseScope,
} from "@ag2cli/app-server-protocol/types.js"
import type { PublicPermissionModeValue } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { SessionServer } from "@ag2cli/session-client/session-client.js"
import type { SessionCatalog } from "@ag2cli/runtime/ports/session-catalog.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import { AppServerOperationRegistry } from "../app-server-operation-registry.js"
import { AppServerPresenceRegistry, type AppServerPresenceRegistration, type AppServerWriteAccess } from "../app-server-presence.js"
import type { WorkspaceInspectionPort } from "./workspace-methods.js"

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
  readonly capabilities?: AppServerCapabilities
  readonly deviceRegistry?: AppServerDeviceRegistry
  readonly connectionId: string
  readonly deviceId: string
  readonly clientKind: AppServerClientInfo["clientKind"]
  readonly operationRegistry: AppServerOperationRegistry
  readonly presenceRegistry?: AppServerPresenceRegistry
  /** Serve-only identity registry. Local embedded Hosts leave this undefined. */
  readonly workspaceRegistry?: ServeWorkspaceRegistry
  /** Permission modes remote clients may select on this Host (public snapshot security descriptor). */
  readonly selectableModes: readonly PublicPermissionModeValue[]
  /**
   * Injected workspace identity derivation (owner: capabilities/security +
   * composition). Transport must not import the implementation; assemblies
   * pass it at connection construction.
   */
  readonly workspaceIdForRoot: (workspaceRoot: string) => string
  /** Injected classifier for the workspace-unavailable domain error. */
  readonly isWorkspaceUnavailableError: (error: unknown) => error is { readonly message: string; readonly workspaceRoot: string }
  /**
   * Structured workspace inspection port (owner: capabilities/workspace).
   * Hosts that do not enable the read-only workspace face leave this
   * undefined; the method group then answers `capability_unavailable`.
   */
  readonly workspaceInspection?: WorkspaceInspectionPort
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
  /** Implicit one-shot acquisition for submit without an explicit lease; released right after admission. */
  readonly acquireWriteAccess: (id: SessionId, scope: InteractionLeaseScope) => AppServerWriteAccess | undefined
  readonly releaseWriteAccess: (id: SessionId, access: AppServerWriteAccess | undefined) => void
  readonly detachSession: (id: SessionId) => void
  readonly emit: (method: string, params: Record<string, unknown>) => void
}

export type { AppServerClientInfo, AppServerInteractionLease, AppServerInteractionLeases, JsonRpcNotification }
