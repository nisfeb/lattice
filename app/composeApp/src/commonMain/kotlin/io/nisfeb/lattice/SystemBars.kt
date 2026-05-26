package io.nisfeb.lattice

import androidx.compose.runtime.Composable

/**
 * Tell the OS whether the system bars (status / navigation) should draw their
 * icons dark or light, so they stay legible against the app background showing
 * through them edge-to-edge. [darkIcons] = true for a light background.
 *
 * Android applies it via the window insets controller; desktop has no system
 * bars, so it's a no-op there.
 */
@Composable
expect fun SystemBarIcons(darkIcons: Boolean)
