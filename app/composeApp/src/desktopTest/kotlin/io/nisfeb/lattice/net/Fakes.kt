package io.nisfeb.lattice.net

import io.nisfeb.lattice.bookmarks.Bookmark
import io.nisfeb.lattice.bookmarks.BookmarkStore
import io.nisfeb.lattice.theme.SavedTheme
import io.nisfeb.lattice.theme.ThemeSettings
import io.nisfeb.lattice.theme.ThemeStore
import io.nisfeb.lattice.urbit.SavedSession
import io.nisfeb.lattice.urbit.SessionStore
import io.nisfeb.lattice.urbit.UrbitSession
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockWebServer

/** In-memory SessionStore for tests. */
class FakeSessionStore : SessionStore {
    val entries = mutableListOf<SavedSession>()
    private var activeShip: String? = null
    override fun all() = entries.toList()
    override fun active() = entries.firstOrNull { it.ship == activeShip }
    override fun activeShip() = activeShip
    override fun save(entry: SavedSession, makeActive: Boolean) {
        entries.removeAll { it.ship == entry.ship }; entries.add(entry); if (makeActive) activeShip = entry.ship
    }
    override fun setActive(ship: String) { activeShip = ship }
    override fun remove(ship: String) { entries.removeAll { it.ship == ship }; if (activeShip == ship) activeShip = null }
    override fun clearAll() { entries.clear(); activeShip = null }
}

/** In-memory ThemeStore for tests. */
class FakeThemeStore : ThemeStore {
    var active = ThemeSettings()
    var saved: List<SavedTheme> = emptyList()
    override fun load() = active
    override fun save(settings: ThemeSettings) { active = settings }
    override fun loadSaved() = saved
    override fun saveSaved(themes: List<SavedTheme>) { saved = themes }
}

/** In-memory BookmarkStore for tests. */
class FakeBookmarkStore : BookmarkStore {
    var list: List<Bookmark> = emptyList()
    override fun all() = list
    override fun save(list: List<Bookmark>) { this.list = list }
}

/** A UrbitSession already authenticated against [server] (~zod), via tryRestore. */
fun loggedInSession(server: MockWebServer): UrbitSession {
    val store = FakeSessionStore()
    val base = server.url("/").toString().trimEnd('/')
    store.save(SavedSession(base, "~zod", "urbauth-~zod", "abc123", server.hostName))
    return UrbitSession(OkHttpClient(), store).also { it.tryRestore() }
}
