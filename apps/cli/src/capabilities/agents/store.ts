import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, join, relative } from "node:path"
import { byteLength, MAX_SKILL_FILE_BYTES } from "../security/resource-limits.js"

export type AgentSource = "project" | "user"

export interface AgentDefinition {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly source: AgentSource
  readonly path: string
  readonly model?: string
  readonly tools: readonly string[]
}

export interface AgentDiagnostic {
  readonly path: string
  readonly error: string
}

export interface AgentScanResult {
  readonly agents: readonly AgentDefinition[]
  readonly diagnostics: readonly AgentDiagnostic[]
}

/** Create a project-scoped agent definition without allowing path traversal. */
export async function createAgentFile(root: string, name: string): Promise<string> {
  const normalized = name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(
      "Agent name must start with a letter or digit, contain only letters, digits, underscores, and hyphens, and be no longer than 64 characters",
    )
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, `${normalized}.md`)
  try {
    await writeFile(
      path,
      [
        "---",
        `name: ${normalized}`,
        "description: Describe when to use this agent",
        "tools: read_file, glob, grep",
        "---",
        "",
        "Describe this agent's instructions here.",
        "",
      ].join("\n"),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    )
  } catch (error) {
    if (isAlreadyExists(error)) throw new Error(`Agent definition already exists: ${normalized}`, { cause: error })
    throw error
  }
  return path
}

/** Load custom agent descriptions without coupling them to runtime execution. */
export function scanAgentRoots(roots: ReadonlyArray<{ readonly root: string; readonly source: AgentSource }>): AgentScanResult {
  const agents: AgentDefinition[] = []
  const diagnostics: AgentDiagnostic[] = []
  for (const root of roots) {
    if (!existsSync(root.root)) continue
    for (const path of collectAgentFiles(root.root)) {
      try {
        const size = statSync(path).size
        if (size > MAX_SKILL_FILE_BYTES) throw new Error(`File exceeds the ${MAX_SKILL_FILE_BYTES}-byte limit`)
        const content = readFileSync(path, "utf8")
        if (byteLength(content) > MAX_SKILL_FILE_BYTES) throw new Error(`File exceeds the ${MAX_SKILL_FILE_BYTES}-byte limit`)
        agents.push({ ...parseAgentFile(basename(path, ".md"), content), source: root.source, path })
      } catch (error) {
        diagnostics.push({
          path: `${root.source}:${relative(root.root, path)}`,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return { agents: deduplicateAgents(agents), diagnostics }
}

export function parseAgentFile(fileName: string, content: string): Omit<AgentDefinition, "source" | "path"> {
  if (!content.startsWith("---")) throw new Error("Missing opening frontmatter delimiter ---")
  const end = content.indexOf("---", 3)
  if (end < 0) throw new Error("Missing closing frontmatter delimiter ---")
  const fields: Record<string, string> = {}
  for (const line of content.slice(3, end).split("\n")) {
    const match = /^([\w-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (match) fields[match[1]!] = match[2]!.trim().replace(/^['"]|['"]$/g, "")
  }
  const name = (fields.name ?? fileName.replace(/\.md$/i, "")).trim()
  const description = fields.description?.trim()
  if (!name) throw new Error("Missing name field")
  if (!description) throw new Error("Missing description field")
  if (description.length > 500) throw new Error("description must not exceed 500 characters")
  const tools = (fields.tools ?? "").split(/[\s,]+/).filter(Boolean)
  // A wildcard would pass the parent pool unrestricted while the child-side
  // intersection reads it as an unknown name (deny-all) — reject it here so
  // both sides share one explicit-list semantics.
  if (tools.includes("*")) throw new Error('wildcard "*" is not allowed in tools; list tool names explicitly')
  return {
    name,
    description,
    body: content.slice(end + 3).trim(),
    ...(fields.model ? { model: fields.model } : {}),
    tools,
  }
}

function collectAgentFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(path)
    else if (entry.isDirectory()) {
      const nested = join(path, "AGENT.md")
      if (existsSync(nested) && statSync(nested).isFile()) files.push(nested)
    }
  }
  return files
}

function deduplicateAgents(agents: readonly AgentDefinition[]): AgentDefinition[] {
  const names = new Set<string>()
  return agents.filter((agent) => {
    const key = agent.name.toLowerCase()
    if (names.has(key)) return false
    names.add(key)
    return true
  })
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}
