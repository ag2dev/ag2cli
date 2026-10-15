import { flatText, type CallModel, type CallModelOptions, type ModelClient } from "@ag2cli/runtime/ports/model/contract.js"
import type { CallModelStream } from "@ag2cli/runtime/ports/model/stream.js"
import type { Guardian } from "@ag2cli/runtime/ports/guardian.js"
import { modelClientToStream } from "../infrastructure/model/stream-adapter.js"
import type { AssistantMessage, Message } from "@ag2cli/core/message.js"
import { isGuardianConfigured, loadRuntimeConfig, type RuntimeConfig } from "../config/runtime.js"
import { createLlmGuardian } from "../capabilities/guardian/llm-guardian.js"

/**
 * Load only the selected provider adapter for the new composition root.
 *
 * Provider SDKs are intentionally dynamic imports here. The profile entrypoint
 * should not statically pull every provider implementation into its bundle.
 */
export async function pickModelClient(config: RuntimeConfig = loadRuntimeConfig()): Promise<ModelClient> {
  if (config.provider.protocol === "openai") {
    const { OpenAIModelClient } = await import("../infrastructure/model/openai-client.js")
    const baseURL = config.provider.openaiBaseURL ?? config.provider.baseURL
    const apiKey = config.provider.openaiApiKey ?? config.provider.apiKey
    const model = config.provider.openaiModel ?? config.provider.model
    if (baseURL && apiKey && model) {
      return new OpenAIModelClient({
        baseURL,
        apiKey,
        model,
        ...(config.provider.contextWindow === undefined ? {} : { contextWindow: config.provider.contextWindow }),
        ...(config.provider.compatibility === undefined ? {} : { compatibility: config.provider.compatibility }),
        thinking: config.provider.thinking,
        reasoningEffort: config.provider.reasoningEffort,
        ...(config.provider.maxTokens === undefined ? {} : { maxTokens: config.provider.maxTokens }),
      })
    }
    throw new Error("OpenAI configuration is missing: set AG2CLI_BASE_URL, AG2CLI_API_KEY, and AG2CLI_MODEL (or AG2CLI_OPENAI_*)")
  }
  const { AnthropicModelClient } = await import("../infrastructure/model/anthropic-client.js")
  if (config.provider.baseURL && config.provider.apiKey && config.provider.model) {
    return new AnthropicModelClient({
      baseURL: config.provider.baseURL,
      apiKey: config.provider.apiKey,
      model: config.provider.model,
      ...(config.provider.contextWindow === undefined ? {} : { contextWindow: config.provider.contextWindow }),
    })
  }
  throw new Error("Anthropic protocol configuration is missing: set AG2CLI_BASE_URL, AG2CLI_API_KEY, and AG2CLI_MODEL")
}

/**
 * The guardian reviewer adapter, or undefined when no guardian is configured.
 * An unresolved credential keeps the guardian unconfigured rather than failing.
 * Composition owns the reviewer's model client; the capability stays pure.
 */
export async function pickGuardian(config: RuntimeConfig = loadRuntimeConfig()): Promise<Guardian | undefined> {
  if (!isGuardianConfigured(config)) return undefined
  const guardian = config.guardian!
  const implementation = guardian.implementation
  const modelClient =
    implementation.protocol === "openai"
      ? await import("../infrastructure/model/openai-client.js").then(
          ({ OpenAIModelClient }) =>
            new OpenAIModelClient({
              baseURL: implementation.baseURL,
              apiKey: guardian.apiKey!,
              model: implementation.model,
              ...(implementation.maxOutputTokens === undefined ? {} : { maxTokens: implementation.maxOutputTokens }),
            }),
        )
      : await import("../infrastructure/model/anthropic-client.js").then(
          ({ AnthropicModelClient }) =>
            new AnthropicModelClient({
              baseURL: implementation.baseURL,
              apiKey: guardian.apiKey!,
              model: implementation.model,
              ...(implementation.maxOutputTokens === undefined ? {} : { maxTokens: implementation.maxOutputTokens }),
            }),
        )
  return createLlmGuardian(
    {
      guardianId: guardian.guardianId ?? `llm:${implementation.model}`,
      ...(implementation.timeoutMs === undefined ? {} : { timeoutMs: implementation.timeoutMs }),
      ...(implementation.maxOutputTokens === undefined ? {} : { maxOutputTokens: implementation.maxOutputTokens }),
    },
    { modelClient },
  )
}

/**
 * The runtime review deadline derived from the same config snapshot as
 * `pickGuardian`: the configured `timeoutMs` bounds the whole auto-mode
 * review race, not only the provider call inside the adapter. Undefined
 * when no guardian is configured — the runtime default then applies.
 */
export function guardianReviewDeadlineMs(config: RuntimeConfig = loadRuntimeConfig()): number | undefined {
  if (!isGuardianConfigured(config)) return undefined
  return config.guardian!.implementation.timeoutMs
}

/** Default callModel: reuse the provider adapter from the composition root. */
export const defaultCallModel: CallModel = async (messages, options) => {
  const client = await pickModelClient()
  return client.call({
    messages,
    model: options?.model,
    tools: options?.tools,
    maxTokens: options?.maxTokens,
    systemPrompt: options?.systemPrompt,
    signal: options?.signal,
    thinking: options?.thinking,
    reasoningEffort: options?.reasoningEffort,
    onRetry: options?.onRetry,
  })
}

/**
 * Run one conversation turn: send the existing messages to the model and return the assistant reply.
 *
 * @param messages The full conversation history.
 * @param deps.callModel The injected model call; defaults to the composition-root provider adapter.
 * @param deps.options Options forwarded to callModel, including tools.
 */
export async function chat(
  messages: Message[],
  deps: { callModel?: CallModel; options?: CallModelOptions } = {},
): Promise<AssistantMessage> {
  const callModel = deps.callModel ?? defaultCallModel
  return callModel(messages, deps.options)
}

/** Convenience helper: one user message → assistant reply. */
export async function askOnce(prompt: string, deps: { callModel?: CallModel } = {}): Promise<string> {
  const { userText } = await import("@ag2cli/core/message.js")
  const reply = await chat([userText(prompt)], deps)
  return flatText(reply.message.content)
}

/** Default implementation: the composition root selects a provider adapter based on AG2CLI_PROTOCOL. */
export const defaultCallModelStream: CallModelStream = async function* (messages) {
  try {
    const client = await pickModelClient()
    yield* modelClientToStream(client)(messages)
  } catch (err) {
    yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
  }
}

/**
 * Convenience collector that joins a streamed conversation's events into complete text.
 */
export async function chatStream(messages: Message[], deps: { callModelStream?: CallModelStream } = {}): Promise<string> {
  const callModelStream = deps.callModelStream ?? defaultCallModelStream
  let full = ""
  for await (const ev of callModelStream(messages)) {
    if (ev.type === "text") full += ev.text
    else if (ev.type === "error") throw ev.error
  }
  return full
}

/**
 * Demo that prints text to the terminal as it arrives: consume the event stream and write each text event to stdout immediately.
 * Use process.stdout.write directly to bypass Bun's line buffering and produce a true streaming effect.
 */
export async function chatStreamPrint(messages: Message[], deps: { callModelStream?: CallModelStream } = {}): Promise<string> {
  const callModelStream = deps.callModelStream ?? defaultCallModelStream
  let full = ""
  for await (const ev of callModelStream(messages)) {
    if (ev.type === "text") {
      full += ev.text
      process.stdout.write(ev.text)
    } else if (ev.type === "error") {
      throw ev.error
    }
  }
  process.stdout.write("\n")
  return full
}
