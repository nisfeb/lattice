package io.nisfeb.lattice.bookmarks

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.io.File

/** Desktop BookmarkStore backed by ~/.config/lattice/bookmarks.json. */
class FileBookmarkStore(dir: File = defaultDir()) : BookmarkStore {
    private val file = File(dir, "bookmarks.json").also { it.parentFile?.mkdirs() }
    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true }
    private val ser = ListSerializer(Bookmark.serializer())

    private fun read(): List<Bookmark> =
        runCatching { json.decodeFromString(ser, file.readText()) }.getOrDefault(emptyList())

    private fun write(list: List<Bookmark>) {
        runCatching { file.writeText(json.encodeToString(ser, list)) }
    }

    override fun all(): List<Bookmark> = read()

    override fun add(bookmark: Bookmark) {
        val list = read().filterNot { it.url == bookmark.url }
        write(list + bookmark)
    }

    override fun remove(url: String) = write(read().filterNot { it.url == url })

    override fun contains(url: String): Boolean = read().any { it.url == url }

    companion object {
        fun defaultDir(): File {
            val xdg = System.getenv("XDG_CONFIG_HOME")
            val base = if (!xdg.isNullOrBlank()) File(xdg)
            else File(System.getProperty("user.home"), ".config")
            return File(base, "lattice")
        }
    }
}
