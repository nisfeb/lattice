package io.nisfeb.lattice.bookmarks

import io.nisfeb.lattice.shipScope
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.io.File

/** Desktop BookmarkStore backed by per-ship ~/.config/lattice/<ship>/bookmarks.json. */
class FileBookmarkStore(ship: String, dir: File = defaultDir()) : BookmarkStore {
    private val file = File(File(dir, shipScope(ship)), "bookmarks.json").also { it.parentFile?.mkdirs() }
    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true }
    private val ser = ListSerializer(Bookmark.serializer())

    override fun all(): List<Bookmark> =
        runCatching { json.decodeFromString(ser, file.readText()) }.getOrDefault(emptyList())

    override fun save(list: List<Bookmark>) {
        runCatching { file.writeText(json.encodeToString(ser, list)) }
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
