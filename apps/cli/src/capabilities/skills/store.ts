/**
 * Skill loading layer.
 *
 * A skill is a loadable set of task steps: when the model encounters a matching scenario,
 * it may follow applicable steps within the user's request. The format is minimal: one Markdown file per skill
 * (frontmatter + instruction body). After loading, the skill list is added to the system prompt so the model knows
 * which capabilities are available; the skill tool returns the body but does not execute the steps.
 *
 * Difference from memory:
 *  - memory = facts (who/what), recalled and injected passively;
 *  - skill = task guidance (how to do something), selected and followed within the user's request.
 * Their structure is similar (frontmatter files), but their semantics and injection methods differ, so they remain separate modules.
 *
 * Format:
 *   ---
 *   name: deploy-steps
 *   description: Use when the user wants to deploy; provide deployment steps.
 *   trigger: deploy release   (optional trigger keywords, space-separated)
 *   ---
 *   <instruction body: detailed steps>
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { byteLength, MAX_LOADED_SKILLS, MAX_SKILL_BODY_CHARS, MAX_SKILL_FILE_BYTES } from "../security/resource-limits.js"
import type { Skill, SkillRoot } from "@ag2cli/runtime/application/skills/types.js"
export type { Skill, SkillRoot } from "@ag2cli/runtime/application/skills/types.js"
export { skillCatalogSection } from "@ag2cli/runtime/application/skills/types.js"

/** A skill. */
export interface SkillDiagnostic {
  readonly path: string
  readonly error: string
}

export interface SkillScanResult {
  readonly skills: readonly Skill[]
  readonly diagnostics: readonly SkillDiagnostic[]
}

/** Skill parsing error. */
export class SkillParseError extends Error {
  constructor(
    public readonly fileName: string,
    message: string,
  ) {
    super(`${fileName}: ${message}`)
    this.name = "SkillParseError"
  }
}

/** Parse the text of one skill file. */
export function parseSkillFile(fileName: string, content: string): Skill {
  if (!content.startsWith("---")) throw new SkillParseError(fileName, "Missing opening frontmatter delimiter ---")
  const endIdx = content.indexOf("---", 3)
  if (endIdx === -1) throw new SkillParseError(fileName, "Missing closing frontmatter delimiter ---")
  const header = content.slice(3, endIdx)
  const body = content.slice(endIdx + 3).trim()
  if (body.length > MAX_SKILL_BODY_CHARS) {
    throw new SkillParseError(fileName, `Body exceeds the ${MAX_SKILL_BODY_CHARS}-character limit`)
  }

  const fields: Record<string, string> = {}
  for (const line of header.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = /^([\w-]+)\s*:\s*(.*)$/.exec(trimmed)
    if (!m) continue
    fields[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "")
  }

  const name = (fields.name ?? fileName.replace(/\.md$/i, "")).trim()
  if (!name) throw new SkillParseError(fileName, "Missing name field")
  if (!fields.description) throw new SkillParseError(fileName, "Missing description field")
  if (fields.description.length > 500) throw new SkillParseError(fileName, "description must not exceed 500 characters")
  const triggers = (fields.trigger ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return { name, description: fields.description, triggers, body }
}

/** Scan all skills in a directory. Skip malformed files by default. Return an empty list if the directory does not exist. */
export function scanSkills(dir: string, opts: { skipBad?: boolean } = {}): Skill[] {
  return scanSkillsWithDiagnostics(dir, opts).skills as Skill[]
}

/** Scan legacy flat files and nested <name>/SKILL.md files deterministically. */
export function scanSkillsWithDiagnostics(
  dir: string,
  opts: { skipBad?: boolean; source?: Skill["source"]; maxDepth?: number } = {},
): SkillScanResult {
  const skipBad = opts.skipBad ?? true
  if (!existsSync(dir)) return { skills: [], diagnostics: [] }
  const out: Skill[] = []
  const diagnostics: SkillDiagnostic[] = []
  const maxDepth = opts.maxDepth ?? 4
  const files = collectSkillFiles(dir, 0, maxDepth, (path, error) => {
    const diagnostic = { path: relative(dir, path) || ".", error: error instanceof Error ? error.message : String(error) }
    diagnostics.push(diagnostic)
    if (!skipBad) throw error
  })
  for (const filePath of files.slice(0, MAX_LOADED_SKILLS)) {
    let content: string
    try {
      const size = statSync(filePath).size
      if (size > MAX_SKILL_FILE_BYTES) throw new Error(`File exceeds the ${MAX_SKILL_FILE_BYTES}-byte limit`)
      content = readFileSync(filePath, "utf-8")
      if (byteLength(content) > MAX_SKILL_FILE_BYTES) throw new Error(`File exceeds the ${MAX_SKILL_FILE_BYTES}-byte limit`)
    } catch (err) {
      diagnostics.push({ path: relative(dir, filePath), error: err instanceof Error ? err.message : String(err) })
      if (!skipBad) throw err
      continue
    }
    const relativePath = relative(dir, filePath)
    const defaultName = basename(filePath).toLowerCase() === "skill.md" ? basename(dirname(filePath)) : basename(filePath, ".md")
    try {
      const skill = parseSkillFile(defaultName, content)
      out.push({ ...skill, source: opts.source, path: filePath })
    } catch (err) {
      const diagnostic = { path: relativePath, error: err instanceof Error ? err.message : String(err) }
      diagnostics.push(diagnostic)
      if (!skipBad) throw err
    }
  }
  if (files.length > MAX_LOADED_SKILLS) {
    diagnostics.push({
      path: relative(dir, files[MAX_LOADED_SKILLS] ?? dir),
      error: `Skill count exceeds the limit of ${MAX_LOADED_SKILLS}`,
    })
  }
  return { skills: dedupeSkills(out), diagnostics }
}

/** Merge roots in precedence order; the first occurrence of a skill name wins. */
export function scanSkillRoots(roots: ReadonlyArray<SkillRoot>, opts: { skipBad?: boolean; maxDepth?: number } = {}): SkillScanResult {
  const skills: Skill[] = []
  const diagnostics: SkillDiagnostic[] = []
  for (const root of roots) {
    const result = scanSkillsWithDiagnostics(root.root, { ...opts, source: root.source })
    skills.push(...result.skills)
    diagnostics.push(...result.diagnostics.map((item) => ({ ...item, path: `${root.source}:${item.path}` })))
  }
  return { skills: dedupeSkills(skills), diagnostics }
}

function collectSkillFiles(dir: string, depth: number, maxDepth: number, onError: (path: string, error: unknown) => void): string[] {
  if (depth > maxDepth) return []
  const files: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    onError(dir, error)
    return files
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isFile() && (depth === 0 ? entry.name.toLowerCase().endsWith(".md") : entry.name === "SKILL.md")) {
      files.push(path)
    } else if (entry.isDirectory() && !entry.name.startsWith(".") && depth < maxDepth) {
      files.push(...collectSkillFiles(path, depth + 1, maxDepth, onError))
    }
  }
  return files
}

/**
 * Dedupe by lowercase name so `Deploy` and `deploy` are treated as the same
 * skill (matching memory dedup and the case-insensitive skill tool lookup),
 * keeping the first occurrence's precedence order (project before user).
 */
function dedupeSkills(skills: readonly Skill[]): Skill[] {
  const seen = new Set<string>()
  return skills.filter((skill) => {
    const key = skill.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
