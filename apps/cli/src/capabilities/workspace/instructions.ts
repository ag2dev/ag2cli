/**
 * Hierarchical project instruction files for interactive clients.
 *
 * The configured name is intentionally a single basename. The primary
 * workspace loads matching files from the filesystem root to the current
 * directory, so a nested file can refine a parent directory's instructions.
 * Additional workspace roots are independent project roots and load only
 * their own matching file.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { byteLength, MAX_PROJECT_INSTRUCTION_BYTES } from "../security/resource-limits.js"
import { DEFAULT_PROJECT_INSTRUCTION_FILE, validateProjectInstructionFileName } from "../../config/instruction-file.js"

export { DEFAULT_PROJECT_INSTRUCTION_FILE, validateProjectInstructionFileName }

export interface ProjectInstructionFile {
  readonly path: string
  readonly content: string
}

export interface ProjectInstructionDiagnostic {
  readonly path: string
  readonly message: string
}

export interface ProjectInstructionLoadResult {
  readonly files: readonly ProjectInstructionFile[]
  readonly diagnostics: readonly ProjectInstructionDiagnostic[]
}

export interface LoadProjectInstructionOptions {
  readonly cwd: string
  readonly roots?: readonly string[]
  readonly fileName?: string
}

/**
 * Load matching files with deterministic root-to-leaf precedence.
 * A malformed, unreadable, symlinked, or oversized file is ignored and
 * returned as a diagnostic instead of preventing the TUI from starting.
 */
export function loadProjectInstructionFiles(options: LoadProjectInstructionOptions): ProjectInstructionLoadResult {
  const fileName = validateProjectInstructionFileName(options.fileName)
  const diagnostics: ProjectInstructionDiagnostic[] = []
  const files: ProjectInstructionFile[] = []
  const seen = new Set<string>()

  const addCandidate = (directory: string): void => {
    const candidate = join(directory, fileName)
    let descriptor
    try {
      descriptor = lstatSync(candidate)
    } catch {
      return
    }
    if (descriptor.isSymbolicLink()) {
      diagnostics.push({ path: candidate, message: "Instruction file is a symbolic link and was not loaded" })
      return
    }
    if (!descriptor.isFile()) {
      diagnostics.push({ path: candidate, message: "Instruction path is not a regular file" })
      return
    }
    if (descriptor.size > MAX_PROJECT_INSTRUCTION_BYTES) {
      diagnostics.push({
        path: candidate,
        message: `File exceeds the ${MAX_PROJECT_INSTRUCTION_BYTES}-byte limit`,
      })
      return
    }
    let canonicalPath: string
    let content: string
    try {
      canonicalPath = realpathSync(candidate)
      content = readFileSync(canonicalPath, "utf8")
    } catch (error) {
      diagnostics.push({
        path: candidate,
        message: `Read failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    if (byteLength(content) > MAX_PROJECT_INSTRUCTION_BYTES) {
      diagnostics.push({
        path: canonicalPath,
        message: `File exceeds the ${MAX_PROJECT_INSTRUCTION_BYTES}-byte limit`,
      })
      return
    }
    if (seen.has(canonicalPath)) return
    seen.add(canonicalPath)
    files.push({ path: canonicalPath, content: content.replace(/^\uFEFF/, "") })
  }

  const primaryDirectories = ancestorDirectories(options.cwd)
  for (const directory of primaryDirectories) addCandidate(directory)

  for (const root of options.roots ?? []) {
    let canonicalRoot: string
    try {
      canonicalRoot = realpathSync(resolve(root))
    } catch {
      diagnostics.push({ path: root, message: "Additional workspace root is inaccessible; instruction files were not loaded" })
      continue
    }
    addCandidate(canonicalRoot)
  }

  return { files, diagnostics }
}

function ancestorDirectories(directory: string): string[] {
  let current = realpathSync(resolve(directory))
  const result: string[] = []
  while (true) {
    result.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return result.reverse()
}
