/**
 * The permission desk: the coordinator-owned facts behind the
 * permission surfaces. It holds the in-process full-access
 * confirmation ledger (keyed by session id, so a switch within the
 * process reuses it while a new process re-confirms) and the newest
 * mode/rules submissions with their canonical outcomes, keyed by
 * operation id so a late or superseded result settles nothing. The
 * task kit probe reads it live at key and render time — no inbound
 * channel into the engines exists.
 */
import type { PermissionTaskFacts } from "../tasks/index.js"
import type { OperationId, TuiKernelPorts } from "./contract.js"

/** Where a mode submission was born; the confirm card is the only via-confirm path. */
export type ModeSubmitOrigin = "slash" | "mode-row" | "rotation" | "confirm"

type SubmissionStatus = "pending" | "applied" | "stale" | "failed"

interface ModeSubmission {
  readonly mode: string
  readonly operationId: OperationId
  readonly origin: ModeSubmitOrigin
  status: SubmissionStatus
}

interface RulesSubmission {
  readonly names: readonly string[]
  readonly operationId: OperationId
  status: SubmissionStatus
}

/** What a settled operation moved; the origin rides along so force-completes close the right card. */
export type PermissionSettlement = { readonly target: "mode"; readonly origin: ModeSubmitOrigin } | { readonly target: "rules" } | null

export class PermissionDesk {
  private readonly confirmed = new Set<string>()
  private modeSubmission: ModeSubmission | null = null
  private rulesSubmission: RulesSubmission | null = null

  isConfirmed(sessionId: string | null): boolean {
    return sessionId !== null && this.confirmed.has(sessionId)
  }

  markConfirmed(sessionId: string): void {
    this.confirmed.add(sessionId)
  }

  submitMode(operationId: OperationId, mode: string, origin: ModeSubmitOrigin): void {
    this.modeSubmission = { mode, operationId, origin, status: "pending" }
  }

  submitRules(operationId: OperationId, names: readonly string[]): void {
    this.rulesSubmission = { names: names.slice(), operationId, status: "pending" }
  }

  settle(operationId: OperationId, status: "applied" | "stale" | "failed"): PermissionSettlement {
    const mode = this.modeSubmission
    if (mode?.operationId === operationId) {
      mode.status = status
      return { target: "mode", origin: mode.origin }
    }
    const rules = this.rulesSubmission
    if (rules?.operationId === operationId) {
      rules.status = status
      return { target: "rules" }
    }
    return null
  }

  /** Lineage-scoped submissions die with the binding; confirmed sessions survive for in-process reuse. */
  clearTransient(): void {
    this.modeSubmission = null
    this.rulesSubmission = null
  }

  /** Assemble the live facts the permission and confirm cards read; called per probe, never cached. */
  facts(sessionId: string | null, probe: ReturnType<TuiKernelPorts["permission"]>): PermissionTaskFacts {
    return {
      mirror:
        probe === null
          ? null
          : {
              currentMode: probe.currentMode,
              selectableModes: probe.selectableModes,
              guardianAvailable: probe.guardianAvailable,
              rules: probe.rules,
              directories: probe.directories,
              workspaceRoot: probe.workspaceRoot,
              deniedLedger: probe.deniedLedger,
            },
      fullAccessConfirmed: this.isConfirmed(sessionId),
      modeSubmission:
        this.modeSubmission === null
          ? null
          : {
              mode: this.modeSubmission.mode,
              status: this.modeSubmission.status,
              viaConfirm: this.modeSubmission.origin === "confirm",
            },
      rulesSubmission: this.rulesSubmission === null ? null : { names: this.rulesSubmission.names, status: this.rulesSubmission.status },
    }
  }
}
