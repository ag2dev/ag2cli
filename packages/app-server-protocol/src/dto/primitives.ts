import { z } from "zod"

// Shared Zod building blocks for the public DTO layer. Constraints are
// expressed with Zod's native `.min()`/`.max()`/`.int()`/`.regex()` chain so
// they survive JSON Schema generation; `.refine()`-based checks degrade to
// bare types there. Each builder keeps the `name` parameter so parsers keep
// producing the same per-field error messages as before the symbols moved
// here. The `\S` pattern mirrors a `trim().length > 0` verdict, including
// rejection of whitespace-only strings.

export function nonEmptyStringSchema(name: string): z.ZodString {
  const message = `${name} must be a non-empty string`
  return z.string({ invalid_type_error: message, required_error: message }).min(1, { message }).regex(/\S/, { message })
}

export function nonNegativeIntegerSchema(name: string): z.ZodNumber {
  const message = `${name} must be a non-negative integer`
  return z
    .number({ invalid_type_error: message, required_error: message })
    .int({ message })
    .min(0, { message })
    .max(Number.MAX_SAFE_INTEGER, { message })
}

export function positiveIntegerSchema(name: string): z.ZodNumber {
  const message = `${name} must be a positive integer`
  return z
    .number({ invalid_type_error: message, required_error: message })
    .int({ message })
    .min(1, { message })
    .max(Number.MAX_SAFE_INTEGER, { message })
}

export function booleanSchema(name: string): z.ZodBoolean {
  return z.boolean({ invalid_type_error: `${name} must be a boolean` })
}

// Workspace-relative POSIX path: no leading "/" (absolute) and no ".."
// segment (lexical traversal). Fully anchored so it survives JSON Schema's
// unanchored `pattern` application.
const WORKSPACE_RELATIVE_PATH_PATTERN = /^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$))(?=.*\S).+$/

export function workspaceRelativePathSchema(name: string): z.ZodString {
  const message = `${name} must be a workspace-relative POSIX path`
  return z
    .string({ invalid_type_error: message, required_error: message })
    .min(1, { message })
    .regex(WORKSPACE_RELATIVE_PATH_PATTERN, { message })
}

export function nonEmptyStringArraySchema(name: string): z.ZodArray<z.ZodString> {
  const message = `${name} must be a non-empty string array`
  const element = z.string({ invalid_type_error: message, required_error: message }).min(1, { message }).regex(/\S/, { message })
  return z.array(element, { invalid_type_error: message })
}

/** Unlike {@link nonEmptyStringArraySchema}, free-form arrays such as
 * `session.submit`'s `context` have always allowed empty-string entries. */
export function freeformStringArraySchema(name: string): z.ZodArray<z.ZodString> {
  const message = `${name} must be a string array`
  return z.array(z.string({ invalid_type_error: message, required_error: message }), {
    invalid_type_error: message,
  })
}

// Accepts `Z`, `z` or numeric UTC offsets; seconds are mandatory (matching
// `Date.prototype.toISOString` output), fractional seconds are optional.
const ISO_8601_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

export function iso8601TimestampSchema(name: string): z.ZodString {
  const message = `${name} must be an ISO-8601 timestamp string`
  return z.string({ invalid_type_error: message, required_error: message }).regex(ISO_8601_TIMESTAMP_PATTERN, { message })
}
