import { randomUuidV7 } from "../infrastructure/uuid-v7.js"

/** Mint the identity for a newly-created interactive TUI session. */
export function createTuiSessionId(): string {
  return randomUuidV7()
}
