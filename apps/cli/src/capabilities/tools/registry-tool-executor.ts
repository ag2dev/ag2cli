import { registerModelBashAuthority, type ToolExecutor } from "@ag2cli/runtime/ports/tool-executor.js"
import type { ToolRegistry } from "./registry.js"

/** Adapter for the existing ToolRegistry; no registry type leaks into the runtime port. */
export function registryToolExecutor(registry: ToolRegistry, options: { readonly modelBashAuthority?: boolean } = {}): ToolExecutor {
  const executor: ToolExecutor = {
    listTools: () => registry.toApiDefinitions(),
    describeTool: (name, input) => registry.describeTool(name, input),
    prepare: ({ name, input, signal, context }) =>
      registry.prepare(name, input, {
        signal,
        execution: context,
        onOutput: context?.onOutput,
      }),
    execute: ({ name, input, signal, context }) =>
      registry.execute(name, input, {
        signal,
        execution: context,
        onOutput: context?.onOutput,
      }),
  }
  return options.modelBashAuthority === false ? executor : registerModelBashAuthority(executor)
}
