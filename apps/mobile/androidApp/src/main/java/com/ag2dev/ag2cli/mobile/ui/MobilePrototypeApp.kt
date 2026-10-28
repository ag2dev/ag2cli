package com.ag2dev.ag2cli.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.FactCheck
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfoV2
import androidx.compose.material3.adaptive.navigation3.ListDetailSceneStrategy
import androidx.compose.material3.adaptive.navigation3.rememberListDetailSceneStrategy
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.neverEqualPolicy
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ag2dev.ag2cli.mobile.data.PairingFlowViewModel
import com.ag2dev.ag2cli.mobile.data.PairedDevicesState
import com.ag2dev.ag2cli.mobile.data.PairedDevicesViewModel
import com.ag2dev.ag2cli.mobile.data.PairedDeviceSummary
import androidx.compose.ui.tooling.preview.Preview
import androidx.window.core.layout.WindowSizeClass
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import com.ag2dev.ag2cli.mobile.R
import com.ag2dev.ag2cli.mobile.data.ConnectionPreviewState
import com.ag2dev.ag2cli.mobile.data.DEMO_SERVER_PROFILE_KEY
import com.ag2dev.ag2cli.mobile.data.DemoSessionRepository
import com.ag2dev.ag2cli.mobile.data.ApprovalOutcomeState
import com.ag2dev.ag2cli.mobile.data.SessionRepository
import com.ag2dev.ag2cli.mobile.data.SessionComposerViewModel
import com.ag2dev.ag2cli.mobile.data.SessionTimelineMessage
import com.ag2dev.ag2cli.mobile.core.model.ApprovalKey
import com.ag2dev.ag2cli.mobile.core.model.ApprovalSummary
import com.ag2dev.ag2cli.mobile.core.model.ServerProfileKey
import com.ag2dev.ag2cli.mobile.core.model.SessionKey
import com.ag2dev.ag2cli.mobile.core.model.SessionStatus
import com.ag2dev.ag2cli.mobile.core.model.SessionSummary
import kotlinx.serialization.Serializable

@Serializable
private data object SessionsRoute : NavKey

@Serializable
private data class SessionDetailRoute(val key: SessionKey) : NavKey

@Serializable
private data object ApprovalsRoute : NavKey

@Serializable
private data class ApprovalDetailRoute(val key: ApprovalKey) : NavKey

@Serializable
private data object SettingsRoute : NavKey

private enum class PrimaryDestination(val labelResource: Int) {
    SESSIONS(R.string.nav_sessions),
    APPROVALS(R.string.nav_approvals),
    SETTINGS(R.string.nav_settings),
}

@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
fun MobilePrototypeApp(
    repository: SessionRepository,
    pairingFlow: PairingFlowViewModel,
    pairedDevicesFlow: PairedDevicesViewModel,
    composerState: SessionComposerViewModel,
    onPastePairingLink: () -> String?,
) {
    val pairingState by pairingFlow.state.collectAsStateWithLifecycle()
    val pairedDevicesState by pairedDevicesFlow.state.collectAsStateWithLifecycle()
    val refreshPairedDevices = remember(pairedDevicesFlow) { pairedDevicesFlow::refresh }
    val forgetPairedDevice = remember(pairedDevicesFlow) { pairedDevicesFlow::forget }
    val activePairingLink = pairingState.connectionLink
    if (activePairingLink != null) {
        PairingConfirmationScreen(
            state = pairingState,
            onDismiss = pairingFlow::dismiss,
            onDeviceNameChange = pairingFlow::updateDeviceName,
            onConfirmPairing = pairingFlow::confirm,
            onLocalNetworkPermissionDenied = pairingFlow::markLocalNetworkPermissionDenied,
        )
    } else {
        MobilePrototypeContent(
            repository,
            onStartPairing = pairingFlow::open,
            onPastePairingLink = onPastePairingLink,
            pairedDevicesState = pairedDevicesState,
            composerState = composerState,
            onRefreshPairedDevices = refreshPairedDevices,
            onForgetPairedDevice = forgetPairedDevice,
        )
    }
}

@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
private fun MobilePrototypeContent(
    repository: SessionRepository,
    initialSessionId: String? = null,
    initialServerProfileKey: ServerProfileKey = DEMO_SERVER_PROFILE_KEY,
    onStartPairing: (String) -> Unit = {},
    onPastePairingLink: () -> String? = { null },
    pairedDevicesState: PairedDevicesState = PairedDevicesState(),
    composerState: SessionComposerViewModel,
    onRefreshPairedDevices: () -> Unit = {},
    onForgetPairedDevice: (PairedDeviceSummary) -> Unit = {},
) {
    val initialRoutes = remember(initialSessionId, initialServerProfileKey) {
        if (initialSessionId == null) {
            arrayOf<NavKey>(SessionsRoute)
        } else {
            arrayOf<NavKey>(
                SessionsRoute,
                SessionDetailRoute(SessionKey(initialServerProfileKey, initialSessionId)),
            )
        }
    }
    val backStack = rememberNavBackStack(*initialRoutes)
    val showDetailBackButton = !currentWindowAdaptiveInfoV2().windowSizeClass
        .isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_EXPANDED_LOWER_BOUND)
    var connectionState by remember { mutableStateOf(ConnectionPreviewState.CONNECTED) }
    val approvalOutcomes = remember { ApprovalOutcomeState() }
    val sceneStrategy = rememberListDetailSceneStrategy<NavKey>()
    val navItemColors = NavigationSuiteDefaults.itemColors(
        navigationBarItemColors = NavigationBarItemDefaults.colors(
            selectedIconColor = MaterialTheme.colorScheme.onSecondaryContainer,
            selectedTextColor = MaterialTheme.colorScheme.onSecondaryContainer,
            indicatorColor = MaterialTheme.colorScheme.surfaceVariant,
            unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
        ),
        navigationRailItemColors = NavigationRailItemDefaults.colors(
            selectedIconColor = MaterialTheme.colorScheme.onSecondaryContainer,
            selectedTextColor = MaterialTheme.colorScheme.onSecondaryContainer,
            indicatorColor = MaterialTheme.colorScheme.surfaceVariant,
            unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
        ),
    )
    val currentRoute = backStack.lastOrNull()
    val activeServerProfileKey = when (currentRoute) {
        is SessionDetailRoute -> currentRoute.key.serverProfileKey
        is ApprovalDetailRoute -> currentRoute.key.serverProfileKey
        else -> initialServerProfileKey
    }
    val pendingApprovals = repository.pendingApprovals(activeServerProfileKey)
        .filterNot { approvalOutcomes.isResolved(ApprovalKey(activeServerProfileKey, it.id)) }
    val approvalOutcome = approvalOutcomes.latestOutcome(activeServerProfileKey)
    val selectedDestination = when (currentRoute) {
        is ApprovalsRoute, is ApprovalDetailRoute -> PrimaryDestination.APPROVALS
        is SettingsRoute -> PrimaryDestination.SETTINGS
        else -> PrimaryDestination.SESSIONS
    }

    NavigationSuiteScaffold(
        navigationSuiteColors = NavigationSuiteDefaults.colors(
            navigationBarContainerColor = MaterialTheme.colorScheme.background,
            navigationRailContainerColor = MaterialTheme.colorScheme.background,
        ),
        containerColor = MaterialTheme.colorScheme.background,
        contentColor = MaterialTheme.colorScheme.onBackground,
        navigationSuiteItems = {
            item(
                selected = selectedDestination == PrimaryDestination.SESSIONS,
                onClick = { backStack.openRoot(SessionsRoute) },
                icon = { Icon(Icons.Outlined.ChatBubbleOutline, contentDescription = null) },
                label = { Text(stringResource(PrimaryDestination.SESSIONS.labelResource)) },
                colors = navItemColors,
            )
            item(
                selected = selectedDestination == PrimaryDestination.APPROVALS,
                onClick = { backStack.openRoot(ApprovalsRoute) },
                icon = { Icon(Icons.AutoMirrored.Outlined.FactCheck, contentDescription = null) },
                label = { Text(stringResource(PrimaryDestination.APPROVALS.labelResource)) },
                colors = navItemColors,
            )
            item(
                selected = selectedDestination == PrimaryDestination.SETTINGS,
                onClick = { backStack.openRoot(SettingsRoute) },
                icon = { Icon(Icons.Outlined.Settings, contentDescription = null) },
                label = { Text(stringResource(PrimaryDestination.SETTINGS.labelResource)) },
                colors = navItemColors,
            )
        },
    ) {
        NavDisplay(
            backStack = backStack,
            onBack = { backStack.removeLastOrNull() },
            sceneStrategies = listOf(sceneStrategy),
            modifier = Modifier
                .fillMaxSize()
                .semantics { testTagsAsResourceId = true }
                .windowInsetsPadding(WindowInsets.safeDrawing),
            entryProvider = entryProvider {
                entry<SessionsRoute>(
                    metadata = ListDetailSceneStrategy.listPane(
                        detailPlaceholder = { DetailPlaceholder(stringResource(R.string.placeholder_choose_session)) },
                    ),
                ) {
                    SessionsListPane(
                        sessions = repository.sessions(initialServerProfileKey),
                        connectionState = connectionState,
                        selectedSessionId = (backStack.lastOrNull() as? SessionDetailRoute)?.key
                            ?.takeIf { it.serverProfileKey == initialServerProfileKey }
                            ?.sessionId,
                        onSessionSelected = {
                            backStack.add(SessionDetailRoute(SessionKey(initialServerProfileKey, it)))
                        },
                        onRetry = { connectionState = ConnectionPreviewState.CONNECTING },
                    )
                }
                entry<SessionDetailRoute>(metadata = ListDetailSceneStrategy.detailPane()) { route ->
                    val session = repository.session(route.key)
                    if (session == null) {
                        MissingDetail(showBackButton = showDetailBackButton, onBack = { backStack.removeLastOrNull() })
                    } else {
                        val initialTimeline = remember(repository, route.key) {
                            repository.timeline(route.key)
                        }
                        val capabilities = remember(repository, route.key) {
                            repository.sessionCapabilities(route.key)
                        }
                        SessionDetailPane(
                            sessionKey = route.key,
                            session = session,
                            initialTimeline = initialTimeline,
                            composerState = composerState,
                            canSubmit = capabilities.canSubmit,
                            canCancel = capabilities.canCancel,
                            approval = pendingApprovals.firstOrNull { it.sessionId == session.id },
                            showBackButton = showDetailBackButton,
                            onBack = { backStack.removeLastOrNull() },
                            onOpenApproval = {
                                backStack.add(ApprovalDetailRoute(ApprovalKey(route.key.serverProfileKey, it)))
                            },
                        )
                    }
                }
                entry<ApprovalsRoute>(
                    metadata = ListDetailSceneStrategy.listPane(
                        detailPlaceholder = { DetailPlaceholder(stringResource(R.string.placeholder_choose_approval)) },
                    ),
                ) {
                    ApprovalsListPane(
                        approvals = pendingApprovals,
                        outcome = approvalOutcome,
                        onApprovalSelected = {
                            backStack.add(ApprovalDetailRoute(ApprovalKey(activeServerProfileKey, it)))
                        },
                    )
                }
                entry<ApprovalDetailRoute>(metadata = ListDetailSceneStrategy.detailPane()) { route ->
                    val approval = repository.approval(route.key)
                    if (approval == null) {
                        MissingDetail(showBackButton = showDetailBackButton, onBack = { backStack.removeLastOrNull() })
                    } else {
                        ApprovalDetailPane(
                            approval = approval,
                            outcome = approvalOutcomes.outcome(route.key),
                            showBackButton = showDetailBackButton,
                            onBack = { backStack.removeLastOrNull() },
                            onDecision = {
                                approvalOutcomes.record(route.key, it)
                            },
                        )
                    }
                }
                entry<SettingsRoute> {
                    LaunchedEffect(onRefreshPairedDevices) {
                        onRefreshPairedDevices()
                    }
                    SettingsPane(
                        connectionState = connectionState,
                        onConnectionStateSelected = { connectionState = it },
                        onStartPairing = onStartPairing,
                        onPastePairingLink = onPastePairingLink,
                        pairedDevicesState = pairedDevicesState,
                        onForgetPairedDevice = onForgetPairedDevice,
                    )
                }
            },
        )
    }
}

private fun <T : NavKey> MutableList<T>.openRoot(route: T) {
    clear()
    add(route)
}

@Composable
private fun SessionsListPane(
    sessions: List<SessionSummary>,
    connectionState: ConnectionPreviewState,
    selectedSessionId: String?,
    onSessionSelected: (String) -> Unit,
    onRetry: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        ScreenHeading(
            eyebrow = stringResource(R.string.sessions_eyebrow),
            title = stringResource(R.string.sessions_title),
            subtitle = stringResource(R.string.sessions_subtitle),
            trailing = { ConnectionPill(connectionState) },
        )
        if (connectionState == ConnectionPreviewState.OFFLINE) {
            OfflineBanner(onRetry = onRetry)
        } else if (connectionState == ConnectionPreviewState.CONNECTING || connectionState == ConnectionPreviewState.REPLAYING) {
            ConnectionBanner(connectionState)
        }
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.label_recent), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("${sessions.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.weight(1f))
            Icon(Icons.Outlined.Terminal, contentDescription = stringResource(R.string.accessibility_local_demo), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
            Text(stringResource(R.string.label_demo), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (sessions.isEmpty()) {
            EmptySessionsState()
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 14.dp, end = 14.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(
                    items = sessions,
                    key = { it.id },
                    contentType = { "session-card" },
                ) { session ->
                    SessionCard(
                        session = session,
                        selected = session.id == selectedSessionId,
                        onClick = { onSessionSelected(session.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun SessionCard(session: SessionSummary, selected: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Card(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("session_card_${session.id}")
            .semantics { this.selected = selected },
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) colors.surfaceVariant else colors.surface,
        ),
        border = BorderStroke(
            width = 1.dp,
            color = if (selected) colors.onSurface.copy(alpha = 0.22f) else colors.outline.copy(alpha = 0.65f),
        ),
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusDot(session.status)
                Text(
                    session.title,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(session.updated, style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
            }
            Text(
                session.preview,
                style = MaterialTheme.typography.bodySmall,
                color = colors.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Outlined.FolderOpen, contentDescription = null, modifier = Modifier.size(14.dp), tint = colors.onSurfaceVariant)
                Text(session.workspace, style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                Spacer(Modifier.weight(1f))
                StatusBadge(session.status)
            }
        }
    }
}

@Composable
internal fun SessionDetailPane(
    sessionKey: SessionKey,
    session: SessionSummary,
    initialTimeline: List<SessionTimelineMessage>,
    composerState: SessionComposerViewModel,
    canSubmit: Boolean,
    canCancel: Boolean,
    approval: ApprovalSummary?,
    showBackButton: Boolean,
    onBack: () -> Unit,
    onOpenApproval: (String) -> Unit,
) {
    var messages by remember(sessionKey, initialTimeline) {
        mutableStateOf(initialTimeline, neverEqualPolicy())
    }
    val draft = composerState.draft(sessionKey)
    var previewRunActive by remember(sessionKey) { mutableStateOf(false) }
    var previewRunCancelled by remember(sessionKey) { mutableStateOf(false) }
    var previewMessageSubmitted by remember(sessionKey) { mutableStateOf(false) }
    val listState = key(sessionKey) {
        rememberLazyListState(initialFirstVisibleItemIndex = messages.size + 1)
    }
    val keyboard = LocalSoftwareKeyboardController.current
    val userLabel = stringResource(R.string.sample_author_user)
    val nowLabel = stringResource(R.string.demo_time_now)
    val submitMessage = {
        val submittedText = draft
        if (submittedText.isNotBlank() && canSubmit && !previewRunActive) {
            val nextId = (messages.lastOrNull()?.id ?: 0L) + 1L
            messages = messages + SessionTimelineMessage(
                id = nextId,
                author = userLabel,
                time = nowLabel,
                text = submittedText,
                fromUser = true,
            )
            composerState.updateDraft(sessionKey, "")
            previewRunActive = canCancel
            previewRunCancelled = false
            previewMessageSubmitted = true
            keyboard?.hide()
        }
    }
    LaunchedEffect(sessionKey, messages.size) {
        listState.scrollToItem(messages.size + 1)
    }
    Column(Modifier.fillMaxSize()) {
        DetailTopBar(title = stringResource(R.string.session_detail_title), showBackButton = showBackButton, onBack = onBack)
        LazyColumn(
            modifier = Modifier
                .testTag("session_timeline")
                .weight(1f)
                .fillMaxWidth(),
            state = listState,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 24.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            item(key = "session-header", contentType = "session-header") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    StatusBadge(session.status)
                    Text(session.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(session.workspace, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("·", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(session.updated, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(stringResource(R.string.session_id, session.id), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontFamily = FontFamily.Monospace)
                }
            }
            item(key = "timeline-heading", contentType = "section-heading") {
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.7f))
                    Text(stringResource(R.string.label_timeline), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            items(
                items = messages,
                key = { it.id },
                contentType = { "timeline-message" },
            ) { message ->
                TimelineMessage(message)
            }
            if (approval != null && session.status == SessionStatus.WAITING_APPROVAL) {
                item(key = "approval-${approval.id}", contentType = "approval-prompt") {
                    ApprovalPromptCard(approval = approval, onClick = { onOpenApproval(approval.id) })
                }
            }
            if (session.status == SessionStatus.RUNNING) {
                item(key = "session-running", contentType = "session-status") {
                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                        shape = RoundedCornerShape(14.dp),
                    ) {
                        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            StatusDot(SessionStatus.RUNNING)
                            Column {
                                Text(stringResource(R.string.session_working), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                                Text(stringResource(R.string.session_waiting_next_event), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            if (session.status == SessionStatus.FAILED) {
                item(key = "session-failed", contentType = "session-status") {
                    MessageBanner(stringResource(R.string.session_failed_preview), danger = true)
                }
            }
            if (session.status == SessionStatus.UNKNOWN) {
                item(key = "session-unknown", contentType = "session-status") {
                    MessageBanner(stringResource(R.string.session_unknown_status_preview), danger = false)
                }
            }
            item(key = "demo-disclosure", contentType = "disclosure") {
                DemoDisclosure()
            }
        }
        SessionComposer(
            draft = draft,
            canSubmit = canSubmit,
            canCancel = canCancel,
            previewRunActive = previewRunActive,
            previewRunCancelled = previewRunCancelled,
            previewMessageSubmitted = previewMessageSubmitted,
            onDraftChange = { composerState.updateDraft(sessionKey, it) },
            onSubmit = submitMessage,
            onCancel = {
                if (canCancel) {
                    previewRunActive = false
                    previewRunCancelled = true
                }
            },
        )
    }
}

@Composable
private fun TimelineMessage(message: SessionTimelineMessage) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
        Box(
            Modifier
                .padding(top = 2.dp)
                .size(30.dp)
                .clip(CircleShape)
                .background(if (message.fromUser) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.primary),
            contentAlignment = Alignment.Center,
        ) {
            if (message.fromUser) {
                Text(message.author.take(1), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSecondary)
            } else {
                Icon(Icons.Outlined.Terminal, contentDescription = null, modifier = Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onPrimary)
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(message.author, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                Text(message.time, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(message.text, style = MaterialTheme.typography.bodyMedium, lineHeight = 23.sp)
        }
    }
}

@Composable
private fun SessionComposer(
    draft: String,
    canSubmit: Boolean,
    canCancel: Boolean,
    previewRunActive: Boolean,
    previewRunCancelled: Boolean,
    previewMessageSubmitted: Boolean,
    onDraftChange: (String) -> Unit,
    onSubmit: () -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .imePadding()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = onDraftChange,
            modifier = Modifier.fillMaxWidth(),
            enabled = canSubmit && !previewRunActive,
            placeholder = { Text(stringResource(R.string.session_composer_placeholder)) },
            maxLines = 4,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(
                onSend = {
                    if (canSubmit && !previewRunActive && draft.isNotBlank()) {
                        onSubmit()
                    }
                },
            ),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            when {
                previewRunActive -> Text(
                    stringResource(R.string.session_preview_running),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                previewRunCancelled -> Text(
                    stringResource(R.string.session_preview_cancelled),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                previewMessageSubmitted -> Text(
                    stringResource(R.string.session_preview_message_added),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                !canSubmit -> Text(
                    stringResource(R.string.session_preview_read_only),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> Text(
                    stringResource(R.string.session_preview_composer_disclosure),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (previewRunActive) {
                FilledTonalButton(
                    onClick = onCancel,
                    enabled = canCancel,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(stringResource(R.string.session_cancel_preview))
                }
            } else {
                Button(
                    onClick = onSubmit,
                    enabled = canSubmit && draft.isNotBlank(),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = null)
                    Text(stringResource(R.string.session_send_preview))
                }
            }
        }
    }
}

@Composable
private fun ApprovalPromptCard(approval: ApprovalSummary, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        shape = RoundedCornerShape(16.dp),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.Info, contentDescription = null, tint = LocalAppPalette.current.warning, modifier = Modifier.size(19.dp))
                Text(stringResource(R.string.approval_needed), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                Icon(Icons.Outlined.ChevronRight, contentDescription = stringResource(R.string.accessibility_open_approval), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(stringResource(R.string.approval_tool_wants_to_change, approval.tool, approval.path), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.action_review_request)) }
        }
    }
}

@Composable
private fun ApprovalsListPane(
    approvals: List<ApprovalSummary>,
    outcome: String?,
    onApprovalSelected: (String) -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        ScreenHeading(
            eyebrow = stringResource(R.string.approvals_eyebrow),
            title = stringResource(R.string.approvals_title),
            subtitle = stringResource(R.string.approvals_subtitle),
            trailing = {
                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceVariant) {
                    Text("${approvals.size}", modifier = Modifier.padding(horizontal = 11.dp, vertical = 7.dp), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                }
            },
        )
        if (outcome != null) {
            MessageBanner(
                stringResource(R.string.approval_demo_decision_recorded, approvalOutcomeLabel(outcome)),
                danger = false,
            )
        }
        if (approvals.isEmpty()) {
            EmptyApprovalsState()
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(
                    items = approvals,
                    key = { it.id },
                    contentType = { "approval-card" },
                ) { approval ->
                    ApprovalListCard(approval = approval, onClick = { onApprovalSelected(approval.id) })
                }
            }
        }
    }
}

@Composable
private fun ApprovalListCard(approval: ApprovalSummary, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = CardDefaults.outlinedCardBorder(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.Info, contentDescription = null, tint = LocalAppPalette.current.warning, modifier = Modifier.size(18.dp))
                Text(approval.tool, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                Text(stringResource(R.string.approval_status_pending), style = MaterialTheme.typography.labelSmall, color = LocalAppPalette.current.warning, fontWeight = FontWeight.Bold)
            }
            Text(approval.path, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontFamily = FontFamily.Monospace, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.action_review_changes), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                Icon(Icons.Outlined.ChevronRight, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ApprovalDetailPane(
    approval: ApprovalSummary,
    outcome: String?,
    showBackButton: Boolean,
    onBack: () -> Unit,
    onDecision: (String) -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        DetailTopBar(title = stringResource(R.string.approval_detail_title), showBackButton = showBackButton, onBack = onBack)
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Info, contentDescription = null, tint = LocalAppPalette.current.warning, modifier = Modifier.size(20.dp))
                    Text(stringResource(R.string.approval_status_pending_heading), style = MaterialTheme.typography.labelMedium, color = LocalAppPalette.current.warning, fontWeight = FontWeight.Bold)
                }
                Text(approval.tool, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                Text(approval.reason, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, lineHeight = 22.sp)
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.label_requested_file), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                CodeSurface {
                    Text(approval.path, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.label_proposed_change), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                CodeSurface {
                    if (approval.removedLine.isNotEmpty()) {
                        CodeLine(approval.removedLine, added = false)
                    }
                    CodeLine(approval.addedLine, added = true)
                }
            }
            MessageBanner(
                stringResource(R.string.approval_preview_only),
                danger = false,
            )
            if (outcome == null) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onClick = { onDecision("denied") }, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.action_deny)) }
                    Button(onClick = { onDecision("approved") }, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.action_approve)) }
                }
            } else {
                Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(12.dp)) {
                    Text(
                        stringResource(R.string.approval_demo_outcome, approvalOutcomeLabel(outcome)),
                        modifier = Modifier.fillMaxWidth().padding(14.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
    }
}

@Composable
private fun CodeSurface(content: @Composable () -> Unit) {
    Surface(
        color = LocalAppPalette.current.codeBackground,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(5.dp), content = { content() })
    }
}

@Composable
private fun CodeLine(text: String, added: Boolean) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(5.dp))
            .background(if (added) LocalAppPalette.current.success.copy(alpha = 0.12f) else LocalAppPalette.current.danger.copy(alpha = 0.12f))
            .padding(horizontal = 8.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(if (added) "+" else "−", color = if (added) LocalAppPalette.current.success else LocalAppPalette.current.danger, fontFamily = FontFamily.Monospace)
        Text(text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SettingsPane(
    connectionState: ConnectionPreviewState,
    onConnectionStateSelected: (ConnectionPreviewState) -> Unit,
    onStartPairing: (String) -> Unit,
    onPastePairingLink: () -> String?,
    pairedDevicesState: PairedDevicesState,
    onForgetPairedDevice: (PairedDeviceSummary) -> Unit,
) {
    var pairingLinkText by remember { mutableStateOf("") }
    var pairingLinkReady by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        ScreenHeading(
            eyebrow = stringResource(R.string.settings_eyebrow),
            title = stringResource(R.string.settings_title),
            subtitle = stringResource(R.string.settings_subtitle),
        )
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SettingsSection(
                title = stringResource(R.string.settings_pairing_title),
                description = stringResource(R.string.settings_pairing_description),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        stringResource(
                            if (pairingLinkReady) R.string.settings_pairing_link_ready
                            else R.string.settings_pairing_link_hint,
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    OutlinedButton(
                        onClick = {
                            val pastedLink = onPastePairingLink()?.trim()
                            if (!pastedLink.isNullOrBlank()) {
                                pairingLinkText = pastedLink
                                pairingLinkReady = true
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(stringResource(R.string.settings_pairing_paste_action))
                    }
                    Button(
                        onClick = {
                            onStartPairing(pairingLinkText.trim())
                            pairingLinkText = ""
                            pairingLinkReady = false
                        },
                        enabled = pairingLinkText.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(stringResource(R.string.settings_pairing_review_action))
                    }
                }
            }
            SettingsSection(
                title = stringResource(R.string.settings_connection_preview),
                description = stringResource(R.string.settings_connection_preview_description),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ConnectionPreviewState.entries.forEach { state ->
                        FilterChip(
                            selected = state == connectionState,
                            onClick = { onConnectionStateSelected(state) },
                            label = { Text(stringResource(state.labelResource())) },
                            leadingIcon = { Icon(state.icon(), contentDescription = null, modifier = Modifier.size(18.dp)) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
            SettingsSection(
                title = stringResource(R.string.settings_paired_devices),
                description = stringResource(R.string.settings_paired_devices_description),
            ) {
                PairedDevicesContent(
                    state = pairedDevicesState,
                    onForgetPairedDevice = onForgetPairedDevice,
                )
            }
            SettingsSection(
                title = stringResource(R.string.settings_appearance),
                description = stringResource(R.string.settings_appearance_description),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AssistChip(onClick = {}, label = { Text(stringResource(R.string.settings_appearance_system)) }, leadingIcon = { Icon(Icons.Outlined.Settings, null, Modifier.size(16.dp)) })
                    AssistChip(onClick = {}, label = { Text(stringResource(R.string.settings_appearance_palette)) }, leadingIcon = { Icon(Icons.Outlined.Code, null, Modifier.size(16.dp)) })
                }
            }
            SettingsSection(
                title = stringResource(R.string.settings_about),
                description = stringResource(R.string.settings_about_description),
            ) {
                DemoDisclosure()
            }
        }
    }
}

@Composable
private fun PairedDevicesContent(
    state: PairedDevicesState,
    onForgetPairedDevice: (PairedDeviceSummary) -> Unit,
) {
    var deviceToForget by remember { mutableStateOf<PairedDeviceSummary?>(null) }
    val selectedDevice = deviceToForget
    if (selectedDevice != null) {
        AlertDialog(
            onDismissRequest = { deviceToForget = null },
            title = { Text(stringResource(R.string.settings_forget_device_title)) },
            text = { Text(stringResource(R.string.settings_forget_device_confirmation, selectedDevice.deviceName)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        onForgetPairedDevice(selectedDevice)
                        deviceToForget = null
                    },
                    enabled = state.removingDeviceId == null,
                ) {
                    Text(stringResource(R.string.settings_forget_device_confirm))
                }
            },
            dismissButton = {
                TextButton(onClick = { deviceToForget = null }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }

    if (state.isLoading && state.devices.isEmpty()) {
        Text(
            stringResource(R.string.settings_paired_devices_loading),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    } else if (state.devices.isEmpty()) {
        Text(
            stringResource(R.string.settings_paired_devices_empty),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    if (state.hasError) {
        Text(
            stringResource(R.string.settings_paired_devices_error),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        state.devices.forEach { device ->
            OutlinedCard(modifier = Modifier.fillMaxWidth()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(device.deviceName, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(device.serverOrigin, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(
                            stringResource(R.string.settings_paired_device_host_id, device.hostId),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    OutlinedButton(
                        onClick = { deviceToForget = device },
                        enabled = state.removingDeviceId == null,
                    ) {
                        Text(
                            stringResource(
                                if (state.removingDeviceId == device.deviceId) R.string.settings_forget_device_working
                                else R.string.settings_forget_device_action,
                            ),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsSection(title: String, description: String, content: @Composable () -> Unit) {
    OutlinedCard(shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            content()
        }
    }
}

@Composable
private fun ScreenHeading(
    eyebrow: String,
    title: String,
    subtitle: String,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = 22.dp, top = 22.dp, end = 20.dp, bottom = 15.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(eyebrow, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, letterSpacing = 1.2.sp)
            Text(title, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (trailing != null) {
            Spacer(Modifier.width(12.dp))
            trailing()
        }
    }
}

@Composable
private fun DetailTopBar(title: String, showBackButton: Boolean, onBack: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(56.dp)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showBackButton) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.action_back))
            }
        }
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun DetailPlaceholder(message: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(30.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(stringResource(R.string.placeholder_detail_appears), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun MissingDetail(showBackButton: Boolean, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        DetailTopBar(title = stringResource(R.string.state_unavailable), showBackButton = showBackButton, onBack = onBack)
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.state_demo_item_unavailable), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ConnectionPill(state: ConnectionPreviewState) {
    val palette = LocalAppPalette.current
    val color = when (state) {
        ConnectionPreviewState.CONNECTED -> palette.success
        ConnectionPreviewState.OFFLINE -> palette.danger
        else -> palette.warning
    }
    Surface(color = color.copy(alpha = 0.12f), shape = RoundedCornerShape(50)) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(7.dp).clip(CircleShape).background(color))
            Text(
                stringResource(state.labelResource()),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurface,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun StatusDot(status: SessionStatus) {
    val color = status.color()
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
}

@Composable
private fun StatusBadge(status: SessionStatus) {
    val color = status.color()
    Surface(color = color.copy(alpha = 0.12f), shape = RoundedCornerShape(50)) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(color))
            Text(
                stringResource(status.labelResource()).uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurface,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun OfflineBanner(onRetry: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(Modifier.padding(start = 14.dp, top = 12.dp, end = 8.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.WifiOff, contentDescription = null, tint = MaterialTheme.colorScheme.error)
            Spacer(Modifier.width(10.dp))
            Text(stringResource(R.string.connection_offline_sample_data), modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            IconButton(onClick = onRetry) { Icon(Icons.Outlined.Refresh, contentDescription = stringResource(R.string.accessibility_retry)) }
        }
    }
}

@Composable
private fun ConnectionBanner(state: ConnectionPreviewState) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(state.icon(), contentDescription = null, modifier = Modifier.size(16.dp), tint = LocalAppPalette.current.warning)
        Text(
            stringResource(
                if (state == ConnectionPreviewState.CONNECTING) {
                    R.string.connection_connecting_message
                } else {
                    R.string.connection_replaying_message
                },
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun MessageBanner(message: String, danger: Boolean) {
    val color = if (danger) LocalAppPalette.current.danger else MaterialTheme.colorScheme.onSurfaceVariant
    Surface(
        color = if (danger) color.copy(alpha = 0.1f) else MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(13.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            Icon(if (danger) Icons.Outlined.ErrorOutline else Icons.Outlined.Info, contentDescription = null, modifier = Modifier.size(18.dp), tint = color)
            Text(message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface, lineHeight = 19.sp)
        }
    }
}

@Composable
private fun EmptySessionsState() {
    Box(Modifier.fillMaxSize().padding(28.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(32.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(stringResource(R.string.empty_sessions_title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(stringResource(R.string.empty_sessions_message), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun EmptyApprovalsState() {
    Box(Modifier.fillMaxSize().padding(28.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Outlined.CheckCircle, contentDescription = null, modifier = Modifier.size(32.dp), tint = LocalAppPalette.current.success)
            Text(stringResource(R.string.empty_approvals_title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(stringResource(R.string.empty_approvals_message), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun DemoDisclosure() {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        Icon(Icons.Outlined.Info, contentDescription = null, modifier = Modifier.size(17.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            stringResource(R.string.demo_disclosure),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            lineHeight = 19.sp,
        )
    }
}

private fun SessionStatus.labelResource(): Int = when (this) {
    SessionStatus.RUNNING -> R.string.status_running
    SessionStatus.WAITING_APPROVAL -> R.string.status_waiting_approval
    SessionStatus.COMPLETED -> R.string.status_completed
    SessionStatus.FAILED -> R.string.status_failed
    SessionStatus.UNKNOWN -> R.string.status_unknown
}

@Composable
private fun SessionStatus.color(): Color = when (this) {
    SessionStatus.RUNNING -> LocalAppPalette.current.info
    SessionStatus.WAITING_APPROVAL -> LocalAppPalette.current.warning
    SessionStatus.COMPLETED -> LocalAppPalette.current.success
    SessionStatus.FAILED -> LocalAppPalette.current.danger
    SessionStatus.UNKNOWN -> MaterialTheme.colorScheme.onSurfaceVariant
}

private fun ConnectionPreviewState.labelResource(): Int = when (this) {
    ConnectionPreviewState.CONNECTED -> R.string.connection_demo_connected
    ConnectionPreviewState.CONNECTING -> R.string.connection_connecting
    ConnectionPreviewState.REPLAYING -> R.string.connection_replaying
    ConnectionPreviewState.OFFLINE -> R.string.connection_offline
}

@Composable
private fun approvalOutcomeLabel(outcome: String): String = when (outcome) {
    "approved" -> stringResource(R.string.approval_decision_approved)
    "denied" -> stringResource(R.string.approval_decision_denied)
    else -> outcome
}

private fun ConnectionPreviewState.icon() = when (this) {
    ConnectionPreviewState.CONNECTED -> Icons.Outlined.Wifi
    ConnectionPreviewState.CONNECTING, ConnectionPreviewState.REPLAYING -> Icons.Outlined.Refresh
    ConnectionPreviewState.OFFLINE -> Icons.Outlined.WifiOff
}

@Preview(name = "Large window · app navigation", widthDp = 1000, heightDp = 900, showBackground = true)
@Composable
private fun LargeWindowAppPreview() {
    val resources = LocalResources.current
    val repository = remember(resources) { DemoSessionRepository(resources) }
    val composerState = remember { SessionComposerViewModel() }
    val session = repository.sessions(DEMO_SERVER_PROFILE_KEY).first()
    Ag2CliTheme {
        MobilePrototypeContent(
            repository,
            initialSessionId = session.id,
            initialServerProfileKey = DEMO_SERVER_PROFILE_KEY,
            composerState = composerState,
        )
    }
}
