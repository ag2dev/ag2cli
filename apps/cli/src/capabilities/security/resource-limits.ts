/**
 * Runtime resource limits for untrusted model- and workspace-derived data.
 *
 * These limits are deliberately fixed in the application boundary. They are
 * not compatibility switches and are not user-controlled per invocation.
 */

export const MAX_STDIN_BYTES = 1 * 1024 * 1024
export const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024
export const MAX_CONTEXT_ATTACHMENTS = 16
export const MAX_CONTEXT_ATTACHMENT_BYTES = 8 * 1024 * 1024
export const MAX_TOOL_RESULT_CHARS = 64 * 1024
export const MAX_SKILL_FILE_BYTES = 256 * 1024
export const MAX_SKILL_BODY_CHARS = 128 * 1024
export const MAX_MEMORY_FILE_BYTES = 256 * 1024
export const MAX_MEMORY_HEADER_BYTES = 64 * 1024
export const MAX_MEMORY_BODY_CHARS = 128 * 1024
export const MAX_PROJECT_INSTRUCTION_BYTES = 256 * 1024
export const MAX_WEB_FETCH_RESPONSE_BYTES = 4 * 1024 * 1024
export const MAX_LOADED_SKILLS = 256
export const MAX_LOADED_MEMORIES = 256

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}
