import { createHash, randomBytes } from "node:crypto"
import {
  type AppServerDeviceRegistry,
  type AppServerPairClaimParams,
  type AppServerPairClaimResult,
  type AppServerPairCreateParams,
  type AppServerPairCreateResult,
  type AppServerPairPreviewResult,
  type AppServerPairingRegistry,
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

/** Single-use, Host-bound tickets owned by one running `serve` authority. */
export class InMemoryAppServerPairingRegistry implements AppServerPairingRegistry {
  private readonly tickets = new Map<string, PairingTicket>()
  private readonly now: () => Date

  constructor(
    private readonly devices: AppServerDeviceRegistry,
    private readonly hostId: string,
    options: InMemoryAppServerPairingRegistryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
  }

  async create(input: AppServerPairCreateParams): Promise<AppServerPairCreateResult> {
    const scopes = normalizeScopes(input.scopes)
    const ttlMs = normalizeTtl(input.ttlMs)
    const now = this.now().getTime()
    this.removeExpired(now)
    const pairingToken = `ag2cli-pairing.${randomBytes(32).toString("base64url")}`
    const expiresAt = now + ttlMs
    this.tickets.set(digest(pairingToken), { scopes, expiresAt })
    return { pairingToken, hostId: this.hostId, scopes, expiresAt: new Date(expiresAt).toISOString() }
  }

  async preview(pairingToken: string): Promise<AppServerPairPreviewResult | undefined> {
    const ticket = this.getTicket(pairingToken)
    if (ticket === undefined) return undefined
    return { hostId: this.hostId, scopes: ticket.scopes, expiresAt: new Date(ticket.expiresAt).toISOString() }
  }

  async claim(input: AppServerPairClaimParams): Promise<AppServerPairClaimResult | undefined> {
    const key = digest(input.pairingToken)
    const ticket = this.getTicket(input.pairingToken)
    if (ticket === undefined) return undefined
    this.tickets.delete(key)
    return this.devices.register({
      name: input.name,
      clientKind: input.clientKind,
      scopes: ticket.scopes,
      publicKey: input.publicKey,
    })
  }

  close(): void {
    this.tickets.clear()
  }

  private getTicket(pairingToken: string): PairingTicket | undefined {
    if (pairingToken.trim().length === 0) return undefined
    const key = digest(pairingToken)
    const ticket = this.tickets.get(key)
    if (ticket === undefined || ticket.expiresAt <= this.now().getTime()) {
      this.tickets.delete(key)
      return undefined
    }
    return ticket
  }

  private removeExpired(now: number): void {
    for (const [key, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(key)
    }
  }
}

function normalizeScopes(scopes: readonly AppServerScope[]): readonly AppServerScope[] {
  const unique = [...new Set(scopes)]
  const invalid = unique.filter((scope) => !PAIRABLE_SCOPES.has(scope))
  if (invalid.length > 0) throw new Error(`Invalid pairing scope: ${invalid.join(", ")}`)
  if (unique.length === 0) throw new Error("Pairing requires at least one scope")
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

const PAIRABLE_SCOPES = new Set<AppServerScope>([
  "session:read",
  "session:write",
  "approval:write",
  "shell:execute",
  "session:policy",
  "workspace:read",
])
