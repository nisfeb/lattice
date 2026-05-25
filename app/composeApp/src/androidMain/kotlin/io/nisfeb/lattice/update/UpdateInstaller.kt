package io.nisfeb.lattice.update

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.util.Log
import androidx.core.content.FileProvider
import kotlinx.coroutines.delay
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * **Sideload distribution only.** Downloads a signed APK from the release URL
 * and hands it to Android's package installer. Requires the
 * REQUEST_INSTALL_PACKAGES permission + a FileProvider (both declared in the
 * Android manifest). This would violate Google Play's Device-and-Network-Abuse
 * policy, so it must be excluded from any future Play Store flavor.
 */
class UpdateInstaller(private val context: Context) : UpdateInstallerHook {

    override suspend fun download(
        manifest: UpdateManifest,
        onProgress: (Int) -> Unit,
        onReady: (String) -> Unit,
        onFailure: (String) -> Unit,
    ) {
        val updatesDir = File(context.getExternalFilesDir(null), "updates").apply { mkdirs() }
        val target = File(updatesDir, "lattice-${manifest.versionName}.apk")
        if (target.exists()) target.delete()

        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val req = DownloadManager.Request(Uri.parse(manifest.url))
            .setTitle("Lattice ${manifest.versionName}")
            .setDescription("Downloading update")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationUri(Uri.fromFile(target))
            .addRequestHeader("User-Agent", "Lattice-UpdateInstaller")
        val downloadId = dm.enqueue(req)

        // Poll at 250ms for fine-grained progress (DownloadManager's broadcast
        // is coarse for a single foreground-bounded download).
        while (true) {
            val cursor: Cursor = dm.query(DownloadManager.Query().setFilterById(downloadId)) ?: run {
                onFailure("download manager returned null cursor"); return
            }
            cursor.use { c ->
                if (!c.moveToFirst()) { onFailure("download id $downloadId not found"); return }
                when (c.getInt(c.getColumnIndex(DownloadManager.COLUMN_STATUS))) {
                    DownloadManager.STATUS_SUCCESSFUL -> {
                        val ok = try {
                            verifySha256(target, manifest.sha256)
                        } catch (e: java.io.IOException) {
                            target.delete()
                            onFailure("SHA-256 check failed: ${e.message ?: e::class.simpleName}")
                            return
                        }
                        if (!ok) {
                            target.delete()
                            onFailure("downloaded APK failed SHA-256 check")
                            return
                        }
                        onReady(target.absolutePath)
                        return
                    }
                    DownloadManager.STATUS_FAILED -> {
                        val reason = c.getInt(c.getColumnIndex(DownloadManager.COLUMN_REASON))
                        onFailure("download failed (reason $reason)")
                        return
                    }
                    DownloadManager.STATUS_RUNNING,
                    DownloadManager.STATUS_PAUSED,
                    DownloadManager.STATUS_PENDING -> {
                        val total = c.getLong(c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                        val soFar = c.getLong(c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                        val pct = if (total > 0) ((soFar * 100) / total).toInt() else 0
                        onProgress(pct.coerceIn(0, 99))
                    }
                }
            }
            delay(250)
        }
    }

    /** Hand the verified APK to the package installer via a FileProvider URI. */
    override fun install(apkPath: String) {
        val file = File(apkPath)
        val authority = "${context.packageName}.updates.fileprovider"
        val uri = FileProvider.getUriForFile(context, authority, file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            Log.e("UpdateInstaller", "install intent failed", e)
        }
    }

    private fun verifySha256(file: File, expected: String): Boolean {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }.equals(expected, ignoreCase = true)
    }
}
