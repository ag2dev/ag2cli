/** Runtime identity source. Concrete randomness/time can be replaced in tests or Host. */
export interface RuntimeIdentity {
  nextId(): string
}

export const defaultRuntimeIdentity: RuntimeIdentity = {
  nextId() {
    const crypto = (globalThis as typeof globalThis & { crypto?: { randomUUID?: () => string } }).crypto
    return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  },
}
