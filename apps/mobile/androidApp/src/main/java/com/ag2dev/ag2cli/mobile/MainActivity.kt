package com.ag2dev.ag2cli.mobile

import android.content.ClipboardManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.ViewModelProvider
import com.ag2dev.ag2cli.mobile.data.AndroidPairingCoordinator
import com.ag2dev.ag2cli.mobile.data.DemoSessionRepository
import com.ag2dev.ag2cli.mobile.data.PairingFlowViewModel
import com.ag2dev.ag2cli.mobile.data.PairedDevicesViewModel
import com.ag2dev.ag2cli.mobile.data.SessionComposerViewModel
import com.ag2dev.ag2cli.mobile.ui.Ag2CliTheme
import com.ag2dev.ag2cli.mobile.ui.MobilePrototypeApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        clearIntentData()
        enableEdgeToEdge()
        val repository = DemoSessionRepository(resources)
        val pairingCoordinator = AndroidPairingCoordinator(applicationContext)
        val pairingFlow = ViewModelProvider(this)[PairingFlowViewModel::class.java]
        pairingFlow.attachPairingOperations(pairingCoordinator::preview, pairingCoordinator::pair)
        val pairedDevices = ViewModelProvider(this)[PairedDevicesViewModel::class.java]
        pairedDevices.attachOperations(pairingCoordinator::pairedDevices, pairingCoordinator::forgetPairedDevice)
        val composerState = ViewModelProvider(this)[SessionComposerViewModel::class.java]
        setContent {
            Ag2CliTheme {
                MobilePrototypeApp(
                    repository = repository,
                    pairingFlow = pairingFlow,
                    pairedDevicesFlow = pairedDevices,
                    composerState = composerState,
                    onPastePairingLink = ::readPairingLinkFromClipboard,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        clearIntentData()
    }

    private fun clearIntentData() {
        setIntent(Intent(this, MainActivity::class.java))
    }

    private fun readPairingLinkFromClipboard(): String? {
        val clipboard = getSystemService(ClipboardManager::class.java) ?: return null
        val clip = clipboard.primaryClip ?: return null
        if (clip.itemCount == 0) return null
        return clip.getItemAt(0).coerceToText(this).toString()
    }
}
