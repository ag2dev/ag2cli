package com.ag2dev.ag2cli.mobile.data

import androidx.compose.runtime.mutableStateMapOf
import androidx.lifecycle.ViewModel
import com.ag2dev.ag2cli.mobile.core.model.SessionKey

/** Keeps unsent drafts across Activity recreation without putting prompt text in saved state. */
class SessionComposerViewModel : ViewModel() {
    private val drafts = mutableStateMapOf<SessionKey, String>()

    fun draft(sessionKey: SessionKey): String = drafts[sessionKey].orEmpty()

    fun updateDraft(sessionKey: SessionKey, value: String) {
        if (value.isEmpty()) drafts.remove(sessionKey) else drafts[sessionKey] = value
    }
}
