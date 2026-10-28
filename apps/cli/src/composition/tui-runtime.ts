import { createPendingApprovalBroker } from "@ag2cli/runtime/ports/approval-broker.js"
import { createPendingAskBroker } from "@ag2cli/runtime/ports/ask-broker.js"
import { buildAgentServerHost, type AgentServerHost, type BuildAgentServerHostOptions } from "./agent-host.js"

/** Ordinary TUI composition: one local durable Host, never a serve connection. */
export function buildTuiRuntime(
  options: Omit<BuildAgentServerHostOptions, "profile" | "runtimeProfile"> & { readonly runtimeProfile?: "interactive" },
): Promise<AgentServerHost> {
  return buildAgentServerHost({
    ...options,
    // Every TUI parks ask-classed tools on the pending broker; an
    // assembly without one never resolves an approval card.
    approval: options.approval ?? createPendingApprovalBroker(),
    // Parent asks ride the durable lifecycle: the executor parks on this
    // broker and the ask card resolves through the public interaction
    // surface, the same path a remote client would take.
    ask: options.ask ?? createPendingAskBroker(),
    profile: "local-durable",
    runtimeProfile: options.runtimeProfile ?? "interactive",
  })
}
