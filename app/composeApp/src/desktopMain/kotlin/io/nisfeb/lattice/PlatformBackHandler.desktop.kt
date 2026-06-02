package io.nisfeb.lattice

import androidx.compose.runtime.Composable

@Composable
actual fun PlatformBackHandler(enabled: Boolean, onBack: () -> Unit) {
    // No system back gesture on desktop; the toolbar Back button handles
    // navigation, so there's nothing to intercept.
}
