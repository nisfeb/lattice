package io.nisfeb.lattice.update

/**
 * Produces an UpdateManifest or null. Implementations MUST NOT throw — return
 * null on any failure (network, parse). Logging is the implementation's job.
 */
interface UpdateChecker {
    suspend fun check(): UpdateManifest?
}

/**
 * Banner surface state. Idle = nothing to show. Available holds a manifest
 * awaiting user action. Downloading carries progress 0..99 (100 is the
 * transition to Ready). Ready = APK on disk and SHA-256-verified. Failed flips
 * on a download/hash error and lets the user retry.
 */
sealed interface UpdateStatus {
    data object Idle : UpdateStatus
    data class Available(val manifest: UpdateManifest) : UpdateStatus
    data class Downloading(val manifest: UpdateManifest, val progress: Int) : UpdateStatus
    data class Ready(val manifest: UpdateManifest, val apkPath: String) : UpdateStatus
    data class Failed(val manifest: UpdateManifest?, val message: String) : UpdateStatus
}
