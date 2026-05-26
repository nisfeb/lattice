package io.nisfeb.lattice.bookmarks

import kotlinx.serialization.Serializable

/** A saved `urb://` bookmark. */
@Serializable
data class Bookmark(val url: String, val title: String)

/**
 * Local cache of this ship's bookmarks (Android SharedPreferences, desktop a
 * JSON file). The whole list is read/replaced — mutations + cross-install sync
 * are handled by [io.nisfeb.lattice.bookmarks.BookmarkRepository].
 */
interface BookmarkStore {
    fun all(): List<Bookmark>
    fun save(list: List<Bookmark>)
}
