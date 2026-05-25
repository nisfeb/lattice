package io.nisfeb.lattice.update

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Fetches latest.json from a fixed HTTPS URL. Rate-limited: skips the network if
 * the last check was under [minIntervalMs] ago (the caller fires this on every
 * foreground; the throttle keeps daily users to ~one network hit per interval).
 * Owns a derived client with a 15s callTimeout so a hung fetch can't pin a
 * thread. Never throws — returns null on any failure.
 */
class HttpUpdateChecker(
    http: OkHttpClient,
    private val url: String,
    private val now: () -> Long,
    private val lastCheckedAtMs: () -> Long,
    private val recordCheckedAt: (Long) -> Unit,
    private val minIntervalMs: Long,
) : UpdateChecker {

    private val client: OkHttpClient = http.newBuilder()
        .callTimeout(15, TimeUnit.SECONDS)
        .build()

    override suspend fun check(): UpdateManifest? = withContext(Dispatchers.IO) {
        val nowMs = now()
        if (nowMs - lastCheckedAtMs() < minIntervalMs) return@withContext null
        runCatching {
            val req = Request.Builder().url(url)
                .header("User-Agent", "Lattice-UpdateChecker")
                .build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@runCatching null
                val body = resp.body?.string() ?: return@runCatching null
                val m = UpdateManifest.parse(body) ?: return@runCatching null
                recordCheckedAt(nowMs)
                m
            }
        }.onFailure {
            if (it is CancellationException) throw it
            Log.w("HttpUpdateChecker", "check failed", it)
        }.getOrNull()
    }
}
