package io.nisfeb.lattice

import android.app.Application
import android.os.Build
import io.nisfeb.lattice.update.HttpUpdateChecker
import io.nisfeb.lattice.update.UpdateInstaller
import io.nisfeb.lattice.update.UpdateRuntime
import io.nisfeb.lattice.update.UpdateState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/**
 * Holds the process-wide [UpdateState] so the in-app update banner survives
 * Activity recreation (rotation, etc.). [checkForUpdate] fetches the release
 * manifest (rate-limited) and feeds it to the state machine; MainActivity calls
 * it on each foreground.
 */
class LatticeApplication : Application() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    lateinit var updateState: UpdateState
        private set

    private val httpChecker by lazy {
        val prefs = getSharedPreferences("update_state", MODE_PRIVATE)
        HttpUpdateChecker(
            http = OkHttpClient(),
            url = "https://github.com/nisfeb/lattice/releases/latest/download/latest.json",
            now = { System.currentTimeMillis() },
            lastCheckedAtMs = { prefs.getLong("last_check_ms", 0L) },
            recordCheckedAt = { prefs.edit().putLong("last_check_ms", it).apply() },
            minIntervalMs = 12L * 60L * 60L * 1000L, // 12h
        )
    }

    override fun onCreate() {
        super.onCreate()
        AndroidApp.context = applicationContext
        updateState = UpdateState(
            scope = scope,
            runtime = object : UpdateRuntime {
                override fun installedVersionCode(): Int = try {
                    @Suppress("DEPRECATION")
                    packageManager.getPackageInfo(packageName, 0).versionCode
                } catch (_: Exception) {
                    0
                }
                override fun supportedSdk(): Int = Build.VERSION.SDK_INT
            },
            installer = UpdateInstaller(this),
        )
    }

    fun checkForUpdate() {
        scope.launch {
            httpChecker.check()?.let { updateState.onManifest(it) }
        }
    }
}
