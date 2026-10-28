import { descriptorByName, GENERIC_OPENAI_DESCRIPTOR, OPENAI_ENDPOINT_DESCRIPTORS } from "./descriptors.js"
import type {
  OpenAICompatibilityOverride,
  OpenAIEndpointDescriptor,
  ResolvedOpenAICompatibility,
} from "@ag2cli/runtime/ports/model/compatibility.js"

export function resolveOpenAICompatibility(endpoint: string, override?: OpenAICompatibilityOverride): ResolvedOpenAICompatibility {
  const normalizedEndpoint = normalizeEndpoint(endpoint)
  const resolved = resolveFamilyDescriptor(new URL(normalizedEndpoint), override?.name)
  const descriptor = applyOverride(resolved.descriptor, override)
  return {
    endpoint: normalizedEndpoint,
    descriptor,
    source: resolved.source,
  }
}

export function deriveFamily(endpoint: string | undefined, compatibilityOverride?: string): string | undefined {
  if (compatibilityOverride !== undefined) {
    const overrideDescriptor = descriptorByName(compatibilityOverride)
    if (overrideDescriptor !== undefined) return overrideDescriptor.name
  }
  const trimmed = endpoint?.trim()
  if (!trimmed) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  return resolveFamilyDescriptor(url, undefined).family
}

interface FamilyResolution {
  readonly family: string | undefined
  readonly descriptor: OpenAIEndpointDescriptor
  readonly source: "override" | "endpoint" | "generic"
}

function resolveFamilyDescriptor(url: URL, overrideName: string | undefined): FamilyResolution {
  if (overrideName !== undefined) {
    const overrideDescriptor = descriptorByName(overrideName)
    if (overrideDescriptor !== undefined) {
      return { family: overrideDescriptor.name, descriptor: overrideDescriptor, source: "override" }
    }
  }
  const endpointDescriptor = OPENAI_ENDPOINT_DESCRIPTORS.find((descriptor) => matchesEndpoint(url, descriptor))
  if (endpointDescriptor !== undefined) {
    return { family: endpointDescriptor.name, descriptor: endpointDescriptor, source: "endpoint" }
  }
  return { family: undefined, descriptor: GENERIC_OPENAI_DESCRIPTOR, source: "generic" }
}

function applyOverride(descriptor: OpenAIEndpointDescriptor, override?: OpenAICompatibilityOverride): OpenAIEndpointDescriptor {
  if (!override) return descriptor
  return {
    ...descriptor,
    ...(override.maxTokensField === undefined ? {} : { maxTokensField: override.maxTokensField }),
    ...(override.supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort: override.supportsReasoningEffort }),
    ...(override.thinkingRequestFormat === undefined ? {} : { thinkingRequestFormat: override.thinkingRequestFormat }),
    ...(override.reasoningReplay === undefined ? {} : { reasoningReplay: override.reasoningReplay }),
    ...(override.assistantEmptyContent === undefined ? {} : { assistantEmptyContent: override.assistantEmptyContent }),
    ...(override.parseThinkTags === undefined ? {} : { parseThinkTags: override.parseThinkTags }),
    ...(override.visibleReasoningDetailTypes === undefined ? {} : { visibleReasoningDetailTypes: override.visibleReasoningDetailTypes }),
    ...(override.supportsStreamUsage === undefined ? {} : { supportsStreamUsage: override.supportsStreamUsage }),
    ...(override.requiresToolResultName === undefined ? {} : { requiresToolResultName: override.requiresToolResultName }),
  }
}

function normalizeEndpoint(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error("OpenAI endpoint must not be empty")
  try {
    return new URL(trimmed).toString()
  } catch {
    throw new Error(`Invalid OpenAI endpoint: ${value}`)
  }
}

function matchesEndpoint(url: URL, descriptor: OpenAIEndpointDescriptor): boolean {
  return descriptor.matchers.some((matcher) => {
    if (matcher.kind === "hostname") return url.hostname === matcher.value
    if (matcher.kind === "hostname-suffix") return url.hostname.endsWith(matcher.value)
    return url.pathname === matcher.value || url.pathname.startsWith(`${matcher.value}/`)
  })
}
