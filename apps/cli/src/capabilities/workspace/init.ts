import { access, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { WorkspacePolicy } from "../security/workspace.js"

export async function initializeProjectInstructions(workspaceRoot: string): Promise<string> {
  const workspace = new WorkspacePolicy({ workspaceRoot })
  const path = await workspace.resolveWithin(join(workspaceRoot, "AGENTS.md"), "write")
  try {
    await access(path)
    return "AGENTS.md already exists; it was not overwritten"
  } catch {
    // Continue with a deterministic, intentionally small baseline.
  }
  let packageSummary = ""
  try {
    const packageJson = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }
    const scripts = Object.keys(packageJson.scripts ?? {}).sort()
    if (scripts.length > 0) packageSummary = `\n## Commands\n${scripts.map((script) => `- \`npm run ${script}\``).join("\n")}\n`
  } catch {
    // package.json is optional.
  }
  const content = [
    "# AGENTS.md",
    "",
    "This file contains project-specific instructions for coding agents.",
    "",
    "## Working agreement",
    "- Inspect the relevant files before editing.",
    "- Keep changes focused and run the smallest relevant verification.",
    "- Do not read or expose credentials, tokens, or ignored secret files.",
    packageSummary,
  ].join("\n")
  await writeFile(path, content, { encoding: "utf8", flag: "wx" })
  return "Created AGENTS.md"
}
