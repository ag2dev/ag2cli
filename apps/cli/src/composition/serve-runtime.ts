import { buildAgentServerHost, type AgentServerHost, type BuildAgentServerHostOptions } from "./agent-host.js"

/** Long-lived multi-client composition; workspace routing is registry-backed. */
export function buildServeRuntime(options: Omit<BuildAgentServerHostOptions, "profile" | "runtimeProfile">): Promise<AgentServerHost> {
  return buildAgentServerHost({ ...options, profile: "serve-durable", runtimeProfile: "headless" })
}
