import { z } from "zod"
import type { HeadlessOutputFormat } from "./output-format.js"
import type { ObservabilityMode, TelemetryMode } from "@ag2cli/core/model/observation.js"
import type { Theme } from "./theme.js"

const nonEmptyString = z.string().min(1)
const providerDisplayName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // oxlint-disable-next-line no-control-regex -- display names must stay on one terminal row
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Must be a single line of text")
const positiveInteger = z.number().int().min(1).max(10_000_000)

const providerConfigSchema = z
  .object({
    displayName: providerDisplayName.optional(),
    protocol: z.enum(["anthropic", "openai"]).optional(),
    compatibility: z.enum(["auto", "generic", "openai", "deepseek", "qwen", "openrouter", "together", "zai", "llama.cpp"]).optional(),
    thinking: z.enum(["auto", "on", "off"]).optional(),
    reasoningEffort: z.enum(["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    baseURL: nonEmptyString.optional(),
    model: nonEmptyString.optional(),
    contextWindow: positiveInteger.optional(),
    maxTokens: positiveInteger.optional(),
    openaiBaseURL: nonEmptyString.optional(),
    openaiModel: nonEmptyString.optional(),
  })
  .strict()

const compactConfigSchema = z
  .object({
    autoCompactTokens: positiveInteger.optional(),
    blockingLimitTokens: positiveInteger.optional(),
  })
  .strict()

const uiConfigSchema = z
  .object({
    effort: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict()

const tuiConfigSchema = z
  .object({
    theme: z.enum(["dark", "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi"] as [Theme, ...Theme[]]).optional(),
  })
  .strict()

const pathsConfigSchema = z
  .object({
    eventRoot: nonEmptyString.optional(),
    memoryRoot: nonEmptyString.optional(),
    instructionFileName: nonEmptyString.optional(),
    agentRoot: nonEmptyString.optional(),
    userAgentRoot: nonEmptyString.optional(),
    wikiRoot: nonEmptyString.optional(),
    userMemoryRoot: nonEmptyString.optional(),
    teamMemoryRoot: nonEmptyString.optional(),
    skillRoot: nonEmptyString.optional(),
    userSkillRoot: nonEmptyString.optional(),
    trustStore: nonEmptyString.optional(),
  })
  .strict()

const featuresConfigSchema = z
  .object({
    trustProjectSkills: z.boolean().optional(),
    globHidden: z.boolean().optional(),
    globNoIgnore: z.boolean().optional(),
  })
  .strict()

const serverTlsConfigSchema = z
  .object({
    certFile: nonEmptyString,
    keyFile: nonEmptyString,
  })
  .strict()

const serverConfigSchema = z
  .object({
    host: nonEmptyString.optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    requireAuth: z.boolean().optional(),
    corsOrigins: z.array(nonEmptyString).min(1).max(32).optional(),
    tls: serverTlsConfigSchema.optional(),
  })
  .strict()

const acpConfigSchema = z
  .object({
    mode: z.enum(["plan", "run"]).optional(),
  })
  .strict()

const observabilityConfigSchema = z
  .object({
    mode: z.enum(["disabled", "metadata", "local-full"]).optional(),
    telemetry: z.enum(["disabled", "redacted"]).optional(),
    maxPayloadBytes: z
      .number()
      .int()
      .min(4_096)
      .max(16 * 1024 * 1024)
      .optional(),
    telemetryRoot: nonEmptyString.optional(),
  })
  .strict()

const correlationConfigSchema = z
  .object({
    traceId: nonEmptyString.optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict()

/** Discriminated on `kind`; M4 ships the llm reviewer only. */
const guardianLlmImplementationSchema = z
  .object({
    kind: z.literal("llm"),
    protocol: z.enum(["anthropic", "openai"]),
    baseURL: nonEmptyString,
    model: nonEmptyString,
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
    maxOutputTokens: positiveInteger.optional(),
  })
  .strict()

const guardianConfigSchema = z
  .object({
    guardianId: nonEmptyString.optional(),
    implementation: z.discriminatedUnion("kind", [guardianLlmImplementationSchema]),
  })
  .strict()

const responseLanguageSchema = z
  .string()
  .min(1)
  .max(64)
  // oxlint-disable-next-line no-control-regex -- deliberately rejects ASCII control characters in a single-line value
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Must be a single line of text")

/**
 * User-editable configuration. Provider credentials and server bearer tokens
 * deliberately remain environment-only; they must not be persisted here.
 */
export const configFileSchema = z
  .object({
    provider: providerConfigSchema.optional(),
    guardian: guardianConfigSchema.optional(),
    compact: compactConfigSchema.optional(),
    maxTurns: positiveInteger.optional(),
    responseLanguage: responseLanguageSchema.optional(),
    ui: uiConfigSchema.optional(),
    tui: tuiConfigSchema.optional(),
    paths: pathsConfigSchema.optional(),
    features: featuresConfigSchema.optional(),
    server: serverConfigSchema.optional(),
    acp: acpConfigSchema.optional(),
    sessionId: nonEmptyString.optional(),
    outputFormat: z.enum(["text", "json", "jsonl"]).optional(),
    observability: observabilityConfigSchema.optional(),
    correlation: correlationConfigSchema.optional(),
  })
  .strict()

export type ConfigFile = z.infer<typeof configFileSchema>

export type ConfigProtocol = ConfigFile["provider"] extends infer Provider
  ? Provider extends { protocol?: infer Protocol }
    ? Protocol
    : never
  : never

export type ConfigOutputFormat = HeadlessOutputFormat
export type ConfigTheme = Theme
export type ConfigObservabilityMode = ObservabilityMode
export type ConfigTelemetryMode = TelemetryMode
