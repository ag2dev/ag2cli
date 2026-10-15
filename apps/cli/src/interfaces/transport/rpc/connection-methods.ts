import {
  APP_SERVER_PROTOCOL_VERSION,
  type AppServerClientInfo,
  type AppServerScope,
  type JsonValue,
  type ServerInitializeResult,
} from "@ag2cli/app-server-protocol/types.js"
import { parseServerInitializeParams } from "@ag2cli/app-server-protocol/validation.js"
import { RpcApplicationError, toJson, type MethodContext } from "./method-context.js"
import { statSync } from "node:fs"

const DEFAULT_CAPABILITIES = [
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
] as const

export class ConnectionMethods {
  constructor(private readonly context: MethodContext) {}

  async initialize(value: unknown): Promise<ServerInitializeResult> {
    if (this.context.initialized) throw new RpcApplicationError("already_initialized", "Connection is already initialized")
    const params = parseServerInitializeParams(value)
    if (
      this.context.authenticatedDeviceId !== undefined &&
      params.device?.deviceId !== undefined &&
      params.device.deviceId !== this.context.authenticatedDeviceId
    ) {
      throw new RpcApplicationError("device_auth_mismatch", "server.initialize deviceId does not match the transport identity")
    }
    if (params.serverFingerprint !== undefined && params.serverFingerprint !== this.context.descriptor.fingerprint) {
      throw new RpcApplicationError("server_fingerprint_mismatch", "Server fingerprint does not match")
    }
    if (this.context.authenticatedDevicePublicKey !== undefined) {
      if (this.context.deviceProofVerifier === undefined) {
        throw new RpcApplicationError("device_proof_unavailable", "Device proof verification is not enabled on this Host")
      }
      if (params.device?.challenge === undefined || params.device.signature === undefined) {
        throw new RpcApplicationError("device_proof_required", "This device must submit a challenge proof")
      }
      const verified = await this.context.deviceProofVerifier.verify({
        deviceId: this.context.authenticatedDeviceId!,
        publicKey: this.context.authenticatedDevicePublicKey,
        clientId: params.client.clientId,
        proof: params.device,
      })
      if (!verified) throw new RpcApplicationError("device_proof_invalid", "Device challenge proof is invalid or expired")
    }
    const requested = params.requestedScopes ?? this.context.grantedScopes
    const denied = requested.filter((scope) => !this.context.grantedScopes.includes(scope))
    if (denied.length > 0) throw new RpcApplicationError("scope_denied", `The requested scopes are not authorized: ${denied.join(", ")}`)
    this.context.setClientKind(params.client.clientKind)
    this.context.setScopes([...requested])
    this.context.setPresenceRegistration(
      this.context.presenceRegistry?.register({
        connectionId: this.context.connectionId,
        deviceId: this.context.deviceId,
        client: params.client,
        notify: (method, values) => this.context.emit(method, values),
      }),
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
      connection: { connectionId: this.context.connectionId, deviceId: this.context.deviceId, scopes: this.context.scopes },
      capabilities: capabilitiesForClient(
        this.context.capabilities ?? defaultCapabilities(this.context.scopes, this.context.deviceRegistry),
        this.context.clientKind,
      ),
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

  health(): JsonValue {
    return { ok: true, status: "ready", protocolVersion: APP_SERVER_PROTOCOL_VERSION }
  }

  describe(): JsonValue {
    return toJson(this.context.descriptor)
  }
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

function capabilitiesForClient(capabilities: readonly string[], clientKind: AppServerClientInfo["clientKind"]): readonly string[] {
  if (clientKind !== "mobile") return capabilities
  const denied = new Set(["session.fork", "session.delete", "session.rewind", "session.shell", "session.permission"])
  return capabilities.filter((capability) => !denied.has(capability))
}

function defaultCapabilities(grantedScopes: readonly AppServerScope[], deviceRegistry: MethodContext["deviceRegistry"]): readonly string[] {
  if (deviceRegistry === undefined || !grantedScopes.includes("device:admin")) return DEFAULT_CAPABILITIES
  return [...DEFAULT_CAPABILITIES, "device.list", "device.revoke"]
}
