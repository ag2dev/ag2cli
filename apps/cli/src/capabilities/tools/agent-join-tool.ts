/**
 * `agent_join` tool face (E1): a thin read over the child runner's outcome
 * retention.
 *
 * Judgment classifies it `session-internal` — a read of process-local state
 * with no external effect — so it never raises an approval card and stays
 * usable in plan mode (where it structurally answers unknown-child: no
 * delegation can have spawned under the plan cap). The handle is the spawn
 * result's childSessionId; a wait is bounded by the runner's clamp and can
 * be interrupted by the parent turn's signal like any other tool.
 */

import { z } from "zod/v4"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import type { Tool, ToolContext } from "@ag2cli/runtime/ports/tool/contract.js"
import type { ChildAgentRunner } from "../execution/child-agent-runner.js"

const inputSchema = z.object({
  task_id: z.string().min(1).describe("Async subagent handle, which is the childSessionId from the spawn result"),
  timeout_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Maximum time to wait for a running subagent; omitted or 0 returns the current status immediately"),
})

export interface AgentJoinToolDependencies {
  /** Resolved lazily; the composition assigns the runner after the model layer exists. */
  readonly runnerThunk: () => ChildAgentRunner | undefined
}

export class AgentJoinTool implements Tool<typeof inputSchema> {
  readonly name = "agent_join"
  readonly description =
    "Look up an async subagent by task_id. For a terminal task, return its final report or failure/cancellation reason; for a running task, return its status. When timeout_ms > 0, wait up to that duration for a terminal state. task_id is the handle returned by an async spawn from the agent tool."
  readonly inputSchema = inputSchema

  constructor(private readonly deps: AgentJoinToolDependencies) {}

  async call(args: z.infer<typeof inputSchema>, context?: ToolContext): Promise<ToolResult> {
    const runner = this.deps.runnerThunk()
    if (runner === undefined) {
      return structuredError("delegation unavailable: this host did not assemble a child agent runner")
    }
    const result = await runner.join(args.task_id, {
      ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
    })
    switch (result.status) {
      case "unknown":
        return structuredError(
          `unknown task_id: ${args.task_id}; in-register ids: ${result.known.length > 0 ? result.known.join(", ") : "(none)"}`,
          { code: "unknown_tool_or_input" },
        )
      case "running":
        return {
          content: `child agent ${args.task_id} still running${args.timeout_ms ? "; timed out waiting" : ""}; retry with a longer timeout_ms or wait for its completion notification`,
        }
      case "completed":
        return { content: result.finalText ?? "child agent completed without a final report", metadata: { childSessionId: args.task_id } }
      case "failed":
        return { content: `child agent failed: ${result.error}`, isError: true, metadata: { childSessionId: args.task_id } }
      case "cancelled":
        return { content: "child agent cancelled", isError: true, metadata: { childSessionId: args.task_id } }
    }
  }

  isReadOnly(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    // Bounded waiting (runner clamps the timeout) holds no concurrency slot
    // and mutates nothing.
    return true
  }
}

function structuredError(message: string, denial?: ToolResult["denial"]): ToolResult {
  return { content: `agent_join tool refused: ${message}`, isError: true, ...(denial === undefined ? {} : { denial }) }
}
