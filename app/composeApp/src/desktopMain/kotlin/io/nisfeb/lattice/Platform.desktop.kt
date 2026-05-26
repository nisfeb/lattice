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
