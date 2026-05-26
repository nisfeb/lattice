package io.nisfeb.lattice.bookmarks

import io.nisfeb.lattice.urbit.SettingsClient
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * Bookmarks, persisted locally per ship and synced to the ship's %settings
 * (desk "lattice", bucket "bookmarks", entry "list") so they appear on the
 * user's other installs. Local store is the offline cache; %settings is the
 * cross-install source of truth when reachable. Mirrors [io.nisfeb.lattice.theme.ThemeRepository].
 */
class BookmarkRepository(
    private val store: BookmarkStore,
    private val settings: SettingsClient,
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val ser = ListSerializer(Bookmark.serializer())

    private companion object {
        const val DESK = "lattice"
        const val BUCKET = "bookmarks"
        const val ENTRY = "list"
    }

    /** Locally-cached bookmarks (instant, offline-safe). */
    fun local(): List<Bookmark> = store.all()

    /** Pull bookmarks from %settings; refresh the local cache. Null if unreachable/unset. */
    suspend fun pull(): List<Bookmark>? {
        val raw = settings.readEntry(DESK, BUCKET, ENTRY) ?: return null
        val list = runCatching { json.decodeFromString(ser, raw) }.getOrNull() ?: return null
        store.save(list)
        return list
    }

    /** Persist the list locally and push it to %settings (best-effort). */
    suspend fun push(list: List<Bookmark>) {
        store.save(list)
        settings.putEntry(DESK, BUCKET, ENTRY, json.encodeToString(ser, list))
    }
}
