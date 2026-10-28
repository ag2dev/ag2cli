package com.ag2dev.ag2cli.mobile.data

import androidx.compose.runtime.mutableStateMapOf
import com.ag2dev.ag2cli.mobile.core.model.ApprovalKey
import com.ag2dev.ag2cli.mobile.core.model.ServerProfileKey

/** Keeps prototype approval feedback isolated by server profile and approval ID. */
class ApprovalOutcomeState {
    private val outcomes = mutableStateMapOf<ApprovalKey, String>()
    private val latestByProfile = mutableStateMapOf<ServerProfileKey, String>()

    fun outcome(key: ApprovalKey): String? = outcomes[key]

    fun isResolved(key: ApprovalKey): Boolean = outcomes.containsKey(key)

    fun latestOutcome(serverProfileKey: ServerProfileKey): String? = latestByProfile[serverProfileKey]

    fun record(key: ApprovalKey, outcome: String) {
        outcomes[key] = outcome
        latestByProfile[key.serverProfileKey] = outcome
    }
}
