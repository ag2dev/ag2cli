import { createHash } from "node:crypto"
import type { ToolPreparation } from "@ag2cli/core/tool-facts.js"
import { isPreparedSecurityFact } from "@ag2cli/core/tool-facts.js"
export { isModelBashInput, MAX_MODEL_BASH_TIMEOUT_MS, type ModelBashInput } from "@ag2cli/core/model-bash.js"
import { isModelBashInput } from "@ag2cli/core/model-bash.js"

export const BASH_PREPARATION_VERSION = "ag2cli-bash-preparation-2026-10-05"
export const BASH_POLICY_VERSION = "ag2cli-canonical-1"

/** Deterministic binding of an approved command to its exact cwd. */
export function canonicalFingerprint(command: string, cwd: string): string {
  return createHash("sha256").update(`${BASH_PREPARATION_VERSION}\0${BASH_POLICY_VERSION}\0${cwd}\0${command}`, "utf8").digest("hex")
}

export function fixedBashArgv(command: string): string[] {
  return ["/bin/bash", "--noprofile", "--norc", "-c", command]
}

/**
 * Enforce the model-Bash contract at every executor boundary. The registry is
 * the normal producer, but remote/custom ToolExecutors are still untrusted:
 * an allow result without a command fingerprint must become a durable deny
 * fact before any provider can start a process.
 */
export function normalizeModelBashPreparation(input: unknown, preparation: ToolPreparation): ToolPreparation {
  if (!isModelBashInput(input)) {
    return invalidBashPreparation(input, "Model Bash input does not satisfy the strict command schema")
  }
  if (!isPreparationShape(preparation)) {
    return invalidBashPreparation(input, "Model Bash preparation has an invalid structure")
  }
  // The only legal Bash fact is the read-only template; a write-side fact
  // riding a Bash preparation could mint an allow for a different effect.
  if (preparation.securityFact !== undefined && preparation.securityFact.kind !== "bash-read-only-template") {
    return invalidBashPreparation(input, "Model Bash preparation cannot include write-side security facts")
  }
  if (preparation.policyVersion === "user-owned") {
    return invalidBashPreparation(input, "Model Bash cannot use a user-owned preparation")
  }
  if (preparation.status === "ready" && preparation.decision === "deny") {
    return invalidBashPreparation(input, "A ready model Bash preparation cannot use deny")
  }
  // Every non-ready status — the terminal denials and the replayed "reused"
  // fact — must carry deny: model Bash has no reuse-execution path, so the
  // only preparation shape that may reach a spawn is ready.
  if (preparation.status !== "ready" && preparation.decision !== "deny") {
    return invalidBashPreparation(input, "A non-ready model Bash preparation must use deny")
  }
  if (preparation.status === "ready" && !preparation.approvalFingerprint) {
    return invalidBashPreparation(input, "Model Bash preparation is missing approvalFingerprint")
  }
  if (preparation.status === "ready" && !isModelBashInput(preparation.preparedInput)) {
    return invalidBashPreparation(input, "Model Bash preparation is missing a valid command")
  }
  return preparation
}

function isPreparationShape(value: unknown): value is ToolPreparation {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    (candidate.status === "ready" ||
      candidate.status === "invalid" ||
      candidate.status === "blocked" ||
      candidate.status === "denied" ||
      candidate.status === "reused") &&
    (candidate.decision === "allow" || candidate.decision === "ask" || candidate.decision === "deny") &&
    Array.isArray(candidate.reasons) &&
    candidate.reasons.every((reason) => typeof reason === "string") &&
    typeof candidate.analyzerVersion === "string" &&
    candidate.analyzerVersion.length > 0 &&
    typeof candidate.policyVersion === "string" &&
    candidate.policyVersion.length > 0 &&
    (candidate.scopeRevision === undefined ||
      (typeof candidate.scopeRevision === "number" && Number.isInteger(candidate.scopeRevision) && candidate.scopeRevision >= 0)) &&
    (candidate.scopeDigest === undefined || (typeof candidate.scopeDigest === "string" && /^[a-f0-9]{64}$/.test(candidate.scopeDigest))) &&
    (candidate.policyRevision === undefined ||
      (typeof candidate.policyRevision === "number" && Number.isInteger(candidate.policyRevision) && candidate.policyRevision >= 0)) &&
    (candidate.securityFact === undefined || isPreparedSecurityFact(candidate.securityFact))
  )
}

function invalidBashPreparation(input: unknown, reason: string): ToolPreparation {
  return {
    status: "invalid",
    decision: "deny",
    preparedInput: input,
    reasons: [reason],
    analyzerVersion: "executor-contract",
    policyVersion: "executor-contract",
  }
}
