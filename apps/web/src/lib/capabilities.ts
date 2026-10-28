import type { AppServerCapabilities } from "@ag2cli/app-server-protocol/dto/capabilities.js"

/** Static degradation gates derived from server.initialize capabilities
 * (contract §5): a missing capability hides or disables the matching face;
 * it never errors. */
export interface SessionCapabilities {
  readonly steer: boolean
  readonly cancelInput: boolean
  readonly askUser: boolean
  readonly permissionModes: readonly string[]
  readonly workspace: { readonly diff: boolean; readonly readFile: boolean }
  readonly shell: boolean
}

export function sessionCapabilities(capabilities: AppServerCapabilities | undefined): SessionCapabilities {
  return {
    steer: capabilities?.session.methods.includes("session.steer") ?? false,
    cancelInput: capabilities?.session.methods.includes("session.cancelInput") ?? false,
    askUser: capabilities?.interactions.askUser ?? false,
    permissionModes: [...(capabilities?.security.permissionModes ?? [])],
    workspace: { diff: capabilities?.workspace.diff ?? false, readFile: capabilities?.workspace.readFile ?? false },
    shell: capabilities?.execution.explicitShell ?? false,
  }
}
