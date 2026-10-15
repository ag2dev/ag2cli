/**
 * Read-only composition diagnostics exposed to rich clients such as the TUI.
 *
 * This is metadata only: it intentionally excludes memory bodies, skill bodies
 * and provider credentials.
 */
export interface RuntimeStatus {
  readonly workspaceRoot: string
  readonly additionalDirectories: readonly string[]
  readonly tools: readonly string[]
  readonly skills: readonly RuntimeSkillStatus[]
  readonly agents?: readonly RuntimeAgentStatus[]
  readonly skillDiagnostics: readonly RuntimeDiagnostic[]
  readonly memories: readonly RuntimeMemoryStatus[]
  readonly instructions?: readonly RuntimeInstructionStatus[]
  readonly instructionDiagnostics?: readonly RuntimeDiagnostic[]
}

export interface RuntimeAgentStatus {
  readonly name: string
  readonly description: string
  readonly source: "project" | "user"
  readonly model?: string
  readonly tools?: readonly string[]
  /** Local definition path used only by an explicit TUI editor action. */
  readonly path?: string
}

export interface RuntimeSkillStatus {
  readonly name: string
  readonly description: string
  readonly source?: "project" | "user" | "builtin"
  /** Optional trigger keywords from frontmatter; a hint only, never auto-matched. */
  readonly triggers?: readonly string[]
}

export interface RuntimeMemoryStatus {
  readonly name: string
  readonly description: string
  readonly type: string
  readonly scope?: string
  readonly alwaysLoad?: boolean
  /** Local file path used by the interactive memory editor; not model context. */
  readonly path?: string
}

export interface RuntimeInstructionStatus {
  readonly path: string
  readonly bytes: number
}

export interface RuntimeDiagnostic {
  readonly source: string
  readonly message: string
}
