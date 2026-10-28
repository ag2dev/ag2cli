package com.ag2dev.ag2cli.mobile.core.protocol

import kotlin.time.Instant

const val APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX = "ag2cli-p256-spki."
const val APP_SERVER_DEVICE_SIGNATURE_PREFIX = "ag2cli-p256-signature."
const val APP_SERVER_DEVICE_CHALLENGE_PREFIX = "ag2cli-challenge."

data class DeviceProofMessage(
    val hostId: String,
    val challenge: String,
    val deviceId: String,
    val clientId: String,
)

/** Returns a raw 64-byte P-1363 signature over SHA-256(message). */
fun interface AppServerDeviceProofSigner {
    suspend fun signP256Sha256(message: ByteArray): ByteArray
}

/** Platform-backed validation of an encoded P-256 public key before consuming a pairing ticket. */
fun interface AppServerDevicePublicKeyValidator {
    fun isValid(publicKey: String): Boolean
}

suspend fun signAppServerDeviceChallenge(
    challenge: AppServerDeviceChallenge,
    deviceId: String,
    clientId: String,
    signer: AppServerDeviceProofSigner,
    now: Instant = kotlin.time.Clock.System.now(),
): AppServerDeviceProof {
    if (clientId.isBlank() || deviceId.isBlank() || challenge.hostId.isBlank() || !isValidAppServerHostId(challenge.hostId)) {
        throw AppServerProtocolException("invalid_result", "Device challenge contains a blank required value")
    }
    if (!isValidDeviceChallenge(challenge.challenge)) {
        throw AppServerProtocolException("invalid_result", "Device challenge has an invalid format")
    }
    if (challenge.expiresAt !in 0..MAX_SAFE_INTEGER) {
        throw AppServerProtocolException("invalid_result", "Device challenge expiry is invalid")
    }
    if (challenge.expiresAt <= now.toEpochMilliseconds()) {
        throw AppServerProtocolException("challenge_expired", "Device challenge has expired")
    }
    val message = createDeviceProofMessage(
        DeviceProofMessage(
            hostId = challenge.hostId,
            challenge = challenge.challenge,
            deviceId = deviceId,
            clientId = clientId,
        ),
    ).encodeToByteArray()
    val signature = signer.signP256Sha256(message)
    if (signature.size != P256_SIGNATURE_SIZE) {
        throw AppServerProtocolException("invalid_signature", "Device proof signer returned a non-P1363 signature")
    }
    return AppServerDeviceProof(
        deviceId = deviceId,
        challenge = challenge.challenge,
        signature = encodeDeviceSignatureP1363(signature),
    )
}

fun createDeviceProofMessage(input: DeviceProofMessage): String = buildString {
    append("[\"ag2cli-device-proof.v1\",")
    appendJsonString(input.hostId)
    append(',')
    appendJsonString(input.challenge)
    append(',')
    appendJsonString(input.deviceId)
    append(',')
    appendJsonString(input.clientId)
    append(']')
}

fun encodeDevicePublicKeySubjectPublicKeyInfo(value: ByteArray): String =
    APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX + encodeBase64Url(value)

fun encodeDeviceSignatureP1363(value: ByteArray): String {
    require(value.size == P256_SIGNATURE_SIZE) { "P-256 P1363 signature must be 64 bytes" }
    return APP_SERVER_DEVICE_SIGNATURE_PREFIX + encodeBase64Url(value)
}

fun encodeDeviceChallenge(value: ByteArray): String {
    require(value.size == CHALLENGE_SIZE) { "App Server challenge must be 32 bytes" }
    return APP_SERVER_DEVICE_CHALLENGE_PREFIX + encodeBase64Url(value)
}

fun isValidDeviceChallenge(value: String): Boolean {
    if (!value.startsWith(APP_SERVER_DEVICE_CHALLENGE_PREFIX)) return false
    val decoded = decodeBase64Url(value.removePrefix(APP_SERVER_DEVICE_CHALLENGE_PREFIX)) ?: return false
    return decoded.size == CHALLENGE_SIZE
}

fun isValidDevicePublicKey(value: String): Boolean {
    if (!value.startsWith(APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX)) return false
    val encoded = value.removePrefix(APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX)
    if (encoded.length > MAX_PUBLIC_KEY_BASE64URL_LENGTH) return false
    val decoded = decodeBase64Url(encoded) ?: return false
    return decoded.isNotEmpty() && decoded.size <= MAX_PUBLIC_KEY_DER_SIZE
}

fun isValidDeviceSignature(value: String): Boolean {
    if (!value.startsWith(APP_SERVER_DEVICE_SIGNATURE_PREFIX)) return false
    val decoded = decodeBase64Url(value.removePrefix(APP_SERVER_DEVICE_SIGNATURE_PREFIX)) ?: return false
    return decoded.size == P256_SIGNATURE_SIZE
}

fun derEcdsaSignatureToP1363(der: ByteArray): ByteArray {
    var offset = 0
    require(readByte(der, offset++) == 0x30) { "ECDSA signature must be a DER sequence" }
    val sequenceLength = readDerLength(der, offset).also { offset = it.nextOffset }
    require(sequenceLength.value == der.size - offset) { "ECDSA DER sequence length is invalid" }

    val r = readDerInteger(der, offset).also { offset = it.nextOffset }
    val s = readDerInteger(der, offset).also { offset = it.nextOffset }
    require(offset == der.size) { "ECDSA DER signature contains trailing bytes" }
    return fixedWidthInteger(r.value) + fixedWidthInteger(s.value)
}

fun encodeBase64Url(bytes: ByteArray): String {
    val output = StringBuilder((bytes.size * 4 + 2) / 3)
    var index = 0
    while (index < bytes.size) {
        val first = bytes[index].toInt() and 0xff
        val hasSecond = index + 1 < bytes.size
        val hasThird = index + 2 < bytes.size
        val second = if (hasSecond) bytes[index + 1].toInt() and 0xff else 0
        val third = if (hasThird) bytes[index + 2].toInt() and 0xff else 0

        output.append(BASE64[(first ushr 2) and 0x3f])
        output.append(BASE64[((first and 0x03) shl 4) or (second ushr 4)])
        if (hasSecond) output.append(BASE64[((second and 0x0f) shl 2) or (third ushr 6)])
        if (hasThird) output.append(BASE64[third and 0x3f])
        index += 3
    }
    return output.toString().replace('+', '-').replace('/', '_')
}

fun decodeBase64Url(value: String): ByteArray? {
    if (value.isEmpty()) return byteArrayOf()
    if (value.any { it !in BASE64_URL }) return null
    if (value.length % 4 == 1) return null

    val output = ByteArray(value.length * 3 / 4 + 2)
    var outputIndex = 0
    var buffer = 0
    var bits = 0
    for (character in value) {
        val digit = BASE64_URL.indexOf(character)
        if (digit < 0) return null
        buffer = (buffer shl 6) or digit
        bits += 6
        if (bits >= 8) {
            bits -= 8
            output[outputIndex++] = ((buffer ushr bits) and 0xff).toByte()
        }
    }
    val decoded = output.copyOf(outputIndex)
    return decoded.takeIf { encodeBase64Url(it) == value }
}

private data class DerValue(val value: ByteArray, val nextOffset: Int)

private fun readDerInteger(bytes: ByteArray, start: Int): DerValue {
    var offset = start
    require(readByte(bytes, offset++) == 0x02) { "ECDSA DER value is not an integer" }
    val length = readDerLength(bytes, offset).also { offset = it.nextOffset }.value
    require(length in 1..(P256_COMPONENT_SIZE + 1)) { "ECDSA DER integer has an invalid length" }
    require(offset + length <= bytes.size) { "ECDSA DER integer is truncated" }
    val encoded = bytes.copyOfRange(offset, offset + length)
    require((encoded[0].toInt() and 0x80) == 0) { "ECDSA DER integer must be non-negative" }
    require(encoded.size == 1 || encoded[0] != 0.toByte() || (encoded[1].toInt() and 0x80) != 0) {
        "ECDSA DER integer has a redundant sign byte"
    }
    val magnitude = if (encoded.size > 1 && encoded[0] == 0.toByte()) encoded.copyOfRange(1, encoded.size) else encoded
    require(magnitude.size <= P256_COMPONENT_SIZE) { "ECDSA DER integer exceeds P-256 width" }
    return DerValue(magnitude, offset + length)
}

private fun fixedWidthInteger(value: ByteArray): ByteArray {
    val padded = ByteArray(P256_COMPONENT_SIZE)
    value.copyInto(padded, destinationOffset = P256_COMPONENT_SIZE - value.size)
    return padded
}

private data class DerLength(val value: Int, val nextOffset: Int)

private fun readDerLength(bytes: ByteArray, start: Int): DerLength {
    val first = readByte(bytes, start)
    if (first < 0x80) return DerLength(first, start + 1)
    val count = first and 0x7f
    require(count == 1) { "P-256 ECDSA DER length must use short or one-byte long form" }
    val length = readByte(bytes, start + 1)
    require(length >= 0x80) { "ECDSA DER length is not minimally encoded" }
    return DerLength(length, start + 2)
}

private fun readByte(bytes: ByteArray, index: Int): Int {
    require(index in bytes.indices) { "ECDSA DER signature is truncated" }
    return bytes[index].toInt() and 0xff
}

internal fun StringBuilder.appendJsonString(value: String) {
    append('"')
    var index = 0
    while (index < value.length) {
        val character = value[index]
        when (character) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\t' -> append("\\t")
            '\n' -> append("\\n")
            '\u000c' -> append("\\f")
            '\r' -> append("\\r")
            else -> when {
                character.code < 0x20 -> appendUnicodeEscape(character)
                character.isHighSurrogate() && (index + 1 >= value.length || !value[index + 1].isLowSurrogate()) -> appendUnicodeEscape(character)
                character.isLowSurrogate() && (index == 0 || !value[index - 1].isHighSurrogate()) -> appendUnicodeEscape(character)
                else -> append(character)
            }
        }
        index += 1
    }
    append('"')
}

/** Converts a raw 64-byte P-1363 P-256 signature to the DER form used by Android's JCA verifier. */
fun p1363EcdsaSignatureToDer(signature: ByteArray): ByteArray {
    require(signature.size == P256_SIGNATURE_SIZE) { "P-256 P1363 signature must be 64 bytes" }
    val body = encodeDerInteger(signature.copyOfRange(0, P256_COMPONENT_SIZE)) +
        encodeDerInteger(signature.copyOfRange(P256_COMPONENT_SIZE, P256_SIGNATURE_SIZE))
    return byteArrayOf(0x30, body.size.toByte()) + body
}

private fun encodeDerInteger(value: ByteArray): ByteArray {
    var firstSignificantByte = 0
    while (firstSignificantByte < value.lastIndex && value[firstSignificantByte] == 0.toByte()) {
        firstSignificantByte += 1
    }
    val magnitude = value.copyOfRange(firstSignificantByte, value.size)
    val needsSignByte = (magnitude[0].toInt() and 0x80) != 0
    val encodedLength = magnitude.size + if (needsSignByte) 1 else 0
    val output = ByteArray(encodedLength + 2)
    output[0] = 0x02
    output[1] = encodedLength.toByte()
    val valueOffset = 2 + if (needsSignByte) 1 else 0
    magnitude.copyInto(output, destinationOffset = valueOffset)
    return output
}

private fun StringBuilder.appendUnicodeEscape(character: Char) {
    append("\\u")
    append(HEX[(character.code ushr 12) and 0x0f])
    append(HEX[(character.code ushr 8) and 0x0f])
    append(HEX[(character.code ushr 4) and 0x0f])
    append(HEX[character.code and 0x0f])
}

private const val P256_COMPONENT_SIZE = 32
private const val P256_SIGNATURE_SIZE = P256_COMPONENT_SIZE * 2
private const val CHALLENGE_SIZE = 32
private const val MAX_PUBLIC_KEY_DER_SIZE = 256
private const val MAX_PUBLIC_KEY_BASE64URL_LENGTH = (MAX_PUBLIC_KEY_DER_SIZE * 8 + 5) / 6
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private const val BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
private const val BASE64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
private const val HEX = "0123456789abcdef"
