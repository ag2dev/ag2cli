/** Options that stay inside one process and never cross the JSON-RPC boundary. */
export interface SessionExecuteOptions {
  readonly signal?: AbortSignal
  /** Internal host admission mode: durably accept an input without waiting for execution. */
  readonly acceptOnly?: boolean
}
