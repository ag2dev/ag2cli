import { createHash, randomBytes } from "node:crypto"
import {
  APP_SERVER_SCOPES,
  type AppServerDeviceRegistration,
  type AppServerDeviceRegistry,
  type AppServerPairingChallenge,
  type AppServerPairingClaimInput,
  type AppServerPairingRegistry,
  type AppServerPairingStartInput,
  type AppServerScope,
} from "@ag2cli/app-server-protocol/types.js"

const DEFAULT_TTL_MS = 5 * 60_000
const MIN_TTL_MS = 30_000
const MAX_TTL_MS = 10 * 60_000

interface PairingTicket {
  readonly scopes: readonly AppServerScope[]
  readonly expiresAt: number
}

export interface InMemoryAppServerPairingRegistryOptions {
  readonly now?: () => Date
}

/**
 * Single-use pairing tickets owned by one running `serve` Host.
 *
 * The raw ticket is never retained after `start`; only its digest is kept in
 * memory. Claim removes the ticket before awaiting registration, so concurrent
 * claims cannot create two devices from one QR/link.
 */
export class InMemoryAppServerPairingRegistry implements AppServerPairingRegistry {
  private readonly tickets = new Map<string, PairingTicket>()
  private readonly now: () => Date

  constructor(
    private readonly devices: AppServerDeviceRegistry,
    options: InMemoryAppServerPairingRegistryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
  }

  async start(input: AppServerPairingStartInput): Promise<AppServerPairingChallenge> {
    const scopes = normalizeScopes(input.scopes)
    const ttlMs = normalizeTtl(input.ttlMs)
    const now = this.now().getTime()
    this.removeExpired(now)
    const pairingToken = `ag2cli-pairing.${randomBytes(32).toString("base64url")}`
    const expiresAt = now + ttlMs
    this.tickets.set(digest(pairingToken), { scopes, expiresAt })
    return { pairingToken, scopes, expiresAt: new Date(expiresAt).toISOString() }
  }

  async claim(input: AppServerPairingClaimInput): Promise<AppServerDeviceRegistration | undefined> {
    if (typeof input.pairingToken !== "string") return undefined
    const pairingToken = input.pairingToken.trim()
    if (pairingToken.length === 0) return undefined
    const now = this.now().getTime()
    const key = digest(pairingToken)
    const ticket = this.tickets.get(key)
    if (ticket === undefined || ticket.expiresAt <= now) {
      this.tickets.delete(key)
      return undefined
    }
    this.tickets.delete(key)
    return this.devices.register({
      name: input.name,
      clientKind: input.clientKind,
      scopes: ticket.scopes,
      ...(input.publicKey === undefined ? {} : { publicKey: input.publicKey }),
    })
  }

  close(): void {
    this.tickets.clear()
  }

  private removeExpired(now: number): void {
    for (const [key, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(key)
    }
  }
}

function normalizeScopes(scopes: readonly AppServerScope[]): readonly AppServerScope[] {
  const unique = [...new Set(scopes)]
  const invalid = unique.filter((scope) => !(APP_SERVER_SCOPES as readonly string[]).includes(scope))
  if (invalid.length > 0) throw new Error(`Invalid pairing scope: ${invalid.join(", ")}`)
  return unique
}

function normalizeTtl(value: number | undefined): number {
  const ttlMs = value ?? DEFAULT_TTL_MS
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new Error(`pairing ttl must be between ${MIN_TTL_MS} and ${MAX_TTL_MS} milliseconds`)
  }
  return ttlMs
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}
