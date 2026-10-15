import { randomUUID } from "node:crypto"
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  createFailure,
  createNotification,
  createSuccess,
  isRequest,
} from "@ag2cli/app-server-protocol/json-rpc.js"
import {
  type AppServerClientInfo,
  type AppServerDescriptor,
  type AppServerDeviceRegistry,
  type AppServerScope,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonValue,
  type InteractionLeaseScope,
} from "@ag2cli/app-server-protocol/types.js"
import { AppServerProtocolError, assertJsonValue } from "@ag2cli/app-server-protocol/validation.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import { IncompatibleSessionEventError } from "@ag2cli/core/session/session-security.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import type { SessionServer } from "@ag2cli/client/session-client.js"
import { SessionIdConflictError, type SessionCatalog } from "@ag2cli/runtime/ports/session-catalog.js"
import { CommandIdempotencyConflictError } from "@ag2cli/runtime/application/session/command-idempotency.js"
import { SessionPolicyRevisionConflictError } from "@ag2cli/runtime/application/session/permission-state.js"
import { SessionRevisionConflictError } from "@ag2cli/runtime/application/session/revision-conflict.js"
import { SessionWriterConflictError } from "@ag2cli/runtime/application/session/session-authority.js"
import { SessionExecutionReservationConflictError } from "@ag2cli/runtime/ports/session-execution-reservation.js"
import { getSnapshotCommand, readEventsCommand } from "@ag2cli/protocol/session-command.js"
import { AppServerOperationRegistry } from "./app-server-operation-registry.js"
import {
  AppServerInteractionError,
  AppServerPresenceRegistry,
  type AppServerPresenceRegistration,
  type AppServerWriteAccess,
} from "./app-server-presence.js"
import type { AppServerDeviceProofVerifier } from "./app-server-device-proof.js"
import { ConnectionMethods } from "./rpc/connection-methods.js"
import { RpcApplicationError, type MethodContext, type RpcSubscription, type ServeWorkspaceRegistry, toJson } from "./rpc/method-context.js"
import { SessionReadMethods } from "./rpc/session-read-methods.js"
import { SessionWriteMethods } from "./rpc/session-write-methods.js"
import { DeviceMethods } from "./rpc/device-methods.js"
import { InteractionMethods } from "./rpc/interaction-methods.js"

export { APP_SERVER_SESSION_COMMAND_POLICIES } from "./rpc/session-write-methods.js"

const DEFAULT_SCOPES: readonly AppServerScope[] = ["session:read", "session:write", "approval:write", "shell:execute"]
export interface AppServerRpcConnectionOptions {
  readonly sessionServer: SessionServer
  readonly catalog?: SessionCatalog
  readonly descriptor: AppServerDescriptor
  readonly profile: "durable" | "ephemeral"
  readonly workspaceRoot?: string
  /**
   * Injected workspace identity derivation: the owner is
   * capabilities/security/workspace + composition; transport must not
   * import it. Required so a missing assembly fails at construction.
   */
  readonly workspaceIdForRoot: (workspaceRoot: string) => string
  /**
   * Injected classifier for the workspace-unavailable domain error. The
   * guarded shape is the protocol contract (message + workspaceRoot for the
   * error details), not the concrete error class.
   */
  readonly isWorkspaceUnavailableError: (error: unknown) => error is { readonly message: string; readonly workspaceRoot: string }
  readonly configurationFingerprint?: string
  readonly workspaceFingerprint?: string
  readonly securityFingerprint?: string
  readonly grantedScopes?: readonly AppServerScope[]
  readonly deviceRegistry?: AppServerDeviceRegistry
  readonly capabilities?: readonly string[]
  readonly connectionId?: string
  readonly deviceId?: string
  /** Device identity already authenticated by the physical transport. */
  readonly authenticatedDeviceId?: string
  /** Public key registered for the authenticated device, when proof is required. */
  readonly authenticatedDevicePublicKey?: string
  /** Host-owned verifier for the initialize challenge proof. */
  readonly deviceProofVerifier?: AppServerDeviceProofVerifier
  /** Shared by all connections belonging to one Host. */
  readonly operationRegistry?: AppServerOperationRegistry
  /** Shared by all connections belonging to one Host. */
  readonly presenceRegistry?: AppServerPresenceRegistry
  readonly workspaceRegistry?: ServeWorkspaceRegistry
  /** Host-scoped live projection used only for reconnecting clients. */
  readonly readTransient?: (sessionId: SessionId) => readonly TransientStreamEvent[]
  readonly onNotification: (notification: JsonRpcNotification) => void
}

/** Connection-local JSON-RPC dispatcher over one authoritative SessionServer. */
export class AppServerRpcConnection {
  private readonly subscriptions = new Map<string, RpcSubscription>()
  private readonly operationRegistry: AppServerOperationRegistry
  private readonly presenceRegistry?: AppServerPresenceRegistry
  private readonly connectionId: string
  private readonly deviceId: string
  private readonly authenticatedDeviceId?: string
  private readonly capabilities?: readonly string[]
  private readonly grantedScopes: readonly AppServerScope[]
  private readonly deviceRegistry?: AppServerDeviceRegistry
  private presenceRegistration?: AppServerPresenceRegistration
  private scopes: readonly AppServerScope[] = []
  private initialized = false
  private closed = false
  private readonly methodContext: MethodContext
  private readonly connectionMethods: ConnectionMethods
  private readonly sessionReadMethods: SessionReadMethods
  private readonly sessionWriteMethods: SessionWriteMethods
  private readonly interactionMethods: InteractionMethods
  private readonly deviceMethods: DeviceMethods

  constructor(private readonly options: AppServerRpcConnectionOptions) {
    this.connectionId = options.connectionId ?? `connection-${randomUUID()}`
    if (
      options.deviceId !== undefined &&
      options.authenticatedDeviceId !== undefined &&
      options.deviceId !== options.authenticatedDeviceId
    ) {
      throw new Error("deviceId does not match authenticatedDeviceId")
    }
    if (options.authenticatedDevicePublicKey !== undefined && options.authenticatedDeviceId === undefined) {
      throw new Error("authenticatedDevicePublicKey must be set together with authenticatedDeviceId")
    }
    this.authenticatedDeviceId = options.authenticatedDeviceId
    this.deviceId = options.authenticatedDeviceId ?? options.deviceId ?? `device-${randomUUID()}`
    this.grantedScopes = options.grantedScopes ?? DEFAULT_SCOPES
    this.deviceRegistry = options.deviceRegistry
    this.capabilities = options.capabilities
    this.operationRegistry = options.operationRegistry ?? new AppServerOperationRegistry()
    this.presenceRegistry = options.presenceRegistry
    const contextState = {
      scopes: [] as readonly AppServerScope[],
      presenceRegistration: undefined as AppServerPresenceRegistration | undefined,
      clientKind: "unknown" as AppServerClientInfo["clientKind"],
      initialized: false,
    }
    const context: MethodContext = {
      sessionServer: options.sessionServer,
      ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
      descriptor: options.descriptor,
      profile: options.profile,
      workspaceIdForRoot: options.workspaceIdForRoot,
      isWorkspaceUnavailableError: options.isWorkspaceUnavailableError,
      ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
      ...(options.configurationFingerprint === undefined ? {} : { configurationFingerprint: options.configurationFingerprint }),
      ...(options.workspaceFingerprint === undefined ? {} : { workspaceFingerprint: options.workspaceFingerprint }),
      ...(options.securityFingerprint === undefined ? {} : { securityFingerprint: options.securityFingerprint }),
      grantedScopes: this.grantedScopes,
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      ...(options.deviceRegistry === undefined ? {} : { deviceRegistry: options.deviceRegistry }),
      connectionId: this.connectionId,
      deviceId: this.deviceId,
      get clientKind() {
        return contextState.clientKind
      },
      ...(this.authenticatedDeviceId === undefined ? {} : { authenticatedDeviceId: this.authenticatedDeviceId }),
      ...(options.authenticatedDevicePublicKey === undefined ? {} : { authenticatedDevicePublicKey: options.authenticatedDevicePublicKey }),
      ...(options.deviceProofVerifier === undefined ? {} : { deviceProofVerifier: options.deviceProofVerifier }),
      operationRegistry: this.operationRegistry,
      ...(this.presenceRegistry === undefined ? {} : { presenceRegistry: this.presenceRegistry }),
      ...(options.workspaceRegistry === undefined ? {} : { workspaceRegistry: options.workspaceRegistry }),
      ...(options.readTransient === undefined ? {} : { readTransient: options.readTransient }),
      subscriptions: this.subscriptions,
      get scopes() {
        return contextState.scopes
      },
      get presenceRegistration() {
        return contextState.presenceRegistration
      },
      get initialized() {
        return contextState.initialized
      },
      setScopes: (scopes: readonly AppServerScope[]) => {
        contextState.scopes = scopes
        this.scopes = scopes
      },
      setPresenceRegistration: (registration: AppServerPresenceRegistration | undefined) => {
        contextState.presenceRegistration = registration
        this.presenceRegistration = registration
      },
      markInitialized: () => {
        contextState.initialized = true
        this.initialized = true
      },
      setClientKind: (clientKind) => {
        contextState.clientKind = clientKind
      },
      requireScope: (scope: AppServerScope) => this.requireScope(scope),
      requireCatalog: () => this.requireCatalog(),
      requireDeviceRegistry: () => this.requireDeviceRegistry(),
      requireExistingSession: (id: SessionId) => this.requireExistingSession(id),
      requireRevision: (id: SessionId, expectedRevision: number) => this.requireRevision(id, expectedRevision),
      readSnapshot: (id: SessionId) => this.readSnapshot(id),
      readEvents: (id: SessionId, afterRevision: number) => this.readEvents(id, afterRevision),
      assertWriteAccess: (id: SessionId, scope: InteractionLeaseScope | "none", generation: number | undefined) =>
        this.assertWriteAccess(id, scope, generation),
      releaseWriteAccess: (id: SessionId, access: AppServerWriteAccess | undefined) => this.releaseWriteAccess(id, access),
      detachSession: (id: SessionId) => this.detachSession(id),
      emit: (method: string, params: Record<string, unknown>) => this.emit(method, params),
    }
    this.methodContext = context
    this.connectionMethods = new ConnectionMethods(this.methodContext)
    this.sessionReadMethods = new SessionReadMethods(this.methodContext)
    this.sessionWriteMethods = new SessionWriteMethods(this.methodContext)
    this.interactionMethods = new InteractionMethods(this.methodContext)
    this.deviceMethods = new DeviceMethods(this.methodContext)
  }

  async handle(message: JsonRpcMessage): Promise<JsonRpcResponse | undefined> {
    if (this.closed || !isRequest(message)) return undefined
    try {
      const result = await this.dispatch(message)
      return createSuccess(message.id, assertJsonValue(result, `${message.method}.result`))
    } catch (error) {
      return createFailure(message.id, ...errorResponse(error, this.options.isWorkspaceUnavailableError))
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const subscription of this.subscriptions.values()) {
      subscription.unsubscribe()
      subscription.unsubscribeTransient()
    }
    this.subscriptions.clear()
    this.presenceRegistry?.unregister(this.connectionId)
    this.presenceRegistration = undefined
  }

  private async dispatch(request: JsonRpcRequest): Promise<JsonValue> {
    if (request.method === "server.initialize") return toJson(await this.connectionMethods.initialize(request.params))
    if (!this.initialized) throw new RpcApplicationError("not_initialized", "Call server.initialize first")
    if (request.method === "server.health") return this.connectionMethods.health()
    if (request.method === "server.describe") return this.connectionMethods.describe()

    switch (request.method) {
      case "session.list":
        return toJson(await this.sessionReadMethods.listSessions(request.params))
      case "session.create":
        return toJson(await this.sessionWriteMethods.createSession(request.params))
      case "session.get":
        return toJson(await this.sessionReadMethods.getSession(request.params))
      case "session.fork":
        return toJson(await this.sessionWriteMethods.forkSession(request.params))
      case "session.archive":
        return toJson(await this.sessionWriteMethods.archiveSession(request.params))
      case "session.delete":
        return toJson(await this.sessionWriteMethods.deleteSession(request.params))
      case "session.attach":
        return toJson(await this.sessionReadMethods.attachSession(request.params))
      case "session.detach":
        return toJson(await this.sessionReadMethods.detach(request.params))
      case "session.snapshot":
        return toJson(await this.sessionReadMethods.snapshot(request.params))
      case "session.command":
        return toJson(await this.sessionWriteMethods.command(request.params))
      case "session.plan":
        return toJson(await this.sessionWriteMethods.plan(request.params))
      case "session.submit":
        return toJson(await this.sessionWriteMethods.submit(request.params))
      case "session.cancel":
        return toJson(await this.sessionWriteMethods.cancel(request.params))
      case "session.resolveApproval":
        return toJson(await this.sessionWriteMethods.resolveApproval(request.params))
      case "session.replay":
        return toJson(await this.sessionReadMethods.replay(request.params))
      case "session.trace":
        return toJson(await this.sessionReadMethods.trace(request.params))
      case "session.modelCalls":
        return toJson(await this.sessionReadMethods.modelCalls(request.params))
      case "session.resync":
        return toJson(await this.sessionReadMethods.resync(request.params))
      case "interaction.acquire":
      case "interaction.renew":
      case "interaction.release":
      case "interaction.takeover":
        return toJson(await this.interactionMethods.handle(request.method, request.params))
      case "device.list":
        return toJson(await this.deviceMethods.list())
      case "device.revoke":
        return toJson(await this.deviceMethods.revoke(request.params))
      default:
        throw new RpcMethodNotFoundError(request.method)
    }
  }

  private async readSnapshot(id: SessionId): Promise<import("@ag2cli/core/session/session-snapshot.js").SessionSnapshot> {
    const result = await this.options.sessionServer.execute(id, getSnapshotCommand())
    if (result.type !== "snapshot") throw new RpcApplicationError("invalid_host_result", "Host did not return a snapshot")
    return result.snapshot
  }

  private async readEvents(id: SessionId, afterRevision: number): Promise<readonly AgentEvent[]> {
    const result = await this.options.sessionServer.execute(id, readEventsCommand(afterRevision))
    if (result.type !== "events") throw new RpcApplicationError("invalid_host_result", "Host did not return events")
    return result.events
  }

  private requireCatalog(): SessionCatalog {
    if (!this.options.catalog) throw new RpcApplicationError("catalog_unavailable", "Session catalog is not enabled on this Host")
    return this.options.catalog
  }

  private requireDeviceRegistry(): AppServerDeviceRegistry {
    if (this.deviceRegistry === undefined)
      throw new RpcApplicationError("device_registry_unavailable", "Device registry is not enabled on this Host")
    return this.deviceRegistry
  }

  private async requireExistingSession(id: SessionId): Promise<void> {
    if (this.options.catalog) {
      if (!(await this.options.catalog.get(id))) throw new RpcApplicationError("session_not_found", `Session does not exist: ${id}`)
      return
    }
    const events = await this.readEvents(id, 0)
    if (events.length === 0) throw new RpcApplicationError("session_not_found", `Session does not exist: ${id}`)
  }

  private async requireRevision(id: SessionId, expectedRevision: number): Promise<void> {
    const snapshot = await this.readSnapshot(id)
    if (snapshot.lastRevision !== expectedRevision) {
      throw new RpcApplicationError(
        "revision_conflict",
        `Session revision changed: expected ${expectedRevision}, got ${snapshot.lastRevision}`,
      )
    }
  }

  private requireScope(scope: AppServerScope): void {
    if (!this.scopes.includes(scope)) throw new RpcApplicationError("scope_denied", `The current connection lacks scope: ${scope}`)
  }

  private detachSession(id: SessionId): void {
    const subscription = this.subscriptions.get(id)
    if (!subscription) return
    subscription.unsubscribe()
    subscription.unsubscribeTransient()
    this.subscriptions.delete(id)
    this.presenceRegistration?.detach(id.toString())
  }

  /**
   * `scope === "none"` means the command is not lease-protected at all.
   * When the Host has no interaction lease subsystem configured
   * (`presenceRegistry === undefined`; this only
   * happens in tests, the real Host composition always provides one), a
   * caller that never names a lease may still proceed unguarded, but a
   * caller that explicitly names one it cannot possibly hold gets
   * `interaction_unavailable` rather than being silently ignored.
   */
  private assertWriteAccess(
    id: SessionId,
    scope: InteractionLeaseScope | "none",
    generation: number | undefined,
  ): AppServerWriteAccess | undefined {
    if (scope === "none") return undefined
    if (this.presenceRegistry === undefined) {
      if (generation !== undefined) this.requireLeaseSupport()
      return undefined
    }
    return this.presenceRegistry.assertWriteAccess(id.toString(), scope, this.connectionId, generation)
  }

  private requireLeaseSupport(): void {
    if (this.presenceRegistry === undefined) {
      throw new RpcApplicationError("interaction_unavailable", "Interaction leases are not enabled on this App Server")
    }
  }

  private releaseWriteAccess(id: SessionId, access: AppServerWriteAccess | undefined): void {
    if (!access) return
    this.presenceRegistry?.releaseIfHeld(id.toString(), access.scope, this.connectionId, access.lease.generation)
  }

  private emit(method: string, params: Record<string, unknown>): void {
    this.options.onNotification(createNotification(method, toJson(params)))
  }
}

class RpcMethodNotFoundError extends RpcApplicationError {
  constructor(method: string) {
    super("method_not_found", `Unknown App Server method: ${method}`)
  }
}

function errorResponse(
  error: unknown,
  isWorkspaceUnavailableError: (error: unknown) => error is { readonly message: string; readonly workspaceRoot: string },
): [number, string, { readonly code: string; readonly details?: JsonValue }] {
  if (error instanceof RpcMethodNotFoundError) return [JSON_RPC_METHOD_NOT_FOUND, error.message, { code: error.kind }]
  if (error instanceof RpcApplicationError) {
    return [
      JSON_RPC_INVALID_PARAMS,
      error.message,
      { code: error.kind, ...(error.details === undefined ? {} : { details: error.details }) },
    ]
  }
  if (error instanceof AppServerProtocolError) return [JSON_RPC_INVALID_PARAMS, error.message, { code: error.kind }]
  if (error instanceof AppServerInteractionError) {
    return [
      JSON_RPC_INVALID_PARAMS,
      error.message,
      { code: error.kind, ...(error.details === undefined ? {} : { details: toJson(error.details) }) },
    ]
  }
  // Surface input conflicts as stable protocol errors before generic internal mapping.
  if (error instanceof CommandIdempotencyConflictError) {
    return [
      JSON_RPC_INVALID_PARAMS,
      error.message,
      { code: "command_idempotency_conflict", details: toJson({ family: error.family, commandId: error.commandId }) },
    ]
  }
  if (error instanceof SessionExecutionReservationConflictError) {
    return [JSON_RPC_INVALID_PARAMS, error.message, { code: "reservation_conflict", details: toJson({ sessionId: error.sessionId }) }]
  }
  if (error instanceof SessionWriterConflictError) {
    return [JSON_RPC_INVALID_PARAMS, error.message, { code: "reservation_conflict", details: toJson({ sessionId: error.sessionId }) }]
  }
  if (error instanceof SessionRevisionConflictError) {
    return [
      JSON_RPC_INVALID_PARAMS,
      error.message,
      { code: "revision_conflict", details: toJson({ sessionId: error.sessionId, expectedRevision: error.expectedRevision }) },
    ]
  }
  if (error instanceof SessionPolicyRevisionConflictError) {
    return [
      JSON_RPC_INVALID_PARAMS,
      error.message,
      {
        code: "policy_revision_conflict",
        details: toJson({
          sessionId: error.sessionId,
          expectedPolicyRevision: error.expectedPolicyRevision,
          actualPolicyRevision: error.actualPolicyRevision,
        }),
      },
    ]
  }
  if (error instanceof IncompatibleSessionEventError) {
    // A rules commit the current policy contract forbids (e.g. Allow(bash))
    // or incompatible persisted history: the typed reason crosses the wire
    // instead of an opaque internal error.
    return [JSON_RPC_INVALID_PARAMS, error.message, { code: "incompatible_session_event" }]
  }
  if (error instanceof SessionIdConflictError) {
    return [JSON_RPC_INVALID_PARAMS, error.message, { code: "session_id_conflict", details: toJson({ sessionId: error.sessionId }) }]
  }
  if (isWorkspaceUnavailableError(error)) {
    return [
      JSON_RPC_INVALID_PARAMS,
      error.message,
      { code: "workspace_unavailable", details: toJson({ workspaceRoot: error.workspaceRoot }) },
    ]
  }
  return [JSON_RPC_INTERNAL_ERROR, "App Server internal error", { code: "internal_error" }]
}
