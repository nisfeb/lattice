package io.nisfeb.lattice

import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.res.loadImageBitmap
import androidx.compose.ui.res.useResource
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import io.nisfeb.lattice.bookmarks.FileBookmarkStore
import io.nisfeb.lattice.theme.FileThemeStore
import io.nisfeb.lattice.urbit.FileSessionStore
import okhttp3.OkHttpClient
import kotlin.system.exitProcess

/**
 * Tear down [http] so the process can exit. OkHttp's Dispatcher uses
 * non-daemon worker threads, and the SSE updates stream parks one in a
 * blocking read (it's built with no read timeout), so without this the JVM
 * lingers in `ps` after the window closes. cancelAll() ends in-flight calls
 * (including the EventSource), shutdownNow() interrupts the workers, and
 * evictAll() closes pooled sockets. All non-blocking.
 */
private fun shutdownHttp(http: OkHttpClient) {
    runCatching { http.dispatcher.cancelAll() }
    runCatching { http.dispatcher.executorService.shutdownNow() }
    runCatching { http.connectionPool.evictAll() }
}

fun main(args: Array<String>) {
    // Register Lattice as the urb:// scheme handler so handoffs from
    // other apps route here (Linux/Windows; macOS is set via the
    // app bundle's Info.plist at packaging time).
    SchemeRegistration.ensureRegistered()

    // Linux/Windows pass the opened URL as a process argument; macOS
    // delivers it as an Apple Event (handled below). Grab any urb://
    // arg for the cold-launch case.
    val launchUrl = args.firstOrNull { it.startsWith("urb://") }

    // Owned here (not inside App) so we can tear it down on close — see shutdownHttp.
    val http = OkHttpClient()

    application {
        val icon = useResource("lattice.png") { BitmapPainter(loadImageBitmap(it)) }
        var pendingUrl by remember { mutableStateOf(launchUrl) }

        // macOS delivers urb:// opens — both the initial launch and
        // while-running re-opens — via this AWT handler, not argv.
        // Unsupported on Linux/Windows (throws), hence runCatching.
        LaunchedEffect(Unit) {
            runCatching {
                java.awt.Desktop.getDesktop().setOpenURIHandler { event ->
                    val u = event.uri.toString()
                    if (u.startsWith("urb://")) pendingUrl = u
                }
            }
        }

        Window(
            onCloseRequest = ::exitApplication,
            title = "lattice",
            icon = icon,
        ) {
            App(
                FileSessionStore(),
                FileBookmarkStore(),
                FileThemeStore(),
                initialUrl = pendingUrl,
                onUrlConsumed = { pendingUrl = null },
                httpClient = http,
            )
        }
    }

    // application{} returns once the window closes (exitApplication). Close out
    // OkHttp, then force the JVM down: shutdownNow() interrupts the workers but
    // a thread parked mid-socket-read may not unwind promptly, and those threads
    // are non-daemon — exitProcess guarantees we don't linger.
    shutdownHttp(http)
    exitProcess(0)
}
