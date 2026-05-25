package io.nisfeb.lattice

import androidx.compose.ui.graphics.Color
import io.nisfeb.lattice.theme.colorFromHex
import io.nisfeb.lattice.theme.toHex
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ColorHexTest {

    @Test fun roundTripSixDigit() {
        assertEquals("#5BEDF9", colorFromHex("#5BEDF9")?.toHex())
        assertEquals("#120041", colorFromHex("#120041")?.toHex())
    }

    @Test fun acceptsNoHashAndLowercase() {
        assertEquals("#5BEDF9", colorFromHex("5bedf9")?.toHex())
    }

    @Test fun eightDigitDropsAlphaInToHex() {
        assertEquals("#5BEDF9", colorFromHex("#FF5BEDF9")?.toHex())
    }

    @Test fun rejectsBadInput() {
        assertNull(colorFromHex("nope"))
        assertNull(colorFromHex("#12"))
        assertNull(colorFromHex(""))
        assertNull(colorFromHex("#ZZZZZZ"))
    }

    @Test fun toHexFromKnownColor() {
        assertEquals("#5BEDF9", Color(0xFF5BEDF9).toHex())
    }
}
