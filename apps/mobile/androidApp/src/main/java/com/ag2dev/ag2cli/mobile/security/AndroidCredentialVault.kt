package com.ag2dev.ag2cli.mobile.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import com.ag2dev.ag2cli.mobile.core.protocol.appServerJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Serializable
data class StoredDeviceCredential(
    val endpoint: String,
    val hostId: String,
    val deviceId: String,
    val deviceName: String,
    val credential: String,
) {
    override fun toString(): String =
        "StoredDeviceCredential(endpoint=${redactedEndpointOrigin(endpoint)}, hostId=$hostId, deviceId=$deviceId, deviceName=$deviceName, credential=<redacted>)"
}

@Serializable
private data class StoredDeviceCredentialSet(val records: List<StoredDeviceCredential>)

/** AES-GCM encrypted credential storage under noBackupFilesDir, with its key held by Android Keystore. */
class AndroidCredentialVault(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, CREDENTIAL_FILE_NAME))

    fun prepare() {
        synchronized(VAULT_LOCK) {
            encryptionKey()
            val parent = file.baseFile.parentFile
            if (parent == null || (!parent.exists() && !parent.mkdirs())) {
                throw IOException("Credential storage is unavailable")
            }
        }
    }

    fun save(value: StoredDeviceCredential) {
        synchronized(VAULT_LOCK) {
            val records = readRecordsUnlocked()
                .filterNot { it.deviceId == value.deviceId && it.hostId == value.hostId } + value
            require(records.size <= MAX_CREDENTIAL_RECORDS) { "Too many paired devices are stored" }
            writeRecordsUnlocked(records)
        }
    }

    fun load(): StoredDeviceCredential? {
        return loadAll().firstOrNull()
    }

    fun loadAll(): List<StoredDeviceCredential> = synchronized(VAULT_LOCK) {
        readRecordsUnlocked()
    }

    fun remove(deviceId: String, hostId: String): Boolean = synchronized(VAULT_LOCK) {
        val records = readRecordsUnlocked()
        val remaining = records.filterNot {
            it.deviceId == deviceId && it.hostId == hostId
        }
        if (remaining.size == records.size) return@synchronized false

        if (remaining.isEmpty()) {
            clearUnlocked()
        } else {
            writeRecordsUnlocked(remaining)
        }
        true
    }

    fun clear() {
        synchronized(VAULT_LOCK) {
            clearUnlocked()
        }
    }

    private fun writeRecordsUnlocked(records: List<StoredDeviceCredential>) {
        val plainText = appServerJson.encodeToString(StoredDeviceCredentialSet(records)).encodeToByteArray()
        require(plainText.size <= MAX_PLAINTEXT_BYTES) { "Stored credential record is too large" }
        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
        cipher.updateAAD(ASSOCIATED_DATA_V3)
        val encrypted = cipher.doFinal(plainText)
        val payload = byteArrayOf(FORMAT_VERSION_V3.toByte()) + cipher.iv + encrypted

        var output: java.io.FileOutputStream? = null
        try {
            output = file.startWrite()
            output.write(payload)
            output.fd.sync()
            file.finishWrite(output)
        } catch (error: Exception) {
            output?.let(file::failWrite)
            throw error
        }
    }

    private fun clearUnlocked() {
        file.delete()
        val keyStore = loadKeyStore()
        if (keyStore.containsAlias(ENCRYPTION_KEY_ALIAS)) keyStore.deleteEntry(ENCRYPTION_KEY_ALIAS)
    }

    private fun encryptionKey(): SecretKey {
        val keyStore = loadKeyStore()
        val existing = keyStore.getKey(ENCRYPTION_KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                ENCRYPTION_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setKeySize(AES_KEY_SIZE_BITS)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun readRecordsUnlocked(): List<StoredDeviceCredential> {
        val input = try {
            file.openRead()
        } catch (_: FileNotFoundException) {
            return emptyList()
        }
        val payload = input.use { stream ->
            if (stream.channel.size() > MAX_CIPHERTEXT_BYTES) throw IOException("Stored credential record is too large")
            val bytes = stream.readBytes()
            if (bytes.size > MAX_CIPHERTEXT_BYTES) throw IOException("Stored credential record is too large")
            bytes
        }
        if (payload.size < HEADER_SIZE + GCM_TAG_BYTES) {
            throw GeneralSecurityException("Stored credential record is invalid")
        }
        val formatVersion = payload[0].toInt() and 0xff
        if (formatVersion != FORMAT_VERSION_V3) throw GeneralSecurityException("Stored credential record is invalid")
        val nonce = payload.copyOfRange(VERSION_BYTES, HEADER_SIZE)
        val ciphertext = payload.copyOfRange(HEADER_SIZE, payload.size)
        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), GCMParameterSpec(GCM_TAG_BITS, nonce))
        cipher.updateAAD(ASSOCIATED_DATA_V3)
        val plainText = cipher.doFinal(ciphertext).decodeToString(throwOnInvalidSequence = true)
        return try {
            appServerJson.decodeFromString<StoredDeviceCredentialSet>(plainText).records
        } catch (_: IllegalArgumentException) {
            throw GeneralSecurityException("Stored credential record is invalid")
        }
    }

    private fun loadKeyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val ENCRYPTION_KEY_ALIAS = "com.ag2dev.ag2cli.mobile.credential-vault.v1"
        private const val CREDENTIAL_FILE_NAME = "paired-device-credential.v3.bin"
        private const val AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val AES_KEY_SIZE_BITS = 256
        private const val GCM_TAG_BITS = 128
        private const val GCM_TAG_BYTES = GCM_TAG_BITS / 8
        private const val FORMAT_VERSION_V3 = 3
        private const val VERSION_BYTES = 1
        private const val NONCE_BYTES = 12
        private const val HEADER_SIZE = VERSION_BYTES + NONCE_BYTES
        private const val MAX_PLAINTEXT_BYTES = 512 * 1024
        private const val MAX_CIPHERTEXT_BYTES = HEADER_SIZE + MAX_PLAINTEXT_BYTES + GCM_TAG_BYTES
        private const val MAX_CREDENTIAL_RECORDS = 32
        private val ASSOCIATED_DATA_V3 = "ag2cli-mobile-credential-v3".encodeToByteArray()
        private val VAULT_LOCK = Any()
    }
}

private fun redactedEndpointOrigin(endpoint: String): String = runCatching {
    val uri = android.net.Uri.parse(endpoint)
    val scheme = uri.scheme ?: return@runCatching "<redacted>"
    val authority = uri.encodedAuthority ?: return@runCatching "<redacted>"
    "$scheme://$authority"
}.getOrDefault("<redacted>")
