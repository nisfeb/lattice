package io.nisfeb.lattice.theme

import io.nisfeb.lattice.urbit.SettingsClient
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * Named saved themes, persisted locally and synced to the ship's %settings
 * (desk "lattice", bucket "themes", entry "saved") so they appear on the
 * user's other installs. Local store is the offline cache; %settings is the
 * cross-install source of truth when reachable.
 */
class ThemeRepository(
    private val store: ThemeStore,
    private val settings: SettingsClient,
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val ser = ListSerializer(SavedTheme.serializer())

    private companion object {
        const val DESK = "lattice"
        const val BUCKET = "themes"
        const val ENTRY = "saved"
    }

    /** Locally-cached saved themes (instant, offline-safe). */
    fun local(): List<SavedTheme> = store.loadSaved()

    /** Pull saved themes from %settings; update the local cache. Null if unreachable/empty. */
    suspend fun pull(): List<SavedTheme>? {
        val raw = settings.readEntry(DESK, BUCKET, ENTRY) ?: return null
        val list = runCatching { json.decodeFromString(ser, raw) }.getOrNull() ?: return null
        store.saveSaved(list)
        return list
    }

    /** Persist the list locally and push it to %settings (best-effort). */
    suspend fun push(list: List<SavedTheme>) {
        store.saveSaved(list)
        settings.putEntry(DESK, BUCKET, ENTRY, json.encodeToString(ser, list))
    }
}
