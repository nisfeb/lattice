package io.nisfeb.lattice.theme

import io.nisfeb.lattice.shipScope
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.io.File

/** Desktop ThemeStore backed by per-ship ~/.config/lattice/<ship>/{theme,saved-themes}.json. */
class FileThemeStore(ship: String, dir: File = defaultDir()) : ThemeStore {
    private val shipDir = File(dir, shipScope(ship))
    private val file = File(shipDir, "theme.json").also { it.parentFile?.mkdirs() }
    private val savedFile = File(shipDir, "saved-themes.json").also { it.parentFile?.mkdirs() }
    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true }
    private val savedSer = ListSerializer(SavedTheme.serializer())

    // Default to the Light preset for first launch (no saved theme).
    override fun load(): ThemeSettings =
        runCatching { json.decodeFromString<ThemeSettings>(file.readText()) }.getOrDefault(ThemeSettings.Light)

    override fun save(settings: ThemeSettings) {
        runCatching { file.writeText(json.encodeToString(ThemeSettings.serializer(), settings)) }
    }

    override fun loadSaved(): List<SavedTheme> =
        runCatching { json.decodeFromString(savedSer, savedFile.readText()) }.getOrDefault(emptyList())

    override fun saveSaved(themes: List<SavedTheme>) {
        runCatching { savedFile.writeText(json.encodeToString(savedSer, themes)) }
    }

    companion object {
        fun defaultDir(): File {
            val xdg = System.getenv("XDG_CONFIG_HOME")
            val base = if (!xdg.isNullOrBlank()) File(xdg)
            else File(System.getProperty("user.home"), ".config")
            return File(base, "lattice")
        }
    }
}
