import { join } from "node:path"
import type { HeadlessOutputFormat } from "./output-format.js"
import type { ObservabilityMode, TelemetryMode } from "@ag2cli/core/model/observation.js"
import { parseMaxPayloadBytes, parseObservabilityMode, parseTelemetryMode } from "@ag2cli/runtime/ports/observability.js"
import type { CompactThresholds } from "@ag2cli/core/model/limits.js"
import { validateProjectInstructionFileName } from "./instruction-file.js"
import {
  defaultConfigPath,
  readConfigFile,
  resolveApplicationHome,
  resolveConfigPath,
  validateHeadlessConfig,
  type TuiThemePreference,
} from "./config-file.js"
import { mergeConfigSources } from "./config-merge.js"
import type { OpenAICompatibilityName, OpenAIReasoningEffort, OpenAIThinkingMode } from "@ag2cli/runtime/ports/model/compatibility.js"

const DEFAULT_SERVER_CORS_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"] as const

/**
 * Default project-local event root. The serve host compares the configured
 * eventRoot against this exact value to detect "user did not override", so
 * the default and that sentinel must come from one constant.
 */
export const DEFAULT_EVENT_ROOT = ".ag2cli/events"

/** Guardian implementation union; M4 ships the llm reviewer only. */
export interface GuardianLlmImplementation {
  readonly kind: "llm"
  readonly protocol: "anthropic" | "openai"
  readonly baseURL: string
  readonly model: string
  readonly timeoutMs?: number
  readonly maxOutputTokens?: number
}

export interface RuntimeConfig {
  /** Application-scoped home; unlike HOME, this does not affect child processes or workspaces. */
  readonly applicationHome?: string
  readonly provider: {
    /** Optional user-facing label for the configured endpoint. */
    readonly displayName?: string
    readonly protocol: "anthropic" | "openai"
    readonly compatibility?: OpenAICompatibilityName
    readonly thinking: OpenAIThinkingMode
    readonly reasoningEffort: OpenAIReasoningEffort
    readonly baseURL?: string
    readonly apiKey?: string
    readonly model?: string
    /** Provider/model context window in tokens; compatible endpoints cannot expose this reliably. */
    readonly contextWindow?: number
    readonly maxTokens?: number
    readonly openaiBaseURL?: string
    readonly openaiApiKey?: string
    readonly openaiModel?: string
  }
  /** Guardian reviewer; absent means no guardian is configured. */
  readonly guardian?: {
    readonly guardianId?: string
    readonly implementation: GuardianLlmImplementation
    /** Credential is environment-only; absent keeps the guardian unconfigured. */
    readonly apiKey?: string
  }
  /** Explicit compaction thresholds only; missing fields complete in composition from resolved model facts. */
  readonly compact?: Partial<CompactThresholds>
  /** Optional per-run agentic turn cap; absent means unlimited. */
  readonly maxTurns?: number
  /** Preferred language for model-generated explanations and direct replies. */
  readonly responseLanguage?: string
  readonly ui: {
    readonly effort: "low" | "medium" | "high"
  }
  readonly paths: {
    readonly eventRoot: string
    readonly eventRootExplicit?: boolean
    readonly memoryRoot: string
    /** One hierarchical project instruction basename; defaults to AGENTS.md. */
    readonly instructionFileName: string
    readonly agentRoot: string
    readonly userAgentRoot?: string
    readonly wikiRoot: string
    readonly userMemoryRoot?: string
    readonly teamMemoryRoot?: string
    readonly skillRoot?: string
    readonly userSkillRoot?: string
    readonly trustStore: string
  }
  readonly features: {
    readonly trustProjectSkills: boolean
    readonly globHidden: boolean
    readonly globNoIgnore: boolean
  }
  readonly server: {
    /** Serve bearer token; environment-only (AG2CLI_SERVER_TOKEN) and never read from JSONC. */
    readonly token?: string
    readonly host: string
    readonly port: number
    readonly requireAuth: boolean
    readonly corsOrigins: readonly string[]
    readonly tls?: ServerTlsConfig
  }
  readonly acp: {
    readonly mode: "plan" | "run"
  }
  /** Resumes one specific session in headless entrypoints when set. */
  readonly sessionId?: string
  /** Output serialization for headless (non-TUI) agent runs. */
  readonly outputFormat: HeadlessOutputFormat
  readonly observability: {
    readonly mode: ObservabilityMode
    readonly telemetry: TelemetryMode
    readonly includePayload: boolean
    readonly exportTelemetry: boolean
    readonly maxPayloadBytes: number
    readonly telemetryRoot?: string
  }
  readonly correlation: {
    readonly traceId?: string
    readonly operationId?: string
  }
}

export interface ServerTlsConfig {
  readonly certFile: string
  readonly keyFile: string
  /** TLS private-key passphrases are environment-only and never read from JSONC. */
  readonly passphrase?: string
}

export type RuntimeConfigOverrides = {
  readonly provider?: Omit<Partial<RuntimeConfig["provider"]>, "compatibility"> & {
    readonly compatibility?: OpenAICompatibilityName | "auto"
  }
  readonly guardian?: Partial<Omit<NonNullable<RuntimeConfig["guardian"]>, "implementation">> & {
    readonly implementation?: NonNullable<RuntimeConfig["guardian"]>["implementation"]
  }
  readonly compact?: Partial<CompactThresholds>
  readonly maxTurns?: number
  readonly responseLanguage?: string
  readonly ui?: Partial<RuntimeConfig["ui"]>
  readonly paths?: Partial<RuntimeConfig["paths"]>
  readonly features?: Partial<RuntimeConfig["features"]>
  readonly server?: Partial<Omit<RuntimeConfig["server"], "tls">> & {
    readonly tls?: Partial<ServerTlsConfig>
  }
  readonly acp?: Partial<RuntimeConfig["acp"]>
  readonly sessionId?: string
  readonly outputFormat?: HeadlessOutputFormat
  readonly observability?: Partial<RuntimeConfig["observability"]>
  readonly correlation?: Partial<RuntimeConfig["correlation"]>
}

export type RuntimeConfigMode = "interactive" | "headless"

export interface RuntimeConfigLoadOptions {
  /** Interactive entrypoints opt into the default user config file. */
  readonly mode?: RuntimeConfigMode
  /** Explicit config path. Relative paths are resolved from cwd. */
  readonly configPath?: string
  readonly cwd?: string
  /** Highest-precedence values supplied by the caller's CLI parser. */
  readonly cliOverrides?: RuntimeConfigOverrides
}

type MutablePartial<T> = { -readonly [Key in keyof T]?: T[Key] }

export function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: RuntimeConfigLoadOptions = {},
): RuntimeConfig {
  if (env.AG2CLI_SERVER_URL !== undefined) {
    throw new Error("AG2CLI_SERVER_URL has been removed; the regular TUI does not connect to agent serve")
  }
  if (env.AG2CLI_PERMISSION_PROFILE !== undefined) {
    throw new Error(
      "AG2CLI_PERMISSION_PROFILE has been removed; permissions are determined by the Session permission mode (--permission-mode)",
    )
  }
  if (env.AG2CLI_ENABLE_WEB_FETCH !== undefined) {
    throw new Error("AG2CLI_ENABLE_WEB_FETCH is not a switch: web_fetch is always registered and governed by session permission approval")
  }
  if (
    env.AG2CLI_MCP_CONFIG !== undefined ||
    env.AG2CLI_MCP_APPROVED_LIST !== undefined ||
    env.AG2CLI_ENABLE_MCP !== undefined ||
    env.AG2CLI_TRUST_PROJECT_MCP !== undefined
  ) {
    throw new Error(
      "AG2CLI_MCP_CONFIG, AG2CLI_MCP_APPROVED_LIST, AG2CLI_ENABLE_MCP, and AG2CLI_TRUST_PROJECT_MCP have been removed; the MCP tool stack has been deleted",
    )
  }
  if (env.AG2CLI_LSP_CONFIG !== undefined) {
    throw new Error("AG2CLI_LSP_CONFIG has been removed; the LSP tool stack has been deleted")
  }
  if (env.AG2CLI_HOOKS_CONFIG !== undefined || env.AG2CLI_TRUST_PROJECT_HOOKS !== undefined) {
    throw new Error("AG2CLI_HOOKS_CONFIG and AG2CLI_TRUST_PROJECT_HOOKS have been removed; the hooks stack has been deleted")
  }
  const applicationHome = resolveApplicationHome(env, options.cwd ?? process.cwd())
  const explicitConfigPath =
    options.configPath === undefined ? undefined : resolveConfigPath(options.configPath, options.cwd ?? process.cwd())
  const selectedConfigPath = explicitConfigPath ?? (options.mode === "interactive" ? defaultConfigPath(applicationHome) : undefined)
  const fileConfig = selectedConfigPath ? readConfigFile(selectedConfigPath, explicitConfigPath !== undefined) : {}
  if (options.mode === "headless" && explicitConfigPath !== undefined) {
    validateHeadlessConfig(fileConfig, selectedConfigPath!)
  }
  const envConfig = readEnvironmentOverrides(env)
  const merged = mergeConfigSources<RuntimeConfigOverrides>(fileConfig, envConfig, options.cliOverrides)
  const protocol = readProtocol(merged.provider?.protocol)
  const providerDisplayName = readProviderDisplayName(merged.provider?.displayName)
  const contextWindow = readContextWindowOverride(merged.provider?.contextWindow)
  const compact = readExplicitCompactThresholds(merged.compact)
  const maxTurns = readConfiguredMaxTurns(merged.maxTurns)
  const responseLanguage = readResponseLanguage(merged.responseLanguage)
  const guardian = readGuardian(merged.guardian)
  const homeDefault = (value: string | undefined, fallback: string): string => value ?? fallback
  const paths = merged.paths ?? {}
  const features = merged.features ?? {}
  const server = merged.server ?? {}
  const acp = merged.acp ?? {}
  const tls = normalizeServerTls(server.tls)
  const observability = merged.observability ?? {}
  const correlation = merged.correlation ?? {}

  return {
    ...(applicationHome === undefined ? {} : { applicationHome }),
    provider: {
      ...(providerDisplayName === undefined ? {} : { displayName: providerDisplayName }),
      protocol,
      compatibility: readCompatibility(merged.provider?.compatibility),
      thinking: readThinking(merged.provider?.thinking),
      reasoningEffort: readReasoningEffort(merged.provider?.reasoningEffort),
      ...(merged.provider?.baseURL ? { baseURL: merged.provider.baseURL } : {}),
      ...(merged.provider?.apiKey ? { apiKey: merged.provider.apiKey } : {}),
      ...(merged.provider?.model ? { model: merged.provider.model } : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(merged.provider?.maxTokens === undefined ? {} : { maxTokens: merged.provider.maxTokens }),
      ...(merged.provider?.openaiBaseURL ? { openaiBaseURL: merged.provider.openaiBaseURL } : {}),
      ...(merged.provider?.openaiApiKey ? { openaiApiKey: merged.provider.openaiApiKey } : {}),
      ...(merged.provider?.openaiModel ? { openaiModel: merged.provider.openaiModel } : {}),
    },
    ...(guardian === undefined ? {} : { guardian }),
    ...(compact === undefined ? {} : { compact }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(responseLanguage === undefined ? {} : { responseLanguage }),
    ui: {
      effort: readEffort(merged.ui?.effort),
    },
    paths: {
      eventRoot: homeDefault(paths.eventRoot, DEFAULT_EVENT_ROOT),
      ...(paths.eventRoot === undefined && env.AG2CLI_EVENT_ROOT === undefined ? {} : { eventRootExplicit: true }),
      memoryRoot: homeDefault(paths.memoryRoot, ".ag2cli/memory"),
      instructionFileName: validateProjectInstructionFileName(paths.instructionFileName),
      agentRoot: homeDefault(paths.agentRoot, ".ag2cli/agents"),
      ...(paths.userAgentRoot
        ? { userAgentRoot: paths.userAgentRoot }
        : applicationHome
          ? { userAgentRoot: join(applicationHome, "agents") }
          : {}),
      wikiRoot: homeDefault(paths.wikiRoot, ".ag2cli/wiki"),
      ...(paths.userMemoryRoot
        ? { userMemoryRoot: paths.userMemoryRoot }
        : applicationHome
          ? { userMemoryRoot: join(applicationHome, "memory") }
          : {}),
      ...(paths.teamMemoryRoot ? { teamMemoryRoot: paths.teamMemoryRoot } : {}),
      ...(paths.skillRoot ? { skillRoot: paths.skillRoot } : {}),
      ...(paths.userSkillRoot
        ? { userSkillRoot: paths.userSkillRoot }
        : applicationHome
          ? { userSkillRoot: join(applicationHome, "skills") }
          : {}),
      trustStore: homeDefault(
        paths.trustStore,
        applicationHome ? join(applicationHome, "trusted-workspaces.json") : ".ag2cli/trusted-workspaces.json",
      ),
    },
    features: {
      trustProjectSkills: features.trustProjectSkills ?? false,
      globHidden: features.globHidden ?? false,
      globNoIgnore: features.globNoIgnore ?? false,
    },
    server: {
      host: server.host ?? "127.0.0.1",
      port: server.port ?? 8787,
      requireAuth: server.requireAuth ?? false,
      corsOrigins: readCorsOrigins(server.corsOrigins),
      ...(tls === undefined ? {} : { tls }),
      ...(server.token ? { token: server.token.trim() } : {}),
    },
    acp: {
      mode: acp.mode ?? "plan",
    },
    ...(merged.sessionId ? { sessionId: merged.sessionId } : {}),
    outputFormat: merged.outputFormat ?? "json",
    observability: {
      mode: observability.mode ?? "metadata",
      telemetry: observability.telemetry ?? "disabled",
      includePayload: (observability.mode ?? "metadata") === "local-full",
      exportTelemetry: (observability.telemetry ?? "disabled") === "redacted",
      maxPayloadBytes: observability.maxPayloadBytes ?? parseMaxPayloadBytes(undefined),
      ...(observability.telemetryRoot ? { telemetryRoot: observability.telemetryRoot } : {}),
    },
    correlation: {
      ...(correlation.traceId ? { traceId: correlation.traceId } : {}),
      ...(correlation.operationId ? { operationId: correlation.operationId } : {}),
    },
  }
}

/**
 * A guardian is configured only when its llm implementation resolves fully,
 * credential included; an unresolved credential keeps auto unselectable
 * instead of failing the load.
 */
export function isGuardianConfigured(config: RuntimeConfig): boolean {
  const guardian = config.guardian
  if (guardian === undefined) return false
  const { protocol, baseURL, model } = guardian.implementation
  return (
    (protocol === "anthropic" || protocol === "openai") &&
    baseURL.length > 0 &&
    model.length > 0 &&
    guardian.apiKey !== undefined &&
    guardian.apiKey.length > 0
  )
}

/** The guardian exists only with its implementation block; the credential never loads from JSONC. */
function readGuardian(value: RuntimeConfigOverrides["guardian"]): RuntimeConfig["guardian"] | undefined {
  if (value?.implementation === undefined) return undefined
  return {
    ...(value.guardianId === undefined ? {} : { guardianId: value.guardianId }),
    implementation: value.implementation,
    ...(value.apiKey === undefined || value.apiKey.length === 0 ? {} : { apiKey: value.apiKey }),
  }
}

/**
 * Load the interactive client's theme preference without projecting it into
 * RuntimeConfig. A missing default file/field is deliberately distinguishable
 * from an explicit persisted `dark` value so TUI first-run selection remains
 * deterministic.
 */
export function loadTuiThemePreference(
  selectedConfigPath: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
): TuiThemePreference {
  const applicationHome = resolveApplicationHome(env, cwd)
  const explicitPath = selectedConfigPath === undefined ? undefined : resolveConfigPath(selectedConfigPath, cwd)
  const configPath = explicitPath ?? defaultConfigPath(applicationHome)
  if (configPath === undefined) return { theme: "dark", source: "default", configPath: undefined }
  const config = readConfigFile(configPath, explicitPath !== undefined)
  const theme = config.tui?.theme
  return { theme: theme ?? "dark", source: theme === undefined ? "default" : "file", configPath }
}

function readEnvironmentOverrides(env: Readonly<Record<string, string | undefined>>): RuntimeConfigOverrides {
  const provider: {
    displayName?: string
    protocol?: "anthropic" | "openai"
    compatibility?: OpenAICompatibilityName
    thinking?: OpenAIThinkingMode
    reasoningEffort?: OpenAIReasoningEffort
    baseURL?: string
    apiKey?: string
    model?: string
    contextWindow?: number
    maxTokens?: number
    openaiBaseURL?: string
    openaiApiKey?: string
    openaiModel?: string
  } = {}
  if (env.AG2CLI_PROVIDER_DISPLAY_NAME !== undefined) provider.displayName = env.AG2CLI_PROVIDER_DISPLAY_NAME
  if (env.AG2CLI_PROTOCOL !== undefined) provider.protocol = readProtocol(env.AG2CLI_PROTOCOL)
  if (env.AG2CLI_COMPATIBILITY !== undefined) provider.compatibility = readCompatibility(env.AG2CLI_COMPATIBILITY)
  if (env.AG2CLI_THINKING !== undefined) provider.thinking = readThinking(env.AG2CLI_THINKING)
  if (env.AG2CLI_REASONING_EFFORT !== undefined) provider.reasoningEffort = readReasoningEffort(env.AG2CLI_REASONING_EFFORT)
  if (env.AG2CLI_BASE_URL) provider.baseURL = env.AG2CLI_BASE_URL
  if (env.AG2CLI_API_KEY) provider.apiKey = env.AG2CLI_API_KEY
  if (env.AG2CLI_MODEL) provider.model = env.AG2CLI_MODEL
  if (env.AG2CLI_CONTEXT_WINDOW !== undefined && env.AG2CLI_CONTEXT_WINDOW.trim().length > 0) {
    provider.contextWindow = readContextWindowValue(env.AG2CLI_CONTEXT_WINDOW)
  }
  if (env.AG2CLI_MAX_TOKENS !== undefined && env.AG2CLI_MAX_TOKENS.trim().length > 0) {
    provider.maxTokens = readPositiveInteger(env.AG2CLI_MAX_TOKENS, 1, "AG2CLI_MAX_TOKENS")
  }
  if (env.AG2CLI_OPENAI_BASE_URL) provider.openaiBaseURL = env.AG2CLI_OPENAI_BASE_URL
  if (env.AG2CLI_OPENAI_API_KEY) provider.openaiApiKey = env.AG2CLI_OPENAI_API_KEY
  if (env.AG2CLI_OPENAI_MODEL) provider.openaiModel = env.AG2CLI_OPENAI_MODEL

  const guardian: { apiKey?: string } = {}
  if (env.AG2CLI_GUARDIAN_API_KEY) guardian.apiKey = env.AG2CLI_GUARDIAN_API_KEY

  const compact: { autoCompactTokens?: number; blockingLimitTokens?: number } = {}
  if (env.AG2CLI_AUTO_COMPACT_TOKENS !== undefined && env.AG2CLI_AUTO_COMPACT_TOKENS.trim().length > 0) {
    compact.autoCompactTokens = readPositiveInteger(env.AG2CLI_AUTO_COMPACT_TOKENS, 1, "AG2CLI_AUTO_COMPACT_TOKENS")
  }
  if (env.AG2CLI_BLOCKING_LIMIT_TOKENS !== undefined && env.AG2CLI_BLOCKING_LIMIT_TOKENS.trim().length > 0) {
    compact.blockingLimitTokens = readPositiveInteger(env.AG2CLI_BLOCKING_LIMIT_TOKENS, 1, "AG2CLI_BLOCKING_LIMIT_TOKENS")
  }

  const maxTurns =
    env.AG2CLI_MAX_TURNS === undefined || env.AG2CLI_MAX_TURNS.trim().length === 0
      ? undefined
      : readPositiveInteger(env.AG2CLI_MAX_TURNS, 1, "AG2CLI_MAX_TURNS")

  const ui: { effort?: "low" | "medium" | "high" } = {}
  if (env.AG2CLI_EFFORT !== undefined) ui.effort = readEffort(env.AG2CLI_EFFORT)

  const paths: MutablePartial<RuntimeConfig["paths"]> = {}
  if (env.AG2CLI_EVENT_ROOT !== undefined) paths.eventRoot = env.AG2CLI_EVENT_ROOT
  if (env.AG2CLI_MEMORY_ROOT !== undefined) paths.memoryRoot = env.AG2CLI_MEMORY_ROOT
  if (env.AG2CLI_INSTRUCTIONS_FILE !== undefined) {
    paths.instructionFileName = validateProjectInstructionFileName(env.AG2CLI_INSTRUCTIONS_FILE)
  }
  if (env.AG2CLI_AGENT_ROOT !== undefined) paths.agentRoot = env.AG2CLI_AGENT_ROOT
  if (env.AG2CLI_USER_AGENT_ROOT) paths.userAgentRoot = env.AG2CLI_USER_AGENT_ROOT
  if (env.AG2CLI_WIKI_ROOT !== undefined) paths.wikiRoot = env.AG2CLI_WIKI_ROOT
  if (env.AG2CLI_USER_MEMORY_ROOT) paths.userMemoryRoot = env.AG2CLI_USER_MEMORY_ROOT
  if (env.AG2CLI_TEAM_MEMORY_ROOT) paths.teamMemoryRoot = env.AG2CLI_TEAM_MEMORY_ROOT
  if (env.AG2CLI_SKILL_ROOT) paths.skillRoot = env.AG2CLI_SKILL_ROOT
  if (env.AG2CLI_USER_SKILL_ROOT) paths.userSkillRoot = env.AG2CLI_USER_SKILL_ROOT
  if (env.AG2CLI_TRUST_STORE !== undefined) paths.trustStore = env.AG2CLI_TRUST_STORE

  const features: MutablePartial<RuntimeConfig["features"]> = {}
  if (env.AG2CLI_TRUST_PROJECT_SKILLS !== undefined) features.trustProjectSkills = env.AG2CLI_TRUST_PROJECT_SKILLS === "1"
  if (env.AG2CLI_GLOB_HIDDEN !== undefined) features.globHidden = env.AG2CLI_GLOB_HIDDEN === "1"
  if (env.AG2CLI_GLOB_NO_IGNORE !== undefined) features.globNoIgnore = env.AG2CLI_GLOB_NO_IGNORE === "1"

  const server: {
    token?: string
    host?: string
    port?: number
    requireAuth?: boolean
    corsOrigins?: readonly string[]
    tls?: Partial<ServerTlsConfig>
  } = {}
  if (env.AG2CLI_SERVER_TOKEN) server.token = env.AG2CLI_SERVER_TOKEN.trim()
  if (env.AG2CLI_SERVER_HOST !== undefined) server.host = env.AG2CLI_SERVER_HOST
  if (env.AG2CLI_SERVER_PORT !== undefined) server.port = readPort(env.AG2CLI_SERVER_PORT)
  if (env.AG2CLI_SERVER_REQUIRE_AUTH !== undefined) server.requireAuth = env.AG2CLI_SERVER_REQUIRE_AUTH === "1"
  if (env.AG2CLI_SERVER_CORS_ORIGINS !== undefined) server.corsOrigins = env.AG2CLI_SERVER_CORS_ORIGINS.split(",")
  const tls: MutablePartial<ServerTlsConfig> = {}
  if (env.AG2CLI_SERVER_TLS_CERT_FILE !== undefined) tls.certFile = env.AG2CLI_SERVER_TLS_CERT_FILE
  if (env.AG2CLI_SERVER_TLS_KEY_FILE !== undefined) tls.keyFile = env.AG2CLI_SERVER_TLS_KEY_FILE
  if (env.AG2CLI_SERVER_TLS_PASSPHRASE !== undefined) tls.passphrase = env.AG2CLI_SERVER_TLS_PASSPHRASE
  if (Object.keys(tls).length > 0) server.tls = tls

  const acp: { mode?: "plan" | "run" } = {}
  if (env.AG2CLI_ACP_MODE !== undefined) acp.mode = env.AG2CLI_ACP_MODE === "run" ? "run" : "plan"

  const sessionId = env.AG2CLI_SESSION_ID || undefined
  const outputFormat = env.AG2CLI_OUTPUT_FORMAT === undefined ? undefined : readOutputFormat(env.AG2CLI_OUTPUT_FORMAT)

  const observability: MutablePartial<RuntimeConfig["observability"]> = {}
  if (env.AG2CLI_OBSERVABILITY !== undefined) observability.mode = parseObservabilityMode(env.AG2CLI_OBSERVABILITY)
  if (env.AG2CLI_TELEMETRY !== undefined) observability.telemetry = parseTelemetryMode(env.AG2CLI_TELEMETRY)
  if (env.AG2CLI_OBSERVABILITY_MAX_BYTES !== undefined) {
    observability.maxPayloadBytes = parseMaxPayloadBytes(env.AG2CLI_OBSERVABILITY_MAX_BYTES)
  }
  if (env.AG2CLI_TELEMETRY_ROOT) observability.telemetryRoot = env.AG2CLI_TELEMETRY_ROOT

  const correlation: MutablePartial<RuntimeConfig["correlation"]> = {}
  if (env.AG2CLI_TRACE_ID) correlation.traceId = env.AG2CLI_TRACE_ID
  if (env.AG2CLI_OPERATION_ID) correlation.operationId = env.AG2CLI_OPERATION_ID

  const responseLanguage = env.AG2CLI_RESPONSE_LANGUAGE === undefined ? undefined : readResponseLanguage(env.AG2CLI_RESPONSE_LANGUAGE)

  return {
    provider,
    ...(Object.keys(guardian).length === 0 ? {} : { guardian }),
    ...(Object.keys(compact).length === 0 ? {} : { compact }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(responseLanguage === undefined ? {} : { responseLanguage }),
    ui,
    paths,
    features,
    server,
    acp,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(outputFormat === undefined ? {} : { outputFormat }),
    observability,
    correlation,
  }
}

function normalizeServerTls(value: Partial<ServerTlsConfig> | undefined): ServerTlsConfig | undefined {
  if (value === undefined) return undefined
  const certFile = value.certFile?.trim()
  const keyFile = value.keyFile?.trim()
  const passphrase = value.passphrase
  if (certFile === undefined && keyFile === undefined && passphrase === undefined) return undefined
  if (certFile === undefined || keyFile === undefined) {
    throw new Error(
      "server.tls requires both certFile and keyFile; the private-key passphrase must be set through AG2CLI_SERVER_TLS_PASSPHRASE",
    )
  }
  return {
    certFile,
    keyFile,
    ...(passphrase === undefined ? {} : { passphrase }),
  }
}

function readCorsOrigins(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return DEFAULT_SERVER_CORS_ORIGINS
  const origins = value.map((candidate, index) => {
    const trimmed = candidate.trim()
    if (trimmed.length === 0) throw new Error(`server.corsOrigins[${index}] must not be empty`)
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      throw new Error(`server.corsOrigins[${index}] must be a valid HTTP(S) origin`)
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error(`server.corsOrigins[${index}] must be an HTTP(S) origin without a path, query, or credentials`)
    }
    return url.origin
  })
  return [...new Set(origins)]
}

function readProtocol(value: string | undefined): "anthropic" | "openai" {
  if (value === undefined || value === "anthropic") return "anthropic"
  if (value === "openai") return "openai"
  throw new Error(`Unsupported AG2CLI_PROTOCOL: ${value}`)
}

function readProviderDisplayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const displayName = value.trim()
  if (displayName.length === 0) return undefined
  // oxlint-disable-next-line no-control-regex -- terminal labels must remain on one line
  if (displayName.length > 64 || /[\u0000-\u001f\u007f]/u.test(displayName)) {
    throw new Error("AG2CLI_PROVIDER_DISPLAY_NAME must be 1-64 single-line characters")
  }
  return displayName
}

function readCompatibility(value: string | undefined): OpenAICompatibilityName | undefined {
  if (value === undefined || value === "auto") return undefined
  const names: readonly OpenAICompatibilityName[] = [
    "generic",
    "openai",
    "deepseek",
    "qwen",
    "openrouter",
    "together",
    "zai",
    "llama.cpp",
    "moonshot",
    "xai",
  ]
  if (!names.includes(value as OpenAICompatibilityName)) throw new Error(`Unsupported OpenAI compatibility: ${value}`)
  return value as OpenAICompatibilityName
}

function readThinking(value: string | undefined): OpenAIThinkingMode {
  if (value === undefined || value === "auto") return "auto"
  if (value === "on" || value === "off") return value
  throw new Error(`Unsupported thinking mode: ${value}`)
}

function readReasoningEffort(value: string | undefined): OpenAIReasoningEffort {
  if (value === undefined || value === "auto") return "auto"
  const efforts: readonly OpenAIReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
  if (!efforts.includes(value as OpenAIReasoningEffort)) throw new Error(`Unsupported reasoning effort: ${value}`)
  return value as OpenAIReasoningEffort
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return 8787
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid AG2CLI_SERVER_PORT: ${value}`)
  return port
}

function readContextWindowValue(value: string): number {
  const contextWindow = Number(value)
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || contextWindow > 10_000_000) {
    throw new Error(`Invalid AG2CLI_CONTEXT_WINDOW: ${value}`)
  }
  return contextWindow
}

function readContextWindowOverride(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
    throw new Error(`Invalid contextWindow: ${value}`)
  }
  return value
}

function readExplicitCompactThresholds(configured: Partial<CompactThresholds> | undefined): Partial<CompactThresholds> | undefined {
  if (configured?.autoCompactTokens !== undefined && configured.blockingLimitTokens !== undefined) {
    if (configured.blockingLimitTokens <= configured.autoCompactTokens) {
      throw new Error("AG2CLI_BLOCKING_LIMIT_TOKENS must be greater than AG2CLI_AUTO_COMPACT_TOKENS")
    }
  }
  if (configured === undefined || (configured.autoCompactTokens === undefined && configured.blockingLimitTokens === undefined)) {
    return undefined
  }
  return { ...configured }
}

function readConfiguredMaxTurns(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
    throw new Error(`Invalid maxTurns: ${value}`)
  }
  return value
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim().length === 0) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000_000) {
    throw new Error(`Invalid ${name}: ${value}`)
  }
  return parsed
}

function readOutputFormat(value: string | undefined): HeadlessOutputFormat {
  if (value === undefined || value === "json") return "json"
  if (value === "text" || value === "jsonl") return value
  throw new Error(`Unsupported AG2CLI_OUTPUT_FORMAT: ${value}`)
}

function readEffort(value: string | undefined): "low" | "medium" | "high" {
  if (value === undefined || value.trim() === "" || value === "medium") return "medium"
  if (value === "low" || value === "high") return value
  throw new Error(`Unsupported AG2CLI_EFFORT: ${value}`)
}

function readResponseLanguage(configured: string | undefined): string | undefined {
  if (configured !== undefined && configured.trim().length > 0) {
    const language = configured.trim()
    // oxlint-disable-next-line no-control-regex -- deliberately rejects ASCII control characters in a single-line value
    if (language.length > 64 || /[\u0000-\u001f\u007f]/u.test(language)) {
      throw new Error("Invalid AG2CLI_RESPONSE_LANGUAGE: it must be a single line of at most 64 characters")
    }
    return language
  }
  return undefined
}
