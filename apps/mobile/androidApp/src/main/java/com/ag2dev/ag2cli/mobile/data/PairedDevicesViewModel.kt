package com.ag2dev.ag2cli.mobile.data

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class PairedDevicesState(
    val devices: List<PairedDeviceSummary> = emptyList(),
    val isLoading: Boolean = false,
    val removingDeviceId: String? = null,
    val hasError: Boolean = false,
)

/** Loads and removes encrypted device credentials without exposing credential values to the UI. */
class PairedDevicesViewModel : ViewModel() {
    private val mutableState = MutableStateFlow(PairedDevicesState())
    private var loadOperation: (() -> List<PairedDeviceSummary>)? = null
    private var forgetOperation: ((String, String) -> Boolean)? = null

    val state: StateFlow<PairedDevicesState> = mutableState.asStateFlow()

    fun attachOperations(
        load: () -> List<PairedDeviceSummary>,
        forget: (String, String) -> Boolean,
    ) {
        loadOperation = load
        forgetOperation = forget
    }

    fun refresh() {
        val load = loadOperation ?: return
        if (mutableState.value.isLoading) return
        mutableState.update { it.copy(isLoading = true, hasError = false) }
        viewModelScope.launch {
            try {
                val devices = withContext(Dispatchers.IO) { load() }
                mutableState.update { it.copy(devices = devices, hasError = false) }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                mutableState.update { it.copy(hasError = true) }
            } finally {
                mutableState.update { it.copy(isLoading = false) }
            }
        }
    }

    fun forget(device: PairedDeviceSummary) {
        val forget = forgetOperation ?: return
        if (mutableState.value.removingDeviceId != null) return
        mutableState.update { it.copy(removingDeviceId = device.deviceId, hasError = false) }
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { forget(device.deviceId, device.hostId) }
                mutableState.update {
                    it.copy(
                        devices = it.devices.filterNot { current ->
                            current.deviceId == device.deviceId &&
                                current.hostId == device.hostId
                        },
                    )
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                mutableState.update { it.copy(hasError = true) }
            } finally {
                mutableState.update { it.copy(removingDeviceId = null) }
            }
        }
    }
}
