import type { ToolPreparation } from "@ag2cli/core/tool-facts.js"

/** Security decisions are made by Host capability code and consumed by Runtime as facts. */
export interface BashSecurityPort {
  normalizeModelBashPreparation(input: unknown, preparation: ToolPreparation): ToolPreparation
  quoteShellArgs(
    argv: readonly string[],
  ): { readonly success: true; readonly quoted: string } | { readonly success: false; readonly error: string }
}
