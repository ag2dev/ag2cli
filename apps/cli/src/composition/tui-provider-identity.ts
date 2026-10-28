import { resolveOpenAICompatibility } from "../infrastructure/model/compatibility/resolver.js"
import type { RuntimeConfig } from "../config/runtime.js"
import { resolveMainModelFacts, type MainModelFacts } from "./model-facts.js"

export interface TuiProviderIdentity {
  readonly providerName: string
  readonly endpoint: string
  readonly protocol: "anthropic" | "openai"
  readonly modelName: string
  /** True only when the remote endpoint hostname matches a built-in provider. */
  readonly providerMatched: boolean
  /** True only when the configured model id matches the built-in model catalog. */
  readonly modelMatched: boolean
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  openrouter: "OpenRouter",
  together: "Together",
  zai: "Z.AI",
  openai: "OpenAI",
  moonshot: "Moonshot",
  xai: "xAI",
}

/** Resolve the display identity from the configured endpoint and catalog facts. */
export function resolveTuiProviderIdentity(
  config: RuntimeConfig,
  modelFacts: MainModelFacts = resolveMainModelFacts(config),
): TuiProviderIdentity {
  const { provider } = config
  const endpoint = provider.protocol === "openai" ? (provider.openaiBaseURL ?? provider.baseURL) : provider.baseURL
  const modelName = provider.protocol === "openai" ? (provider.openaiModel ?? provider.model) : provider.model
  const hostname = endpointHostname(endpoint)
  const match = resolveBuiltInProvider(endpoint)

  return {
    providerName: provider.displayName ?? match?.label ?? hostname ?? "unknown",
    endpoint: endpoint ?? "unknown",
    protocol: provider.protocol,
    modelName: modelName ?? "unknown",
    providerMatched: match !== undefined,
    modelMatched: modelFacts.resolved.matched,
  }
}

/** Resolve whether a server-reported model id is present in the same catalog scope. */
export function isTuiModelCatalogMatch(config: RuntimeConfig, modelId: string): boolean {
  return resolveMainModelFacts(config, modelId).resolved.matched
}

function resolveBuiltInProvider(endpoint: string | undefined): { readonly label: string } | undefined {
  if (endpoint === undefined) return undefined
  const hostname = endpointHostname(endpoint)
  if (hostname === undefined || isLocalHostname(hostname)) return undefined
  if (hostname === "api.anthropic.com") return { label: PROVIDER_LABELS.anthropic! }
  try {
    const resolved = resolveOpenAICompatibility(endpoint)
    if (resolved.source !== "endpoint") return undefined
    const label = PROVIDER_LABELS[resolved.descriptor.name]
    return label === undefined ? undefined : { label }
  } catch {
    return undefined
  }
}

function endpointHostname(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined
  try {
    return new URL(endpoint).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function isLocalHostname(hostname: string): boolean {
  const unbracketed = hostname.replace(/^\[|\]$/gu, "")
  if (unbracketed === "localhost" || unbracketed.endsWith(".localhost") || unbracketed === "localhost.localdomain") return true
  if (unbracketed === "::1" || unbracketed === "0.0.0.0") return true
  const octets = unbracketed.split(".").map(Number)
  return octets.length === 4 && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) && octets[0] === 127
}
