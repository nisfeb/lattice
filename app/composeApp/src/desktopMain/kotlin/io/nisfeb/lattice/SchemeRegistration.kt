package io.nisfeb.lattice

import io.nisfeb.lattice.urbit.FileSessionStore
import java.io.File

/**
 * Registers Lattice as the OS handler for the `urb://` URL scheme so a
 * `urb://~ship/path` opened from another app (Talon, a browser, a
 * file manager) routes here.
 *
 *  - **Linux:** writes a user-level `.desktop` entry with
 *    `MimeType=x-scheme-handler/urb;` and points `xdg-mime` at it.
 *  - **Windows:** writes `HKCU\Software\Classes\urb` registry keys.
 *  - **macOS:** no-op — scheme association lives in the .app's
 *    Info.plist (`CFBundleURLTypes`), declared at packaging time in
 *    `build.gradle.kts` (`macOS { infoPlist { … } }`).
 *
 * Runs at most once per (binary path): a marker file records the exec
 * path we registered, so a reinstall to a new location re-registers
 * but a normal launch is a cheap no-op. Self-registration avoids
 * depending on jpackage scheme-association support (which Compose
 * Desktop's Gradle DSL doesn't expose).
 */
object SchemeRegistration {
    private val osName = System.getProperty("os.name", "").lowercase()

    fun ensureRegistered() {
        val exec = currentExecPath() ?: return
        // Skip dev runs launched through the JDK (`./gradlew run`) — we
        // don't want to register `java` as the urb:// handler.
        val execName = File(exec).name.lowercase()
        if (execName == "java" || execName == "javaw") return

        val marker = File(FileSessionStore.defaultDir(), "urb-scheme-registered")
        if (marker.exists() && marker.readText().trim() == exec) return

        val ok = runCatching {
            when {
                "linux" in osName -> registerLinux(exec)
                "windows" in osName -> registerWindows(exec)
                else -> false // macOS handled via Info.plist at build time
            }
        }.getOrDefault(false)

        if (ok) runCatching {
            marker.parentFile?.mkdirs()
            marker.writeText(exec)
        }
    }

    private fun currentExecPath(): String? =
        runCatching { ProcessHandle.current().info().command().orElse(null) }.getOrNull()

    private fun registerLinux(exec: String): Boolean {
        val appsDir = File(System.getProperty("user.home"), ".local/share/applications")
        appsDir.mkdirs()
        val desktopFile = File(appsDir, "lattice-urb.desktop")
        desktopFile.writeText(
            """
            [Desktop Entry]
            Type=Application
            Name=Lattice
            Comment=Browse gemtext over Urbit
            Exec="$exec" %u
            Terminal=false
            Categories=Network;
            MimeType=x-scheme-handler/urb;
            NoDisplay=true
            """.trimIndent() + "\n",
        )
        run("xdg-mime", "default", "lattice-urb.desktop", "x-scheme-handler/urb")
        run("update-desktop-database", appsDir.absolutePath)
        return true
    }

    private fun registerWindows(exec: String): Boolean {
        // HKCU\Software\Classes\urb → URL Protocol; shell\open\command
        // invokes the launcher with the URL as %1.
        run("reg", "add", "HKCU\\Software\\Classes\\urb", "/ve", "/d", "URL:urb Protocol", "/f")
        run("reg", "add", "HKCU\\Software\\Classes\\urb", "/v", "URL Protocol", "/d", "", "/f")
        run(
            "reg", "add", "HKCU\\Software\\Classes\\urb\\shell\\open\\command",
            "/ve", "/d", "\"$exec\" \"%1\"", "/f",
        )
        return true
    }

    private fun run(vararg cmd: String): Boolean = runCatching {
        ProcessBuilder(*cmd)
            .redirectError(ProcessBuilder.Redirect.DISCARD)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .start()
            .waitFor()
        true
    }.getOrDefault(false)
}
