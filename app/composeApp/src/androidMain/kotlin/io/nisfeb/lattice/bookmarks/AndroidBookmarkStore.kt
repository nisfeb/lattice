package io.nisfeb.lattice.bookmarks

import android.content.Context
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** Android BookmarkStore backed by SharedPreferences (one JSON list). */
class AndroidBookmarkStore(context: Context) : BookmarkStore {
    private val prefs = context.getSharedPreferences("lattice-bookmarks", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val ser = ListSerializer(Bookmark.serializer())

    private fun read(): List<Bookmark> =
        runCatching { json.decodeFromString(ser, prefs.getString("list", null) ?: "") }
            .getOrDefault(emptyList())

    private fun write(list: List<Bookmark>) {
        prefs.edit().putString("list", json.encodeToString(ser, list)).apply()
    }

    override fun all(): List<Bookmark> = read()

    override fun add(bookmark: Bookmark) {
        write(read().filterNot { it.url == bookmark.url } + bookmark)
    }

    override fun remove(url: String) = write(read().filterNot { it.url == url })

    override fun contains(url: String): Boolean = read().any { it.url == url }
}
