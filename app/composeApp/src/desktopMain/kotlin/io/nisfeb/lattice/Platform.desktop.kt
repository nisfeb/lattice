package io.nisfeb.lattice

import java.awt.Toolkit
import java.awt.datatransfer.StringSelection

actual val isDesktop: Boolean = true

actual fun shareText(text: String): String? {
    // Desktop has no system share sheet; copying the link to the clipboard is
    // the closest "send this to someone" affordance.
    val selection = StringSelection(text)
    Toolkit.getDefaultToolkit().systemClipboard.setContents(selection, selection)
    return "Link copied to clipboard."
}
