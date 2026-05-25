package io.nisfeb.lattice

/** True on desktop (JVM), false on Android — drives desktop-only layout (sidebar, tabs, compact sizing). */
expect val isDesktop: Boolean
