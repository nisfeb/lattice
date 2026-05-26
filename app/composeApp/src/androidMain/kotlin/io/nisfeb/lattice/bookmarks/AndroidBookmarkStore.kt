package io.nisfeb.lattice.bookmarks

import android.content.Context
import io.nisfeb.lattice.shipScope
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** Android BookmarkStore backed by per-ship SharedPreferences (one JSON list). */
class AndroidBookmarkStore(context: Context, ship: String) : BookmarkStore {
    private val prefs = context.getSharedPreferences("lattice-bookmarks.${shipScope(ship)}", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val ser = ListSerializer(Bookmark.serializer())

    override fun all(): List<Bookmark> =
        runCatching { json.decodeFromString(ser, prefs.getString("list", null) ?: "") }
            .getOrDefault(emptyList())

    override fun save(list: List<Bookmark>) {
        prefs.edit().putString("list", json.encodeToString(ser, list)).apply()
    }
}
