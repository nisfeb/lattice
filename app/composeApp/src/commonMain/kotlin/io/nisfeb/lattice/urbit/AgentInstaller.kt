package io.nisfeb.lattice.urbit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Onboarding: detect whether the %lattice Gall agent is installed on the user's
 * ship and, if not, install it from the publisher ([SOURCE_SHIP]) by poking
 * %hood with a `kiln-install` action over an Eyre channel — the same primitive
 * Landscape's app store uses. The publisher must be online and publishing the
 * desk (`:treaty|publish %lattice`).
 */
class AgentInstaller(private val session: UrbitSession) {

    private val media = "application/json".toMediaType()

    /**
     * Is the %lattice agent installed? Probes one of its Eyre routes: an unbound
     * path (agent absent) 404s, while a present agent answers (200, or 403 if it
     * declined — either way it's installed). Network failure → treat as unknown
     * (installed) so we don't nag on a flaky connection.
     */
    suspend fun isInstalled(): Boolean = withContext(Dispatchers.IO) {
        val base = session.baseUrl ?: return@withContext true
        val url = base.newBuilder().addPathSegments("apps/lattice/list").build()
        runCatching {
            session.http.newCall(Request.Builder().url(url).get().build()).execute()
                .use { resp -> resp.code != 404 }
        }.getOrDefault(true)
    }

    /** Poke %hood to install %lattice from [SOURCE_SHIP]. */
    suspend fun install(): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val base = session.baseUrl ?: error("not logged in")
            val our = (session.shipName ?: error("not logged in")).removePrefix("~")
            val channelId = "lattice-install-${System.currentTimeMillis()}"
            val url = base.newBuilder().addPathSegments("~/channel/$channelId").build()
            val body = installActions(our).toString().toRequestBody(media)
            session.http.newCall(Request.Builder().url(url).put(body).build()).execute()
                .use { resp -> if (!resp.isSuccessful) error("install poke HTTP ${resp.code}") }
        }
    }

    /** Poll until the agent's routes come up (the desk syncs over Ames), or time out. */
    suspend fun awaitInstalled(timeoutMs: Long = 180_000, intervalMs: Long = 3_000): Boolean =
        withTimeoutOrNull(timeoutMs) {
            while (!isInstalled()) delay(intervalMs)
            true
        } ?: false

    companion object {
        const val SOURCE_SHIP = "~ricsul-bilwyt"
        const val DESK = "lattice"

        /**
         * The Eyre channel action array that pokes %hood/`kiln-install`. JSON shape
         * matches base's `mar/kiln/install.hoon` grab: { local, ship (with ~), desk }.
         * [ourShip] is our @p without the leading `~` (the poke target).
         */
        fun installActions(ourShip: String): JsonArray = buildJsonArray {
            add(
                buildJsonObject {
                    put("id", 1)
                    put("action", "poke")
                    put("ship", ourShip)
                    put("app", "hood")
                    put("mark", "kiln-install")
                    put(
                        "json",
                        buildJsonObject {
                            put("local", DESK)
                            put("ship", SOURCE_SHIP)
                            put("desk", DESK)
                        },
                    )
                },
            )
        }
    }
}
