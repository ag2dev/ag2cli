import { z } from "zod"
import { nonEmptyStringSchema, nonNegativeIntegerSchema, positiveIntegerSchema, workspaceRelativePathSchema } from "./primitives.js"

// Read-only workspace surface. Structured entries are authoritative; git
// patch text is display data and never an apply authority. Paths are
// workspace-relative POSIX paths only.

export const workspaceChangeOperationSchema = z.enum(["add", "delete", "modify", "move", "copy"])
export type WorkspaceChangeOperation = z.infer<typeof workspaceChangeOperationSchema>

export const workspaceFileKindSchema = z.enum(["text", "binary", "symlink", "directory", "unknown"])
export type WorkspaceFileKind = z.infer<typeof workspaceFileKindSchema>

export const workspaceDiffParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("workspace.diff.sessionId"),
    cursor: nonEmptyStringSchema("workspace.diff.cursor").optional(),
    limit: positiveIntegerSchema("workspace.diff.limit").optional(),
    includePatch: z.boolean().optional(),
  })
  .strict()
export type WorkspaceDiffParams = z.infer<typeof workspaceDiffParamsSchema>

export const workspaceDiffChangeSchema = z
  .object({
    operation: workspaceChangeOperationSchema,
    path: workspaceRelativePathSchema("workspace.diff.change.path"),
    oldPath: workspaceRelativePathSchema("workspace.diff.change.oldPath").optional(),
    fileKind: workspaceFileKindSchema,
    additions: nonNegativeIntegerSchema("workspace.diff.change.additions").optional(),
    deletions: nonNegativeIntegerSchema("workspace.diff.change.deletions").optional(),
    truncated: z.boolean(),
    gitPatch: z.string().optional(),
  })
  .strict()
export type WorkspaceDiffChange = z.infer<typeof workspaceDiffChangeSchema>

export const workspaceDiffResultSchema = z
  .object({
    sessionId: nonEmptyStringSchema("workspace.diff.sessionId"),
    workspaceId: nonEmptyStringSchema("workspace.diff.workspaceId"),
    snapshotToken: nonEmptyStringSchema("workspace.diff.snapshotToken"),
    asOf: z
      .object({
        head: nonEmptyStringSchema("workspace.diff.asOf.head").optional(),
        indexTree: nonEmptyStringSchema("workspace.diff.asOf.indexTree").optional(),
        workingTreeDigest: nonEmptyStringSchema("workspace.diff.asOf.workingTreeDigest"),
      })
      .strict(),
    changes: z.array(workspaceDiffChangeSchema),
    nextCursor: nonEmptyStringSchema("workspace.diff.nextCursor").optional(),
  })
  .strict()
export type WorkspaceDiffResult = z.infer<typeof workspaceDiffResultSchema>

export const workspaceReadFileParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema("workspace.readFile.sessionId"),
    path: workspaceRelativePathSchema("workspace.readFile.path"),
    startLine: positiveIntegerSchema("workspace.readFile.startLine").optional(),
    maxLines: positiveIntegerSchema("workspace.readFile.maxLines").optional(),
    expectedDigest: nonEmptyStringSchema("workspace.readFile.expectedDigest").optional(),
  })
  .strict()
export type WorkspaceReadFileParams = z.infer<typeof workspaceReadFileParamsSchema>

export const workspaceReadFileResultSchema = z
  .object({
    sessionId: nonEmptyStringSchema("workspace.readFile.sessionId"),
    workspaceId: nonEmptyStringSchema("workspace.readFile.workspaceId"),
    path: nonEmptyStringSchema("workspace.readFile.path"),
    kind: z.enum(["text", "binary"]),
    content: z.string().optional(),
    encoding: z.literal("utf-8").optional(),
    sizeBytes: nonNegativeIntegerSchema("workspace.readFile.sizeBytes"),
    digest: nonEmptyStringSchema("workspace.readFile.digest"),
    startLine: positiveIntegerSchema("workspace.readFile.startLine").optional(),
    totalLines: positiveIntegerSchema("workspace.readFile.totalLines").optional(),
    nextStartLine: positiveIntegerSchema("workspace.readFile.nextStartLine").optional(),
  })
  .strict()
export type WorkspaceReadFileResult = z.infer<typeof workspaceReadFileResultSchema>
