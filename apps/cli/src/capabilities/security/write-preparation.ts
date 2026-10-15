/**
 * Write-tool preparation producer: labels the write target's zone as a
 * preparation fact. Scratch targets carry `{ kind: "scratch-write" }` so the
 * canonical judgment can exempt them in every permission mode; dangerous
 * targets carry `{ kind: "dangerous-write" }` so the judgment upgrades the
 * mode default to an ask; workspace and external targets carry no fact and
 * keep their existing judgment path.
 *
 * The decision stays pinned to "ask": a non-bash preparation allow would
 * itself authorize execution (F7 no-parallel-allow), so the fact may only
 * widen the canonical judgment, never bypass it. Admission (resolveWithin at
 * call time) remains the enforcer; classification here is non-throwing.
 */
import type { ToolPreparation } from "@ag2cli/core/tool-facts.js"
import type { WorkspacePolicy } from "@ag2cli/runtime/ports/workspace.js"

const WRITE_PREPARATION_VERSION = "write-preparation"

export async function prepareWritePreparation(
  preparedInput: unknown,
  targetPath: string,
  workspace: WorkspacePolicy | undefined,
): Promise<ToolPreparation> {
  const preparation: ToolPreparation = {
    status: "ready",
    decision: "ask",
    preparedInput,
    reasons: [],
    analyzerVersion: WRITE_PREPARATION_VERSION,
    policyVersion: WRITE_PREPARATION_VERSION,
  }
  if (workspace === undefined) return preparation
  const zone = await workspace.classifyWriteTarget(targetPath).catch(() => "external" as const)
  if (zone === "scratch") return { ...preparation, securityFact: { kind: "scratch-write" } }
  if (zone === "dangerous") return { ...preparation, securityFact: { kind: "dangerous-write" } }
  return preparation
}
