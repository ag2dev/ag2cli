/**
 * GrepTool — regex search over file contents.
 *
 * Search file contents with ripgrep.
 * Three output modes:
 *  - files_with_matches (default): return only paths of matching files.
 *  - content: return matching lines (supports -A/-B/-C context and -n line numbers).
 *  - count: return the match count for each file.
 * Read-only, so it is safe to run concurrently.
 */

import { z } from "zod/v4"
import { resolve } from "node:path"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import type { Tool } from "@ag2cli/runtime/ports/tool/contract.js"
import { runRipgrep } from "./ripgrep.js"
import { NotRegularFileError, assertSearchRootKind } from "../security/file-kind.js"
import { securityDenialCode, sensitiveRipgrepExclusions } from "../security/workspace.js"
import { assertAbsolutePath, absolutePathSchema } from "../security/tool-path.js"

const inputSchema = z.object({
  pattern: z.string().describe("Regular expression using ripgrep syntax"),
  path: absolutePathSchema("Absolute path of the search root (defaults to the current working directory)").optional(),
  glob: z.string().optional().describe('File-name filter, such as "*.ts" or "*.{ts,tsx}" (rg --glob)'),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe(
      "content=matching lines (with context/line numbers); files_with_matches=file paths; count=match counts per file. Defaults to files_with_matches.",
    ),
  "-A": z.number().int().nonnegative().optional().describe("Show N lines after each match (content mode only)"),
  "-B": z.number().int().nonnegative().optional().describe("Show N lines before each match (content mode only)"),
  "-C": z.number().int().nonnegative().optional().describe("Show N lines before and after each match (content mode only)"),
  "-n": z.boolean().optional().describe("Show line numbers (content mode only; defaults to true)"),
  "-i": z.boolean().optional().describe("Ignore case (passed to ripgrep -i)"),
  type: z.string().optional().describe("ripgrep file type, such as ts, py, or rust"),
  multiline: z.boolean().optional().describe("Enable multiline regex matching"),
  head_limit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Limit the number of output entries (all modes). Defaults to 250; use 0 for no limit (use with care)."),
  offset: z.number().int().nonnegative().optional().describe("Skip the first N entries before applying head_limit (pagination)"),
})

export class GrepTool implements Tool<typeof inputSchema> {
  readonly name = "grep"
  readonly description =
    "Search file contents with ripgrep. Always use grep for content searches; do not call Linux grep or invoke grep/rg through Bash. Supports full regular expressions, glob, type, output_mode, -A/-B/-C context, and multiline. output_mode can be content, files_with_matches, or count. Escape literal braces in ripgrep patterns. Matching is single-line by default; set multiline=true for cross-line matches."
  readonly inputSchema = inputSchema

  async call(
    args: z.infer<typeof inputSchema>,
    context?: import("@ag2cli/runtime/ports/tool/contract.js").ToolContext,
  ): Promise<ToolResult> {
    let cwd: string
    // Security foundation: the search root must be inside the workspace (traverse).
    try {
      if (args.path !== undefined) assertAbsolutePath(args.path, "path")
      cwd = context?.workspace
        ? await context.workspace.resolveWithin(args.path ?? process.cwd(), "traverse")
        : args.path
          ? resolve(args.path)
          : process.cwd()
    } catch (err) {
      const denialCode = securityDenialCode(err)
      return {
        content: `grep failed: ${err instanceof Error ? err.message : err}`,
        isError: true,
        ...(denialCode === undefined ? {} : { denial: { code: denialCode } }),
      }
    }
    try {
      await assertSearchRootKind(cwd)
    } catch (err) {
      if (err instanceof NotRegularFileError) {
        const denialCode = securityDenialCode(err)
        return {
          content: `grep failed: ${err.message}`,
          isError: true,
          ...(denialCode === undefined ? {} : { denial: { code: denialCode } }),
        }
      }
      const code = (err as NodeJS.ErrnoException).code
      const reason = code === "ENOENT" ? "Search path does not exist" : "Search path is inaccessible"
      return { content: `grep failed: ${reason}: ${args.path ?? cwd}`, isError: true }
    }
    const mode = args.output_mode ?? "files_with_matches"
    const headLimit = args.head_limit ?? 250

    const rgArgs: string[] = []
    // Map output_mode to rg flags.
    if (mode === "count") rgArgs.push("--count")
    else if (mode === "files_with_matches") rgArgs.push("--files-with-matches")
    // Content mode needs no special flag (matching lines are the default output).
    if (mode === "content") {
      if (args["-A"] != null) rgArgs.push("-A", String(args["-A"]))
      if (args["-B"] != null) rgArgs.push("-B", String(args["-B"]))
      if (args["-C"] != null) rgArgs.push("-C", String(args["-C"]))
      // Line numbers are enabled by default.
      if (args["-n"] !== false) rgArgs.push("-n")
    }
    if (args["-i"]) rgArgs.push("-i")
    if (args.type) rgArgs.push("--type", args.type)
    if (args.multiline) rgArgs.push("-U", "--multiline-dotall")
    if (args.glob) rgArgs.push("--glob", args.glob)
    // Limit line width so minified or base64 content does not overwhelm the context;
    // preview preserves enough of a matching line for diagnosis instead of silently dropping long lines.
    rgArgs.push("--max-columns", "500", "--max-columns-preview")
    // Sensitive paths are always excluded so searches cannot expose secrets from .env files or credentials. ripgrep honors .gitignore
    // and skips hidden files by default; add a safeguard so sensitive targets remain excluded even when not ignored or when the user passes --glob.
    // Derive exclusions from the single source of sensitive-path constants in workspace.ts, matching glob behavior.
    rgArgs.push(...sensitiveRipgrepExclusions().flatMap((glob) => ["--glob", glob]))
    // Search pattern (positional argument, placed last).
    // -e prevents a pattern beginning with '-' from becoming an rg option.
    rgArgs.push("-e", args.pattern)

    let lines: string[]
    try {
      lines = await runRipgrep(rgArgs, cwd, { signal: context?.signal })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: context?.signal?.aborted ? "grep was cancelled" : `grep failed: ${msg}`,
        isError: true,
      }
    }

    // Paginate with head_limit / offset (0 = unlimited).
    let paged = lines
    if (headLimit > 0) {
      const offset = args.offset ?? 0
      paged = lines.slice(offset, offset + headLimit)
    }
    const truncated = headLimit > 0 && lines.length > (args.offset ?? 0) + paged.length

    if (paged.length === 0) {
      return { content: `No content matched "${args.pattern}".` }
    }
    const note = truncated ? `(${lines.length} entries total; showing ${paged.length}. Use offset to view more.)\n` : ""
    return { content: `${note}${paged.join("\n")}` }
  }

  isReadOnly(): boolean {
    return true
  }
  isConcurrencySafe(): boolean {
    return true
  }
}
