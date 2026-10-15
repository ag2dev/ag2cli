/**
 * WriteFileTool — file-writing tool.
 *
 * Write to a local file.
 * This tool illustrates concurrency partitioning: write tools have isConcurrencySafe=false and are isolated into serial singleton batches,
 * so they do not run alongside other tools (avoiding write/write conflicts and read/write races).
 */

import { z } from "zod/v4"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { ToolResult, ToolPreparation } from "@ag2cli/core/tool-facts.js"
import type { Tool, ToolContext } from "@ag2cli/runtime/ports/tool/contract.js"
import { byteLength, MAX_TEXT_FILE_BYTES } from "../security/resource-limits.js"
import { securityDenialCode } from "../security/workspace.js"
import { prepareWritePreparation } from "../security/write-preparation.js"
import { absolutePathSchema, assertAbsolutePath } from "../security/tool-path.js"
import { buildUnifiedDiff, capStructuredPatch } from "./unified-diff.js"

const inputSchema = z.object({
  path: absolutePathSchema("Absolute path of the file to write"),
  content: z.string().max(MAX_TEXT_FILE_BYTES).describe("Complete content to write (replaces any existing file)"),
})

export class WriteFileTool implements Tool<typeof inputSchema> {
  readonly name = "write_file"
  readonly description =
    "Write complete text to a local file, replacing any existing content. path must be an absolute path. Use this to create a new file or rewrite one completely. Before replacing an existing file, read it with read_file; the write is rejected if the file changes after it was read. Prefer file_edit for partial changes."
  readonly inputSchema = inputSchema

  async prepare(args: z.infer<typeof inputSchema>, context?: ToolContext): Promise<ToolPreparation> {
    return prepareWritePreparation(args, args.path, context?.workspace)
  }

  async call(args: z.infer<typeof inputSchema>, context?: ToolContext): Promise<ToolResult> {
    try {
      assertAbsolutePath(args.path, "path")
      const fullPath = context?.workspace ? await context.workspace.resolveWithin(args.path, "write") : resolve(args.path)
      if (byteLength(args.content) > MAX_TEXT_FILE_BYTES) {
        return { content: `Failed to write file: content exceeds the ${MAX_TEXT_FILE_BYTES}-byte limit`, isError: true }
      }

      let existing = false
      try {
        const fileStat = await stat(fullPath)
        existing = true
        if (!fileStat.isFile()) {
          return { content: "Failed to write file: target is not a regular file", isError: true }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      }

      // Show the old side of the patch: existing content before replacement (an empty string for a new file).
      let oldContent = ""
      if (existing) {
        const state = context?.readFileState?.get(fullPath)
        if (!state) {
          return {
            content: `Failed to write file: existing file has not been read; read it first with read_file: ${fullPath}`,
            isError: true,
          }
        }
        const currentContent = await readFile(fullPath, "utf8")
        if (currentContent !== state.content) {
          return {
            content: `Failed to write file: file was modified externally after being read; read it again with read_file: ${fullPath}`,
            isError: true,
          }
        }
        oldContent = currentContent
      }

      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, args.content, "utf8")
      const mtime = await stat(fullPath)
        .then((fileStat) => fileStat.mtimeMs)
        .catch(() => Date.now())
      context?.readFileState?.set(fullPath, { timestamp: mtime, content: args.content })
      return {
        content: `Wrote ${args.content.length} bytes to ${args.path}`,
        appliedPatch: capStructuredPatch(buildUnifiedDiff(oldContent, args.content)),
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const denialCode = securityDenialCode(err)
      return {
        content: `Failed to write file: ${msg}`,
        isError: true,
        ...(denialCode === undefined ? {} : { denial: { code: denialCode } }),
      }
    }
  }

  isReadOnly(): boolean {
    return false
  }

  /** Write tool is not concurrency-safe and must run serially with respect to other tools. */
  isConcurrencySafe(): boolean {
    return false
  }
}
