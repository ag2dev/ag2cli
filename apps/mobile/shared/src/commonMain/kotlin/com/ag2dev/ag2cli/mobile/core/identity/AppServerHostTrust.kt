package com.ag2dev.ag2cli.mobile.core.identity

import com.ag2dev.ag2cli.mobile.core.protocol.AppServerHostProofPurpose
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerProtocolException
import com.ag2dev.ag2cli.mobile.core.protocol.HostIdentityCryptography
import com.ag2dev.ag2cli.mobile.core.protocol.HostProofExpectation
import com.ag2dev.ag2cli.mobile.core.protocol.ServerPreflightResult
import com.ag2dev.ag2cli.mobile.core.protocol.VerifiedHostIdentity
import com.ag2dev.ag2cli.mobile.core.protocol.encodeDeviceChallenge
import com.ag2dev.ag2cli.mobile.core.protocol.isValidAppServerHostId
import com.ag2dev.ag2cli.mobile.core.protocol.verifyAppServerHostProof
import kotlin.concurrent.atomics.AtomicBoolean
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlin.time.Clock

fun interface SecureRandomPort {
    fun bytes(size: Int): ByteArray
}

internal fun interface EpochClock {
    fun nowEpochMillis(): Long
}

@OptIn(ExperimentalAtomicApi::class)
internal class AppServerHostProofChallenge internal constructor(
    val expectedHostId: String,
    val purpose: AppServerHostProofPurpose,
    val nonce: String,
) {
    private val consumed = AtomicBoolean(false)

    internal fun consume(): Boolean = consumed.compareAndSet(expectedValue = false, newValue = true)

    override fun toString(): String =
        "AppServerHostProofChallenge(expectedHostId=$expectedHostId, purpose=$purpose, nonce=<redacted>)"
}

/** Creates and verifies the Host proof challenge used before a connection sends sensitive data. */
class AppServerHostTrust internal constructor(
    private val random: SecureRandomPort,
    private val cryptography: HostIdentityCryptography,
    private val clock: EpochClock = EpochClock { Clock.System.now().toEpochMilliseconds() },
) {
    constructor(random: SecureRandomPort, cryptography: HostIdentityCryptography) : this(random, cryptography, EpochClock { Clock.System.now().toEpochMilliseconds() })

    internal fun createChallenge(expectedHostId: String, purpose: AppServerHostProofPurpose): AppServerHostProofChallenge {
        if (!isValidAppServerHostId(expectedHostId)) {
            throw AppServerProtocolException("host_proof_invalid", "Expected Host ID has an invalid format")
        }

        val nonceBytes = try {
            random.bytes(CHALLENGE_SIZE)
        } catch (_: Exception) {
            throw AppServerProtocolException("host_random_unavailable", "Secure random bytes are unavailable")
        }
        if (nonceBytes.size != CHALLENGE_SIZE) {
            throw AppServerProtocolException("host_random_unavailable", "Secure random source returned an invalid byte count")
        }

        return AppServerHostProofChallenge(
            expectedHostId = expectedHostId,
            purpose = purpose,
            nonce = encodeDeviceChallenge(nonceBytes),
        )
    }

    internal fun verify(
        challenge: AppServerHostProofChallenge,
        proof: ServerPreflightResult,
    ): VerifiedHostIdentity {
        if (!challenge.consume()) {
            throw AppServerProtocolException("host_proof_invalid", "Host identity proof is invalid")
        }
        val now = try {
            clock.nowEpochMillis()
        } catch (_: Exception) {
            throw AppServerProtocolException("host_clock_unavailable", "Host proof time source is unavailable")
        }
        return verifyAppServerHostProof(
            proof = proof,
            expected = HostProofExpectation(
                hostId = challenge.expectedHostId,
                nonce = challenge.nonce,
                purpose = challenge.purpose,
            ),
            cryptography = cryptography,
            nowEpochMillis = now,
        )
    }

    private companion object {
        const val CHALLENGE_SIZE = 32
    }
}
