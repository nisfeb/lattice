package io.nisfeb.lattice

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.nisfeb.lattice.bookmarks.AndroidBookmarkStore
import io.nisfeb.lattice.theme.AndroidThemeStore
import io.nisfeb.lattice.urbit.AndroidSessionStore

class MainActivity : ComponentActivity() {

    // Pending urb:// link from a VIEW intent (e.g. Talon handing off a
    // link). A mutableState so onNewIntent (app already running) flows
    // a new value into the live composition; App reacts via
    // LaunchedEffect(initialUrl) and calls back to clear it.
    private var pendingUrl by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        consumeUrbIntent(intent)
        val sessions = AndroidSessionStore(applicationContext)
        val bookmarks = AndroidBookmarkStore(applicationContext)
        val themes = AndroidThemeStore(applicationContext)
        val updates = (application as? LatticeApplication)?.updateState
        setContent {
            App(
                sessions,
                bookmarks,
                themes,
                initialUrl = pendingUrl,
                onUrlConsumed = { pendingUrl = null },
                updateState = updates,
            )
        }
    }

    override fun onResume() {
        super.onResume()
        // Check for a new release on every foreground; HttpUpdateChecker's
        // 12h throttle keeps the actual network hits sparse.
        (application as? LatticeApplication)?.checkForUpdate()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumeUrbIntent(intent)
    }

    private fun consumeUrbIntent(intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        if (data.startsWith("urb://")) pendingUrl = data
    }
}
