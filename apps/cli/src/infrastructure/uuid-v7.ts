import { randomBytes } from "node:crypto"

/** Create an RFC 9562 UUIDv7 using the current Unix millisecond timestamp. */
export function randomUuidV7(timestamp = Date.now()): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffff_ffff_ffff) {
    throw new RangeError("UUIDv7 timestamp must fit in 48 bits")
  }

  const bytes = randomBytes(16)
  let remaining = timestamp
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff
    remaining = Math.floor(remaining / 0x100)
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f)
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)

  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
