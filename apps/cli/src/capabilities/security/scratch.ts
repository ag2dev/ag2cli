/**
 * Process-level scratch-root registry.
 *
 * Registration happens at WorkspacePolicy construction — the factory rebuilds
 * a policy per tool call, so registration must be idempotent by path.
 * Entrypoints own the exit-path cleanup; reclamation is best-effort only: a
 * crashed or killed process leaves its scratch directories behind, and there
 * is deliberately no durable reclamation.
 */
import { rm } from "node:fs/promises"

const registeredRoots = new Set<string>()

/** Idempotently record a scratch root for exit-time cleanup. */
export function registerScratchRoot(root: string): void {
  registeredRoots.add(root)
}

/** Roots currently registered in this process (diagnostic/test surface). */
export function registeredScratchRoots(): readonly string[] {
  return [...registeredRoots]
}

/** Best-effort recursive removal of every registered scratch root. */
export async function cleanupScratchRoots(): Promise<void> {
  const roots = [...registeredRoots]
  registeredRoots.clear()
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}
