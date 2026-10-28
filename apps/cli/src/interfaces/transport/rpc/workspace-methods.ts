/**
 * Workspace read-only face (contract §12): `workspace.diff` and
 * `workspace.readFile`. Both require `workspace:read` and resolve the
 * session's workspace through the same registry/implicit-root authority the
 * catalog projection uses. Pagination and snapshot-continuation semantics
 * live here; structured diff assembly and path policy live behind the
 * injected inspection port (owner: capabilities/workspace).
 */
import { createHash } from "node:crypto"
import type { WorkspaceDiffResult, WorkspaceReadFileResult } from "@ag2cli/app-server-protocol/types.js"
import { parseWorkspaceDiffParams, parseWorkspaceReadFileParams } from "@ag2cli/app-server-protocol/validation.js"
import { sessionId } from "@ag2cli/core/ids.js"
import type { MethodContext } from "./method-context.js"
import { RpcApplicationError } from "../public-session-command-mapping.js"

export type WorkspaceChangeOperation = "add" | "delete" | "modify" | "move" | "copy"
export type WorkspaceFileKind = "text" | "binary" | "symlink" | "directory" | "unknown"

export interface WorkspaceDiffEntryData {
  readonly operation: WorkspaceChangeOperation
  readonly path: string
  readonly oldPath?: string
  readonly fileKind: WorkspaceFileKind
  readonly additions?: number
  readonly deletions?: number
  readonly truncated: boolean
  readonly gitPatch?: string
}

export interface WorkspaceDiffStateData {
  readonly head?: string
  readonly workingTreeDigest: string
}

export interface WorkspaceReadFileData {
  readonly kind: "text" | "binary"
  readonly sizeBytes: number
  readonly digest: string
  readonly totalLines?: number
  readonly startLine?: number
  readonly content?: string
  readonly nextStartLine?: number
}

export type WorkspaceInspectionFailureCode = "workspace_unavailable" | "workspace_path_denied"

export interface WorkspaceDiffOutcome {
  readonly ok: boolean
  readonly state?: WorkspaceDiffStateData
  readonly changes?: readonly WorkspaceDiffEntryData[]
  readonly code?: WorkspaceInspectionFailureCode
  readonly message?: string
}

export interface WorkspaceReadFileOutcome {
  readonly ok: boolean
  readonly file?: WorkspaceReadFileData
  readonly code?: WorkspaceInspectionFailureCode
  readonly message?: string
}

/**
 * Port owned by the transport boundary; the concrete inspector lives in
 * capabilities/workspace and satisfies this shape structurally. Failures are
 * values, not exceptions, so transport never imports capabilities error
 * classes.
 */
export interface WorkspaceInspectionPort {
  diff(root: string, options?: { readonly includePatch?: boolean }): Promise<WorkspaceDiffOutcome>
  readFile(
    root: string,
    path: string,
    window?: { readonly startLine?: number; readonly maxLines?: number },
  ): Promise<WorkspaceReadFileOutcome>
}

const DEFAULT_DIFF_LIMIT = 200
const MAX_DIFF_LIMIT = 500

function stateKey(state: WorkspaceDiffStateData): string {
  return createHash("sha256")
    .update(`${state.head ?? "-"}\n${state.workingTreeDigest}`)
    .digest("hex")
}

export class WorkspaceMethods {
  constructor(private readonly context: MethodContext) {}

  async diff(value: unknown): Promise<WorkspaceDiffResult> {
    this.context.requireScope("workspace:read")
    const params = parseWorkspaceDiffParams(value)
    const { sessionId: id, workspaceId, root } = await this.resolveSessionWorkspace(params.sessionId)
    const inspection = this.requireInspection()
    const outcome = await inspection.diff(root, { includePatch: params.includePatch === true })
    if (!outcome.ok || outcome.state === undefined || outcome.changes === undefined) {
      throw inspectionFailure(outcome.code, outcome.message)
    }
    const key = stateKey(outcome.state)
    let offset = 0
    if (params.cursor !== undefined) {
      const separator = params.cursor.lastIndexOf(":")
      const cursorOffset = separator === -1 ? Number.NaN : Number(params.cursor.slice(separator + 1))
      if (separator === -1 || !Number.isInteger(cursorOffset) || cursorOffset < 0) {
        throw new RpcApplicationError("invalid_params", `cursor is malformed: ${params.cursor}`)
      }
      if (params.cursor.slice(0, separator) !== key) {
        throw new RpcApplicationError("workspace_changed", `Workspace changed since the paginated diff started: ${workspaceId}`, {
          sessionId: id,
        })
      }
      offset = cursorOffset
    }
    const limit = Math.min(params.limit ?? DEFAULT_DIFF_LIMIT, MAX_DIFF_LIMIT)
    const page = outcome.changes.slice(offset, offset + limit)
    return {
      sessionId: id,
      workspaceId,
      snapshotToken: key,
      asOf: {
        ...(outcome.state.head === undefined ? {} : { head: outcome.state.head }),
        workingTreeDigest: outcome.state.workingTreeDigest,
      },
      changes: page,
      ...(offset + page.length < outcome.changes.length ? { nextCursor: `${key}:${offset + page.length}` } : {}),
    }
  }

  async readFile(value: unknown): Promise<WorkspaceReadFileResult> {
    this.context.requireScope("workspace:read")
    const params = parseWorkspaceReadFileParams(value)
    const { sessionId: id, workspaceId, root } = await this.resolveSessionWorkspace(params.sessionId)
    const inspection = this.requireInspection()
    const outcome = await inspection.readFile(root, params.path, {
      ...(params.startLine === undefined ? {} : { startLine: params.startLine }),
      ...(params.maxLines === undefined ? {} : { maxLines: params.maxLines }),
    })
    if (!outcome.ok || outcome.file === undefined) {
      throw inspectionFailure(outcome.code, outcome.message)
    }
    const file = outcome.file
    if (params.expectedDigest !== undefined && file.digest !== params.expectedDigest) {
      throw new RpcApplicationError("workspace_changed", `Workspace file changed since it was read: ${params.path}`, { sessionId: id })
    }
    return {
      sessionId: id,
      workspaceId,
      path: params.path,
      kind: file.kind,
      ...(file.content === undefined ? {} : { content: file.content, encoding: "utf-8" as const }),
      sizeBytes: file.sizeBytes,
      digest: file.digest,
      ...(file.startLine === undefined ? {} : { startLine: file.startLine }),
      ...(file.totalLines === undefined ? {} : { totalLines: file.totalLines }),
      ...(file.nextStartLine === undefined ? {} : { nextStartLine: file.nextStartLine }),
    }
  }

  private requireInspection(): WorkspaceInspectionPort {
    const inspection = this.context.workspaceInspection
    if (inspection === undefined) {
      throw new RpcApplicationError("capability_unavailable", "Workspace inspection is not enabled on this Host")
    }
    return inspection
  }

  /**
   * Session identity comes from the catalog record (workspaceId, else derived
   * from its workspace root); a serve registry that no longer knows the id —
   * or a Host with neither record root nor implicit root — is unavailable.
   */
  private resolveSessionWorkspace(
    value: string,
  ): Promise<{ readonly sessionId: string; readonly workspaceId: string; readonly root: string }> {
    return resolveSessionWorkspace(this.context, value)
  }
}

/** Shared session-workspace authority: the workspace face resolves reads and
 * the shell task face resolves `cwdRelative` against the same root. */
export async function resolveSessionWorkspace(
  context: MethodContext,
  value: string,
): Promise<{ readonly sessionId: string; readonly workspaceId: string; readonly root: string }> {
  const id = sessionId(value)
  await context.requireExistingSession(id)
  const record = context.catalog === undefined ? undefined : await context.catalog.get(id)
  const root = record?.snapshot.workspaceRoot ?? context.workspaceRoot
  if (root === undefined) {
    throw new RpcApplicationError("workspace_unavailable", `Session has no workspace on this Host: ${id}`)
  }
  const workspaceId = record?.workspaceId ?? context.workspaceIdForRoot(root)
  if (context.workspaceRegistry !== undefined) {
    const registration = await context.workspaceRegistry.get(workspaceId)
    if (registration === undefined) {
      throw new RpcApplicationError("workspace_unavailable", `workspaceId is not registered on this server: ${workspaceId}`)
    }
    return { sessionId: id, workspaceId, root: registration.workspaceRoot }
  }
  return { sessionId: id, workspaceId, root }
}

function inspectionFailure(code: WorkspaceInspectionFailureCode | undefined, message: string | undefined): RpcApplicationError {
  return new RpcApplicationError(code ?? "internal_error", message ?? "Workspace inspection failed")
}
