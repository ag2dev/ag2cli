import {
  APP_SERVER_METHODS,
  APP_SERVER_PROTOCOL_VERSION,
  type AppServerCapabilities,
  type AppServerScope,
  type ServerDescribeResult,
  type ServerInitializeParams,
  type ServerInitializeResult,
} from "@ag2cli/app-server-protocol/types.js"
import { publicSessionEventTypeSchema } from "@ag2cli/app-server-protocol/dto/events.js"
import { parseServerInitializeParams } from "@ag2cli/app-server-protocol/validation.js"
import type { MethodContext } from "./method-context.js"
import { RpcApplicationError } from "../public-session-command-mapping.js"
import { statSync } from "node:fs"

const SESSION_METHODS = APP_SERVER_METHODS.filter((method) => method.startsWith("session."))
const SESSION_EVENT_TYPES = publicSessionEventTypeSchema.options

/** Declarative advertisement only: authorization is scope + policy + lease, never clientKind. */
function defaultCapabilities(context: MethodContext): AppServerCapabilities {
  return {
    session: { methods: SESSION_METHODS, eventTypes: SESSION_EVENT_TYPES },
    interactions: { approval: true, askUser: true },
    workspace: { diff: true, readFile: true },
    security: { permissionModes: [...context.selectableModes], editableRules: true },
    execution: { explicitShell: true },
  }
}

export class ConnectionMethods {
  constructor(private readonly context: MethodContext) {}

  async initialize(value: unknown): Promise<ServerInitializeResult> {
    if (this.context.initialized) throw new RpcApplicationError("already_initialized", "Connection is already initialized")
    const params = parseServerInitializeParams(value)
    if (params.hostId !== this.context.descriptor.hostId) {
      throw new RpcApplicationError("host_identity_mismatch", "server.initialize Host ID does not match this Host")
    }
    if (params.auth.type === "operator" && (params.requestedScopes?.length !== 1 || params.requestedScopes[0] !== "device:admin")) {
      throw new RpcApplicationError("scope_denied", "Operator initialization must request only device:admin")
    }
    const requested = params.requestedScopes ?? this.context.grantedScopes
    const denied = requested.filter((scope) => !this.context.grantedScopes.includes(scope))
    if (denied.length > 0) throw new RpcApplicationError("scope_denied", `The requested scopes are not authorized: ${denied.join(", ")}`)
    return this.completeInitialization(params.client, requested, params.auth.type === "device")
  }

  /** Initialize a private in-process connection without inventing wire credentials. */
  async initializeLocal(
    params: Omit<ServerInitializeParams, "hostId" | "auth" | "appServerProtocolVersion"> & {
      readonly appServerProtocolVersion?: ServerInitializeParams["appServerProtocolVersion"]
    },
  ): Promise<ServerInitializeResult> {
    if (this.context.initialized) throw new RpcApplicationError("already_initialized", "Connection is already initialized")
    if (params.appServerProtocolVersion !== undefined && params.appServerProtocolVersion !== APP_SERVER_PROTOCOL_VERSION) {
      throw new RpcApplicationError("unsupported_protocol_version", "Unsupported App Server protocol version")
    }
    const requested = params.requestedScopes ?? this.context.grantedScopes
    const denied = requested.filter((scope) => !this.context.grantedScopes.includes(scope))
    if (denied.length > 0) throw new RpcApplicationError("scope_denied", `The requested scopes are not authorized: ${denied.join(", ")}`)
    return this.completeInitialization(params.client, requested, true)
  }

  private async completeInitialization(
    client: ServerInitializeParams["client"],
    requested: readonly AppServerScope[],
    registerDevicePresence: boolean,
  ): Promise<ServerInitializeResult> {
    this.context.setClientKind(client.clientKind)
    this.context.setScopes([...requested])
    this.context.setPresenceRegistration(
      registerDevicePresence
        ? this.context.presenceRegistry?.register({
            connectionId: this.context.connectionId,
            deviceId: this.context.deviceId,
            client,
            notify: (method, values) => this.context.emit(method, values),
          })
        : undefined,
    )
    this.context.markInitialized()
    const canReadSessions = this.context.scopes.includes("session:read") || this.context.scopes.includes("session:write")
    const registeredWorkspaces =
      this.context.workspaceRegistry === undefined || !canReadSessions
        ? undefined
        : (await this.context.workspaceRegistry.list()).map((workspace) => ({
            workspaceId: workspace.workspaceId,
            workspaceRoot: workspace.workspaceRoot,
            availability: isDirectory(workspace.workspaceRoot) ? ("available" as const) : ("unavailable" as const),
          }))
    return {
      appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
      server: this.context.descriptor,
      connection: {
        connectionId: this.context.connectionId,
        ...(registerDevicePresence ? { deviceId: this.context.deviceId } : {}),
        scopes: this.context.scopes,
      },
      capabilities: this.context.capabilities ?? defaultCapabilities(this.context),
      host: {
        profile: this.context.profile,
        ...(registeredWorkspaces !== undefined
          ? { workspaces: registeredWorkspaces }
          : this.context.workspaceRoot === undefined
            ? {}
            : { workspaceRoot: this.context.workspaceRoot }),
        ...(this.context.configurationFingerprint === undefined ? {} : { configurationFingerprint: this.context.configurationFingerprint }),
        ...(this.context.workspaceFingerprint === undefined ? {} : { workspaceFingerprint: this.context.workspaceFingerprint }),
        ...(this.context.securityFingerprint === undefined ? {} : { securityFingerprint: this.context.securityFingerprint }),
      },
    }
  }

  health(): { readonly ok: boolean; readonly status: string; readonly protocolVersion: number } {
    return { ok: true, status: "ready", protocolVersion: APP_SERVER_PROTOCOL_VERSION }
  }

  describe(): ServerDescribeResult {
    return {
      server: this.context.descriptor,
      capabilities: this.context.capabilities ?? defaultCapabilities(this.context),
    }
  }
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}
