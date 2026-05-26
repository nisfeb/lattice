package io.nisfeb.lattice

/** True on desktop (JVM), false on Android — drives desktop-only layout (sidebar, tabs, compact sizing). */
expect val isDesktop: Boolean

/**
 * Hand [text] (a urb:// link) to the OS so the user can send it to someone.
 * Android opens the system share sheet; desktop has no share UI, so it copies
 * to the clipboard. Returns a short user-facing message to confirm (or null
 * when the OS shows its own UI and no extra confirmation is needed).
 */
expect fun shareText(text: String): String?
