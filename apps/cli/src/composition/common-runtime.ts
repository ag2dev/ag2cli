import { isAbsolute, resolve } from "node:path"
import type { RuntimeConfig } from "../config/runtime.js"

/**
 * Shared composition inputs; lifecycle policy remains owned by each entrypoint.
 * This module deliberately contains only deterministic dependency preparation.
 * It must not acquire leases, create transports, or own UI/output lifecycle.
 */

/**
 * Resolve workspace-owned configuration without mutating the service-level
 * configuration object. Serve creates one context per registry workspace;
 * local TUI and agent run normally create one for their current workspace.
 */
export function resolveWorkspaceRuntimeConfig(config: RuntimeConfig, workspaceRoot: string): RuntimeConfig {
  const workspacePath = (value: string): string => (isAbsolute(value) ? value : resolve(workspaceRoot, value))
  return {
    ...config,
    paths: {
      ...config.paths,
      memoryRoot: workspacePath(config.paths.memoryRoot),
    },
  }
}
