import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { replaceFileAtomically } from "./file-coordination.js"
import {
  APP_SERVER_SCOPES,
  type AppServerClientInfo,
  type AppServerDevicePrincipal,
  type AppServerDeviceRecord,
  type AppServerDeviceRegistration,
  type AppServerDeviceRegistry,
  type AppServerScope,
  type RegisterAppServerDeviceInput,
} from "@ag2cli/app-server-protocol/types.js"

const DEVICE_REGISTRY_SCHEMA_VERSION = 1 as const
export const APP_SERVER_DEVICE_REGISTRY_FILE = "devices.json"

interface StoredDevice {
  readonly deviceId: string
  readonly credentialDigest: string
  readonly name: string
  readonly clientKind: AppServerClientInfo["clientKind"]
  readonly scopes: readonly AppServerScope[]
  readonly publicKey?: string
  readonly createdAt: string
  readonly revokedAt?: string
}

interface StoredRegistry {
  readonly schemaVersion: typeof DEVICE_REGISTRY_SCHEMA_VERSION
  readonly devices: readonly StoredDevice[]
}

export interface JsonAppServerDeviceRegistryOptions {
  readonly now?: () => Date
}

/**
 * Credential-private device registry for a persistent App Server.
 *
 * The registry is deliberately separate from Session persistence. A corrupt
 * credential file fails closed so a service cannot accidentally start with a
 * different device set; writes are atomic and owner-readable only.
 */
export class JsonAppServerDeviceRegistry implements AppServerDeviceRegistry {
  readonly path: string
  private readonly now: () => Date
  private state?: StoredRegistry
  private loadPromise?: Promise<StoredRegistry>
  private mutationChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly applicationHome: string,
    options: JsonAppServerDeviceRegistryOptions = {},
  ) {
    this.path = join(applicationHome, APP_SERVER_DEVICE_REGISTRY_FILE)
    this.now = options.now ?? (() => new Date())
  }

  async register(input: RegisterAppServerDeviceInput): Promise<AppServerDeviceRegistration> {
    return this.mutate(async (current) => {
      const device = createDevice(input, this.now())
      const credential = createCredential()
      const stored: StoredDevice = {
        ...device,
        credentialDigest: digestCredential(credential),
      }
      const next: StoredRegistry = { schemaVersion: DEVICE_REGISTRY_SCHEMA_VERSION, devices: [...current.devices, stored] }
      await this.persist(next)
      return { state: next, result: { device: toPublicDevice(stored), credential } }
    })
  }

  async authenticate(credential: string): Promise<AppServerDevicePrincipal | undefined> {
    const normalized = credential.trim()
    if (normalized.length === 0) return undefined
    const current = await this.load()
    const digest = digestCredential(normalized)
    const device = current.devices.find((candidate) => candidate.credentialDigest === digest)
    if (!device || device.revokedAt !== undefined) return undefined
    return {
      deviceId: device.deviceId,
      scopes: [...device.scopes],
      ...(device.publicKey === undefined ? {} : { publicKey: device.publicKey }),
    }
  }

  async list(): Promise<readonly AppServerDeviceRecord[]> {
    const current = await this.load()
    return current.devices.map(toPublicDevice)
  }

  async revoke(deviceId: string): Promise<boolean> {
    return this.mutate(async (current) => {
      const index = current.devices.findIndex((device) => device.deviceId === deviceId)
      if (index < 0 || current.devices[index]!.revokedAt !== undefined) {
        return { state: current, result: false }
      }
      const devices = [...current.devices]
      devices[index] = { ...devices[index]!, revokedAt: this.now().toISOString() }
      const next: StoredRegistry = { schemaVersion: DEVICE_REGISTRY_SCHEMA_VERSION, devices }
      await this.persist(next)
      return { state: next, result: true }
    })
  }

  private async load(): Promise<StoredRegistry> {
    if (this.state !== undefined) return this.state
    if (this.loadPromise !== undefined) return this.loadPromise
    const pending = (async () => {
      let raw: string
      try {
        raw = await readFile(this.path, "utf8")
      } catch (error) {
        if (isMissing(error)) return emptyRegistry()
        throw error
      }
      return parseStoredRegistry(raw, this.path)
    })()
    this.loadPromise = pending
    try {
      const loaded = await pending
      this.state = loaded
      return loaded
    } finally {
      if (this.loadPromise === pending) this.loadPromise = undefined
    }
  }

  private async mutate<T>(
    mutation: (current: StoredRegistry) => Promise<{ readonly state: StoredRegistry; readonly result: T }>,
  ): Promise<T> {
    const run = this.mutationChain.then(async () => {
      const current = await this.load()
      const changed = await mutation(current)
      this.state = changed.state
      return changed.result
    })
    this.mutationChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async persist(value: StoredRegistry): Promise<void> {
    await mkdir(this.applicationHome, { recursive: true, mode: 0o700 })
    await replaceFileAtomically(this.path, `${JSON.stringify(value)}\n`)
  }
}

function createDevice(input: RegisterAppServerDeviceInput, now: Date): Omit<StoredDevice, "credentialDigest"> {
  if (input.name.trim().length === 0) throw new Error("device name must not be empty")
  const scopes = normalizeScopes(input.scopes)
  return {
    deviceId: `device-${randomUUID()}`,
    name: input.name,
    clientKind: input.clientKind,
    scopes,
    ...(input.publicKey === undefined ? {} : { publicKey: input.publicKey }),
    createdAt: now.toISOString(),
  }
}

function normalizeScopes(scopes: readonly AppServerScope[]): readonly AppServerScope[] {
  const unique = [...new Set(scopes)]
  const invalid = unique.filter((scope) => !(APP_SERVER_SCOPES as readonly string[]).includes(scope))
  if (invalid.length > 0) throw new Error(`Invalid device scope: ${invalid.join(", ")}`)
  return unique
}

function createCredential(): string {
  return `ag2cli-device.${randomBytes(32).toString("base64url")}`
}

function digestCredential(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex")
}

function toPublicDevice(device: StoredDevice): AppServerDeviceRecord {
  return {
    deviceId: device.deviceId,
    name: device.name,
    clientKind: device.clientKind,
    scopes: [...device.scopes],
    ...(device.publicKey === undefined ? {} : { publicKey: device.publicKey }),
    createdAt: device.createdAt,
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
  }
}

function emptyRegistry(): StoredRegistry {
  return { schemaVersion: DEVICE_REGISTRY_SCHEMA_VERSION, devices: [] }
}

function parseStoredRegistry(raw: string, path: string): StoredRegistry {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`App Server device registry is corrupted: ${path}`, { cause: error })
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`App Server device registry has an invalid structure: ${path}`)
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== DEVICE_REGISTRY_SCHEMA_VERSION || !Array.isArray(record.devices)) {
    throw new Error(`App Server device registry schema is unsupported: ${path}`)
  }
  const devices = record.devices.map((item, index) => parseStoredDevice(item, `${path}#devices[${index}]`))
  const deviceIds = new Set<string>()
  const credentialDigests = new Set<string>()
  for (const device of devices) {
    if (deviceIds.has(device.deviceId)) throw new Error(`App Server device registry contains duplicate deviceId: ${device.deviceId}`)
    if (credentialDigests.has(device.credentialDigest)) throw new Error("App Server device registry contains a duplicate credential")
    deviceIds.add(device.deviceId)
    credentialDigests.add(device.credentialDigest)
  }
  return { schemaVersion: DEVICE_REGISTRY_SCHEMA_VERSION, devices }
}

function parseStoredDevice(value: unknown, path: string): StoredDevice {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`App Server device registry entry is invalid: ${path}`)
  const record = value as Record<string, unknown>
  const deviceId = requiredString(record.deviceId, `${path}.deviceId`)
  const credentialDigest = requiredString(record.credentialDigest, `${path}.credentialDigest`)
  if (!/^[0-9a-f]{64}$/u.test(credentialDigest)) throw new Error(`App Server device registry credential digest is invalid: ${path}`)
  const name = requiredString(record.name, `${path}.name`)
  const clientKind = parseClientKind(record.clientKind, `${path}.clientKind`)
  if (!Array.isArray(record.scopes)) throw new Error(`App Server device registry scopes are invalid: ${path}`)
  const scopes = normalizeScopes(record.scopes as AppServerScope[])
  const publicKey = record.publicKey === undefined ? undefined : requiredString(record.publicKey, `${path}.publicKey`)
  const createdAt = requiredString(record.createdAt, `${path}.createdAt`)
  const revokedAt = record.revokedAt === undefined ? undefined : requiredString(record.revokedAt, `${path}.revokedAt`)
  return {
    deviceId,
    credentialDigest,
    name,
    clientKind,
    scopes,
    ...(publicKey === undefined ? {} : { publicKey }),
    createdAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  }
}

function parseClientKind(value: unknown, path: string): AppServerClientInfo["clientKind"] {
  if (
    value === "tui" ||
    value === "web" ||
    value === "mobile" ||
    value === "desktop" ||
    value === "acp" ||
    value === "script" ||
    value === "unknown"
  ) {
    return value
  }
  throw new Error(`App Server device registry clientKind is invalid: ${path}`)
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`App Server device registry field is invalid: ${path}`)
  return value
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}
