import { createPendingApprovalBroker } from "@ag2cli/runtime/ports/approval-broker.js"
import type { JsonRpcAppServerClient } from "@ag2cli/app-server-client/client.js"
import type { RuntimeConfig } from "../config/runtime.js"
import { drainChildAgents, type ChildAgentRunner } from "../capabilities/execution/child-agent-runner.js"
import { buildAgentServerHost } from "./agent-host.js"
import { pickModelClient } from "./model-client.js"

export interface EphemeralAppServer {
  readonly client: JsonRpcAppServerClient
  /**
   * Turn-scoped async drain: bounds waiting for the invocation's running
   * children, then cancels the remainder. The Host close keeps its own
   * drain as the backstop.
   */
  drainChildAgents(budgetMs?: number): Promise<void>
  close(): Promise<void>
}

/**
 * Compose the private ephemeral App Server for one ACP adapter lifecycle.
 * The adapter owns the whole Host, so no process boundary sits between the
 * ACP edge and its Host; the face exposes the JSON-RPC client plus the
 * per-invocation child drain, and closing releases the connection and the
 * ephemeral storage in one step.
 */
export async function connectEphemeralAppServer(runtimeConfig: RuntimeConfig): Promise<EphemeralAppServer> {
  const client = await pickModelClient(runtimeConfig)
  let runner: ChildAgentRunner | undefined
  const host = await buildAgentServerHost({
    profile: "ephemeral",
    runtimeProfile: "headless",
    workspaceRoot: process.cwd(),
    client,
    approval: createPendingApprovalBroker(),
    runtimeConfig,
    onChildRunner: (minted) => {
      runner = minted
    },
  })
  const connection = host.createConnection()
  return {
    client: connection.client,
    async drainChildAgents(budgetMs) {
      if (runner === undefined) return
      await drainChildAgents(runner, budgetMs)
    },
    async close() {
      await host.close()
    },
  }
}
