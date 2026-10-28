import {
  APP_SERVER_INTERACTION_LEASE_SCOPES,
  type AppServerInteractionLease,
  type AppServerInteractionLeases,
  type InteractionLeaseScope,
} from "@ag2cli/app-server-protocol/types.js"
import type { AppServerRpcClient } from "@ag2cli/app-server-client/client.js"
import { requestInteractionLease } from "@ag2cli/app-server-client/interaction.js"

export interface BrowserInteractionConnection {
  readonly rpc: AppServerRpcClient
  readonly connectionId: string
}

export interface BrowserInteractionLeaseUpdate {
  readonly sessionId: string
  readonly scope: InteractionLeaseScope
  readonly lease: AppServerInteractionLease
}

export interface BrowserInteractionLeaseControllerOptions {
  readonly onLease?: (update: BrowserInteractionLeaseUpdate) => void
  /** Ignore a response that belongs to an old Session or physical connection. */
  readonly isCurrent: (sessionId: string, connection: BrowserInteractionConnection) => boolean
}

export interface BrowserInteractionLeaseAcquireOptions {
  readonly signal?: AbortSignal
}

interface ScopedLeaseState {
  lease: AppServerInteractionLease
  epoch: number
  /** Locally tracked self-ownership: the holder wire shape carries no connection identity. */
  mine?: { readonly key: string; readonly generation: number }
  pendingAcquire?: {
    readonly key: string
    readonly promise: Promise<number | undefined>
  }
  readonly desired: Set<string>
  // Deliberately hand-rolled: release dedupe mixes disciplines a shared
  // once-guard does not offer — wait-for-existing before reacquire,
  // identity-checked delete on settle, and wholesale clear on epoch
  // reset — and the web client stays free of the runtime package owning
  // the shared primitives.
  readonly pendingReleases: Map<string, Promise<void>>
}

/** Coordinates both ephemeral interaction lease scopes without owning Session state or transport recovery. */
export class BrowserInteractionLeaseController {
  private readonly states = new Map<string, ScopedLeaseState>()
  private readonly listeners = new Set<(update: BrowserInteractionLeaseUpdate) => void>()

  constructor(private readonly options: BrowserInteractionLeaseControllerOptions) {}

  onLease(listener: (update: BrowserInteractionLeaseUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  observe(sessionId: string, leases: AppServerInteractionLeases): void {
    for (const scope of APP_SERVER_INTERACTION_LEASE_SCOPES) this.observeLease(sessionId, scope, leases[scope])
  }

  observeLease(sessionId: string, scope: InteractionLeaseScope, lease: AppServerInteractionLease): void {
    const state = this.stateFor(sessionId, scope)
    if (lease.generation < state.lease.generation) return
    this.publish(sessionId, scope, state, lease)
  }

  /** Invalidate local ownership after a physical reconnect, close, or Session switch. */
  reset(sessionId?: string): void {
    const entries =
      sessionId === undefined
        ? [...this.states.entries()]
        : [...this.states.entries()].filter(([key]) => key.startsWith(`${sessionId}\u0000`))
    for (const [key, state] of entries) {
      const separator = key.indexOf("\u0000")
      const currentSessionId = separator < 0 ? key : key.slice(0, separator)
      const scope = separator < 0 ? undefined : key.slice(separator + 1)
      if (scope !== "composer" && scope !== "session-control") continue
      state.epoch += 1
      state.desired.clear()
      state.mine = undefined
      state.pendingAcquire = undefined
      state.pendingReleases.clear()
      this.publish(currentSessionId, scope, state, availableLease(), true)
    }
  }

  currentLease(sessionId: string, scope: InteractionLeaseScope): AppServerInteractionLease {
    return this.stateFor(sessionId, scope).lease
  }

  currentGeneration(sessionId: string, scope: InteractionLeaseScope, connectionId?: string): number | undefined {
    const lease = this.currentLease(sessionId, scope)
    if (lease.status !== "held") return undefined
    if (connectionId !== undefined && !this.heldBySelf(this.stateFor(sessionId, scope), `${sessionId}:${connectionId}`, lease))
      return undefined
    return lease.generation
  }

  async acquire(
    sessionId: string,
    scope: InteractionLeaseScope,
    connection: BrowserInteractionConnection,
    options: BrowserInteractionLeaseAcquireOptions = {},
  ): Promise<number | undefined> {
    throwIfAborted(options.signal)
    if (!this.options.isCurrent(sessionId, connection)) return undefined
    const state = this.stateFor(sessionId, scope)
    const key = interactionKey(sessionId, connection)
    state.desired.add(key)
    const pendingRelease = state.pendingReleases.get(key)
    if (pendingRelease !== undefined) {
      await waitWithAbort(pendingRelease, options.signal)
      if (!this.options.isCurrent(sessionId, connection) || !state.desired.has(key)) return undefined
    }
    const current = state.lease
    if (current.status === "held" && !this.heldBySelf(state, key, current)) {
      throwIfAborted(options.signal)
      return undefined
    }
    if (state.pendingAcquire?.key === key) return waitWithAbort(state.pendingAcquire.promise, options.signal)

    const epoch = state.epoch
    const promise = requestInteractionLease(connection.rpc, "interaction.acquire", sessionId, scope, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }).then(async (next) => {
      // A successful acquire result can only be held by this connection.
      if (next.status === "held") state.mine = { key, generation: next.generation }
      if (state.epoch !== epoch) {
        if (this.options.isCurrent(sessionId, connection) && next.status === "held") {
          await this.release(sessionId, scope, connection, next.generation)
        }
        return undefined
      }
      if (!this.options.isCurrent(sessionId, connection)) return undefined
      if (next.generation < state.lease.generation) return undefined
      this.publish(sessionId, scope, state, next)
      if (!state.desired.has(key)) {
        if (next.status === "held") {
          await this.release(sessionId, scope, connection, next.generation)
        }
        return undefined
      }
      return next.status === "held" ? next.generation : undefined
    })
    state.pendingAcquire = { key, promise }
    void promise.then(
      () => this.clearPendingAcquire(state, promise),
      () => this.clearPendingAcquire(state, promise),
    )
    return promise
  }

  async renew(sessionId: string, scope: InteractionLeaseScope, connection: BrowserInteractionConnection): Promise<void> {
    if (!this.options.isCurrent(sessionId, connection)) return
    const state = this.stateFor(sessionId, scope)
    const current = state.lease
    if (current.status !== "held" || !this.heldBySelf(state, interactionKey(sessionId, connection), current)) return
    const generation = current.generation
    const epoch = state.epoch
    const next = await requestInteractionLease(connection.rpc, "interaction.renew", sessionId, scope, {
      leaseGeneration: generation,
    })
    if (state.epoch !== epoch || !this.options.isCurrent(sessionId, connection) || state.lease.generation > generation) return
    this.publish(sessionId, scope, state, next)
  }

  async release(
    sessionId: string,
    scope: InteractionLeaseScope,
    connection: BrowserInteractionConnection,
    generation: number,
  ): Promise<void> {
    const state = this.stateFor(sessionId, scope)
    const key = interactionKey(sessionId, connection)
    state.desired.delete(key)
    const existing = state.pendingReleases.get(key)
    if (existing !== undefined) {
      await existing
      return
    }
    const epoch = state.epoch
    const release = requestInteractionLease(connection.rpc, "interaction.release", sessionId, scope, {
      leaseGeneration: generation,
    })
      .then((next) => {
        if (state.epoch === epoch && this.options.isCurrent(sessionId, connection)) this.publish(sessionId, scope, state, next)
      })
      .catch(() => {
        const current = state.lease
        if (
          state.epoch === epoch &&
          this.options.isCurrent(sessionId, connection) &&
          current.status === "held" &&
          this.heldBySelf(state, key, current) &&
          current.generation === generation
        ) {
          this.publish(sessionId, scope, state, availableLease(generation))
        }
      })
    state.pendingReleases.set(key, release)
    try {
      await release
    } finally {
      if (state.pendingReleases.get(key) === release) state.pendingReleases.delete(key)
    }
  }

  async releaseIfHeld(sessionId: string, scope: InteractionLeaseScope, connection: BrowserInteractionConnection): Promise<void> {
    const state = this.stateFor(sessionId, scope)
    const key = interactionKey(sessionId, connection)
    state.desired.delete(key)
    const pendingAcquire = state.pendingAcquire?.key === key ? state.pendingAcquire.promise : undefined
    if (pendingAcquire !== undefined) {
      let generation: number | undefined
      try {
        generation = await pendingAcquire
      } catch {
        return
      }
      if (generation !== undefined && !state.desired.has(key)) await this.release(sessionId, scope, connection, generation)
      return
    }
    const current = state.lease
    if (current.status === "held" && this.heldBySelf(state, key, current)) {
      await this.release(sessionId, scope, connection, current.generation)
    }
  }

  async takeover(
    sessionId: string,
    scope: InteractionLeaseScope,
    connection: BrowserInteractionConnection,
  ): Promise<AppServerInteractionLease> {
    if (!this.options.isCurrent(sessionId, connection)) return this.currentLease(sessionId, scope)
    const state = this.stateFor(sessionId, scope)
    state.desired.add(interactionKey(sessionId, connection))
    const epoch = state.epoch
    const next = await requestInteractionLease(connection.rpc, "interaction.takeover", sessionId, scope)
    const isCurrent = this.options.isCurrent(sessionId, connection)
    if (state.epoch !== epoch || !isCurrent) {
      if (state.epoch !== epoch && isCurrent && next.status === "held") {
        await this.release(sessionId, scope, connection, next.generation)
      }
      return this.currentLease(sessionId, scope)
    }
    if (next.generation < state.lease.generation) return state.lease
    // A successful takeover result can only be held by this connection.
    if (next.status === "held") state.mine = { key: interactionKey(sessionId, connection), generation: next.generation }
    this.publish(sessionId, scope, state, next)
    return next
  }

  async withLease<T>(
    sessionId: string,
    scope: InteractionLeaseScope,
    connection: BrowserInteractionConnection,
    options: BrowserInteractionLeaseAcquireOptions,
    operation: (generation: number) => Promise<T> | T,
  ): Promise<T> {
    const generation = await this.acquire(sessionId, scope, connection, options)
    if (generation === undefined) throw new BrowserInteractionLeaseUnavailableError(scope, this.currentLease(sessionId, scope))
    try {
      return await operation(generation)
    } finally {
      await this.release(sessionId, scope, connection, generation)
    }
  }

  private stateFor(sessionId: string, scope: InteractionLeaseScope): ScopedLeaseState {
    const key = `${sessionId}\u0000${scope}`
    const existing = this.states.get(key)
    if (existing !== undefined) return existing
    const state: ScopedLeaseState = {
      lease: availableLease(),
      epoch: 0,
      desired: new Set(),
      pendingReleases: new Map(),
    }
    this.states.set(key, state)
    return state
  }

  private publish(
    sessionId: string,
    scope: InteractionLeaseScope,
    state: ScopedLeaseState,
    lease: AppServerInteractionLease,
    force = false,
  ): void {
    if (!force && lease.generation < state.lease.generation) return
    state.lease = lease
    // Any accepted transition other than our recorded generation means we no longer hold the lease.
    if (state.mine !== undefined && (lease.status !== "held" || lease.generation !== state.mine.generation)) {
      state.mine = undefined
    }
    const update = { sessionId, scope, lease }
    try {
      this.options.onLease?.(update)
    } catch {
      // A presentation observer must not affect lease protocol state.
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(update)
      } catch {
        // A presentation observer must not affect lease protocol state.
      }
    }
  }

  private clearPendingAcquire(state: ScopedLeaseState, promise: Promise<number | undefined>): void {
    if (state.pendingAcquire?.promise === promise) state.pendingAcquire = undefined
  }

  /** Generations never repeat within a scope, so a matching generation proves self-ownership. */
  private heldBySelf(state: ScopedLeaseState, key: string, lease: AppServerInteractionLease): boolean {
    return lease.status === "held" && state.mine?.key === key && state.mine.generation === lease.generation
  }
}

export class BrowserInteractionLeaseUnavailableError extends Error {
  constructor(
    readonly scope: InteractionLeaseScope,
    readonly lease: AppServerInteractionLease,
  ) {
    super(`The ${scope} lease is held by ${lease.holder?.name ?? "another client"}`)
    this.name = "BrowserInteractionLeaseUnavailableError"
  }
}

function availableLease(generation = 0): AppServerInteractionLease {
  return { status: "available", generation }
}

function interactionKey(sessionId: string, connection: BrowserInteractionConnection): string {
  return `${sessionId}:${connection.connectionId}`
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException("Web interaction cancelled", "AbortError")
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted)
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException("Web interaction cancelled", "AbortError"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort)
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Web interaction cancelled", "AbortError"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}
