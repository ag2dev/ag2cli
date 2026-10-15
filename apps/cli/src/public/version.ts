import { readFile } from "node:fs/promises"

export async function readAg2cliVersion(): Promise<string> {
  const compiledVersion = process.env.AG2CLI_COMPILED_VERSION?.trim()
  if (compiledVersion) return compiledVersion

  const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8")
  const parsed = JSON.parse(raw) as { version?: unknown }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json is missing version")
  }
  return parsed.version
}
