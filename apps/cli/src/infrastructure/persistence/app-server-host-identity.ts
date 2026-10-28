import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto"
import { access, mkdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { encodeAppServerHostPublicKey, deriveAppServerHostId } from "@ag2cli/app-server-protocol/host-proof.js"
import type { AppServerHostIdentitySigner } from "@ag2cli/app-server-protocol/types.js"
import { decodeBase64Url, encodeBase64Url } from "@ag2cli/app-server-protocol/device-proof.js"
import { withFileLock, replaceFileAtomically } from "./file-coordination.js"

export const APP_SERVER_HOST_IDENTITY_FILE = "host-identity.json"
const HOST_IDENTITY_SCHEMA_VERSION = 1 as const

interface StoredHostIdentity {
  readonly schemaVersion: typeof HOST_IDENTITY_SCHEMA_VERSION
  readonly privateKeyPkcs8: string
}

export interface JsonAppServerHostIdentityOptions {
  /** Persistent service state that must never be rebound to a newly generated identity. */
  readonly existingStatePaths?: readonly string[]
}

/** Persistent Host identity root. The private key is never returned to callers. */
export class JsonAppServerHostIdentity implements AppServerHostIdentitySigner {
  readonly path: string
  readonly hostId: string
  readonly hostPublicKey: string

  private constructor(
    path: string,
    private readonly privateKey: KeyObject,
    hostId: string,
    hostPublicKey: string,
  ) {
    this.path = path
    this.hostId = hostId
    this.hostPublicKey = hostPublicKey
  }

  static async open(identityRoot: string, options: JsonAppServerHostIdentityOptions = {}): Promise<JsonAppServerHostIdentity> {
    const path = join(identityRoot, APP_SERVER_HOST_IDENTITY_FILE)
    const root = identityRoot
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (((await stat(root)).mode & 0o077) !== 0) {
      throw new Error(`App Server Host identity directory permissions are too broad: ${root}`)
    }
    return withFileLock(join(root, "host-identity.lock"), async () => {
      let raw: string | undefined
      try {
        raw = await readFile(path, "utf8")
      } catch (error) {
        if (!isMissing(error)) throw error
      }

      if (raw !== undefined) {
        await assertPrivatePermissions(root, path)
        return this.fromPrivateKey(path, parseStoredPrivateKey(path, raw))
      }
      for (const statePath of options.existingStatePaths ?? []) {
        if (await pathExists(statePath)) {
          throw new Error(`App Server Host identity is missing while persistent service state exists: ${statePath}`)
        }
      }

      const pair = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
        privateKeyEncoding: { format: "der", type: "pkcs8" },
        publicKeyEncoding: { format: "der", type: "spki" },
      })
      const privateKeyPkcs8 = new Uint8Array(pair.privateKey)
      const privateKey = createPrivateKey({ key: pair.privateKey, format: "der", type: "pkcs8" })
      const identity = await this.fromPrivateKey(path, privateKey)
      const stored: StoredHostIdentity = {
        schemaVersion: HOST_IDENTITY_SCHEMA_VERSION,
        privateKeyPkcs8: encodeBase64Url(privateKeyPkcs8),
      }
      await replaceFileAtomically(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 })
      return identity
    })
  }

  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(signBytes("sha256", Buffer.from(message), { key: this.privateKey, dsaEncoding: "ieee-p1363" }))
  }

  private static async fromPrivateKey(path: string, privateKey: KeyObject): Promise<JsonAppServerHostIdentity> {
    if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error(`App Server Host identity key must be P-256: ${path}`)
    }
    const privatePem = privateKey.export({ format: "pem", type: "pkcs8" })
    const publicDer = new Uint8Array(createPublicKey(privatePem).export({ format: "der", type: "spki" }))
    const hostPublicKey = encodeAppServerHostPublicKey(publicDer)
    const hostId = await deriveAppServerHostId(publicDer)
    return new JsonAppServerHostIdentity(path, privateKey, hostId, hostPublicKey)
  }
}

function parseStoredPrivateKey(path: string, raw: string): KeyObject {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`App Server Host identity is corrupted: ${path}`, { cause: error })
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`App Server Host identity has an invalid structure: ${path}`)
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== HOST_IDENTITY_SCHEMA_VERSION || typeof record.privateKeyPkcs8 !== "string") {
    throw new Error(`App Server Host identity schema is unsupported: ${path}`)
  }
  const privateBytes = decodeBase64Url(record.privateKeyPkcs8)
  if (privateBytes === undefined) throw new Error(`App Server Host identity private key is invalid: ${path}`)
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey({ key: Buffer.from(privateBytes), format: "der", type: "pkcs8" })
  } catch (error) {
    throw new Error(`App Server Host identity private key is invalid: ${path}`, { cause: error })
  }
  return privateKey
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function assertPrivatePermissions(root: string, path: string): Promise<void> {
  const [directory, file] = await Promise.all([stat(root), stat(path)])
  if ((directory.mode & 0o077) !== 0 || (file.mode & 0o077) !== 0) {
    throw new Error(`App Server Host identity permissions are too broad: ${path}`)
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
