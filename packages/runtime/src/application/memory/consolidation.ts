/** Build the bounded, manual memory-consolidation prompt used by `/dream`. */
export function buildMemoryConsolidationPrompt(input: {
  readonly memoryRoot: string
  readonly eventRoot: string
  readonly instructions?: string
}): string {
  const extra = input.instructions?.trim()
  return [
    "Perform a manual memory consolidation pass for AG2CLI.",
    `Memory directory: ${input.memoryRoot}`,
    `Session event directory: ${input.eventRoot}`,
    "",
    "First inspect MEMORY.md and the existing memory files. Use narrow searches over recent session events only when needed.",
    "Merge durable user preferences, project constraints, and useful references into existing topic files instead of creating duplicates.",
    "Write durable memory files directly under the memory directory. Do not save credentials, tokens, transient chat, or facts that can be derived from the current code or git history.",
    "Treat current files and commands as the source of truth; correct or remove stale memory rather than preserving contradictions.",
    "Keep MEMORY.md as a short index of topic files, not a copy of their bodies.",
    ...(extra ? ["", `Additional consolidation instructions: ${extra}`] : []),
    "",
    "Return a short summary of what was consolidated, updated, or pruned. If nothing changed, say so.",
  ].join("\n")
}
