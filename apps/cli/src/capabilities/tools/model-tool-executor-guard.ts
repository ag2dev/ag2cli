import type { ToolExecutor } from "@ag2cli/runtime/ports/tool-executor.js"
import type { ToolPreparation, ToolResult } from "@ag2cli/core/tool-facts.js"

const CUSTOM_BASH_ERROR =
  "Model Bash is provided only by the local canonical registry; a custom ToolExecutor must not declare or execute Bash"

/**
 * Keep the model Bash authority at the composition root.
 *
 * A custom/remote executor may provide non-Bash tools, but it cannot replace
 * the local canonical Bash security authority.  Calls that are not advertised
 * (or are hallucinated by a model) still receive a durable deny preparation
 * and never reach the custom executor.
 */
export function guardModelToolExecutor(executor: ToolExecutor): ToolExecutor {
  assertNoCustomBash(executor)
  return {
    listTools: () => {
      assertNoCustomBash(executor)
      return executor.listTools()
    },
    ...(executor.describeTool
      ? {
          describeTool: (name, input) => {
            if (name === "bash") return { interaction: "none" as const, isReadOnly: false, concurrencySafe: false }
            return executor.describeTool!(name, input)
          },
        }
      : {}),
    prepare: async (input) =>
      input.name === "bash"
        ? deniedPreparation(input.input)
        : executor.prepare
          ? executor.prepare(input)
          : {
              status: "invalid" as const,
              decision: "deny" as const,
              preparedInput: input.input,
              reasons: [`Tool ${input.name} did not provide a canonical preparation`],
              analyzerVersion: "executor-contract",
              policyVersion: "executor-contract",
            },
    execute: async (input) => (input.name === "bash" ? deniedResult() : executor.execute(input)),
  }
}

function assertNoCustomBash(executor: ToolExecutor): void {
  if (executor.listTools().some((tool) => tool.name === "bash")) {
    throw new Error(CUSTOM_BASH_ERROR)
  }
}

function deniedPreparation(input: unknown): ToolPreparation {
  // A rule refusal, not an input problem: the durable code matches the
  // direct execute settlement on every surface.
  return {
    status: "denied",
    decision: "deny",
    preparedInput: input,
    reasons: [CUSTOM_BASH_ERROR],
    analyzerVersion: "executor-contract",
    policyVersion: "executor-contract",
    denial: { code: "denied_by_rule", reason: CUSTOM_BASH_ERROR },
  }
}

function deniedResult(): ToolResult {
  // The guard is a rule refusal: the model-facing content carries the
  // stable code, never an ad-hoc prose string.
  return {
    content: `tool bash denied (denied_by_rule: ${CUSTOM_BASH_ERROR})`,
    isError: true,
    denial: { code: "denied_by_rule", reason: CUSTOM_BASH_ERROR },
  }
}
