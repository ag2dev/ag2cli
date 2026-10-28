import {
  APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX,
  APP_SERVER_DEVICE_SIGNATURE_PREFIX,
  createAppServerDeviceProofMessage,
  encodeBase64Url,
} from "@ag2cli/app-server-protocol/device-proof.js"
import { type AppServerDeviceChallenge, type AppServerDeviceProof } from "@ag2cli/app-server-protocol/types.js"

export interface AppServerDeviceKeyPair {
  readonly privateKey: CryptoKey
  readonly publicKey: string
}

/** Generate a browser/native-compatible P-256 device identity. */
export async function generateAppServerDeviceKeyPair(cryptoApi: Crypto = globalThis.crypto): Promise<AppServerDeviceKeyPair> {
  const generated = await cryptoApi.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])
  if (!("privateKey" in generated)) {
    throw new Error("Failed to generate the App Server device key pair")
  }
  const spki = await cryptoApi.subtle.exportKey("spki", generated.publicKey)
  return {
    privateKey: generated.privateKey,
    publicKey: `${APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX}${encodeBase64Url(new Uint8Array(spki))}`,
  }
}

/** Sign one short-lived server challenge for the first initialize request. */
export async function signAppServerDeviceChallenge(
  challenge: AppServerDeviceChallenge,
  deviceId: string,
  clientId: string,
  keyPair: AppServerDeviceKeyPair,
  cryptoApi: Crypto = globalThis.crypto,
): Promise<AppServerDeviceProof> {
  const message = createAppServerDeviceProofMessage({
    hostId: challenge.hostId,
    challenge: challenge.challenge,
    deviceId,
    clientId,
  })
  const signature = await cryptoApi.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(message))
  return {
    deviceId,
    challenge: challenge.challenge,
    signature: `${APP_SERVER_DEVICE_SIGNATURE_PREFIX}${encodeBase64Url(new Uint8Array(signature))}`,
  }
}
