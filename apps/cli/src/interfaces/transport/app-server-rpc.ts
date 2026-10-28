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
  type AppServerCapabilities,
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
  type ServerInitializeParams,
  type ServerInitializeResult,
} from "@ag2cli/app-server-protocol/types.js"
import { AppServerProtocolError, assertJsonValue } from "@ag2cli/app-server-protocol/validation.js"
import type { PublicPermissionModeValue } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { TransientStreamEvent } from "@ag2cli/core/events/transient.js"
import type { SessionServer } from "@ag2cli/session-client/session-client.js"
import { type SessionCatalog } from "@ag2cli/runtime/ports/session-catalog.js"
import { getSnapshotCommand, readEventsCommand } from "@ag2cli/session-protocol/session-command.js"
import { AppServerOperationRegistry } from "./app-server-operation-registry.js"
import {
  AppServerInteractionError,
  AppServerPresenceRegistry,
  type AppServerPresenceRegistration,
  type AppServerWriteAccess,
} from "./app-server-presence.js"
import { ConnectionMethods } from "./rpc/connection-methods.js"
import { type MethodContext, type RpcSubscription, type ServeWorkspaceRegistry } from "./rpc/method-context.js"
import { classifyRuntimeCommandError, RpcApplicationError, toJson } from "./public-session-command-mapping.js"
import { DEFAULT_SELECTABLE_MODES } from "./rpc/catalog-projection.js"
import { SessionReadMethods } from "./rpc/session-read-methods.js"
import { SessionWriteMethods } from "./rpc/session-write-methods.js"
import { DeviceMethods } from "./rpc/device-methods.js"
import { InteractionMethods } from "./rpc/interaction-methods.js"
import { WorkspaceMethods, type WorkspaceInspectionPort } from "./rpc/workspace-methods.js"

export { DEFAULT_SELECTABLE_MODES } from "./rpc/catalog-projection.js"

const DEFAULT_SCOPES: readonly AppServerScope[] = [
  "session:read",
  "session:write",
  "session:policy",
  "approval:write",
  "shell:execute",
  "workspace:read",
]

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
  readonly capabilities?: AppServerCapabilities
  readonly connectionId?: string
  readonly deviceId?: string
  /** Shared by all connections belonging to one Host. */
  readonly operationRegistry?: AppServerOperationRegistry
  /** Shared by all connections belonging to one Host. */
  readonly presenceRegistry?: AppServerPresenceRegistry
  readonly workspaceRegistry?: ServeWorkspaceRegistry
  /**
   * Structured workspace inspection (owner: capabilities/workspace),
   * satisfied structurally at the composition wiring site. Hosts without
   * the read-only workspace face leave this undefined.
   */
  readonly workspaceInspection?: WorkspaceInspectionPort
  /** Permission modes remote clients may select; defaults to the four base modes. */
  readonly selectableModes?: readonly PublicPermissionModeValue[]
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
  private readonly capabilities?: AppServerCapabilities
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
  private readonly workspaceMethods: WorkspaceMethods

  constructor(private readonly options: AppServerRpcConnectionOptions) {
    this.connectionId = options.connectionId ?? `connection-${randomUUID()}`
    this.deviceId = options.deviceId ?? `device-${randomUUID()}`
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
      operationRegistry: this.operationRegistry,
      ...(this.presenceRegistry === undefined ? {} : { presenceRegistry: this.presenceRegistry }),
      ...(options.workspaceRegistry === undefined ? {} : { workspaceRegistry: options.workspaceRegistry }),
      ...(options.workspaceInspection === undefined ? {} : { workspaceInspection: options.workspaceInspection }),
      selectableModes: options.selectableModes ?? DEFAULT_SELECTABLE_MODES,
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
      acquireWriteAccess: (id: SessionId, scope: InteractionLeaseScope) => this.acquireWriteAccess(id, scope),
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
    this.workspaceMethods = new WorkspaceMethods(this.methodContext)
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

  /** Trusted in-process entry point; network clients must use server.initialize after preflight. */
  initializeLocal(
    params: Omit<ServerInitializeParams, "hostId" | "auth" | "appServerProtocolVersion"> & {
      readonly appServerProtocolVersion?: ServerInitializeParams["appServerProtocolVersion"]
    },
  ): Promise<ServerInitializeResult> {
    if (this.closed) return Promise.reject(new Error("App Server connection is closed"))
    return this.connectionMethods.initializeLocal(params)
  }

  private async dispatch(request: JsonRpcRequest): Promise<JsonValue> {
    if (request.method === "server.initialize") return toJson(await this.connectionMethods.initialize(request.params))
    if (!this.initialized) throw new RpcApplicationError("not_initialized", "Call server.initialize first")
    if (request.method === "server.health") return this.connectionMethods.health()
    if (request.method === "server.describe") return toJson(this.connectionMethods.describe())

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
      case "session.plan":
        return toJson(await this.sessionWriteMethods.plan(request.params))
      case "session.compact":
        return toJson(await this.sessionWriteMethods.compact(request.params))
      case "session.addDirectory":
        return toJson(await this.sessionWriteMethods.addDirectory(request.params))
      case "session.setContextWindow":
        return toJson(await this.sessionWriteMethods.setContextWindow(request.params))
      case "session.clearContextWindow":
        return toJson(await this.sessionWriteMethods.clearContextWindow(request.params))
      case "session.selectAgent":
        return toJson(await this.sessionWriteMethods.selectAgent(request.params))
      case "session.updateGoal":
        return toJson(await this.sessionWriteMethods.updateGoal(request.params))
      case "session.submit":
        return await this.sessionWriteMethods.submit(request.params)
      case "session.steer":
        return toJson(await this.sessionWriteMethods.steer(request.params))
      case "session.cancelRun":
        return toJson(await this.sessionWriteMethods.cancelRun(request.params))
      case "session.cancelInput":
        return toJson(await this.sessionWriteMethods.cancelInput(request.params))
      case "session.messages":
        return toJson(await this.sessionReadMethods.messages(request.params))
      case "session.resolveInteraction":
        return toJson(await this.sessionWriteMethods.resolveInteraction(request.params))
      case "session.getPermissionPolicy":
        return toJson(await this.sessionWriteMethods.getPermissionPolicy(request.params))
      case "session.setPermissionMode":
        return toJson(await this.sessionWriteMethods.setPermissionMode(request.params))
      case "session.setPermissionRules":
        return toJson(await this.sessionWriteMethods.setPermissionRules(request.params))
      case "session.replay":
        return toJson(await this.sessionReadMethods.replay(request.params))
      case "session.trace":
        return toJson(await this.sessionReadMethods.trace(request.params))
      case "session.modelCalls":
        return toJson(await this.sessionReadMethods.modelCalls(request.params))
      case "session.resync":
        return toJson(await this.sessionReadMethods.resync(request.params))
      case "session.createTask":
        return toJson(await this.sessionWriteMethods.createTask(request.params))
      case "session.listTasks":
        return toJson(await this.sessionWriteMethods.listTasks(request.params))
      case "session.cancelTask":
        return toJson(await this.sessionWriteMethods.cancelTask(request.params))
      case "session.getTaskLogs":
        return toJson(await this.sessionWriteMethods.getTaskLogs(request.params))
      case "session.executeShell":
        return toJson(await this.sessionWriteMethods.executeShell(request.params))
      case "session.executeUserShell":
        return toJson(await this.sessionWriteMethods.executeUserShell(request.params))
      case "session.listCheckpoints":
        return toJson(await this.sessionWriteMethods.listCheckpoints(request.params))
      case "session.previewRewind":
        return toJson(await this.sessionWriteMethods.previewRewind(request.params))
      case "session.rewind":
        return toJson(await this.sessionWriteMethods.rewind(request.params))
      case "interaction.acquire":
      case "interaction.renew":
      case "interaction.release":
      case "interaction.takeover":
        return toJson(await this.interactionMethods.handle(request.method, request.params))
      case "device.list":
        return toJson(await this.deviceMethods.list())
      case "device.revoke":
        return toJson(await this.deviceMethods.revoke(request.params))
      case "workspace.diff":
        return toJson(await this.workspaceMethods.diff(request.params))
      case "workspace.readFile":
        return toJson(await this.workspaceMethods.readFile(request.params))
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
   * (`presenceRegistry === undefined`; serve Hosts configure one, the
   * local TUI/run Hosts deliberately run without), a
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

  /**
   * Implicit one-shot lease acquisition for submit without an explicit
   * lease: another holder still fences the request with
   * `interaction_lease_held`; the caller releases right after admission.
   */
  private acquireWriteAccess(id: SessionId, scope: InteractionLeaseScope): AppServerWriteAccess | undefined {
    if (this.presenceRegistry === undefined) return undefined
    return { scope, lease: this.presenceRegistry.acquire(id.toString(), scope, this.connectionId) }
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
  const classified = classifyRuntimeCommandError(error, isWorkspaceUnavailableError)
  if (classified !== undefined) {
    return [
      JSON_RPC_INVALID_PARAMS,
      classified.message,
      { code: classified.code, ...(classified.details === undefined ? {} : { details: classified.details }) },
    ]
  }
  return [JSON_RPC_INTERNAL_ERROR, "App Server internal error", { code: "internal_error" }]
}
