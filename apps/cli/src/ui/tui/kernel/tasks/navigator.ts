/**
 * The task navigator: the TaskPath stack, its per-peer save slots, the
 * pause/resume model and the exactly-once termination contract. An
 * invocation ends once and its caller receives one delivery —
 * completed, dismissed, or invalidated as a real termination cause.
 * Back routes to the top engine first; a dirty root refuses without a
 * guard-free discard, and only an explicit discard call ends it.
 * Pausing detaches a still-valid invocation (state intact) while its
 * dependents above end invalidated; resuming reattaches under the
 * current effective caller. Decision presentations never pass through
 * here — the path moves only through task opens and ends.
 */
import type {
  DeliveredCompletion,
  TaskBackResult,
  TaskComposerMode,
  TaskDefinition,
  TaskEngine,
  TaskKit,
  TaskRowView,
  TaskTabsView,
} from "./contracts.js"

export interface TaskPathNode {
  readonly invocationId: number
  readonly kind: string
  readonly title: string
}

/** Phantom-typed by kind; open mints it and complete/dismiss consume it. */
export interface TaskTicket<K extends string = string> {
  readonly id: number
  readonly kind: K
}

export type TaskOrigin = { readonly kind: "resting" } | { readonly kind: "task"; readonly taskId: number }

export interface TaskDelivery<K extends string = string, V = unknown> {
  readonly ticket: TaskTicket<K>
  readonly origin: TaskOrigin
  readonly completion: DeliveredCompletion<V>
}

export type AnyTaskEffect = { readonly kind: string; readonly [field: string]: unknown }

export interface TaskDispatch {
  readonly effects: readonly AnyTaskEffect[]
  readonly delivery: TaskDelivery | null
}

export type TaskBackOutcome =
  | { readonly status: "empty" }
  | { readonly status: "popped" }
  | { readonly status: "dismissed"; readonly delivery: TaskDelivery }
  | { readonly status: "dirty-guard" }

export interface PausedTaskRef {
  readonly ticket: TaskTicket
  readonly kind: string
  readonly title: string
}

/** Pause detaches the matches and ends their dependents; both are reported. */
export interface PauseOutcome {
  readonly paused: readonly PausedTaskRef[]
  readonly deliveries: readonly TaskDelivery[]
}

export type TaskInputOf<D> = D extends TaskDefinition<string, infer I, unknown, AnyTaskEffect> ? I : never
export type TaskResultOf<D> = D extends TaskDefinition<string, unknown, infer R, AnyTaskEffect> ? R : never

type AnyEngine = TaskEngine<unknown, unknown, AnyTaskEffect>
type AnyDefinition = TaskDefinition<string, unknown, unknown, AnyTaskEffect>

interface LiveInvocation {
  readonly ticket: TaskTicket
  readonly engine: AnyEngine
  originTaskId: number | null
}

export type TaskEntries = Readonly<Record<string, AnyDefinition>>

/** What a pause or invalidation ruling reads about one live invocation. */
export interface TaskRuling {
  readonly kind: string
  readonly scope: TaskEngine<unknown, unknown, AnyTaskEffect>["scope"]
  readonly identities: readonly string[]
}

export type TaskPredicate = (ruling: TaskRuling) => boolean

export class TaskNavigator<Entries extends TaskEntries> {
  private readonly entries: Entries
  private readonly kit: TaskKit
  private readonly stacks = new Map<string, LiveInvocation[]>()
  private readonly pausedInvocations = new Map<number, LiveInvocation>()
  private readonly endedIds = new Set<number>()
  private currentPeer: string
  private nextId = 1

  constructor(entries: Entries, kit: TaskKit, peers: readonly string[] = ["conversation"]) {
    this.entries = entries
    this.kit = kit
    this.currentPeer = peers[0] ?? "conversation"
    for (const peer of peers) this.stacks.set(peer, [])
    if (!this.stacks.has(this.currentPeer)) this.stacks.set(this.currentPeer, [])
  }

  /**
   * Open an invocation on the current caller. The input pairs with the
   * kind at compile time; the previous top stays alive beneath and
   * resumes when this one ends.
   */
  open<K extends string & keyof Entries>(kind: K, input: TaskInputOf<Entries[K]>): TaskTicket<K> {
    const definition = this.entries[kind] as TaskDefinition<K, TaskInputOf<Entries[K]>, unknown, AnyTaskEffect>
    const stack = this.currentStack()
    const engine = definition.create(input, this.kit) as AnyEngine
    const invocation: LiveInvocation = {
      ticket: { id: this.nextId, kind },
      engine,
      originTaskId: stack.length === 0 ? null : stack[stack.length - 1]!.ticket.id,
    }
    this.nextId += 1
    stack.push(invocation)
    return invocation.ticket as TaskTicket<K>
  }

  /** The current TaskPath: one node per live invocation, innermost last. */
  path(): readonly TaskPathNode[] {
    return this.currentStack().map((invocation) => ({
      invocationId: invocation.ticket.id,
      kind: invocation.ticket.kind,
      title: invocation.engine.title,
    }))
  }

  topTicket(): TaskTicket | null {
    const stack = this.currentStack()
    return stack.length === 0 ? null : stack[stack.length - 1]!.ticket
  }

  topTitle(): string | null {
    return this.topInvocation()?.engine.title ?? null
  }

  topComposerMode(): TaskComposerMode {
    return this.topInvocation()?.engine.composerMode ?? "visible"
  }

  topSteps(): readonly string[] {
    return this.topInvocation()?.engine.steps() ?? []
  }

  topHints(): readonly string[] {
    return this.topInvocation()?.engine.hints() ?? []
  }

  topDirty(): boolean {
    return this.topInvocation()?.engine.dirty() ?? false
  }

  /** The top engine's choosable rows; engines without a list surface report none. */
  topRows(): readonly TaskRowView[] {
    return this.topInvocation()?.engine.rows?.() ?? []
  }

  topTabs(): TaskTabsView | undefined {
    return this.topInvocation()?.engine.tabs?.()
  }

  /** The top engine's body lines; engines without a body surface report none. */
  topBody(): readonly string[] {
    return this.topInvocation()?.engine.body?.() ?? []
  }

  /** Route one owned input to the top engine; a completed event settles the invocation. */
  handleIntent(intent: Parameters<AnyEngine["handle"]>[0]): TaskDispatch | null {
    const invocation = this.topInvocation()
    if (invocation === undefined) return null
    const events = invocation.engine.handle(intent)
    const effects: AnyTaskEffect[] = []
    let delivery: TaskDelivery | null = null
    for (const event of events) {
      if (event.kind === "effect") effects.push(event.effect)
      else if (delivery === null) delivery = this.settle(invocation, { kind: "completed", value: event.value })
    }
    return { effects, delivery }
  }

  /** Escape: the engine pops an internal level, the invocation ends, or a dirty root refuses. */
  back(): TaskBackOutcome {
    const invocation = this.topInvocation()
    if (invocation === undefined) return { status: "empty" }
    const result: TaskBackResult = invocation.engine.back()
    if (result === "popped") return { status: "popped" }
    if (result === "dirty" || invocation.engine.dirty()) return { status: "dirty-guard" }
    const delivery = this.settle(invocation, { kind: "dismissed" })
    return delivery === null ? { status: "empty" } : { status: "dismissed", delivery }
  }

  /** The explicit discard after a dirty guard; the only dirty-ending path. */
  discardTop(): TaskDelivery | null {
    const invocation = this.topInvocation()
    return invocation === undefined ? null : this.settle(invocation, { kind: "dismissed" })
  }

  /** Explicit dismiss of a live invocation; the guard is the caller's explicit intent. */
  dismiss<K extends string>(ticket: TaskTicket<K>): TaskDelivery<K> | null {
    return this.settle(this.findLive(ticket.id), { kind: "dismissed" }) as TaskDelivery<K> | null
  }

  /** Complete with the kind's paired result type; a mismatched value is a compile error. */
  complete<K extends string & keyof Entries>(
    ticket: TaskTicket<K>,
    value: TaskResultOf<Entries[K]>,
  ): TaskDelivery<K, TaskResultOf<Entries[K]>> | null {
    return this.settle(this.findLive(ticket.id), { kind: "completed", value }) as TaskDelivery<K, TaskResultOf<Entries[K]>> | null
  }

  /**
   * Pause still-valid invocations the predicate selects. Dependents
   * above a paused invocation end invalidated with one delivery each;
   * the paused engines keep their state for resume.
   */
  pause(predicate: TaskPredicate): PauseOutcome {
    const paused: PausedTaskRef[] = []
    const deliveries: TaskDelivery[] = []
    for (const stack of this.stacks.values()) {
      let floor = 0
      while (floor < stack.length) {
        const index = stack.findIndex((invocation, position) => position >= floor && this.matches(invocation, predicate))
        if (index < 0) break
        deliveries.push(...this.endAbove(stack, index))
        const [detached] = stack.splice(index, 1)
        if (detached === undefined) break
        this.pausedInvocations.set(detached.ticket.id, detached)
        paused.push({ ticket: detached.ticket, kind: detached.ticket.kind, title: detached.engine.title })
        floor = index
      }
    }
    return { paused, deliveries }
  }

  /** Reattach a paused invocation under the current effective caller; state untouched. */
  resume(pausedId: number): TaskTicket | null {
    const detached = this.pausedInvocations.get(pausedId)
    if (detached === undefined) return null
    this.pausedInvocations.delete(pausedId)
    const stack = this.currentStack()
    detached.originTaskId = stack.length === 0 ? null : stack[stack.length - 1]!.ticket.id
    stack.push(detached)
    return detached.ticket
  }

  /**
   * End every live or paused invocation the predicate selects — and,
   * because dependents cannot outlive their caller, everything above
   * one — with the invalidated termination cause, one delivery each.
   */
  invalidate(predicate: TaskPredicate): readonly TaskDelivery[] {
    const deliveries: TaskDelivery[] = []
    for (const stack of this.stacks.values()) {
      let floor = 0
      while (floor < stack.length) {
        const index = stack.findIndex((invocation, position) => position >= floor && this.matches(invocation, predicate))
        if (index < 0) break
        deliveries.push(...this.endAbove(stack, index))
        const delivery = this.settle(stack[index]!, { kind: "invalidated" })
        if (delivery !== null) deliveries.push(delivery)
        else stack.splice(index, 1)
        floor = index
      }
    }
    // settle's detach removes a paused invocation; deleting here first would break it.
    for (const invocation of [...this.pausedInvocations.values()]) {
      if (!this.matches(invocation, predicate)) continue
      const delivery = this.settle(invocation, { kind: "invalidated" })
      if (delivery !== null) deliveries.push(delivery)
    }
    return deliveries
  }

  /** Save the current peer's stack and load the destination's; engines keep their state. */
  switchPeer(peer: string): void {
    if (peer === this.currentPeer) return
    if (!this.stacks.has(peer)) this.stacks.set(peer, [])
    this.currentPeer = peer
  }

  peers(): readonly string[] {
    return [...this.stacks.keys()]
  }

  activePeer(): string {
    return this.currentPeer
  }

  pausedTasks(): readonly PausedTaskRef[] {
    return [...this.pausedInvocations.values()].map((invocation) => ({
      ticket: invocation.ticket,
      kind: invocation.ticket.kind,
      title: invocation.engine.title,
    }))
  }

  private currentStack(): LiveInvocation[] {
    return this.stacks.get(this.currentPeer)!
  }

  private topInvocation(): LiveInvocation | undefined {
    const stack = this.currentStack()
    return stack[stack.length - 1]
  }

  private findLive(id: number): LiveInvocation | null {
    const invocation = this.pausedInvocations.get(id)
    if (invocation !== undefined) return invocation
    for (const stack of this.stacks.values()) {
      const found = stack.find((candidate) => candidate.ticket.id === id)
      if (found !== undefined) return found
    }
    return null
  }

  /** End one invocation exactly once, wherever it lives; non-top stack members cannot settle. */
  private settle(invocation: LiveInvocation | null, completion: DeliveredCompletion<unknown>): TaskDelivery | null {
    if (invocation === null || this.endedIds.has(invocation.ticket.id)) return null
    if (!this.detach(invocation)) return null
    this.endedIds.add(invocation.ticket.id)
    return {
      ticket: invocation.ticket,
      origin: invocation.originTaskId === null ? { kind: "resting" } : { kind: "task", taskId: invocation.originTaskId },
      completion,
    }
  }

  private detach(invocation: LiveInvocation): boolean {
    if (this.pausedInvocations.delete(invocation.ticket.id)) return true
    for (const stack of this.stacks.values()) {
      if (stack[stack.length - 1]?.ticket.id !== invocation.ticket.id) continue
      stack.pop()
      return true
    }
    return false
  }

  /** End everything above `index`, top first, with the invalidated cause; one delivery each. */
  private endAbove(stack: LiveInvocation[], index: number): TaskDelivery[] {
    const deliveries: TaskDelivery[] = []
    while (stack.length - 1 > index) {
      const delivery = this.settle(stack[stack.length - 1]!, { kind: "invalidated" })
      if (delivery === null) break
      deliveries.push(delivery)
    }
    return deliveries
  }

  private matches(invocation: LiveInvocation, predicate: TaskPredicate): boolean {
    return predicate({ kind: invocation.ticket.kind, scope: invocation.engine.scope, identities: invocation.engine.identities() })
  }
}
