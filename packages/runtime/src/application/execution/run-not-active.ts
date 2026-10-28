/**
 * Steer admission addressed a run that is not running: the mailbox has no
 * live target, so acceptance is refused instead of silently queued for a
 * future run. The transport maps this to the protocol `run_not_active`
 * error; the client may fall back to a plain submit.
 */
export class RunNotActiveError extends Error {
  constructor(readonly runId: string) {
    super(`Run is not running: ${runId}`)
    this.name = "RunNotActiveError"
  }
}
