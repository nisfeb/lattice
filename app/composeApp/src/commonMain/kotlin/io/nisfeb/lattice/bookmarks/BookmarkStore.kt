package io.nisfeb.lattice.bookmarks

import kotlinx.serialization.Serializable

/** A saved `urb://` bookmark. */
@Serializable
data class Bookmark(val url: String, val title: String)

/** Persists bookmarks. Android backs it with SharedPreferences, desktop a JSON file. */
interface BookmarkStore {
    fun all(): List<Bookmark>
    fun add(bookmark: Bookmark)
    fun remove(url: String)
    fun contains(url: String): Boolean
}
