import { readFile, stat } from "node:fs/promises"
import { relative } from "node:path"
import type { ContextAttachment, ContextAttachmentLoader } from "@ag2cli/runtime/ports/context-builder.js"
import { byteLength, MAX_CONTEXT_ATTACHMENT_BYTES, MAX_CONTEXT_ATTACHMENTS, MAX_TEXT_FILE_BYTES } from "../security/resource-limits.js"
import { isSensitivePath, type WorkspacePolicy } from "../security/workspace.js"
import { runRipgrep } from "../tools/ripgrep.js"

const DIRECTORY_IGNORE_GLOBS = [
  "!**/node_modules/**",
  "!**/.git/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/.next/**",
  "!**/coverage/**",
  "!**/.turbo/**",
  "!**/.env*",
  "!**/.ssh/**",
  "!**/.aws/**",
  "!**/.gnupg/**",
]

/**
 * List non-sensitive, non-generated files under a resolved directory. Capped
 * at `limit + 1` so an oversized directory is detected and rejected instead
 * of silently truncated or fully buffered.
 */
async function listDirectoryFiles(canonicalDir: string, limit: number, signal?: AbortSignal): Promise<readonly string[]> {
  if (limit <= 0) return []
  const args = ["--files", ...DIRECTORY_IGNORE_GLOBS.flatMap((glob) => ["--glob", glob])]
  const files = await runRipgrep(args, canonicalDir, { maxOutputBytes: 400_000, signal })
  return files
    .filter((file) => !isSensitivePath(file))
    .sort()
    .slice(0, limit + 1)
}

export interface LineRange {
  readonly start: number
  readonly end: number
}

const LINE_RANGE_SUFFIX = /^(.+)#L?(\d+)(?:-(\d+))?$/

/**
 * Split a `@`-reference token into its filesystem path and an optional
 * trailing `#line` / `#start-end` range, e.g. `src/app.ts#10-20`.
 *
 * The optional `L` is accepted for compatibility with external file
 * references such as `src/app.ts#L10-20`; both spellings produce the same
 * internal 1-based inclusive range.
 */
export function parseFileReferenceToken(token: string): { readonly path: string; readonly lineRange?: LineRange } {
  const match = LINE_RANGE_SUFFIX.exec(token)
  if (!match) return { path: token }
  const [, base, startText, endText] = match
  const start = Number(startText)
  const end = endText === undefined ? start : Number(endText)
  if (!Number.isSafeInteger(start) || start < 1 || end < start) {
    throw new Error(`@${token} has an invalid line range`)
  }
  return { path: base!, lineRange: { start, end } }
}

function sliceLines(content: string, range: LineRange): string {
  const lines = content.split(/\r?\n/)
  if (range.start > lines.length) {
    throw new Error(`Start line ${range.start} is outside the file's range (${lines.length} lines total)`)
  }
  return lines.slice(range.start - 1, Math.min(range.end, lines.length)).join("\n")
}

/**
 * Load `@` references only after applying the same workspace policy as
 * tools. A reference that resolves to a directory expands into one
 * attachment per contained file (bounded and generated-output-filtered the
 * same way as the TUI's `@` completion scanner), instead of failing closed.
 */
export function createWorkspaceAttachmentLoader(workspace: WorkspacePolicy): ContextAttachmentLoader {
  return async (paths, signal, sessionWorkspace) => {
    const policy = sessionWorkspace ?? workspace
    const uniquePaths = [...new Set(paths)]
    const attachments: ContextAttachment[] = []
    let totalBytes = 0

    const loadFile = async (displayPath: string, canonical: string, lineRange?: LineRange): Promise<void> => {
      if (attachments.length >= MAX_CONTEXT_ATTACHMENTS) {
        throw new Error(`At most ${MAX_CONTEXT_ATTACHMENTS} file references are allowed`)
      }
      const fileStat = await stat(canonical)
      if (fileStat.size > MAX_TEXT_FILE_BYTES) {
        throw new Error(`@${displayPath} exceeds the ${MAX_TEXT_FILE_BYTES}-byte limit`)
      }
      const fullContent = await readFile(canonical, "utf8")
      if (byteLength(fullContent) > MAX_TEXT_FILE_BYTES) {
        throw new Error(`@${displayPath} exceeds the ${MAX_TEXT_FILE_BYTES}-byte limit`)
      }
      const content = lineRange ? sliceLines(fullContent, lineRange) : fullContent
      totalBytes += byteLength(content)
      if (totalBytes > MAX_CONTEXT_ATTACHMENT_BYTES) {
        throw new Error(`Total file reference size exceeds the ${MAX_CONTEXT_ATTACHMENT_BYTES}-byte limit`)
      }
      attachments.push({ path: displayPath, content })
    }

    for (const rawPath of uniquePaths) {
      if (signal?.aborted) throw new DOMException("File reference loading was aborted", "AbortError")
      try {
        const { path, lineRange } = parseFileReferenceToken(rawPath)
        const canonical = await policy.resolveWithin(path, "read")
        const fileStat = await stat(canonical)
        if (fileStat.isDirectory()) {
          if (lineRange) throw new Error(`@${rawPath} is a directory; line ranges are not supported`)
          const remaining = MAX_CONTEXT_ATTACHMENTS - attachments.length
          if (remaining <= 0) throw new Error(`At most ${MAX_CONTEXT_ATTACHMENTS} file references are allowed`)
          const files = await listDirectoryFiles(canonical, remaining, signal)
          if (files.length > remaining) throw new Error(`At most ${MAX_CONTEXT_ATTACHMENTS} file references are allowed`)
          const displayBase = path.endsWith("/") ? path : `${path}/`
          for (const file of files) {
            if (signal?.aborted) throw new DOMException("File reference loading was aborted", "AbortError")
            await loadFile(`${displayBase}${relative(canonical, file).replaceAll("\\", "/")}`, file)
          }
          continue
        }
        if (!fileStat.isFile()) throw new Error(`@${path} is not a regular file or directory`)
        await loadFile(rawPath, canonical, lineRange)
      } catch (error) {
        // A completion result can become stale between Enter and the next
        // model turn. Missing files are ordinary best-effort misses; policy,
        // sensitivity and size violations remain hard failures.
        if (isMissingPathError(error)) continue
        throw error
      }
    }
    return attachments
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
