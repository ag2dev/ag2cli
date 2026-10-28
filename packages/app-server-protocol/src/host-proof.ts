import {
  APP_SERVER_DEVICE_CHALLENGE_PREFIX,
  APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX,
  APP_SERVER_DEVICE_SIGNATURE_PREFIX,
  decodeBase64Url,
  encodeBase64Url,
} from "./device-proof.js"
import type { AppServerHostProofPurpose } from "./types.js"

export type { AppServerHostProofPurpose } from "./types.js"

export const APP_SERVER_HOST_ID_PREFIX = "ag2cli-host.v1."
export const APP_SERVER_HOST_IDENTITY_DOMAIN = "ag2cli-host-identity.v1"
export const APP_SERVER_HOST_PROOF_DOMAIN = "ag2cli-host-proof.v1"

export interface AppServerHostProofMessageInput {
  readonly purpose: AppServerHostProofPurpose
  readonly hostId: string
  readonly nonce: string
  readonly expiresAt: number
}

/** Derive the stable identity for one logical serve authority from its canonical SPKI DER key. */
export async function deriveAppServerHostId(canonicalSpkiDer: Uint8Array): Promise<string> {
  if (canonicalSpkiDer.byteLength === 0) throw new RangeError("Host identity SPKI must not be empty")
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable")

  const domain = new TextEncoder().encode(APP_SERVER_HOST_IDENTITY_DOMAIN)
  const input = new Uint8Array(domain.byteLength + 1 + canonicalSpkiDer.byteLength)
  input.set(domain)
  input[domain.byteLength] = 0
  input.set(canonicalSpkiDer, domain.byteLength + 1)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input)
  return APP_SERVER_HOST_ID_PREFIX + encodeBase64Url(new Uint8Array(digest))
}

export function isAppServerHostId(value: string): boolean {
  if (!value.startsWith(APP_SERVER_HOST_ID_PREFIX)) return false
  const encodedDigest = value.slice(APP_SERVER_HOST_ID_PREFIX.length)
  return encodedDigest.length === SHA256_BASE64URL_LENGTH && decodeBase64Url(encodedDigest)?.byteLength === SHA256_SIZE
}

/** Encode the positional UTF-8 message signed by the persistent Host identity key. */
export function createAppServerHostProofMessage(input: AppServerHostProofMessageInput): Uint8Array {
  if (!isAppServerHostId(input.hostId)) throw new RangeError("Host ID has an invalid format")
  if (!isAppServerHostProofPurpose(input.purpose)) throw new RangeError("Host proof purpose has an invalid value")
  if (!isValidAppServerHostProofNonce(input.nonce)) throw new RangeError("Host proof nonce has an invalid format")
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) {
    throw new RangeError("Host proof expiry must be a non-negative safe integer")
  }
  const json = JSON.stringify([APP_SERVER_HOST_PROOF_DOMAIN, input.purpose, input.hostId, input.nonce, input.expiresAt])
  return new TextEncoder().encode(json)
}

export function isAppServerHostProofPurpose(value: string): value is AppServerHostProofPurpose {
  return value === "pairing-link" || value === "admin-pairing" || value === "device-connect"
}

export function isValidAppServerHostProofNonce(value: string): boolean {
  if (!value.startsWith(APP_SERVER_DEVICE_CHALLENGE_PREFIX)) return false
  const encodedNonce = value.slice(APP_SERVER_DEVICE_CHALLENGE_PREFIX.length)
  return encodedNonce.length === SHA256_BASE64URL_LENGTH && decodeBase64Url(encodedNonce)?.byteLength === CHALLENGE_SIZE
}

export function decodeAppServerHostPublicKey(value: string): Uint8Array | undefined {
  if (!value.startsWith(APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX)) return undefined
  const encoded = value.slice(APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX.length)
  if (encoded.length > maximumBase64UrlLength(MAX_HOST_PUBLIC_KEY_DER_BYTES)) return undefined
  const decoded = decodeBase64Url(encoded)
  if (decoded === undefined || decoded.byteLength === 0 || decoded.byteLength > MAX_HOST_PUBLIC_KEY_DER_BYTES) return undefined
  return decoded
}

export function decodeAppServerHostProofSignature(value: string): Uint8Array | undefined {
  if (!value.startsWith(APP_SERVER_DEVICE_SIGNATURE_PREFIX)) return undefined
  const encoded = value.slice(APP_SERVER_DEVICE_SIGNATURE_PREFIX.length)
  if (encoded.length !== P256_SIGNATURE_BASE64URL_LENGTH) return undefined
  const decoded = decodeBase64Url(encoded)
  if (decoded === undefined || decoded.byteLength !== P256_SIGNATURE_SIZE) return undefined
  return decoded
}

export function encodeAppServerHostPublicKey(canonicalSpkiDer: Uint8Array): string {
  if (canonicalSpkiDer.byteLength === 0) throw new RangeError("Host identity SPKI must not be empty")
  if (canonicalSpkiDer.byteLength > MAX_HOST_PUBLIC_KEY_DER_BYTES) throw new RangeError("Host identity SPKI is too large")
  return APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX + encodeBase64Url(canonicalSpkiDer)
}

export function encodeAppServerHostProofSignature(signatureP1363: Uint8Array): string {
  if (signatureP1363.byteLength !== P256_SIGNATURE_SIZE) throw new RangeError("Host proof signature must be 64-byte P-1363")
  return APP_SERVER_DEVICE_SIGNATURE_PREFIX + encodeBase64Url(signatureP1363)
}

function maximumBase64UrlLength(byteLength: number): number {
  return Math.ceil((byteLength * 8) / 6)
}

const SHA256_SIZE = 32
const SHA256_BASE64URL_LENGTH = 43
const CHALLENGE_SIZE = 32
const MAX_HOST_PUBLIC_KEY_DER_BYTES = 256
const P256_SIGNATURE_SIZE = 64
const P256_SIGNATURE_BASE64URL_LENGTH = 86
