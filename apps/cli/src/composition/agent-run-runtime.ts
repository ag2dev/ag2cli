import { buildAgentServerHost, type AgentServerHost, type BuildAgentServerHostOptions } from "./agent-host.js"

/** Non-interactive local composition shared by `agent run` and session resume. */
export function buildAgentRunRuntime(options: Omit<BuildAgentServerHostOptions, "profile" | "runtimeProfile">): Promise<AgentServerHost> {
  return buildAgentServerHost({ ...options, profile: "local-durable", runtimeProfile: "headless" })
}
