import { isAbsolute } from "node:path"
import { z } from "zod/v4"

/** Schema for a model-facing filesystem target that must be absolute. */
export function absolutePathSchema(description: string) {
  return z
    .string()
    .min(1, "Path must not be empty")
    .refine((value) => isAbsolute(value), "Path must be absolute")
    .describe(description)
}

/** Defense-in-depth check for callers that invoke a tool outside ToolRegistry. */
export function assertAbsolutePath(value: string, field: string): void {
  if (!value.trim() || !isAbsolute(value)) {
    throw new Error(`${field} must be an absolute path`)
  }
}
