/**
 * Pure validation of the one configured project instruction basename.
 *
 * Owner is config: the name arrives from `AG2CLI_INSTRUCTIONS_FILE` or the
 * JSONC config file and is validated before any workspace capability is
 * assembled. The filesystem loader in `capabilities/workspace/instructions`
 * consumes this contract; it must not be re-implemented there.
 */

export const DEFAULT_PROJECT_INSTRUCTION_FILE = "AGENTS.md"

/** Validate and normalize the one configured project instruction basename. */
export function validateProjectInstructionFileName(value: string | undefined): string {
  const fileName = value?.trim() || DEFAULT_PROJECT_INSTRUCTION_FILE
  if (
    fileName === "." ||
    fileName === ".." ||
    fileName.length > 255 ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\0") ||
    /[\r\n,;:[\]{}]/.test(fileName)
  ) {
    throw new Error(`AG2CLI_INSTRUCTIONS_FILE must be a single file name: ${value ?? ""}`)
  }
  return fileName
}
