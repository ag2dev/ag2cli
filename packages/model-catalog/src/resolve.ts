import { CHAT_MODEL_TABLE, PROTOCOL_DEFAULTS, ROUTE_DEFAULTS } from "./tables.js"
import type { ChatModelEntry, ModelOverrides, ProtocolId, ResolvedModelInfo } from "./types.js"

export interface ResolveModelInput {
  readonly protocol: ProtocolId
  readonly provider?: string
  readonly modelId?: string
  readonly overrides?: ModelOverrides
}

// Lookup order within one scope: entries matching the exact id come before
// entries matching an alias. Scoped entries (provider set) come before
// generic ones (provider absent).
function findEntry(protocol: ProtocolId, provider: string | undefined, modelId: string): ChatModelEntry | undefined {
  let scopedAlias: ChatModelEntry | undefined
  let genericId: ChatModelEntry | undefined
  let genericAlias: ChatModelEntry | undefined
  for (const entry of CHAT_MODEL_TABLE) {
    if (entry.protocol !== protocol) continue
    const scoped = entry.provider !== undefined
    if (scoped) {
      if (entry.provider !== provider) continue
    }
    if (entry.id === modelId) {
      if (scoped) return entry
      if (genericId === undefined) genericId = entry
    }
    if (entry.aliases?.includes(modelId)) {
      if (scoped && scopedAlias === undefined) scopedAlias = entry
      if (!scoped && genericAlias === undefined) genericAlias = entry
    }
  }
  if (scopedAlias !== undefined) return scopedAlias
  if (genericId !== undefined) return genericId
  return genericAlias
}

export function getChatModelEntry(protocol: ProtocolId, provider?: string, modelId?: string): ChatModelEntry | undefined {
  if (modelId === undefined) return undefined
  // The anthropic protocol has a single provider surface; normalize whatever
  // the caller passes so scoped entries resolve without caller-side knowledge.
  const normalized = protocol === "anthropic" ? "anthropic" : provider
  return findEntry(protocol, normalized, modelId)
}

export function resolveModel(input: ResolveModelInput): ResolvedModelInfo {
  const { protocol, overrides } = input
  const provider = protocol === "anthropic" ? "anthropic" : input.provider
  const entry = input.modelId === undefined ? undefined : findEntry(protocol, provider, input.modelId)
  // The anthropic protocol never consults route defaults.
  const route = protocol === "anthropic" ? undefined : provider === undefined ? undefined : ROUTE_DEFAULTS[provider]
  const protocolDefaults = PROTOCOL_DEFAULTS[protocol]

  const contextWindow =
    overrides?.contextWindow !== undefined
      ? { value: overrides.contextWindow, source: "override" as const }
      : entry !== undefined
        ? { value: entry.contextWindow, source: "model" as const }
        : route?.contextWindow !== undefined
          ? { value: route.contextWindow, source: "route" as const }
          : { value: protocolDefaults.contextWindow, source: "protocol" as const }

  const maxOutputTokensCeiling =
    entry !== undefined
      ? { value: entry.maxOutputTokens as number, source: "model" as const }
      : route?.maxOutputTokens !== undefined
        ? { value: route.maxOutputTokens, source: "route" as const }
        : protocolDefaults.maxOutputTokens !== undefined
          ? { value: protocolDefaults.maxOutputTokens, source: "protocol" as const }
          : { value: undefined, source: undefined }

  const requested = overrides?.maxOutputTokens ?? protocolDefaults.requestMaxTokens
  const cap = maxOutputTokensCeiling.value
  const defaultMaxOutputTokens = cap === undefined ? requested : Math.min(requested, cap)

  return {
    matched: entry !== undefined,
    modelId: input.modelId ?? "",
    contextWindow,
    maxOutputTokensCeiling,
    defaultMaxOutputTokens,
    entry,
  }
}
