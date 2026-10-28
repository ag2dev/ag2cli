/** LLM connection settings (model, key, and protocol dialect). */

import { loadRuntimeConfig } from "./runtime.js"

/** LLM connection settings. */
export interface LlmConfig {
  baseURL: string
  apiKey: string
  model: string
  contextWindow?: number
  maxTokens?: number
}

/**
 * Read configuration from the environment.
 *
 * Read only AG2CLI_* variables so vendor-specific host settings cannot unexpectedly alter this application.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): LlmConfig {
  const provider = loadRuntimeConfig(env).provider
  const baseURL = provider.baseURL
  const apiKey = provider.apiKey
  const model = provider.model
  if (!baseURL || !apiKey || !model) {
    throw new Error("Missing LLM configuration: set AG2CLI_BASE_URL / AG2CLI_API_KEY / AG2CLI_MODEL")
  }
  // The SDK appends /v1/messages to baseURL, so baseURL must not include /v1.
  // Accept the raw URL from a curl example (.../v1) too by stripping a trailing /v1 automatically.
  const normalizedBaseURL = baseURL.replace(/\/v1\/?$/, "")
  return {
    baseURL: normalizedBaseURL,
    apiKey,
    model,
    ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
    ...(provider.maxTokens === undefined ? {} : { maxTokens: provider.maxTokens }),
  }
}
