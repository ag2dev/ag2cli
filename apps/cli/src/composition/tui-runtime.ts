import { buildAgentServerHost, type AgentServerHost, type BuildAgentServerHostOptions } from "./agent-host.js"

/** Ordinary TUI composition: one local durable Host, never a serve connection. */
export function buildTuiRuntime(
  options: Omit<BuildAgentServerHostOptions, "profile" | "runtimeProfile"> & { readonly runtimeProfile?: "interactive" },
): Promise<AgentServerHost> {
  return buildAgentServerHost({ ...options, profile: "local-durable", runtimeProfile: options.runtimeProfile ?? "interactive" })
}
