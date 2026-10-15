/**
 * FileEditTool — exact string replacement in files.
 *
 * Core behavior:
 *  - Require a unique old_string match unless replace_all=true.
 *  - findActualString tolerates quote differences between model output and file contents.
 *  - preserveQuoteStyle keeps the file's existing quote style.
 *  - readFileState checks mtime before editing and rejects files changed externally.
 *    Call read_file before edit.
 *  - An empty old_string creates a missing file or fills an empty file.
 *
 * File tools handle file reads/writes and concurrency protection; the runtime context provides authorization.
 */

import { z } from "zod/v4"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { ToolResult, ToolPreparation } from "@ag2cli/core/tool-facts.js"
import type { Tool, ToolContext } from "@ag2cli/runtime/ports/tool/contract.js"
import { findActualString, preserveQuoteStyle } from "./file-edit-utils.js"
import { buildUnifiedDiff, capStructuredPatch, renderUnifiedDiffText } from "./unified-diff.js"
import { byteLength, MAX_TEXT_FILE_BYTES } from "../security/resource-limits.js"
import { securityDenialCode } from "../security/workspace.js"
import { prepareWritePreparation } from "../security/write-preparation.js"
import { absolutePathSchema, assertAbsolutePath } from "../security/tool-path.js"

const inputSchema = z.object({
  file_path: absolutePathSchema("Absolute path of the file to edit"),
  old_string: z.string().describe("Original text to replace (must match uniquely unless replace_all=true)"),
  new_string: z.string().describe("Replacement text"),
  replace_all: z
    .boolean()
    .optional()
    .describe("Whether to replace every match (defaults to false, which requires old_string to match uniquely)"),
})

async function getMtime(path: string): Promise<number> {
  try {
    const s = await stat(path)
    return s.mtimeMs
  } catch {
    return 0
  }
}

export class FileEditTool implements Tool<typeof inputSchema> {
  readonly name = "file_edit"
  readonly description =
    "Replace exact strings in an existing file (old_string → new_string). file_path must be an absolute path. Call read_file before editing. When editing from read_file output, match only the actual content after line-number prefixes and preserve existing indentation; do not include line numbers in the strings. old_string must match uniquely; otherwise, provide more context or use replace_all=true. Make only the necessary changes and do not use write_file for partial edits. Use replace_all=true for batch replacements or renames within one file."
  readonly inputSchema = inputSchema

  async prepare(args: z.infer<typeof inputSchema>, context?: ToolContext): Promise<ToolPreparation> {
    return prepareWritePreparation(args, args.file_path, context?.workspace)
  }

  async call(args: z.infer<typeof inputSchema>, context?: ToolContext): Promise<ToolResult> {
    // Security foundation: check workspace boundaries and sensitive paths for writes. On violation, return is_error; FileEdit never throws.
    let fullPath: string
    try {
      assertAbsolutePath(args.file_path, "file_path")
      fullPath = context?.workspace ? await context.workspace.resolveWithin(args.file_path, "write") : resolve(args.file_path)
    } catch (err) {
      const denialCode = securityDenialCode(err)
      return {
        content: `Edit failed: ${err instanceof Error ? err.message : err}`,
        isError: true,
        ...(denialCode === undefined ? {} : { denial: { code: denialCode } }),
      }
    }
    const { old_string, new_string, replace_all = false } = args
    if (byteLength(new_string) > MAX_TEXT_FILE_BYTES) {
      return { content: `Edit failed: new content exceeds the ${MAX_TEXT_FILE_BYTES}-byte limit`, isError: true }
    }

    // 1. old_string === new_string → no change.
    if (old_string === new_string) {
      return {
        content: "No change: old_string and new_string are identical.",
        isError: true,
      }
    }

    // 2. Read the file (if it does not exist, allow creation only when old_string="").
    let fileContent: string
    let fileExists = true
    try {
      const fileStat = await stat(fullPath)
      if (!fileStat.isFile()) throw new Error("Target is not a regular file")
      if (fileStat.size > MAX_TEXT_FILE_BYTES) {
        return { content: `Edit failed: file exceeds the ${MAX_TEXT_FILE_BYTES}-byte limit`, isError: true }
      }
      fileContent = await readFile(fullPath, "utf8")
      if (byteLength(fileContent) > MAX_TEXT_FILE_BYTES) {
        return { content: `Edit failed: file exceeds the ${MAX_TEXT_FILE_BYTES}-byte limit`, isError: true }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        const message = err instanceof Error ? err.message : String(err)
        return { content: `Edit failed: ${message}`, isError: true }
      }
      fileExists = false
      fileContent = ""
    }

    if (!fileExists) {
      if (old_string === "") {
        // Create a new file.
        await this.writeContent(fullPath, new_string)
        return {
          content: `Created file ${fullPath} (${new_string.length} bytes)`,
          appliedPatch: capStructuredPatch(buildUnifiedDiff("", new_string)),
        }
      }
      return {
        content: `File does not exist: ${fullPath} (to create it, pass an empty string for old_string)`,
        isError: true,
      }
    }

    // 3. Empty old_string + empty file = populate the file.
    if (old_string === "") {
      if (fileContent.length > 0) {
        return {
          content: "Cannot use an empty old_string with a non-empty file; provide the original text to replace.",
          isError: true,
        }
      }
      await this.writeContent(fullPath, new_string)
      return {
        content: `Populated empty file ${fullPath} (${new_string.length} bytes)`,
        appliedPatch: capStructuredPatch(buildUnifiedDiff("", new_string)),
      }
    }

    // 4. Staleness check: read_file must have been called, and the file must not have changed externally.
    const state = context?.readFileState?.get(fullPath)
    if (!state) {
      return {
        content: `This file has not been read; read it with read_file before editing: ${fullPath}.`,
        isError: true,
      }
    }
    const mtime = await getMtime(fullPath)
    if (mtime > state.timestamp && fileContent !== state.content) {
      return {
        content: `The file was modified externally after the last read (mtime and content changed); read it again with read_file.`,
        isError: true,
      }
    }

    // 5. Use findActualString for quote-tolerant matching.
    const actualOld = findActualString(fileContent, old_string)
    if (actualOld === null) {
      return {
        content: `Could not find the text to replace. Confirm that old_string appears in the file, including spaces, indentation, and quotes.\nold_string: ${old_string}`,
        isError: true,
      }
    }

    // 6. Uniqueness check: report an error when there are multiple matches and replace_all is false.
    const matchCount = countOccurrences(fileContent, actualOld)
    if (matchCount > 1 && !replace_all) {
      return {
        content: `Found ${matchCount} matches, but replace_all=false. Provide more context so old_string is unique, or set replace_all=true.\nold_string: ${old_string}`,
        isError: true,
      }
    }

    // 7. Apply replacements: replace all matches when requested, otherwise replace the first. preserveQuoteStyle keeps the quote style.
    const adjustedNew = actualOld !== old_string ? preserveQuoteStyle(new_string, actualOld) : new_string
    const newContent = replace_all ? fileContent.split(actualOld).join(adjustedNew) : fileContent.replace(actualOld, adjustedNew)

    if (newContent === fileContent) {
      return { content: "Replacement made no change (old_string may already match new_string's style).", isError: true }
    }

    await this.writeContent(fullPath, newContent)

    // 8. Update readFileState (file contents and mtime changed after the edit).
    const newMtime = await getMtime(fullPath)
    context?.readFileState?.set(fullPath, { timestamp: newMtime, content: newContent })

    const patch = capStructuredPatch(buildUnifiedDiff(fileContent, newContent))
    return {
      content: `Edited ${fullPath}\n${matchCount > 1 ? `(replaced ${matchCount} occurrences)\n` : ""}Changes:\n${renderUnifiedDiffText(patch)}`,
      appliedPatch: patch,
    }
  }

  private async writeContent(fullPath: string, content: string): Promise<void> {
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, "utf8")
  }

  isReadOnly(): boolean {
    return false
  }
  isConcurrencySafe(): boolean {
    return false
  }
}

/** Count how many times substr occurs in str. */
function countOccurrences(str: string, substr: string): number {
  if (substr === "") return 0
  let count = 0
  let idx = str.indexOf(substr)
  while (idx !== -1) {
    count++
    idx = str.indexOf(substr, idx + substr.length)
  }
  return count
}
