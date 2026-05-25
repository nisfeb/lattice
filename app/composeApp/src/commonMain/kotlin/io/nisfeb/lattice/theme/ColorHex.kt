package io.nisfeb.lattice.theme

import androidx.compose.ui.graphics.Color

/** Parse "#RRGGBB" or "#AARRGGBB" (case-insensitive, '#' optional) → Color, or null. */
fun colorFromHex(hex: String): Color? {
    val s = hex.trim().removePrefix("#")
    return when (s.length) {
        6 -> runCatching { Color(("FF$s").toLong(16)) }.getOrNull()
        8 -> runCatching { Color(s.toLong(16)) }.getOrNull()
        else -> null
    }
}

/** Color → "#RRGGBB". */
fun Color.toHex(): String {
    fun comp(v: Float) = (v * 255f).toInt().coerceIn(0, 255).toString(16).padStart(2, '0')
    return "#${comp(red)}${comp(green)}${comp(blue)}".uppercase()
}
