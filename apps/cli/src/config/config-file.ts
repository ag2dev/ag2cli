import { readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type FormattingOptions, type ParseError } from "jsonc-parser"
import { ZodError } from "zod"
import { configFileSchema, type ConfigFile } from "./config-schema.js"
import { SUPPORTED_THEMES, type Theme } from "./theme.js"

export const DEFAULT_APPLICATION_HOME = ".ag2cli"
export const DEFAULT_CONFIG_FILE = "config.jsonc"

export type TuiThemeSource = "default" | "file"

export interface TuiThemePreference {
  readonly theme: Theme
  readonly source: TuiThemeSource
  readonly configPath: string | undefined
}

export type ThemeCommitResult =
  | { readonly kind: "confirmed" }
  | { readonly kind: "failed-before-replace"; readonly error: unknown }
  | { readonly kind: "uncertain-after-replace"; readonly error: unknown }

export interface TuiThemePreferenceStore {
  commit(path: string, themeId: string): Promise<ThemeCommitResult>
}

export class RuntimeConfigFileError extends Error {
  readonly path: string
  override readonly cause?: unknown

  constructor(message: string, path: string, cause?: unknown) {
    super(message)
    this.name = "RuntimeConfigFileError"
    this.path = path
    this.cause = cause
  }
}

export function resolveApplicationHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
): string | undefined {
  if (env.AG2CLI_HOME !== undefined) {
    if (env.AG2CLI_HOME.trim().length === 0) throw new Error("AG2CLI_HOME requires a non-empty path")
    return resolve(cwd, env.AG2CLI_HOME)
  }
  return env.HOME ? join(env.HOME, DEFAULT_APPLICATION_HOME) : undefined
}

export function defaultConfigPath(applicationHome: string | undefined): string | undefined {
  return applicationHome ? join(applicationHome, DEFAULT_CONFIG_FILE) : undefined
}

export function resolveConfigPath(path: string, cwd = process.cwd()): string {
  if (path.trim().length === 0) throw new Error("--config requires a non-empty path")
  return isAbsolute(path) ? path : resolve(cwd, path)
}

export function parseConfigPathArgs(argv: readonly string[], command: string): string | undefined {
  let configPath: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--config") {
      if (configPath !== undefined) throw new Error("--config may only be specified once")
      configPath = requireConfigPathValue(argv[++index])
      continue
    }
    if (arg.startsWith("--config=")) {
      if (configPath !== undefined) throw new Error("--config may only be specified once")
      configPath = requireConfigPathValue(arg.slice("--config=".length))
      continue
    }
    throw new Error(`${command} does not support option: ${arg}`)
  }
  return configPath
}

export function validateHeadlessConfig(config: ConfigFile, path: string): void {
  const forbiddenPaths = ["instructionFileName", "userMemoryRoot", "teamMemoryRoot", "skillRoot", "userSkillRoot"] as const
  const configuredPaths = config.paths
  for (const key of forbiddenPaths) {
    if (configuredPaths && Object.hasOwn(configuredPaths, key)) {
      throw new RuntimeConfigFileError(`Headless config files must not set paths.${key}: ${path}`, path)
    }
  }
  const features = config.features
  if (features?.trustProjectSkills === true) {
    throw new RuntimeConfigFileError(`Headless config files must not trust project capabilities: ${path}`, path)
  }
}

export function readConfigFile(path: string, required: boolean): ConfigFile {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if (!required && isMissingFile(error)) return {}
    if (isMissingFile(error)) throw new RuntimeConfigFileError(`Configuration file does not exist: ${path}`, path, error)
    throw new RuntimeConfigFileError(`Cannot read configuration file: ${path}`, path, error)
  }

  return parseConfigFileText(text, path)
}

/** Parse and validate one JSONC document without doing filesystem I/O. */
export function parseConfigFileText(text: string, path = "<memory>"): ConfigFile {
  const parseErrors: ParseError[] = []
  const parsed = parse(text, parseErrors, { allowTrailingComma: true, disallowComments: false })
  if (parseErrors.length > 0) {
    const first = parseErrors[0]!
    const position = positionAt(text, first.offset)
    throw new RuntimeConfigFileError(
      `Configuration file syntax error: ${path}:${position.line}:${position.column} ${printParseErrorCode(first.error)}`,
      path,
    )
  }

  // Removed keys are rejected with their own message instead of the generic
  // unknown-key error, so a stale config points at the replacement.
  if (parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, "permissionProfile")) {
    throw new RuntimeConfigFileError(
      `The permissionProfile config key has been removed; permissions are determined by the Session permission mode (--permission-mode): ${path}`,
      path,
    )
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    (parsed as { features?: unknown }).features !== null &&
    typeof (parsed as { features?: unknown }).features === "object" &&
    Object.hasOwn((parsed as { features: object }).features, "webFetch")
  ) {
    throw new RuntimeConfigFileError(
      `features.webFetch is not a switch: web_fetch is always registered and governed by session permission approval: ${path}`,
      path,
    )
  }
  const removedCapabilityKeys: readonly { readonly section: string; readonly key: string; readonly note: string }[] = [
    { section: "paths", key: "mcpConfig", note: "the MCP tool stack has been deleted" },
    { section: "paths", key: "mcpApprovedList", note: "the MCP tool stack has been deleted" },
    { section: "paths", key: "lspConfig", note: "the LSP tool stack has been deleted" },
    { section: "paths", key: "hooksConfig", note: "the hooks stack has been deleted" },
    { section: "features", key: "mcp", note: "the MCP tool stack has been deleted" },
    { section: "features", key: "trustProjectMcp", note: "the MCP tool stack has been deleted" },
    { section: "features", key: "trustProjectHooks", note: "the hooks stack has been deleted" },
  ]
  for (const { section, key, note } of removedCapabilityKeys) {
    const sectionValue = parsed === null ? undefined : (parsed as { [name: string]: unknown })[section]
    if (sectionValue !== null && sectionValue !== undefined && typeof sectionValue === "object" && Object.hasOwn(sectionValue, key)) {
      throw new RuntimeConfigFileError(`${section}.${key} config key has been removed; ${note}: ${path}`, path)
    }
  }

  const result = configFileSchema.safeParse(parsed)
  if (!result.success) {
    throw new RuntimeConfigFileError(`Configuration file validation failed: ${path} ${formatZodError(result.error)}`, path, result.error)
  }
  return result.data
}

/**
 * Apply the smallest JSONC edit that persists the TUI-local theme. The input
 * is validated before editing so callers can guarantee that a rejected write
 * leaves the original bytes untouched.
 */
export function updateTuiThemeConfigText(text: string, themeId: string, path = "<memory>"): string {
  if (!(SUPPORTED_THEMES as readonly string[]).includes(themeId)) {
    throw new Error(`Unsupported TUI theme: ${themeId}`)
  }
  parseConfigFileText(text, path)
  const formattingOptions: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  return applyEdits(text, modify(text, ["tui", "theme"], themeId as Theme, { formattingOptions }))
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}

function requireConfigPathValue(value: string | undefined): string {
  if (!value || value.trim().length === 0) throw new Error("--config requires a non-empty path")
  return value
}

function positionAt(text: string, offset: number): { line: number; column: number } {
  const boundedOffset = Math.max(0, Math.min(offset, text.length))
  const before = text.slice(0, boundedOffset)
  const lines = before.split(/\r?\n/u)
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`).join("; ")
}
