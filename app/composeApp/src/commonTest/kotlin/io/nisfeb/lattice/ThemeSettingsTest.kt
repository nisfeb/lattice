package io.nisfeb.lattice

import io.nisfeb.lattice.theme.SavedTheme
import io.nisfeb.lattice.theme.ThemeSettings
import io.nisfeb.lattice.theme.colorFromHex
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ThemeSettingsTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test fun defaultsAndColorGetters() {
        val s = ThemeSettings()
        assertEquals(false, s.vimMode)
        assertEquals(colorFromHex("#120041"), s.backgroundColor)
        assertEquals(colorFromHex("#5BEDF9"), s.linkColor)
    }

    @Test fun badHexFallsBackToDefault() {
        val s = ThemeSettings(background = "garbage", link = "")
        assertEquals(colorFromHex("#120041"), s.backgroundColor)
        assertEquals(colorFromHex("#5BEDF9"), s.linkColor)
    }

    @Test fun presetsPresent() {
        assertTrue(ThemeSettings.presets.isNotEmpty())
        assertTrue(ThemeSettings.presets.any { it.first == "Lattice Dark" })
    }

    @Test fun settingsRoundTrip() {
        val s = ThemeSettings(link = "#000000", vimMode = true, background = "#0A0A0A")
        assertEquals(s, json.decodeFromString(ThemeSettings.serializer(), json.encodeToString(ThemeSettings.serializer(), s)))
    }

    @Test fun savedThemeListRoundTrip() {
        val ser = ListSerializer(SavedTheme.serializer())
        val list = listOf(
            SavedTheme("Midnight", ThemeSettings(background = "#001018", link = "#00E5A0")),
            SavedTheme("Day", ThemeSettings.Light.copy(vimMode = true)),
        )
        assertEquals(list, json.decodeFromString(ser, json.encodeToString(ser, list)))
    }
}
