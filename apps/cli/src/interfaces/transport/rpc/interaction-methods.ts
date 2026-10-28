import { type AppServerInteractionLease, type JsonValue } from "@ag2cli/app-server-protocol/types.js"
import { parseInteractionRequest, requireLeaseGeneration } from "@ag2cli/app-server-protocol/validation.js"
import { sessionId } from "@ag2cli/core/ids.js"
import type { MethodContext } from "./method-context.js"
import { RpcApplicationError, toJson } from "../public-session-command-mapping.js"

/** App Server interaction lease operations for one connection. */
export class InteractionMethods {
  constructor(private readonly context: MethodContext) {}

  async handle(method: string, value: unknown): Promise<JsonValue> {
    this.context.requireScope("session:write")
    const params = parseInteractionRequest(value, method)
    const registry = this.context.presenceRegistry
    if (registry === undefined) throw new RpcApplicationError("interaction_unavailable", "Interaction leases are not enabled on this Host")
    const id = sessionId(params.sessionId)
    await this.context.requireExistingSession(id)
    let lease: AppServerInteractionLease
    switch (method) {
      case "interaction.acquire":
        lease = registry.acquire(id.toString(), params.scope, this.context.connectionId, params.ttlMs)
        break
      case "interaction.renew":
        lease = registry.renew(id.toString(), params.scope, this.context.connectionId, requireLeaseGeneration(params), params.ttlMs)
        break
      case "interaction.release":
        lease = registry.release(id.toString(), params.scope, this.context.connectionId, requireLeaseGeneration(params))
        break
      case "interaction.takeover":
        lease = registry.takeover(id.toString(), params.scope, this.context.connectionId, params.ttlMs)
        break
      default:
        throw new RpcApplicationError("method_not_found", `Unknown interaction method: ${method}`)
    }
    return { sessionId: id, scope: params.scope, lease: toJson(lease) }
  }
}
