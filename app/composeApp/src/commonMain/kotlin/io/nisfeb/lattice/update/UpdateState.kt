package io.nisfeb.lattice.update

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Pluggable installer hook so commonMain drives both the Android
 * download/install path and a desktop no-op.
 */
interface UpdateInstallerHook {
    suspend fun download(
        manifest: UpdateManifest,
        onProgress: (Int) -> Unit,
        onReady: (String) -> Unit,
        onFailure: (String) -> Unit,
    )

    fun install(apkPath: String)
}

/** Runtime info UpdateState needs without touching an Android Context. */
interface UpdateRuntime {
    /** Currently-installed app versionCode. */
    fun installedVersionCode(): Int

    /** SDK level the host can satisfy (Build.VERSION.SDK_INT on Android). */
    fun supportedSdk(): Int
}

/** Process-wide source of truth for the "is there an update?" banner. */
class UpdateState(
    private val scope: CoroutineScope,
    private val runtime: UpdateRuntime,
    private val installer: UpdateInstallerHook,
) {
    private val _status = MutableStateFlow<UpdateStatus>(UpdateStatus.Idle)
    val status: StateFlow<UpdateStatus> = _status.asStateFlow()

    fun onManifest(manifest: UpdateManifest) {
        if (manifest.versionCode <= runtime.installedVersionCode()) return
        if (manifest.minSdk > runtime.supportedSdk()) return
        when (val cur = _status.value) {
            is UpdateStatus.Downloading, is UpdateStatus.Ready -> return
            else -> {
                if (cur is UpdateStatus.Available && cur.manifest.versionCode == manifest.versionCode) return
                _status.value = UpdateStatus.Available(manifest)
            }
        }
    }

    fun startDownload(manifest: UpdateManifest) {
        _status.value = UpdateStatus.Downloading(manifest, 0)
        scope.launch(Dispatchers.IO) {
            installer.download(
                manifest = manifest,
                onProgress = { pct -> _status.value = UpdateStatus.Downloading(manifest, pct) },
                onReady = { apkPath -> _status.value = UpdateStatus.Ready(manifest, apkPath) },
                onFailure = { message -> _status.value = UpdateStatus.Failed(manifest, message) },
            )
        }
    }

    fun launchInstaller(apkPath: String) = installer.install(apkPath)

    fun dismiss() {
        when (_status.value) {
            is UpdateStatus.Available, is UpdateStatus.Failed -> _status.value = UpdateStatus.Idle
            else -> Unit
        }
    }
}

/** Desktop default: banner inert (desktop self-update isn't wired — users grab installers). */
class NoopUpdateInstallerHook : UpdateInstallerHook {
    override suspend fun download(
        manifest: UpdateManifest,
        onProgress: (Int) -> Unit,
        onReady: (String) -> Unit,
        onFailure: (String) -> Unit,
    ) = onFailure("Desktop builds don't self-update — download the installer.")

    override fun install(apkPath: String) = Unit
}

/** Desktop default runtime — version 0 / SDK wide-open (gated by the no-op installer). */
class StaticUpdateRuntime(
    private val versionCode: Int = 0,
    private val sdk: Int = Int.MAX_VALUE,
) : UpdateRuntime {
    override fun installedVersionCode(): Int = versionCode
    override fun supportedSdk(): Int = sdk
}
