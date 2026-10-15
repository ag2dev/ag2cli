/** Runtime-facing skill value and prompt projection. Storage stays in Host. */
export interface Skill {
  readonly name: string
  readonly description: string
  readonly triggers: readonly string[]
  readonly body: string
  readonly source?: "project" | "user" | "builtin"
  readonly path?: string
}

export interface SkillRoot {
  readonly root: string
  readonly source: "project" | "user" | "builtin"
}

export function skillCatalogSection(skills: readonly Skill[], options: { readonly maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? 6_000
  const lines: string[] = []
  let length = 0
  for (const skill of skills) {
    const triggerHint = skill.triggers.length > 0 ? ` (triggers: ${skill.triggers.join(", ")})` : ""
    const line = `- ${skill.name}: ${skill.description}${triggerHint}`
    if (length + line.length + 1 > maxChars) break
    lines.push(line)
    length += line.length + 1
  }
  return ["Available skills (use skill to read instructions):", ...lines].join("\n")
}
