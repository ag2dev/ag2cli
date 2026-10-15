/**
 * ReadFileTool — file-reading tool.
 *
 * Read file text and return it to the model. After reading, store {mtime, content} in context.readFileState
 * for FileEdit's staleness check (the read-before-write contract).
 */

import { z } from "zod/v4"
import { realpath, stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import type { Tool, ToolContext } from "@ag2cli/runtime/ports/tool/contract.js"
import { readRegularFileText } from "../security/file-kind.js"
import { securityDenialCode } from "../security/workspace.js"
import { absolutePathSchema, assertAbsolutePath } from "../security/tool-path.js"

const inputSchema = z.object({
  path: absolutePathSchema("Absolute path of the file to read"),
  offset: z.number().int().positive().optional().describe("Line to start reading from (1-based; use this to page through large files)"),
  limit: z.number().int().positive().max(2000).optional().describe("Maximum number of lines to read; defaults to 2000"),
})

export class ReadFileTool implements Tool<typeof inputSchema> {
  readonly name = "read_file"
  readonly description =
    "Read a file from the local filesystem. path must be an absolute path. By default, read up to 2000 lines from the beginning; offset and limit support pagination. Return line numbers in cat -n style. This tool reads files, not directories. Use glob to find files by name or search directory contents; do not use Bash ls or find."
  readonly inputSchema = inputSchema

  async call(args: z.infer<typeof inputSchema>, context?: ToolContext): Promise<ToolResult> {
    let fullPath: string
    let readPath: string
    try {
      assertAbsolutePath(args.path, "path")
      // Security foundation: workspace-boundary and sensitive-path checks. The production composition root injects the workspace policy.
      // The no-workspace fallback reads through realpath so the read helper
      // only ever sees a canonical path, but keys readFileState by the lexical
      // resolution that file_edit/write_file use for their staleness lookups.
      if (context?.workspace) {
        fullPath = await context.workspace.resolveWithin(args.path, "read")
        readPath = fullPath
      } else {
        fullPath = resolve(args.path)
        readPath = await realpath(fullPath)
      }
      const dirStat = await stat(readPath)
      if (dirStat.isDirectory()) {
        throw new Error("read_file cannot read directories")
      }
      const { content, stat: fileStat } = await readRegularFileText(readPath)
      // Record the read state for FileEdit's staleness check.
      context?.readFileState?.set(fullPath, { timestamp: fileStat.mtimeMs, content })
      const lines = content.split(/\r?\n/)
      if (content.endsWith("\n")) lines.pop()
      const startLine = args.offset ?? 1
      const selected = lines.slice(startLine - 1, startLine - 1 + (args.limit ?? 2000))
      const numbered = selected.map((line, index) => `${String(startLine + index).padStart(6, " ")}\t${line}`).join("\n")
      const rangeNote =
        startLine > 1 || args.limit !== undefined
          ? `\n[Read lines ${startLine}-${Math.min(lines.length, startLine + selected.length - 1)} of ${lines.length}]`
          : lines.length > selected.length
            ? `\n[Truncated: ${lines.length} lines total; use offset/limit to continue reading]`
            : ""
      return { content: `${numbered}${rangeNote}` }
    } catch (err) {
      // Do not throw on error; return it as an is_error tool_result so the model can decide what to do next.
      const msg = err instanceof Error ? err.message : String(err)
      const denialCode = securityDenialCode(err)
      return {
        content: `Failed to read file: ${msg}`,
        isError: true,
        ...(denialCode === undefined ? {} : { denial: { code: denialCode } }),
      }
    }
  }

  isReadOnly(): boolean {
    return true
  }

  /** Read-only tool; safe to execute concurrently. */
  isConcurrencySafe(): boolean {
    return true
  }
}
