package com.ag2dev.ag2cli.mobile.data

import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ag2dev.ag2cli.mobile.core.pairing.AppServerPairingReview
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class PairingFlowState(
    val connectionLink: String? = null,
    val deviceName: String = "",
    val review: AppServerPairingReview? = null,
    val isReviewing: Boolean = false,
    val isPairing: Boolean = false,
    val result: PairingResult? = null,
    val reviewFailed: Boolean = false,
    val pairingFailed: Boolean = false,
    val storageFailureDeviceId: String? = null,
    val localNetworkPermissionRequired: Boolean = false,
    val localNetworkPermissionDenied: Boolean = false,
) {
    override fun toString(): String =
        "PairingFlowState(connectionLink=${if (connectionLink == null) "null" else "<redacted>"}, " +
        "deviceName=$deviceName, review=$review, isReviewing=$isReviewing, isPairing=$isPairing, result=$result, " +
        "reviewFailed=$reviewFailed, pairingFailed=$pairingFailed, " +
        "storageFailureDeviceId=$storageFailureDeviceId, " +
            "localNetworkPermissionRequired=$localNetworkPermissionRequired, " +
            "localNetworkPermissionDenied=$localNetworkPermissionDenied)"
}

/** Keeps the short-lived pairing link and in-flight result across Activity configuration changes. */
class PairingFlowViewModel : ViewModel() {
    private val mutableState = MutableStateFlow(PairingFlowState())
    private var preview: (suspend (String) -> AppServerPairingReview)? = null
    private var pair: (suspend (String, AppServerPairingReview, String) -> PairingResult)? = null

    val state: StateFlow<PairingFlowState> = mutableState.asStateFlow()

    fun attachPairingOperations(
        previewOperation: suspend (String) -> AppServerPairingReview,
        pairOperation: suspend (String, AppServerPairingReview, String) -> PairingResult,
    ) {
        preview = previewOperation
        pair = pairOperation
    }

    fun open(connectionLink: String) {
        if (mutableState.value.isPairing || mutableState.value.isReviewing) return
        mutableState.value = PairingFlowState(
            connectionLink = connectionLink,
            deviceName = Build.MODEL.take(MAX_DEVICE_NAME_LENGTH),
        )
    }

    fun dismiss() {
        if (!mutableState.value.isPairing && !mutableState.value.isReviewing) mutableState.value = PairingFlowState()
    }

    fun updateDeviceName(value: String) {
        if (!mutableState.value.isPairing && !mutableState.value.isReviewing && value.length <= MAX_DEVICE_NAME_LENGTH) {
            mutableState.update { it.copy(deviceName = value) }
        }
    }

    fun markLocalNetworkPermissionDenied() {
        mutableState.update {
            it.copy(
                localNetworkPermissionRequired = false,
                localNetworkPermissionDenied = true,
            )
        }
    }

    fun confirm() {
        val current = mutableState.value
        val connectionLink = current.connectionLink ?: return
        if (current.isPairing || current.isReviewing) return
        if (current.review == null) reviewLink(connectionLink) else claimDevice(connectionLink, current)
    }

    private fun reviewLink(connectionLink: String) {
        val operation = preview ?: return
        mutableState.update { it.copy(isReviewing = true, reviewFailed = false, localNetworkPermissionRequired = false, localNetworkPermissionDenied = false) }
        viewModelScope.launch {
            try {
                val review = withContext(Dispatchers.IO) { operation(connectionLink) }
                mutableState.update { it.copy(review = review) }
            } catch (error: CancellationException) {
                throw error
            } catch (_: PairingLocalNetworkPermissionRequiredException) {
                mutableState.update { it.copy(localNetworkPermissionRequired = true) }
            } catch (_: Exception) {
                mutableState.update { it.copy(reviewFailed = true) }
            } finally {
                mutableState.update { it.copy(isReviewing = false) }
            }
        }
    }

    private fun claimDevice(connectionLink: String, current: PairingFlowState) {
        val operation = pair ?: return
        val review = current.review ?: return
        val deviceName = current.deviceName.trim()
        if (deviceName.isBlank()) return
        mutableState.update { it.copy(isPairing = true, pairingFailed = false, localNetworkPermissionRequired = false, localNetworkPermissionDenied = false) }
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) { operation(connectionLink, review, deviceName) }
                mutableState.update { it.copy(result = result) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: PairingCredentialPersistenceException) {
                mutableState.update { it.copy(storageFailureDeviceId = error.deviceId) }
            } catch (_: PairingLocalNetworkPermissionRequiredException) {
                mutableState.update { it.copy(localNetworkPermissionRequired = true) }
            } catch (_: Exception) {
                mutableState.update { it.copy(pairingFailed = true) }
            } finally {
                mutableState.update { it.copy(isPairing = false) }
            }
        }
    }

    private companion object {
        const val MAX_DEVICE_NAME_LENGTH = 128
    }
}
