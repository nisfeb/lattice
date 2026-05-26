package io.nisfeb.lattice.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import kotlinx.serialization.Serializable

/**
 * User-customizable theme. Colors are stored as "#RRGGBB" strings so they're
 * easy to edit and persist. Defaults are the brand (icon) palette.
 */
@Serializable
data class ThemeSettings(
    val background: String = "#120041",
    val surface: String = "#211056",
    val text: String = "#E9E6F4",
    val link: String = "#5BEDF9",
    val visited: String = "#C9A8FF",
    val accent: String = "#5BEDF9",
    val vimMode: Boolean = false,
    /** Reading font for the gemtext view: "sans" | "serif" | "mono". */
    val font: String = "sans",
    /** Browser-bar action ids the user pinned to the ⋮ overflow menu (see
     *  [io.nisfeb.lattice.ui.ToolbarActions]); the rest stay inline, subject to
     *  width. Empty = default layout (everything inline until space runs out). */
    val overflowActions: List<String> = emptyList(),
) {
    val backgroundColor: Color get() = colorFromHex(background) ?: Color(0xFF120041)
    val surfaceColor: Color get() = colorFromHex(surface) ?: backgroundColor
    val textColor: Color get() = colorFromHex(text) ?: Color.White
    val linkColor: Color get() = colorFromHex(link) ?: Color(0xFF5BEDF9)
    val visitedColor: Color get() = colorFromHex(visited) ?: Color(0xFFC9A8FF)
    val accentColor: Color get() = colorFromHex(accent) ?: linkColor

    /** The reading font as a Compose family (built-ins — no bundled assets). */
    val fontFamily: FontFamily get() = when (font) {
        "serif" -> FontFamily.Serif
        "mono" -> FontFamily.Monospace
        else -> FontFamily.SansSerif
    }

    companion object {
        val LatticeDark = ThemeSettings()
        val Light = ThemeSettings(
            background = "#FBFAFF", surface = "#ECE7F8", text = "#1A1330",
            link = "#2A6FF0", visited = "#7A3FB0", accent = "#2A6FF0",
        )
        val Terminal = ThemeSettings(
            background = "#0B0F0B", surface = "#13231A", text = "#CFF5CF",
            link = "#5BF98A", visited = "#A8E0FF", accent = "#5BF98A",
        )
        val Paper = ThemeSettings(
            background = "#F7F3E9", surface = "#EAE3D0", text = "#2B2620",
            link = "#9C5A2D", visited = "#7A6A2D", accent = "#9C5A2D",
        )

        /** Named presets for one-tap selection. */
        val presets: List<Pair<String, ThemeSettings>> = listOf(
            "Lattice Dark" to LatticeDark,
            "Light" to Light,
            "Terminal" to Terminal,
            "Paper" to Paper,
        )

        /** Reading-font choices: (key, label) — key is stored in [font]. */
        val fonts: List<Pair<String, String>> = listOf(
            "sans" to "Sans-serif",
            "serif" to "Serif",
            "mono" to "Monospace",
        )
    }
}
