import type { SessionClient } from "@ag2cli/client/session-client.js"
import { SharedSessionController, type SharedSessionControllerOptions } from "@ag2cli/client/shared-session.js"

/** Android/iOS bridge entry; native UI code only renders controller snapshots. */
export function connectMobileSession(client: SessionClient, options?: SharedSessionControllerOptions): Promise<SharedSessionController> {
  return SharedSessionController.connect(client, options)
}
