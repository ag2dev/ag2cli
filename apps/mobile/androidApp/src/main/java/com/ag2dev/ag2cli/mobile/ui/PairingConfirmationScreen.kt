package com.ag2dev.ag2cli.mobile.ui

import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ag2dev.ag2cli.mobile.R
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerScope
import com.ag2dev.ag2cli.mobile.core.protocol.parseAppServerConnectionLink
import com.ag2dev.ag2cli.mobile.data.PairingFlowState
import com.ag2dev.ag2cli.mobile.security.AndroidCleartextEndpointPolicy
import com.ag2dev.ag2cli.mobile.security.AndroidLocalNetworkPolicy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun PairingConfirmationScreen(
    state: PairingFlowState,
    onDismiss: () -> Unit,
    onDeviceNameChange: (String) -> Unit,
    onConfirmPairing: () -> Unit,
    onLocalNetworkPermissionDenied: () -> Unit,
) {
    val context = LocalContext.current
    val connectionLink = state.connectionLink.orEmpty()
    val link = remember(connectionLink) {
        runCatching { parseAppServerConnectionLink(connectionLink) }
            .getOrNull()
            ?.takeIf { it.clientKind == null || it.clientKind == "mobile" }
    }
    var requiresLocalNetworkPermission by remember(link?.endpoint) { mutableStateOf<Boolean?>(null) }
    var isCheckingLocalNetworkPermission by remember(link?.endpoint) { mutableStateOf(false) }
    val coroutineScope = rememberCoroutineScope()

    val localNetworkPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) onConfirmPairing() else onLocalNetworkPermissionDenied()
    }

    BackHandler(enabled = state.isPairing) {
        // Pairing consumes a single-use ticket; keep the screen open until the operation finishes.
    }

    Surface(color = MaterialTheme.colorScheme.background) {
        if (link == null) {
            PairingMessageScreen(
                title = stringResource(R.string.pairing_invalid_title),
                body = stringResource(R.string.pairing_invalid_message),
                actionLabel = stringResource(R.string.action_return_to_app),
                onAction = onDismiss,
            )
            return@Surface
        }

        val allowLoopbackCleartext = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (!AndroidCleartextEndpointPolicy.isPermitted(link.endpoint, allowLoopbackCleartext)) {
            PairingMessageScreen(
                title = stringResource(R.string.pairing_unsupported_endpoint_title),
                body = stringResource(R.string.pairing_unsupported_endpoint_message),
                actionLabel = stringResource(R.string.action_return_to_app),
                onAction = onDismiss,
            )
            return@Surface
        }

        val serverEndpoint = link.endpoint

        Column(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text(
                text = stringResource(R.string.pairing_eyebrow),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = if (state.result == null) {
                    stringResource(R.string.pairing_title)
                } else {
                    stringResource(R.string.pairing_success_title)
                },
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = when {
                    state.result != null -> stringResource(R.string.pairing_success_message, state.result.deviceName)
                    state.storageFailureDeviceId != null -> stringResource(
                        R.string.pairing_storage_failure_message,
                        state.storageFailureDeviceId,
                    )
                    state.pairingFailed -> stringResource(R.string.pairing_failure_message)
                    state.reviewFailed -> stringResource(R.string.pairing_review_failure_message)
                    state.localNetworkPermissionDenied -> stringResource(R.string.pairing_local_network_permission_denied)
                    state.localNetworkPermissionRequired -> stringResource(R.string.pairing_local_network_permission_required)
                    else -> stringResource(R.string.pairing_confirmation_message)
                },
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            if (state.result == null && state.storageFailureDeviceId == null && !state.pairingFailed) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                ) {
                    Column(
                        modifier = Modifier.padding(18.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        PairingIdentityField(
                            label = stringResource(R.string.pairing_server_label),
                            value = serverEndpoint,
                        )
                        PairingIdentityField(
                            label = stringResource(R.string.pairing_host_id_label),
                            value = link.hostId,
                            monospace = true,
                        )
                        PairingIdentityField(
                            label = stringResource(R.string.pairing_expiry_label),
                            value = link.expiresAt,
                            monospace = true,
                        )
                    }
                }
                state.review?.let { review ->
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            stringResource(R.string.pairing_permissions_heading),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        review.scopes.forEach { scope ->
                            Text(stringResource(scopeLabel(scope)), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
                Text(
                    text = stringResource(R.string.pairing_identity_warning),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                OutlinedTextField(
                    value = state.deviceName,
                    onValueChange = onDeviceNameChange,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(stringResource(R.string.pairing_device_name_label)) },
                    singleLine = true,
                    enabled = !state.isPairing && !state.isReviewing,
                )
            }

            if (isCheckingLocalNetworkPermission) {
                Text(
                    stringResource(R.string.pairing_local_network_permission_checking),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (
                requiresLocalNetworkPermission == true &&
                !state.localNetworkPermissionRequired && !state.localNetworkPermissionDenied &&
                state.result == null
            ) {
                Text(
                    stringResource(R.string.pairing_local_network_permission_message),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (state.isPairing || state.isReviewing) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator()
                    Text(
                        text = stringResource(if (state.isReviewing) R.string.pairing_reviewing else R.string.pairing_working),
                        modifier = Modifier.padding(start = 12.dp),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }

            Spacer(Modifier.height(2.dp))
            if (state.result != null || state.pairingFailed || state.storageFailureDeviceId != null) {
                Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.action_return_to_app))
                }
            } else {
                Button(
                    onClick = {
                        if (state.isPairing || state.isReviewing || isCheckingLocalNetworkPermission) return@Button
                        if (state.review != null && state.deviceName.isBlank()) return@Button
                        isCheckingLocalNetworkPermission = true
                        coroutineScope.launch {
                            try {
                                requiresLocalNetworkPermission = Build.VERSION.SDK_INT >= ANDROID_17_API_LEVEL &&
                                    withContext(Dispatchers.IO) {
                                        AndroidLocalNetworkPolicy.requiresPermission(link.endpoint)
                                    }
                                if (
                                    (
                                        requiresLocalNetworkPermission == true ||
                                            state.localNetworkPermissionRequired ||
                                            state.localNetworkPermissionDenied
                                        ) &&
                                    context.checkSelfPermission(ACCESS_LOCAL_NETWORK_PERMISSION) != PackageManager.PERMISSION_GRANTED
                                ) {
                                    localNetworkPermissionLauncher.launch(ACCESS_LOCAL_NETWORK_PERMISSION)
                                } else {
                                    onConfirmPairing()
                                }
                            } finally {
                                isCheckingLocalNetworkPermission = false
                            }
                        }
                    },
                    enabled = !state.isPairing && !state.isReviewing && !isCheckingLocalNetworkPermission &&
                        (state.review == null || state.deviceName.isNotBlank()),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        stringResource(
                            if (state.localNetworkPermissionRequired || state.localNetworkPermissionDenied) {
                                R.string.action_retry_local_network_permission
                            } else if (state.review == null) {
                                R.string.action_review_pairing_permissions
                            } else {
                                R.string.action_confirm_pairing
                            },
                        ),
                    )
                }
                OutlinedButton(
                    onClick = onDismiss,
                    enabled = !state.isPairing && !state.isReviewing,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.action_cancel))
                }
            }
        }
    }
}

private fun scopeLabel(scope: AppServerScope): Int = when (scope) {
    AppServerScope.SESSION_READ -> R.string.pairing_scope_session_read
    AppServerScope.SESSION_WRITE -> R.string.pairing_scope_session_write
    AppServerScope.APPROVAL_WRITE -> R.string.pairing_scope_approval_write
    AppServerScope.SHELL_EXECUTE -> R.string.pairing_scope_shell_execute
    AppServerScope.CONFIG_READ -> R.string.pairing_scope_config_read
    AppServerScope.CONFIG_WRITE -> R.string.pairing_scope_config_write
    AppServerScope.DEVICE_ADMIN -> R.string.pairing_scope_device_admin
}

@Composable
private fun PairingIdentityField(label: String, value: String, monospace: Boolean = false) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        SelectionContainer {
            Text(
                text = value,
                style = if (monospace) MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
private fun PairingMessageScreen(title: String, body: String, actionLabel: String, onAction: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
        Text(body, modifier = Modifier.padding(top = 12.dp), style = MaterialTheme.typography.bodyLarge)
        Button(onClick = onAction, modifier = Modifier.padding(top = 24.dp).fillMaxWidth()) {
            Text(actionLabel)
        }
    }
}

private const val ANDROID_17_API_LEVEL = 37
private const val ACCESS_LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
