package io.nisfeb.lattice.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import io.nisfeb.lattice.theme.ThemeSettings

/** Builds a Material3 scheme from the user's [ThemeSettings]. */
@Composable
fun LatticeTheme(settings: ThemeSettings, content: @Composable () -> Unit) {
    val bg = settings.backgroundColor
    val text = settings.textColor
    val accent = settings.accentColor
    val onAccent = if (accent.luminance() > 0.5f) Color.Black else Color.White

    val scheme = if (bg.luminance() > 0.5f) {
        lightColorScheme(
            primary = accent, onPrimary = onAccent,
            secondary = settings.linkColor, onSecondary = onAccent,
            background = bg, onBackground = text,
            surface = bg, onSurface = text,
            surfaceVariant = settings.surfaceColor, onSurfaceVariant = text,
            error = Color(0xFFB3261E),
        )
    } else {
        darkColorScheme(
            primary = accent, onPrimary = onAccent,
            secondary = settings.linkColor, onSecondary = onAccent,
            background = bg, onBackground = text,
            surface = bg, onSurface = text,
            surfaceVariant = settings.surfaceColor, onSurfaceVariant = text,
            error = Color(0xFFFF6E8A),
        )
    }
    MaterialTheme(colorScheme = scheme, content = content)
}
