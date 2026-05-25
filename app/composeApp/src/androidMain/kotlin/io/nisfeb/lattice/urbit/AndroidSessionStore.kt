package io.nisfeb.lattice.urbit

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Android SessionStore backed by SharedPreferences (one JSON blob). */
class AndroidSessionStore(context: Context) : SessionStore {

    @Serializable
    private data class State(
        val sessions: List<SavedSession> = emptyList(),
        val active: String? = null,
    )

    private val prefs = context.getSharedPreferences("lattice-sessions", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    private fun read(): State =
        runCatching { json.decodeFromString<State>(prefs.getString("state", null) ?: "") }
            .getOrDefault(State())

    private fun write(state: State) {
        prefs.edit().putString("state", json.encodeToString(State.serializer(), state)).apply()
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
}
