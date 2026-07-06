package io.nisfeb.lattice.urbit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.ConcurrentHashMap

/**
 * Coerce a user-typed ship URL to one OkHttp's `toHttpUrl()` can parse.
 * If no scheme is present, prepend `https://` — matches Talon's posture
 * and means users only have to type `http://` when they explicitly want
 * cleartext (e.g. a LAN ship / SSH tunnel). Trailing slashes are stripped
 * so the saved-session entry is stable.
 */
internal fun normalizeShipUrl(input: String): String {
    val trimmed = input.trim().trimEnd('/')
    val lower = trimmed.lowercase()
    return if (lower.startsWith("http://") || lower.startsWith("https://")) {
        trimmed
    } else {
        "https://$trimmed"
    }
}

/**
 * Holds the session cookie for one authenticated Urbit ship and owns the
 * OkHttp client used for requests. Call login() once; afterwards the
 * authenticated [http] client carries the cookie for fetch GETs.
 *
 * Lifted from talon; the chat-channel parts (openChannel) are removed —
 * lattice only needs authenticated GETs to /apps/lattice/fetch.
 */
class UrbitSession(
    parentClient: OkHttpClient,
    private val store: SessionStore,
) {

    private val cookieJar = InMemoryCookieJar()
    // A hard per-call ceiling so a stalled request can't spin indefinitely — every
    // call fails within ~20s with a timeout we can explain, rather than hanging on
    // a connection the ship accepted but never answers. (fetchClient overrides this
    // with a longer bound for cold-route peeks.)
    val http: OkHttpClient = parentClient.newBuilder()
        .cookieJar(cookieJar)
        .callTimeout(java.time.Duration.ofSeconds(20))
        .build()

    @Volatile var baseUrl: HttpUrl? = null
        private set
    @Volatile var shipName: String? = null
        private set

    /**
     * Authenticates against shipUrl (e.g. "https://mything.arvo.network" or
     * "http://localhost:8081") using +code. Accepts a leading '+' and keeps
     * dashes (Urbit's /~/login wants the code verbatim minus the '+').
     * Returns Result.success(ship) on success.
     *
     * If `shipUrl` has no scheme, `https://` is assumed — users only type
     * `http://` when they explicitly want cleartext. Matches Talon: there's
     * no app-level refusal of plaintext http (whether http reaches the wire
     * is the platform's cleartext policy — see the Android manifest).
     */
    suspend fun login(shipUrl: String, code: String): Result<String> =
        withContext(Dispatchers.IO) {
            runCatching {
                val url = normalizeShipUrl(shipUrl).toHttpUrl()
                val body = FormBody.Builder()
                    .add("password", code.trim().removePrefix("+"))
                    .build()
                val request = Request.Builder()
                    .url(url.newBuilder().addPathSegments("~/login").build())
                    .post(body)
                    .build()
                http.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) error("login HTTP ${resp.code}")
                    val cookie = cookieJar.loadForRequest(url)
                        .firstOrNull { it.name.startsWith("urbauth-~") }
                        ?: error("no urbauth cookie returned")
                    val ship = cookie.name.removePrefix("urbauth-")
                    baseUrl = url
                    shipName = ship
                    store.save(
                        SavedSession(
                            shipUrl = url.toString().trimEnd('/'),
                            ship = ship,
                            cookieName = cookie.name,
                            cookieValue = cookie.value,
                            cookieDomain = url.host,
                        ),
                        makeActive = true,
                    )
                    ship
                }
            }
        }

    /** Sign out the active ship; other saved ships stay. */
    fun logout() {
        val s = shipName
        baseUrl = null
        shipName = null
        cookieJar.clear()
        if (s != null) store.remove(s) else store.clearAll()
    }

    /**
     * Restore the active (or named) saved session into the cookie jar. Returns
     * the ship patp on success, null if nothing saved. Doesn't re-verify with
     * the server.
     */
    fun tryRestore(ship: String? = null): String? {
        val saved = if (ship != null) {
            store.all().firstOrNull { it.ship == ship }
        } else store.active()
        if (saved == null) return null
        val url = runCatching { saved.shipUrl.toHttpUrl() }.getOrNull() ?: return null
        val cookie = Cookie.Builder()
            .name(saved.cookieName)
            .value(saved.cookieValue)
            .domain(saved.cookieDomain)
            .path("/")
            .build()
        cookieJar.clear()
        cookieJar.saveFromResponse(url, listOf(cookie))
        baseUrl = url
        shipName = saved.ship
        store.setActive(saved.ship)
        return saved.ship
    }

    /** Our patp with leading ~, e.g. "~zod". Null if not logged in. */
    val ourShip: String? get() = shipName
}

/**
 * Minimal thread-safe in-memory cookie jar — no persistence, wiped on logout.
 * (Lifted from talon.)
 */
private class InMemoryCookieJar : CookieJar {
    private val store = ConcurrentHashMap<String, MutableList<Cookie>>()

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val list = store.getOrPut(url.host) { mutableListOf() }
        synchronized(list) {
            list.removeAll { existing -> cookies.any { it.name == existing.name } }
            list.addAll(cookies)
        }
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val list = store[url.host] ?: return emptyList()
        val snapshot = synchronized(list) { list.toList() }
        return snapshot.filter { it.matches(url) }
    }

    fun clear() = store.clear()
}
