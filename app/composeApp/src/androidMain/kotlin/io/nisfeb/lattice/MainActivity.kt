package io.nisfeb.lattice

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.nisfeb.lattice.bookmarks.AndroidBookmarkStore
import io.nisfeb.lattice.share.SharedContent
import io.nisfeb.lattice.theme.AndroidThemeStore
import io.nisfeb.lattice.urbit.AndroidSessionStore
import okhttp3.OkHttpClient

class MainActivity : ComponentActivity() {

    private val http = OkHttpClient()

    // Pending urb:// link from a VIEW intent (e.g. Talon handing off a
    // link). A mutableState so onNewIntent (app already running) flows
    // a new value into the live composition; App reacts via
    // LaunchedEffect(initialUrl) and calls back to clear it.
    private var pendingUrl by mutableStateOf<String?>(null)

    // Pending content from an ACTION_SEND (share sheet) intent: a shared web
    // URL / text, or a shared text file. Imported to gemtext on the ship.
    private var pendingShare by mutableStateOf<SharedContent?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        consumeUrbIntent(intent)
        consumeShareIntent(intent)
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
                httpClient = http,
                initialShare = pendingShare,
                onShareConsumed = { pendingShare = null },
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
        consumeShareIntent(intent)
    }

    private fun consumeUrbIntent(intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        if (data.startsWith("urb://")) pendingUrl = data
    }

    /** Pull shared text/URL or a shared text file out of an ACTION_SEND intent. */
    private fun consumeShareIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.takeIf { it.isNotBlank() }

        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        if (!text.isNullOrBlank()) {
            pendingShare = SharedContent(text = text, title = subject)
            return
        }

        val uri = extractStream(intent) ?: return
        val body = readText(uri) ?: return
        pendingShare = SharedContent(text = body, title = subject ?: displayName(uri))
    }

    /** Versioned EXTRA_STREAM read: typed overload on API 33+, deprecated form
     *  below — matching Talon's proven share receiver. */
    private fun extractStream(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
        }

    /** Read a shared text file (capped so a huge/binary file can't OOM us). */
    private fun readText(uri: Uri): String? = runCatching {
        contentResolver.openInputStream(uri)?.use { stream ->
            val buf = ByteArray(MAX_SHARE_BYTES)
            var total = 0
            while (total < MAX_SHARE_BYTES) {
                val n = stream.read(buf, total, MAX_SHARE_BYTES - total)
                if (n < 0) break
                total += n
            }
            if (total == 0) null else String(buf, 0, total, Charsets.UTF_8)
        }
    }.getOrNull()

    private fun displayName(uri: Uri): String? = runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0)?.substringBeforeLast('.') else null
        }
    }.getOrNull()

    private companion object {
        const val MAX_SHARE_BYTES = 2 * 1024 * 1024 // 2 MB
    }
}
