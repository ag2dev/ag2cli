/**
 * GlobTool — filename pattern matching.
 *
 * List files with ripgrep --files and filter them with --glob. Read-only, so it is safe to run concurrently.
 *
 * Validate the search root against workspace boundaries; always exclude sensitive directories and credential files.
 */

import { z } from "zod/v4"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import type { Tool } from "@ag2cli/runtime/ports/tool/contract.js"
import { runRipgrep } from "./ripgrep.js"
import { NotRegularFileError, assertSearchRootKind } from "../security/file-kind.js"
import { securityDenialCode, sensitiveRipgrepExclusions } from "../security/workspace.js"
import { assertAbsolutePath, absolutePathSchema } from "../security/tool-path.js"

const inputSchema = z.object({
  pattern: z.string().min(1).describe("Glob pattern, such as **/*.ts, src/**/*.json, or **/*; finds files by name, not by content"),
  path: absolutePathSchema("Absolute path of the search root (defaults to the current working directory)").optional(),
  offset: z.number().int().nonnegative().optional().describe("Skip the first N results (pagination; defaults to 0)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum number of results (defaults to 100; use offset to paginate larger result sets)"),
})

export class GlobTool implements Tool<typeof inputSchema> {
  private readonly includeHidden: boolean
  private readonly noIgnore: boolean

  constructor(options: { readonly includeHidden?: boolean; readonly noIgnore?: boolean } = {}) {
    this.includeHidden = options.includeHidden ?? false
    this.noIgnore = options.noIgnore ?? false
  }

  readonly name = "glob"
  readonly description =
    "Quickly find files by filename using glob patterns (powered by ripgrep), for any kind of codebase. Supports patterns such as **/*.ts and src/**/*.json. Results are sorted by modification time; path must be a directory."
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
        content: `glob failed: ${err instanceof Error ? err.message : err}`,
        isError: true,
        ...(denialCode === undefined ? {} : { denial: { code: denialCode } }),
      }
    }
    try {
      const rootStat = await assertSearchRootKind(cwd)
      if (!rootStat.isDirectory()) {
        return { content: `glob failed: search path is not a directory: ${args.path ?? cwd}`, isError: true }
      }
    } catch (err) {
      if (err instanceof NotRegularFileError) {
        const denialCode = securityDenialCode(err)
        return {
          content: `glob failed: ${err.message}`,
          isError: true,
          ...(denialCode === undefined ? {} : { denial: { code: denialCode } }),
        }
      }
      const code = (err as NodeJS.ErrnoException).code
      const reason = code === "ENOENT" ? "Search directory does not exist" : "Search directory is inaccessible"
      return { content: `glob failed: ${reason}: ${args.path ?? cwd}`, isError: true }
    }
    const limit = args.limit ?? 100
    const offset = args.offset ?? 0

    // Secure defaults: honor .gitignore and skip hidden files. Startup configuration is resolved in the composition root;
    // the model cannot enable hidden files or no-ignore through tool arguments.
    const includeHidden = this.includeHidden
    const noIgnore = this.noIgnore

    // ripgrep --glob supports relative patterns; absolute patterns also work when passed through to rg.
    // Note: any explicit --glob makes ripgrep drop its default hidden-file filter, so when includeHidden
    // is false, explicitly append !.* to exclude dotfiles.
    const rgArgs = [
      "--files",
      "--glob",
      args.pattern,
      "--sort=modified",
      ...(noIgnore ? ["--no-ignore"] : []),
      ...(includeHidden ? ["--hidden"] : []),
      // By default, exclude dotfiles unless hidden files are enabled.
      ...(includeHidden ? [] : ["--glob", "!.*", "--glob", "!.*/"]),
      // Sensitive exclusions are a hard rule (kept even with hidden enabled):
      // derived from the single sensitive-constants source in workspace.ts.
      ...sensitiveRipgrepExclusions().flatMap((glob) => ["--glob", glob]),
    ]

    let lines: string[]
    try {
      lines = await runRipgrep(rgArgs, cwd, { signal: context?.signal })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: context?.signal?.aborted ? "glob was cancelled" : `glob failed: ${msg}`,
        isError: true,
      }
    }

    // rg returns file paths. Add directory paths inferred from matching files so "list directories"
    // has a deterministic tool path in read-only profiles without exposing Bash to the model.
    const absoluteFiles = lines.map((p) => (isAbsolute(p) ? p : join(cwd, p)))
    const directories = new Set<string>()
    for (const file of absoluteFiles) {
      const relativeFile = relative(cwd, file).replaceAll("\\", "/")
      const parts = relativeFile.split("/")
      parts.pop()
      for (let index = 1; index <= parts.length; index++) {
        const directory = parts.slice(0, index).join("/")
        if (globLikeMatch(args.pattern, directory)) directories.add(join(cwd, directory))
      }
    }
    const absolute = [...new Set([...absoluteFiles, ...directories])]
    const truncated = absolute.length > offset + limit
    const page = absolute.slice(offset, offset + limit)

    const header = `Found ${absolute.length} matching paths${truncated ? ` (showing ${page.length}; use offset to view more)` : ""}:`
    return { content: `${header}\n${page.join("\n")}` }
  }

  isReadOnly(): boolean {
    return true
  }
  isConcurrencySafe(): boolean {
    return true
  }
}

function globLikeMatch(pattern: string, value: string): boolean {
  let regex = "^"
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          regex += "(?:.*/)?"
          index += 2
        } else {
          regex += ".*"
          index++
        }
      } else {
        regex += "[^/]*"
      }
    } else if (char === "?") {
      regex += "[^/]"
    } else {
      regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }
  try {
    return new RegExp(`${regex}$`).test(value)
  } catch {
    return false
  }
}
