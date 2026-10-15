import { randomBytes } from "node:crypto"
import {
  APP_SERVER_DEVICE_CHALLENGE_PREFIX,
  APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX,
  APP_SERVER_DEVICE_SIGNATURE_PREFIX,
  createAppServerDeviceProofMessage,
  decodeBase64Url,
  isAppServerDevicePublicKey,
  isAppServerDeviceSignature,
} from "@ag2cli/app-server-protocol/device-proof.js"
import { type AppServerDeviceChallenge, type AppServerDeviceProof } from "@ag2cli/app-server-protocol/types.js"

const DEFAULT_TTL_MS = 60_000

interface DeviceChallengeState {
  readonly deviceId: string
  readonly expiresAt: number
}

export interface AppServerDeviceProofVerificationInput {
  readonly deviceId: string
  readonly publicKey: string
  readonly clientId: string
  readonly proof: AppServerDeviceProof
}

export interface AppServerDeviceChallengeIssuer {
  issue(deviceId: string): AppServerDeviceChallenge
}

export interface AppServerDeviceProofVerifier {
  verify(input: AppServerDeviceProofVerificationInput): Promise<boolean>
}

export interface AppServerDeviceProofServiceOptions {
  readonly serverFingerprint: string
  readonly now?: () => Date
  readonly ttlMs?: number
  readonly crypto?: Crypto
}

/** Host-owned, single-use challenge and P-256 proof verification state. */
export class InMemoryAppServerDeviceProofService implements AppServerDeviceChallengeIssuer, AppServerDeviceProofVerifier {
  private readonly challenges = new Map<string, DeviceChallengeState>()
  private readonly now: () => Date
  private readonly ttlMs: number
  private readonly cryptoApi: Crypto
  private closed = false

  constructor(private readonly options: AppServerDeviceProofServiceOptions) {
    if (options.serverFingerprint.trim().length === 0) throw new RangeError("serverFingerprint must not be empty")
    if (!Number.isSafeInteger(options.ttlMs ?? DEFAULT_TTL_MS) || (options.ttlMs ?? DEFAULT_TTL_MS) <= 0) {
      throw new RangeError("device proof ttl must be a positive integer")
    }
    this.now = options.now ?? (() => new Date())
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.cryptoApi = options.crypto ?? globalThis.crypto
  }

  issue(deviceId: string): AppServerDeviceChallenge {
    if (this.closed) throw new Error("device proof service is closed")
    if (deviceId.trim().length === 0) throw new RangeError("deviceId must not be empty")
    const now = this.now().getTime()
    this.removeExpired(now)
    const challenge = `${APP_SERVER_DEVICE_CHALLENGE_PREFIX}${randomBytes(32).toString("base64url")}`
    const expiresAt = now + this.ttlMs
    this.challenges.set(challenge, { deviceId, expiresAt })
    return {
      deviceId,
      challenge,
      serverFingerprint: this.options.serverFingerprint,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  async verify(input: AppServerDeviceProofVerificationInput): Promise<boolean> {
    if (this.closed) return false
    const challenge = input.proof.challenge
    const signature = input.proof.signature
    if (challenge === undefined || signature === undefined || input.proof.deviceId !== input.deviceId) return false
    const state = this.challenges.get(challenge)
    this.challenges.delete(challenge)
    if (state === undefined || state.expiresAt <= this.now().getTime() || state.deviceId !== input.deviceId) return false
    if (!isAppServerDevicePublicKey(input.publicKey) || !isAppServerDeviceSignature(signature)) return false
    const publicKey = decodeBase64Url(input.publicKey.slice(APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX.length))
    const signatureBytes = decodeBase64Url(signature.slice(APP_SERVER_DEVICE_SIGNATURE_PREFIX.length))
    if (publicKey === undefined || signatureBytes === undefined || signatureBytes.byteLength !== 64) return false
    try {
      const imported = await this.cryptoApi.subtle.importKey(
        "spki",
        publicKey as unknown as NodeJS.BufferSource,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      )
      return await this.cryptoApi.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        imported,
        signatureBytes as unknown as NodeJS.BufferSource,
        new TextEncoder().encode(
          createAppServerDeviceProofMessage({
            serverFingerprint: this.options.serverFingerprint,
            challenge,
            deviceId: input.deviceId,
            clientId: input.clientId,
          }),
        ),
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
