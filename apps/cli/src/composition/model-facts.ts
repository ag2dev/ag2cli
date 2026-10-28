import { resolveModel } from "@ag2cli/model-catalog/resolve.js"
import type { ResolvedModelInfo } from "@ag2cli/model-catalog/types.js"
import { deriveFamily } from "../infrastructure/model/compatibility/resolver.js"
import type { RuntimeConfig } from "../config/runtime.js"

/** The resolved catalog facts of the main model, shared by startup identity and service thresholds. */
export interface MainModelFacts {
  readonly protocol: "anthropic" | "openai"
  readonly family?: string
  readonly resolved: ResolvedModelInfo
}

/**
 * Resolve the main model's catalog facts from a runtime config snapshot.
 *
 * Mirrors pickModelClient's input formula (effective endpoint / effective modelId / derived family)
 * so every consumer sees the same resolution the live client uses. Pure lookup: catalog misses
 * resolve to protocol defaults; miss diagnostics stay owned by the client instances.
 */
export function resolveMainModelFacts(config: RuntimeConfig, modelIdOverride?: string): MainModelFacts {
  const provider = config.provider
  const overrides = {
    ...(provider.contextWindow === undefined ? {} : { contextWindow: provider.contextWindow }),
    ...(provider.maxTokens === undefined ? {} : { maxOutputTokens: provider.maxTokens }),
  }
  if (provider.protocol === "openai") {
    const baseURL = provider.openaiBaseURL ?? provider.baseURL
    const family = deriveFamily(baseURL, provider.compatibility)
    return {
      protocol: "openai",
      ...(family === undefined ? {} : { family }),
      resolved: resolveModel({
        protocol: "openai",
        ...(family === undefined ? {} : { provider: family }),
        modelId: modelIdOverride ?? provider.openaiModel ?? provider.model ?? "",
        overrides,
      }),
    }
  }
  return {
    protocol: "anthropic",
    resolved: resolveModel({ protocol: "anthropic", modelId: modelIdOverride ?? provider.model ?? "", overrides }),
  }
}
