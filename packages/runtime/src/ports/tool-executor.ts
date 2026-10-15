import type { ApiToolDefinition, ToolExecutionMetadata, ToolPreparation, ToolResult } from "@ag2cli/core/tool-facts.js"
import type { ToolExecutionContext } from "./tool/contract.js"

// Capability ownership is kept out of the executor object itself. A symbol
// property could be copied or forged by an in-process custom adapter; a
// WeakSet membership can only be granted by the local composition adapter and
// is not serializable across a remote boundary.
const modelBashAuthorities = new WeakSet<object>()

export function registerModelBashAuthority<T extends ToolExecutor>(executor: T): T {
  modelBashAuthorities.add(executor as object)
  return executor
}

export function hasModelBashAuthority(executor: ToolExecutor): boolean {
  return modelBashAuthorities.has(executor as object)
}

/** Tool boundary used by the execution runtime. Implementations may be local or remote. */
export interface ToolExecutor {
  listTools(): readonly ApiToolDefinition[]
  /** Return client-neutral facts used to route tool interaction. */
  describeTool?(name: string, input: unknown): ToolExecutionMetadata | undefined
  /** Validate/classify a call without starting external work. */
  prepare?(input: {
    readonly name: string
    readonly input: unknown
    readonly signal?: AbortSignal
    readonly context?: ToolExecutionContext
  }): Promise<ToolPreparation>
  execute(input: {
    readonly name: string
    readonly input: unknown
    readonly signal?: AbortSignal
    readonly context?: ToolExecutionContext
  }): Promise<ToolResult>
}

/** Restrict a tool executor without leaking registry details into the runtime. */
export function restrictTools(executor: ToolExecutor, allowed: readonly string[]): ToolExecutor {
  // An empty scope inherits the full pool; there is no wildcard form — a
  // "*" entry is an ordinary unknown name.
  if (allowed.length === 0) return executor
  const names = new Set(allowed)
  const restricted: ToolExecutor = {
    listTools: () => executor.listTools().filter((tool) => names.has(tool.name)),
    ...(executor.describeTool
      ? {
          describeTool: (name, input) => (names.has(name) ? executor.describeTool!(name, input) : undefined),
        }
      : {}),
    ...(executor.prepare
      ? {
          prepare: (input) =>
            names.has(input.name)
              ? executor.prepare!(input)
              : Promise.resolve({
                  status: "denied",
                  decision: "deny",
                  reasons: [`tool ${input.name} denied (unknown_tool_or_input: outside the current agent tool scope)`],
                  analyzerVersion: "registry",
                  policyVersion: "registry",
                  denial: { code: "unknown_tool_or_input" },
                }),
        }
      : {}),
    execute: (input) =>
      names.has(input.name)
        ? executor.execute(input)
        : Promise.resolve({
            content: `tool ${input.name} denied (unknown_tool_or_input: outside the current agent tool scope)`,
            isError: true,
            denial: { code: "unknown_tool_or_input" },
          }),
  }
  return hasModelBashAuthority(executor) ? registerModelBashAuthority(restricted) : restricted
}

/**
 * Derive the retry key for one logical tool call. External adapters should
 * pass this key to the remote system's idempotency facility when it has one.
 */
export function toolIdempotencyKey(input: Pick<ToolExecutionContext, "sessionId" | "runId" | "turn" | "toolUseId">): string {
  return [input.sessionId, input.runId, input.turn, input.toolUseId].map((part) => encodeURIComponent(String(part))).join(":")
}
