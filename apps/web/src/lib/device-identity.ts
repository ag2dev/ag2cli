import type { BrowserDeviceIdentity } from "./pairing"
import { isAppServerHostId } from "@ag2cli/app-server-protocol/host-proof.js"

const DATABASE_NAME = "ag2cli.web"
const DATABASE_VERSION = 1
const STORE_NAME = "device-identities"

interface StoredBrowserDeviceIdentity {
  readonly credential: string
  readonly deviceId: string
  readonly publicKey: string
  readonly privateKey: CryptoKey
  readonly hostId: string
}

export interface BrowserDeviceIdentityStore {
  load(key: string): Promise<BrowserDeviceIdentity | undefined>
  save(key: string, identity: BrowserDeviceIdentity): Promise<void>
  remove(key: string): Promise<void>
}

const memoryIdentities = new Map<string, BrowserDeviceIdentity>()

/**
 * Persist browser device identities without exporting the private key.
 * IndexedDB can structured-clone a non-extractable CryptoKey; the in-memory
 * fallback keeps the current tab usable in restricted browser contexts.
 */
export function createBrowserDeviceIdentityStore(
  indexedDb: IDBFactory | undefined = typeof globalThis.indexedDB === "undefined" ? undefined : globalThis.indexedDB,
): BrowserDeviceIdentityStore {
  let database: Promise<IDBDatabase> | undefined

  const openDatabase = (): Promise<IDBDatabase> => {
    if (indexedDb === undefined) return Promise.reject(new Error("IndexedDB is not available"))
    if (database !== undefined) return database
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error("Could not open the device identity database"))
      request.onblocked = () => reject(new Error("Device identity database is blocked by another connection"))
    })
    return database
  }

  return {
    async load(key) {
      const memory = memoryIdentities.get(key)
      if (memory !== undefined) return memory
      try {
        const db = await openDatabase()
        const stored = await readIdentity(db, key)
        if (stored === undefined) return undefined
        const identity = toBrowserDeviceIdentity(stored)
        if (identity === undefined) return undefined
        memoryIdentities.set(key, identity)
        return identity
      } catch {
        return memoryIdentities.get(key)
      }
    },

    async save(key, identity) {
      memoryIdentities.set(key, identity)
      try {
        const db = await openDatabase()
        await writeIdentity(db, key, identity)
      } catch {
        // The in-memory copy remains available for this tab. A caller that
        // needs durable storage can detect support before offering pairing.
      }
    },

    async remove(key) {
      memoryIdentities.delete(key)
      try {
        const db = await openDatabase()
        await deleteIdentity(db, key)
      } catch {
        // Missing IndexedDB should not prevent forgetting the in-memory copy.
      }
    },
  }
}

function readIdentity(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Could not read the device identity"))
  })
}

function writeIdentity(db: IDBDatabase, key: string, identity: BrowserDeviceIdentity): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite")
    transaction.objectStore(STORE_NAME).put(identity, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the device identity"))
    transaction.onabort = () => reject(transaction.error ?? new Error("Saving the device identity was aborted"))
  })
}

function deleteIdentity(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite")
    transaction.objectStore(STORE_NAME).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete the device identity"))
    transaction.onabort = () => reject(transaction.error ?? new Error("Deleting the device identity was aborted"))
  })
}

function toBrowserDeviceIdentity(value: unknown): BrowserDeviceIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Partial<StoredBrowserDeviceIdentity>
  if (
    typeof record.credential !== "string" ||
    typeof record.deviceId !== "string" ||
    typeof record.hostId !== "string" ||
    !isAppServerHostId(record.hostId) ||
    typeof record.publicKey !== "string" ||
    record.privateKey === undefined
  ) {
    return undefined
  }
  return {
    credential: record.credential,
    deviceId: record.deviceId,
    publicKey: record.publicKey,
    privateKey: record.privateKey,
    hostId: record.hostId,
  }
}
