package com.ag2dev.ag2cli.mobile.data

import android.content.Context
import java.io.IOException
import java.util.UUID

/** Persists the non-secret client instance ID, matching the Web client's browser-local ID. */
class AndroidAppServerClientIdStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun getOrCreate(): String = synchronized(STORE_LOCK) {
        preferences.getString(CLIENT_ID_KEY, null)?.takeIf(String::isNotBlank) ?: UUID.randomUUID().toString().also { id ->
            if (!preferences.edit().putString(CLIENT_ID_KEY, id).commit()) {
                throw IOException("Could not persist the App Server client ID")
            }
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "app-server-client"
        const val CLIENT_ID_KEY = "client-id"
        val STORE_LOCK = Any()
    }
}
