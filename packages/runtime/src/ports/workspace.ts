/**
 * Runtime-owned workspace boundary. The Host supplies the filesystem-backed implementation.
 *
 * Modes: read (file reads), write (file writes), traverse (recursive search
 * roots such as glob/grep — external roots allowed), bash-cwd (the cwd a bash
 * process will start in — restricted to the admitted roots).
 */
export type AccessMode = "read" | "write" | "traverse" | "bash-cwd"

export interface WorkspacePolicyOptions {
  readonly workspaceRoot: string
  readonly additionalDirectories?: readonly string[]
  /**
   * Session identity scoping the per-session scratch zone. Absent on the
   * directly constructed policy instances that legitimately have no scratch.
   */
  readonly sessionId?: string
}

/**
 * Zone classification of a write target; consumed as a preparation fact.
 * `dangerous` labels a target inside the admitted roots that hits the
 * ask-side dangerous list — admission still passes it; the judgment asks.
 */
export type WriteTargetClassification = "scratch" | "workspace" | "dangerous" | "external"

export interface WorkspacePolicy {
  readonly workspaceRoot: string
  readonly additionalDirectories: readonly string[]
  readonly effectiveDirectories: readonly string[]
  readonly scopeRevision: number
  readonly scopeDigest: string
  /** Per-session scratch root; undefined when this policy has no scratch zone. */
  readonly scratchRoot?: string
  addAdditionalDirectory(directory: string): Promise<{ readonly canonical: string; readonly changed: boolean }>
  resolveWithin(targetPath: string, mode: AccessMode): Promise<string>
  assertWithin(targetPath: string, mode: AccessMode): Promise<void>
  isAllowed(targetPath: string, mode: AccessMode): Promise<boolean>
  setAdditionalDirectories(directories: readonly string[]): void
  /**
   * Non-throwing write-target classification for the permission judgment's
   * preparation facts. Admission (resolveWithin) stays the enforcer; this
   * seam only labels the zone.
   */
  classifyWriteTarget(targetPath: string): Promise<WriteTargetClassification>
}

export type WorkspacePolicyFactory = (options: WorkspacePolicyOptions) => WorkspacePolicy
export type WorkspaceScopeDigest = (workspaceRoot: string, additionalDirectories: readonly string[]) => string
