import type { SessionClient } from "@ag2cli/session-client/session-client.js"
import { SharedSessionController, type SharedSessionControllerOptions } from "@ag2cli/session-client/shared-session.js"

/** Electron main/renderer bridge entry; the host owns the actual window. */
export function connectElectronSession(client: SessionClient, options?: SharedSessionControllerOptions): Promise<SharedSessionController> {
  return SharedSessionController.connect(client, options)
}
