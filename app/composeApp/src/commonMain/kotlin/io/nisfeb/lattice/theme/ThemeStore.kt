package io.nisfeb.lattice.theme

/**
 * Persists the user's theme locally. Android → SharedPreferences, desktop →
 * JSON files. Holds the active theme plus the user's named saved themes (the
 * latter is the local cache of what's synced to %settings).
 */
interface ThemeStore {
    fun load(): ThemeSettings
    fun save(settings: ThemeSettings)
    fun loadSaved(): List<SavedTheme>
    fun saveSaved(themes: List<SavedTheme>)
}
