/**
 * Run queue: the framework-free submission coordinator the host drives
 * between the store's effect seam and its run/slash ports. Prompts and
 * queue-policy slash inputs park behind the active run in one FIFO and
 * drain one item per finished execution; whatever executes owns the one
 * slot until the host reports it finished, so a slow queue-policy read
 * keeps its serialization instead of racing a prompt.
 * Immediate slash inputs and exit run without waiting; interrupt aborts
 * the active execution and drops the parked queue. The module owns
 * ordering only: abort signals, slash execution and the canonical
 * session queue stay with the host, and queued texts are mirrored out
 * for the view. Shell submissions join as a decided change when the
 * shell prefix lands.
 */
import type { QueuedPreview } from "./lines.js"
import type { SlashBusyPolicy, SlashInput } from "./slash.js"

/** Parked-input rows the frame renders before eliding the rest. */
const QUEUED_ROW_CAP = 3

const MAX_PARKED_INPUTS = 100
const MAX_PARKED_INPUT_BYTES = 8 * 1024 * 1024
type ParkedSubmission = { readonly kind: "prompt"; readonly text: string } | { readonly kind: "slash"; readonly input: SlashInput }
type RefusedSubmission = ParkedSubmission

/**
 * What the host executes for one accepted submission. An execute-slash
 * event carries the slot fact: a queue-policy command owns the run slot
 * for its duration (admitted or drained), while immediates and exit
 * never do — their settle must not free a slot another execution holds.
 */
export type TuiRunQueueEvent =
  | { readonly kind: "start-run"; readonly prompt: string }
  | { readonly kind: "execute-slash"; readonly input: SlashInput; readonly ownsSlot: boolean }
  | { readonly kind: "refused"; readonly submission: RefusedSubmission; readonly limit: "items" | "bytes" }
  | { readonly kind: "abort-run" }

export interface TuiRunQueueOptions {
  /**
   * Busy policy per submission; the host closes over its registry. The
   * default parks everything but exit, mirroring the slash framework's
   * queue default.
   */
  readonly busyPolicy?: (input: SlashInput) => SlashBusyPolicy
  /** Lower test/embedding limit; values are clamped to the production hard cap. */
  readonly maxParkedItems?: number
  /** Lower test/embedding limit; values are clamped to the production hard cap. */
  readonly maxParkedBytes?: number
}

export interface TuiRunQueue {
  /**
   * Submit one prompt: starts now or parks behind the active run. A
   * started prompt owns the slot until the host reports it finished.
   */
  submitPrompt(text: string): readonly TuiRunQueueEvent[]
  /**
   * Submit one parsed slash input per its busy policy. Exit and
   * immediate commands execute without waiting or owning the slot; a
   * queue-policy command parks behind the active run and, when it is
   * the one executing, owns the slot until the host reports it
   * finished — keeping a slow queue-policy read serialized against
   * prompts.
   */
  submitSlash(input: SlashInput): readonly TuiRunQueueEvent[]
  /**
   * Interrupt semantics: the parked queue drops entirely; the active run
   * (if any) reports abort-run for the host to signal.
   */
  interrupt(): readonly TuiRunQueueEvent[]
  /**
   * The active execution ended — a run or an executing queue-policy
   * command: free the slot and drain at most one item.
   */
  runFinished(): readonly TuiRunQueueEvent[]
  /** Parked submission texts in submit order; the view mirrors them. */
  queuedInputs(): readonly string[]
  /** Bounded preview copied for rendering; work is O(visible rows), not O(queue size). */
  queuedPreview(): QueuedPreview
}

export function createRunQueue(options: TuiRunQueueOptions = {}): TuiRunQueue {
  const busyPolicy = options.busyPolicy ?? (() => "queue")
  const limit = (requested: number | undefined, hardMaximum: number): number =>
    requested === undefined || !Number.isFinite(requested) ? hardMaximum : Math.min(hardMaximum, Math.max(0, Math.floor(requested)))
  const itemLimit = limit(options.maxParkedItems, MAX_PARKED_INPUTS)
  const byteLimit = limit(options.maxParkedBytes, MAX_PARKED_INPUT_BYTES)
  const parked: ParkedSubmission[] = []
  let activeRun = false
  let parkedBytes = 0
  const encoder = new TextEncoder()

  const queuedTexts = (): readonly string[] => parked.map((item) => (item.kind === "prompt" ? item.text : item.input.raw))
  const queuedPreview = (): QueuedPreview => {
    const visible = parked.slice(0, QUEUED_ROW_CAP).map((item) => (item.kind === "prompt" ? item.text : item.input.raw))
    return { visible, elided: Math.max(0, parked.length - visible.length) }
  }
  const byteLength = (text: string): number => encoder.encode(text).byteLength
  const refuse = (submission: RefusedSubmission, bytes: number): TuiRunQueueEvent => {
    const limit = parked.length >= itemLimit ? "items" : parkedBytes + bytes > byteLimit ? "bytes" : "items"
    return { kind: "refused", submission, limit }
  }

  const drain = (): readonly TuiRunQueueEvent[] => {
    if (activeRun || parked.length === 0) return []
    const next = parked.shift()!
    parkedBytes -= byteLength(next.kind === "prompt" ? next.text : next.input.raw)
    activeRun = true
    if (next.kind === "prompt") return [{ kind: "start-run", prompt: next.text }]
    return [{ kind: "execute-slash", input: next.input, ownsSlot: true }]
  }

  return {
    submitPrompt(text) {
      if (activeRun) {
        const bytes = byteLength(text)
        if (parked.length >= itemLimit || parkedBytes + bytes > byteLimit) return [refuse({ kind: "prompt", text }, bytes)]
        parked.push({ kind: "prompt", text })
        parkedBytes += bytes
        return []
      }
      activeRun = true
      return [{ kind: "start-run", prompt: text }]
    },
    submitSlash(input) {
      if (input.name === "exit" || busyPolicy(input) !== "queue") {
        // Exit and immediate commands never wait and never own the
        // slot; issuances stay ordered, but completions may interleave.
        return [{ kind: "execute-slash", input, ownsSlot: false }]
      }
      if (activeRun) {
        const bytes = byteLength(input.raw)
        if (parked.length >= itemLimit || parkedBytes + bytes > byteLimit) return [refuse({ kind: "slash", input }, bytes)]
        parked.push({ kind: "slash", input })
        parkedBytes += bytes
        return []
      }
      // A queue-policy command that executes owns the slot for its
      // duration: its runFinished frees the queue, and a prompt
      // submitted while it runs parks instead of racing it.
      activeRun = true
      return [{ kind: "execute-slash", input, ownsSlot: true }]
    },
    interrupt() {
      parked.length = 0
      parkedBytes = 0
      if (!activeRun) return []
      activeRun = false
      return [{ kind: "abort-run" }]
    },
    runFinished() {
      activeRun = false
      return drain()
    },
    queuedInputs: queuedTexts,
    queuedPreview,
  }
}
