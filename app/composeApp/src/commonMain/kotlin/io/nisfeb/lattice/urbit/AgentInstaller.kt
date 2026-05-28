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
 * Onboarding installer for a Gall desk on the user's ship. Installs [desk] from
 * its publisher [sourceShip] by poking %hood with `kiln-install` over an Eyre
 * channel — the same primitive Landscape's app store uses. The publisher must be
 * online and publishing the desk.
 *
 * Two are wired at startup: %lattice (required, from `~ricsul-bilwyt`) and
 * %obelisk (optional — the Explore tab's relational index, from
 * `~dister-nomryg-nilref`). They differ only in [desk]/[sourceShip] and how
 * presence is detected ([probe]) — obelisk has no Eyre routes of its own, so its
 * probe goes through lattice's query bridge.
 */
class AgentInstaller(
    private val session: UrbitSession,
    val desk: String,
    val sourceShip: String,
    private val probe: suspend () -> Boolean,
) {
    private val media = "application/json".toMediaType()

    /** Is [desk] installed? Network failure → treat as unknown (true) so we don't
     *  nag on a flaky connection. */
    suspend fun isInstalled(): Boolean = withContext(Dispatchers.IO) {
        runCatching { probe() }.getOrDefault(true)
    }

    /** Poke %hood to install [desk] from [sourceShip]. */
    suspend fun install(): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val base = session.baseUrl ?: error("not logged in")
            val our = (session.shipName ?: error("not logged in")).removePrefix("~")
            val channelId = "$desk-install-${System.currentTimeMillis()}"
            val url = base.newBuilder().addPathSegments("~/channel/$channelId").build()
            val body = installActions(our, desk, sourceShip).toString().toRequestBody(media)
            session.http.newCall(Request.Builder().url(url).put(body).build()).execute()
                .use { resp -> if (!resp.isSuccessful) error("install poke HTTP ${resp.code}") }
        }
    }

    /** Poll until the desk comes up (it syncs over Ames), or time out. */
    suspend fun awaitInstalled(timeoutMs: Long = 180_000, intervalMs: Long = 3_000): Boolean =
        withTimeoutOrNull(timeoutMs) {
            while (!isInstalled()) delay(intervalMs)
            true
        } ?: false

    companion object {
        const val LATTICE_DESK = "lattice"
        const val LATTICE_SOURCE = "~ricsul-bilwyt"
        const val OBELISK_DESK = "obelisk"
        const val OBELISK_SOURCE = "~dister-nomryg-nilref"

        /**
         * %lattice presence: probe one of its Eyre routes — an unbound path 404s
         * when the agent is absent; a present agent answers (200, or 403). Used as
         * the lattice installer's [probe].
         */
        fun latticeProbe(session: UrbitSession): suspend () -> Boolean = {
            val base = session.baseUrl
            if (base == null) {
                true
            } else {
                val url = base.newBuilder().addPathSegments("apps/lattice/list").build()
                session.http.newCall(Request.Builder().url(url).get().build()).execute()
                    .use { resp -> resp.code != 404 }
            }
        }

        /**
         * The Eyre channel action that pokes %hood/`kiln-install`. JSON shape
         * matches base's `mar/kiln/install.hoon`: { local, ship (with ~), desk }.
         * [ourShip] is our @p without the leading `~` (the poke target).
         */
        fun installActions(ourShip: String, desk: String, sourceShip: String): JsonArray = buildJsonArray {
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
                            put("local", desk)
                            put("ship", sourceShip)
                            put("desk", desk)
                        },
                    )
                },
            )
        }
    }
}
