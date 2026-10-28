/** Section names of the structured summary, in order. */
export const SUMMARY_SECTION_NAMES = [
  "Primary Request and Intent",
  "Key Technical Concepts",
  "Files and Code Sections",
  "Errors and fixes",
  "Problem Solving",
  "Pending Tasks",
  "Current Work",
  "Optional Next Step",
] as const

/**
 * The summarizer contract: a fixed eight-section structure. Verbatim user
 * input is deliberately not a section — the quote ledger carries originals,
 * and duplicating them here would double the product's size.
 */
export function summaryPrompt(options: { readonly instructions?: string } = {}): string {
  const sections = SUMMARY_SECTION_NAMES.map((name, index) => `${index + 1}. ${name}`).join("\n")
  const extra = options.instructions?.trim()
  return [
    "Summarize the conversation history so a fresh model instance can continue the work seamlessly.",
    "Respond with exactly these sections, in this order, each as a `## <name>` heading followed by concise prose:",
    sections,
    "",
    "Rules:",
    "- Preserve key facts, decisions, requirements, file paths, identifiers, and error messages.",
    "- Describe intent and outcomes, not full transcripts; the original text stays retrievable out of band.",
    "- Keep every section; write `N/A` when a section has nothing to report.",
    "- Stay under 3000 characters total.",
    ...(extra ? ["", `Additional summarization requirements: ${extra}`] : []),
  ].join("\n")
}

const SUMMARY_TRUNCATION_MARKER = " […summary truncated]"

/**
 * The summary content budget is enforced before delivery by cutting the
 * tail; the structured contract keeps its opening sections intact.
 */
export function clampSummaryToCap(summary: string, summaryCapTokens: number): string {
  const chars = Math.ceil(summary.length / 4)
  if (chars <= summaryCapTokens) return summary
  const keep = Math.max(0, summaryCapTokens * 4 - SUMMARY_TRUNCATION_MARKER.length)
  return `${summary.slice(0, keep)}${SUMMARY_TRUNCATION_MARKER}`
}
