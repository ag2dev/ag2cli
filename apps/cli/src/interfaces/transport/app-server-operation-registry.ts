export interface AppServerOperation {
  readonly signal: AbortSignal
  release(): void
}

/** Host-wide operation cancellation shared by every client connection. */
export class AppServerOperationRegistry {
  private readonly operations = new Map<string, AbortController>()

  begin(key: string): AppServerOperation {
    if (this.operations.has(key)) throw new Error(`commandId is already running: ${key.slice(key.lastIndexOf(":") + 1)}`)
    const controller = new AbortController()
    this.operations.set(key, controller)
    let released = false
    return {
      signal: controller.signal,
      release: () => {
        if (released) return
        released = true
        if (this.operations.get(key) === controller) this.operations.delete(key)
      },
    }
  }

  cancel(key: string, reason = new DOMException("Session operation cancelled", "AbortError")): boolean {
    const controller = this.operations.get(key)
    if (controller === undefined) return false
    controller.abort(reason)
    return true
  }

  close(reason = new Error("App Server Host closed")): void {
    for (const controller of this.operations.values()) controller.abort(reason)
    this.operations.clear()
  }
}

export function appServerOperationKey(sessionId: string, commandId: string): string {
  return `${sessionId}:${commandId}`
}
