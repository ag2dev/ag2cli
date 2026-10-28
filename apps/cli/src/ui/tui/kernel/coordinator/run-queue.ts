/**
 * The coordinator's run slot: queue-policy slash inputs park behind
 * the one run slot and drain one per freed slot, so a slow queue-policy
 * command keeps its serialization against runs and other commands.
 * Immediate inputs and exit execute without waiting and never own the
 * slot. Prompts never park here — they ride the canonical session
 * mailbox; the host only borrows the slot for them. Ordering only:
 * execution and the canonical queue stay with the command channel.
 */
import type { SlashBusyPolicy, SlashInput } from "./slash.js"

/** Who holds the run slot: nobody, a canonical run episode, or a local slash execution. */
export type SlotOwner = "none" | "run" | "slash"

/** One parked slash as the preview names it: stable id plus the raw text. */
export interface ParkedRow {
  readonly id: string
  readonly raw: string
}

/** The parked entry the queue keeps; the drain hands the full input back. */
interface ParkedEntry {
  readonly id: string
  readonly input: SlashInput
}

export interface RunQueueOptions {
  readonly busyPolicy?: (input: SlashInput) => SlashBusyPolicy
}

export interface RunQueue {
  /** Inputs the coordinator must execute now; an empty return means the submission parked. */
  submitSlash(input: SlashInput): readonly SlashInput[]
  /** True only for the none→run transition; the caller whose mark transitioned owns the episode. */
  markRunBusy(): boolean
  runEpisodeSettled(): readonly SlashInput[]
  /** A slot-owning slash settled; idle drains one parked command, busy releases to the host's reconcile. */
  slashFinished(idle: boolean): readonly SlashInput[]
  /**
   * The parked queue and slot ownership drop entirely, and no execution
   * follows. Lineage loss and io degrade must not emit a run interrupt:
   * the host already owns the abandoned lineage's run lifecycle, and a
   * degraded channel refuses interrupts outright.
   */
  interrupt(): void
  slotOwner(): SlotOwner
  queuedInputs(): readonly string[]
  /** The parked rows with their stable ids, oldest first. */
  queuedRows(): readonly ParkedRow[]
  /** Remove exactly the named parked row; false when the id is unknown. */
  cancelParked(id: string): boolean
}

export function createRunQueue(options: RunQueueOptions = {}): RunQueue {
  const busyPolicy = options.busyPolicy ?? (() => "queue")
  const parked: ParkedEntry[] = []
  let owner: SlotOwner = "none"
  let nextId = 0

  const drainOne = (): readonly SlashInput[] => {
    if (owner !== "none" || parked.length === 0) return []
    const next = parked.shift()!
    owner = "slash"
    return [next.input]
  }

  return {
    submitSlash(input) {
      if (input.name === "exit" || busyPolicy(input) !== "queue") return [input]
      if (owner !== "none") {
        parked.push({ id: `park:${++nextId}`, input })
        return []
      }
      owner = "slash"
      return [input]
    },
    markRunBusy() {
      if (owner !== "none") return false
      owner = "run"
      return true
    },
    runEpisodeSettled() {
      if (owner === "run") owner = "none"
      return drainOne()
    },
    slashFinished(idle) {
      if (owner === "slash") owner = "none"
      return idle ? drainOne() : []
    },
    interrupt() {
      parked.length = 0
      owner = "none"
    },
    queuedInputs: () => parked.map((row) => row.input.raw),
    queuedRows: () => parked.map((row) => ({ id: row.id, raw: row.input.raw })),
    cancelParked(id) {
      const at = parked.findIndex((row) => row.id === id)
      if (at < 0) return false
      parked.splice(at, 1)
      return true
    },
    slotOwner: () => owner,
  }
}
