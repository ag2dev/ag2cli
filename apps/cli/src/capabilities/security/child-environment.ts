import { delimiter, isAbsolute } from "node:path"

const INHERITED_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR"] as const

function sanitizePath(value: string | undefined): string | undefined {
  if (!value) return undefined
  const entries = value.split(delimiter).filter((entry) => entry !== "" && entry !== "." && isAbsolute(entry))
  return entries.length > 0 ? entries.join(delimiter) : undefined
}

/** Build the minimum host environment safe for configured child processes. */
export function buildChildEnvironment(overrides: Readonly<Record<string, string | undefined>> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const key of INHERITED_ENV_KEYS) {
    const value = overrides[key] ?? process.env[key]
    if (value !== undefined) env[key] = key === "PATH" ? sanitizePath(value) : value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!INHERITED_ENV_KEYS.includes(key as (typeof INHERITED_ENV_KEYS)[number])) env[key] = value
  }
  return env
}
