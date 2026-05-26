package io.nisfeb.lattice

import java.awt.Toolkit
import java.awt.datatransfer.StringSelection

actual val isDesktop: Boolean = true

actual fun shareText(text: String): String? {
    // Desktop has no system share sheet; copying the link to the clipboard is
    // the closest "send this to someone" affordance.
    copyToClipboard(text)
    return "Link copied to clipboard."
}

actual fun copyToClipboard(text: String) {
    val selection = StringSelection(text)
    Toolkit.getDefaultToolkit().systemClipboard.setContents(selection, selection)
}

actual fun openInBrowser(url: String) {
    // Shell out to the OS opener — AWT's Desktop.browse throws on Wayland-only
    // Linux (Hyprland/Sway/…), so prefer xdg-open and keep AWT as a fallback.
    val os = System.getProperty("os.name", "").lowercase()
    val cmd = when {
        "linux" in os -> arrayOf("xdg-open", url)
        "mac" in os || "darwin" in os -> arrayOf("open", url)
        "windows" in os -> arrayOf("rundll32", "url.dll,FileProtocolHandler", url)
        else -> null
    }
    if (cmd != null && runCatching { ProcessBuilder(*cmd).start() }.isSuccess) return
    runCatching {
        val desktop = java.awt.Desktop.getDesktop()
        if (java.awt.Desktop.isDesktopSupported() && desktop.isSupported(java.awt.Desktop.Action.BROWSE)) {
            desktop.browse(java.net.URI(url))
        }
    }
}
