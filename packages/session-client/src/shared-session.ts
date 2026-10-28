import type { SessionClient, SessionEventListener, SessionExecuteOptions } from "./session-client.js"
import type { SessionCommand, SessionCommandResult } from "@ag2cli/session-protocol/session-command.js"
import { SessionReplica } from "./session-replica.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"

export interface SharedSessionControllerOptions {
  readonly onChange?: (snapshot: SessionSnapshot) => void
}

/**
 * Platform-neutral session state controller.
 *
 * Electron, Android and iOS hosts all use this controller; they only provide a
 * SessionClient and render the resulting canonical snapshot. No UI toolkit or
 * native runtime is allowed to enter this module.
 */
export class SharedSessionController {
  private readonly unsubscribeReplica: () => void

  private constructor(
    private readonly client: SessionClient,
    private readonly replica: SessionReplica,
    private readonly options: SharedSessionControllerOptions,
  ) {
    this.unsubscribeReplica = replica.subscribe((snapshot) => options.onChange?.(snapshot))
  }

  static async connect(client: SessionClient, options: SharedSessionControllerOptions = {}): Promise<SharedSessionController> {
    const replica = await SessionReplica.connect(client)
    return new SharedSessionController(client, replica, options)
  }

  get sessionId(): string {
    return this.client.sessionId
  }

  get snapshot(): SessionSnapshot {
    return this.replica.snapshot
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    return this.replica.subscribe(listener)
  }

  async execute(command: SessionCommand, options?: SessionExecuteOptions): Promise<SessionCommandResult> {
    const result = await this.client.execute(command, options)
    if (hasSnapshot(result)) this.replica.sync(result.snapshot)
    return result
  }

  subscribeEvents(afterRevision: number, listener: SessionEventListener): () => void {
    return this.client.subscribe(afterRevision, listener)
  }

  close(): void {
    this.unsubscribeReplica()
    this.replica.close()
  }
}

function hasSnapshot(result: SessionCommandResult): result is Extract<SessionCommandResult, { readonly snapshot: SessionSnapshot }> {
  return "snapshot" in result
}
