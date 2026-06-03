package io.nisfeb.lattice

import androidx.compose.runtime.Composable

/**
 * Intercept the system Back gesture/button. While [enabled], [onBack] runs
 * instead of the OS default (which would close the app); when disabled, Back
 * falls through to the OS. Android wires it to the activity's
 * OnBackPressedDispatcher (so the back gesture pops in-app navigation instead
 * of closing); desktop has no system back gesture — navigation is the toolbar
 * Back button — so it's a no-op there.
 *
 * Multiple handlers form a LIFO stack: the most recently composed *enabled*
 * one wins. We compose a screen-level handler (pop a sub-screen to Browse) and,
 * deeper, the browser's history handler — so on Browse the browser pops tab
 * history, and only at the root does Back close the app.
 */
@Composable
expect fun PlatformBackHandler(enabled: Boolean, onBack: () -> Unit)
