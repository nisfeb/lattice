package io.nisfeb.lattice.urbit

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission

/**
 * Desktop SessionStore backed by a JSON file under the user config dir
 * (~/.config/lattice/sessions.json, or $XDG_CONFIG_HOME).
 */
class FileSessionStore(dir: File = defaultDir()) : SessionStore {

    @Serializable
    private data class State(
        val sessions: List<SavedSession> = emptyList(),
        val active: String? = null,
    )

    private val file = File(dir, "sessions.json").also {
        it.parentFile?.mkdirs()
        restrict(it.parentFile, dir = true) // 0700 the config dir
    }
    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true }

    private fun read(): State =
        runCatching { json.decodeFromString<State>(file.readText()) }.getOrDefault(State())

    private fun write(state: State) {
        runCatching {
            // The file holds a bearer session cookie — keep it owner-only so other
            // local users can't read it. Set perms before writing the secret.
            if (!file.exists()) file.createNewFile()
            restrict(file, dir = false)
            file.writeText(json.encodeToString(State.serializer(), state))
        }
    }

    private fun restrict(f: File?, dir: Boolean) {
        if (f == null) return
        runCatching {
            val perms = if (dir) {
                setOf(
                    PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE,
                    PosixFilePermission.OWNER_EXECUTE,
                )
            } else {
                setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)
            }
            Files.setPosixFilePermissions(f.toPath(), perms)
        } // best-effort: no-op on non-POSIX filesystems (e.g. Windows)
    }

    override fun all(): List<SavedSession> = read().sessions.sortedBy { it.ship }

    override fun active(): SavedSession? {
        val s = read()
        return s.sessions.firstOrNull { it.ship == s.active } ?: s.sessions.firstOrNull()
    }

    override fun activeShip(): String? = active()?.ship

    override fun save(entry: SavedSession, makeActive: Boolean) {
        val s = read()
        val others = s.sessions.filterNot { it.ship == entry.ship }
        write(State(others + entry, if (makeActive) entry.ship else s.active))
    }

    override fun setActive(ship: String) {
        val s = read()
        if (s.sessions.any { it.ship == ship }) write(s.copy(active = ship))
    }

    override fun remove(ship: String) {
        val s = read()
        val left = s.sessions.filterNot { it.ship == ship }
        val active = if (s.active == ship) left.firstOrNull()?.ship else s.active
        write(State(left, active))
    }

    override fun clearAll() = write(State())

    companion object {
        fun defaultDir(): File {
            val xdg = System.getenv("XDG_CONFIG_HOME")
            val base = if (!xdg.isNullOrBlank()) File(xdg)
            else File(System.getProperty("user.home"), ".config")
            return File(base, "lattice")
        }
    }
}
