package com.ag2dev.ag2cli.mobile.core.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

const val APP_SERVER_HOST_ID_PREFIX = "ag2cli-host.v1."
const val APP_SERVER_HOST_PROOF_IDENTITY_DOMAIN = "ag2cli-host-identity.v1"
const val APP_SERVER_HOST_PROOF_DOMAIN = "ag2cli-host-proof.v1"

@Serializable
enum class AppServerHostProofPurpose {
    @SerialName("pairing-link") PAIRING_LINK,
    @SerialName("admin-pairing") ADMIN_PAIRING,
    @SerialName("device-connect") DEVICE_CONNECT,
}

@Serializable
data class ServerPreflightParams(
    val nonce: String,
    val purpose: AppServerHostProofPurpose,
) {
    override fun toString(): String = "ServerPreflightParams(nonce=<redacted>, purpose=$purpose)"
}

@Serializable
data class ServerPreflightResult(
    val hostId: String,
    val hostPublicKey: String,
    val nonce: String,
    val purpose: AppServerHostProofPurpose,
    val expiresAt: Long,
    val signature: String,
    val deviceChallenge: String? = null,
    val deviceChallengeExpiresAt: Long? = null,
) {
    override fun toString(): String =
        "ServerPreflightResult(hostId=$hostId, purpose=$purpose, expiresAt=$expiresAt, proof=<redacted>)"
}

data class HostProofExpectation(
    val hostId: String,
    val nonce: String,
    val purpose: AppServerHostProofPurpose,
) {
    override fun toString(): String = "HostProofExpectation(hostId=$hostId, nonce=<redacted>, purpose=$purpose)"
}

/** Platform cryptography used to hash Host identity keys and verify P-256 proofs. */
interface HostIdentityCryptography {
    fun sha256(value: ByteArray): ByteArray

    /** `signatureP1363` is the protocol's raw 64-byte r || s signature. */
    fun verifyP256Sha256(spkiDer: ByteArray, message: ByteArray, signatureP1363: ByteArray): Boolean
}

/** A capability returned only after the identity, nonce, purpose, expiry, and signature agree. */
class VerifiedHostIdentity internal constructor(
    val hostId: String,
)

/** Build the exact positional UTF-8 payload signed by a Host identity key. */
fun createAppServerHostProofMessage(proof: ServerPreflightResult): ByteArray {
    require(isValidAppServerHostId(proof.hostId)) { "Host proof Host ID has an invalid format" }
    require(isValidAppServerHostProofNonce(proof.nonce)) { "Host proof nonce has an invalid format" }
    require(proof.expiresAt in 0..MAX_SAFE_INTEGER) { "Host proof expiry is outside the safe integer range" }
    return buildString {
        append('[')
        appendJsonString(APP_SERVER_HOST_PROOF_DOMAIN)
        append(',')
        appendJsonString(proof.purpose.wireValue)
        append(',')
        appendJsonString(proof.hostId)
        append(',')
        appendJsonString(proof.nonce)
        append(',')
        append(proof.expiresAt)
        append(']')
    }.encodeToByteArray()
}

/** Verify a preflight proof before the caller sends any ticket, credential, or other sensitive frame. */
fun verifyAppServerHostProof(
    proof: ServerPreflightResult,
    expected: HostProofExpectation,
    cryptography: HostIdentityCryptography,
    nowEpochMillis: Long,
): VerifiedHostIdentity {
    rejectUnless(isValidAppServerHostId(expected.hostId) && proof.hostId == expected.hostId)
    rejectUnless(isValidAppServerHostProofNonce(expected.nonce) && proof.nonce == expected.nonce)
    rejectUnless(proof.purpose == expected.purpose)
    rejectUnless(proof.expiresAt in 0..MAX_SAFE_INTEGER)
    rejectUnless(nowEpochMillis >= 0 && proof.expiresAt > nowEpochMillis)
    val latestAllowedExpiry = if (nowEpochMillis > Long.MAX_VALUE - MAX_HOST_PROOF_LIFETIME_MILLIS) {
        Long.MAX_VALUE
    } else {
        nowEpochMillis + MAX_HOST_PROOF_LIFETIME_MILLIS
    }
    rejectUnless(proof.expiresAt <= latestAllowedExpiry)

    val spkiDer = decodeAppServerHostPublicKey(proof.hostPublicKey)
        ?: rejectInvalidProof()
    val signature = decodeAppServerHostProofSignature(proof.signature)
        ?: rejectInvalidProof()

    val identityInput = buildHostIdentityInput(spkiDer)
    val digest = try {
        cryptography.sha256(identityInput)
    } catch (_: Exception) {
        throw AppServerProtocolException("host_identity_unavailable", "Host identity verification is unavailable")
    }
    rejectUnless(digest.size == SHA256_SIZE)
    val derivedHostId = APP_SERVER_HOST_ID_PREFIX + encodeBase64Url(digest)
    rejectUnless(derivedHostId == expected.hostId)

    val message = createAppServerHostProofMessage(proof)
    val signatureValid = try {
        cryptography.verifyP256Sha256(spkiDer, message, signature)
    } catch (_: Exception) {
        false
    }
    rejectUnless(signatureValid)
    return VerifiedHostIdentity(derivedHostId)
}

fun isValidAppServerHostId(value: String): Boolean {
    if (!value.startsWith(APP_SERVER_HOST_ID_PREFIX)) return false
    if (value.length - APP_SERVER_HOST_ID_PREFIX.length != SHA256_BASE64URL_LENGTH) return false
    val encodedDigest = value.substring(APP_SERVER_HOST_ID_PREFIX.length)
    return encodedDigest.length == SHA256_BASE64URL_LENGTH && decodeBase64Url(encodedDigest)?.size == SHA256_SIZE
}

fun isValidAppServerHostProofNonce(value: String): Boolean {
    if (!value.startsWith(APP_SERVER_DEVICE_CHALLENGE_PREFIX)) return false
    if (value.length - APP_SERVER_DEVICE_CHALLENGE_PREFIX.length != CHALLENGE_BASE64URL_LENGTH) return false
    val encodedNonce = value.substring(APP_SERVER_DEVICE_CHALLENGE_PREFIX.length)
    return encodedNonce.length == CHALLENGE_BASE64URL_LENGTH && decodeBase64Url(encodedNonce)?.size == CHALLENGE_SIZE
}

fun decodeAppServerHostPublicKey(value: String): ByteArray? =
    decodePrefixedValue(value, APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX, MAX_HOST_PUBLIC_KEY_DER_BYTES)

fun decodeAppServerHostProofSignature(value: String): ByteArray? =
    decodePrefixedValue(value, APP_SERVER_DEVICE_SIGNATURE_PREFIX, P256_SIGNATURE_SIZE)
        ?.takeIf { it.size == P256_SIGNATURE_SIZE }

private fun buildHostIdentityInput(spkiDer: ByteArray): ByteArray {
    val domain = APP_SERVER_HOST_PROOF_IDENTITY_DOMAIN.encodeToByteArray()
    return ByteArray(domain.size + 1 + spkiDer.size).also { input ->
        domain.copyInto(input)
        input[domain.size] = 0
        spkiDer.copyInto(input, destinationOffset = domain.size + 1)
    }
}

private fun decodePrefixedValue(value: String, prefix: String, maximumDecodedBytes: Int): ByteArray? {
    if (!value.startsWith(prefix)) return null
    val encodedLength = value.length - prefix.length
    val maximumEncodedCharacters = (maximumDecodedBytes * 8 + 5) / 6
    if (encodedLength !in 1..maximumEncodedCharacters) return null
    val encoded = value.substring(prefix.length)
    return decodeBase64Url(encoded)?.takeIf { it.isNotEmpty() && it.size <= maximumDecodedBytes }
}

private fun rejectUnless(condition: Boolean) {
    if (!condition) rejectInvalidProof()
}

private fun rejectInvalidProof(): Nothing =
    throw AppServerProtocolException("host_proof_invalid", "Host identity proof is invalid")

private const val MAX_HOST_PROOF_LIFETIME_MILLIS = 60_000L
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private const val MAX_HOST_PUBLIC_KEY_DER_BYTES = 256
private const val SHA256_SIZE = 32
private const val SHA256_BASE64URL_LENGTH = 43
private const val P256_SIGNATURE_SIZE = 64
private const val P256_SIGNATURE_BASE64URL_LENGTH = 86
private const val CHALLENGE_SIZE = 32
private const val CHALLENGE_BASE64URL_LENGTH = 43

private val AppServerHostProofPurpose.wireValue: String
    get() = when (this) {
        AppServerHostProofPurpose.PAIRING_LINK -> "pairing-link"
        AppServerHostProofPurpose.ADMIN_PAIRING -> "admin-pairing"
        AppServerHostProofPurpose.DEVICE_CONNECT -> "device-connect"
    }
