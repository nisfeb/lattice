package io.nisfeb.lattice.theme

import android.content.Context
import io.nisfeb.lattice.shipScope
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** Android ThemeStore backed by per-ship SharedPreferences. */
class AndroidThemeStore(context: Context, ship: String) : ThemeStore {
    private val prefs = context.getSharedPreferences("lattice-theme.${shipScope(ship)}", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val savedSer = ListSerializer(SavedTheme.serializer())

    // Default to the Light preset for first launch (no saved theme).
    override fun load(): ThemeSettings =
        runCatching { json.decodeFromString<ThemeSettings>(prefs.getString("theme", null) ?: "") }
            .getOrDefault(ThemeSettings.Light)

    override fun save(settings: ThemeSettings) {
        prefs.edit().putString("theme", json.encodeToString(ThemeSettings.serializer(), settings)).apply()
    }

    override fun loadSaved(): List<SavedTheme> =
        runCatching { json.decodeFromString(savedSer, prefs.getString("saved", null) ?: "") }
            .getOrDefault(emptyList())

    override fun saveSaved(themes: List<SavedTheme>) {
        prefs.edit().putString("saved", json.encodeToString(savedSer, themes)).apply()
    }
}
