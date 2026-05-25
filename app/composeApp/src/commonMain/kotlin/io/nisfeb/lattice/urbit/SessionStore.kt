package io.nisfeb.lattice.urbit

import kotlinx.serialization.Serializable

/** A saved session for one ship. (Lifted from talon.) */
@Serializable
data class SavedSession(
    val shipUrl: String,
    val ship: String,       // "~patp"
    val cookieName: String, // e.g. "urbauth-~patp"
    val cookieValue: String,
    val cookieDomain: String,
)

/**
 * Platform-agnostic interface for persisting Urbit login state. Android backs
 * it with SharedPreferences, desktop with a JSON file. Single active ship is
 * enough for v1, but the multi-ship shape is kept so the lifted UrbitSession
 * works unchanged.
 */
interface SessionStore {
    fun all(): List<SavedSession>
    fun active(): SavedSession?
    fun activeShip(): String?
    fun save(entry: SavedSession, makeActive: Boolean = true)
    fun setActive(ship: String)
    fun remove(ship: String)
    fun clearAll()
}
