import { createPublicKey, randomBytes, verify } from "node:crypto"
import {
  APP_SERVER_DEVICE_CHALLENGE_PREFIX,
  APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX,
  APP_SERVER_DEVICE_SIGNATURE_PREFIX,
  createAppServerDeviceProofMessage,
  decodeBase64Url,
  encodeBase64Url,
  isAppServerDevicePublicKey,
  isAppServerDeviceSignature,
} from "@ag2cli/app-server-protocol/device-proof.js"
import { isAppServerHostId } from "@ag2cli/app-server-protocol/host-proof.js"
import type { AppServerDeviceChallenge, AppServerDeviceProof } from "@ag2cli/app-server-protocol/types.js"

const DEFAULT_TTL_MS = 60_000

interface DeviceChallengeState {
  readonly connectionId: string
  readonly hostId: string
  readonly expiresAt: number
}

export interface AppServerDeviceProofVerificationInput {
  readonly connectionId: string
  readonly hostId: string
  readonly deviceId: string
  readonly publicKey: string
  readonly clientId: string
  readonly proof: AppServerDeviceProof
}

export interface AppServerDeviceChallengeIssuer {
  issue(connectionId: string, hostId: string): AppServerDeviceChallenge
}

export interface AppServerDeviceProofVerifier {
  verify(input: AppServerDeviceProofVerificationInput): Promise<boolean>
}

export interface AppServerDeviceProofServiceOptions {
  readonly now?: () => Date
  readonly ttlMs?: number
}

/** Issues one-use device challenges bound to the WebSocket that received them. */
export class InMemoryAppServerDeviceProofService implements AppServerDeviceChallengeIssuer, AppServerDeviceProofVerifier {
  private readonly challenges = new Map<string, DeviceChallengeState>()
  private readonly now: () => Date
  private readonly ttlMs: number
  private closed = false

  constructor(options: AppServerDeviceProofServiceOptions = {}) {
    if (!Number.isSafeInteger(options.ttlMs ?? DEFAULT_TTL_MS) || (options.ttlMs ?? DEFAULT_TTL_MS) <= 0) {
      throw new RangeError("device proof ttl must be a positive integer")
    }
    this.now = options.now ?? (() => new Date())
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  }

  issue(connectionId: string, hostId: string): AppServerDeviceChallenge {
    if (this.closed) throw new Error("device proof service is closed")
    if (connectionId.trim().length === 0) throw new RangeError("connectionId must not be empty")
    if (!isAppServerHostId(hostId)) throw new RangeError("hostId has an invalid format")
    const now = this.now().getTime()
    this.removeExpired(now)
    const challenge = `${APP_SERVER_DEVICE_CHALLENGE_PREFIX}${encodeBase64Url(randomBytes(32))}`
    const expiresAt = now + this.ttlMs
    this.challenges.set(challenge, { connectionId, hostId, expiresAt })
    return { challenge, hostId, expiresAt }
  }

  async verify(input: AppServerDeviceProofVerificationInput): Promise<boolean> {
    if (this.closed) return false
    const { proof } = input
    if (proof.challenge.trim().length === 0 || proof.signature.trim().length === 0) return false
    const state = this.challenges.get(proof.challenge)
    this.challenges.delete(proof.challenge)
    if (
      state === undefined ||
      state.expiresAt <= this.now().getTime() ||
      state.connectionId !== input.connectionId ||
      state.hostId !== input.hostId
    ) {
      return false
    }
    if (!isAppServerDevicePublicKey(input.publicKey) || !isAppServerDeviceSignature(proof.signature)) return false
    const publicKeyBytes = decodeBase64Url(input.publicKey.slice(APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX.length))
    const signatureBytes = decodeBase64Url(proof.signature.slice(APP_SERVER_DEVICE_SIGNATURE_PREFIX.length))
    if (publicKeyBytes === undefined || signatureBytes === undefined || signatureBytes.byteLength !== 64) return false
    try {
      const key = createPublicKey({ key: Buffer.from(publicKeyBytes), format: "der", type: "spki" })
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return false
      if (!equalBytes(new Uint8Array(key.export({ format: "der", type: "spki" })), publicKeyBytes)) return false
      return verify(
        "sha256",
        Buffer.from(
          createAppServerDeviceProofMessage({
            hostId: input.hostId,
            challenge: proof.challenge,
            deviceId: input.deviceId,
            clientId: input.clientId,
          }),
        ),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(signatureBytes),
      )
    } catch {
      return false
    }
  }

  close(): void {
    this.closed = true
    this.challenges.clear()
  }

  private removeExpired(now: number): void {
    for (const [challenge, state] of this.challenges) {
      if (state.expiresAt <= now) this.challenges.delete(challenge)
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}
