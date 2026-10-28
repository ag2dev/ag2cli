import type { AppServerDeviceChallenge } from "./types.js"

export const APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX = "ag2cli-p256-spki."
export const APP_SERVER_DEVICE_SIGNATURE_PREFIX = "ag2cli-p256-signature."
export const APP_SERVER_DEVICE_CHALLENGE_PREFIX = "ag2cli-challenge."

export interface AppServerDeviceProofMessageInput {
  readonly hostId: string
  readonly challenge: string
  readonly deviceId: string
  readonly clientId: string
}

/**
 * Encode the signed payload as a positional JSON array.
 *
 * The order is part of the public protocol so non-TypeScript clients can
 * reproduce the exact bytes without depending on object-key ordering.
 */
export function createAppServerDeviceProofMessage(input: AppServerDeviceProofMessageInput): string {
  return JSON.stringify(["ag2cli-device-proof.v1", input.hostId, input.challenge, input.deviceId, input.clientId])
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    encoded += BASE64[(first >> 2) & 0x3f]
    encoded += BASE64[((first & 0x03) << 4) | ((second ?? 0) >> 4)]
    encoded += second === undefined ? "=" : BASE64[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]
    encoded += third === undefined ? "=" : BASE64[third & 0x3f]
  }
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

export function decodeBase64Url(value: string): Uint8Array | undefined {
  if (value.length === 0) return new Uint8Array()
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const remainder = normalized.length % 4
  if (remainder === 1) return undefined
  const padded = normalized + "=".repeat((4 - remainder) % 4)
  const output: number[] = []
  for (let index = 0; index < padded.length; index += 4) {
    const first = base64Value(padded[index]!)
    const second = base64Value(padded[index + 1]!)
    const third = padded[index + 2] === "=" ? undefined : base64Value(padded[index + 2]!)
    const fourth = padded[index + 3] === "=" ? undefined : base64Value(padded[index + 3]!)
    if (
      first === undefined ||
      second === undefined ||
      (third === undefined && padded[index + 2] !== "=") ||
      (fourth === undefined && padded[index + 3] !== "=")
    ) {
      return undefined
    }
    output.push((first << 2) | (second >> 4))
    if (third !== undefined) output.push(((second & 0x0f) << 4) | (third >> 2))
    if (fourth !== undefined && third !== undefined) output.push(((third & 0x03) << 6) | fourth)
  }
  const decoded = new Uint8Array(output)
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

export function isAppServerDevicePublicKey(value: string): boolean {
  if (!value.startsWith(APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX)) return false
  const encoded = value.slice(APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX.length)
  if (encoded.length > MAX_PUBLIC_KEY_BASE64URL_LENGTH) return false
  const decoded = decodeBase64Url(encoded)
  return decoded !== undefined && decoded.byteLength > 0 && decoded.byteLength <= MAX_PUBLIC_KEY_DER_SIZE
}

export function isAppServerDeviceSignature(value: string): boolean {
  const encoded = value.startsWith(APP_SERVER_DEVICE_SIGNATURE_PREFIX) ? value.slice(APP_SERVER_DEVICE_SIGNATURE_PREFIX.length) : ""
  return encoded.length === 86 && decodeBase64Url(encoded)?.byteLength === 64
}

export function isAppServerDeviceChallenge(value: string): boolean {
  const encoded = value.startsWith(APP_SERVER_DEVICE_CHALLENGE_PREFIX) ? value.slice(APP_SERVER_DEVICE_CHALLENGE_PREFIX.length) : ""
  return encoded.length === 43 && decodeBase64Url(encoded)?.byteLength === 32
}

export function isValidAppServerDeviceChallenge(value: AppServerDeviceChallenge): boolean {
  return (
    isAppServerDeviceChallenge(value.challenge) &&
    isValidHostId(value.hostId) &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt >= 0
  )
}

function base64Value(value: string): number | undefined {
  const index = BASE64.indexOf(value)
  return index < 0 ? undefined : index
}

function isValidHostId(value: string): boolean {
  if (!value.startsWith("ag2cli-host.v1.")) return false
  const encoded = value.slice("ag2cli-host.v1.".length)
  return encoded.length === 43 && decodeBase64Url(encoded)?.byteLength === 32
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const MAX_PUBLIC_KEY_DER_SIZE = 256
const MAX_PUBLIC_KEY_BASE64URL_LENGTH = Math.ceil((MAX_PUBLIC_KEY_DER_SIZE * 8) / 6)
