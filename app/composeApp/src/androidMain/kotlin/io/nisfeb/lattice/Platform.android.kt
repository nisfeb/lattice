package io.nisfeb.lattice

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent

actual val isDesktop: Boolean = false

/**
 * Application context for platform helpers that need one outside a composable
 * (e.g. [shareText]). Set once in [LatticeApplication.onCreate]. Holding the
 * application context is leak-safe.
 */
@SuppressLint("StaticFieldLeak")
internal object AndroidApp {
    lateinit var context: Context
}

actual fun shareText(text: String): String? {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    // Launched from the application context (not an Activity), so the chooser
    // needs its own task.
    val chooser = Intent.createChooser(send, "Share link").apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    AndroidApp.context.startActivity(chooser)
    return null
}
