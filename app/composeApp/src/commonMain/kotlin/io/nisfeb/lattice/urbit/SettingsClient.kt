package io.nisfeb.lattice.urbit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

/**
 * Minimal client for the ship's %settings agent — enough to sync values
 * across a user's installs. Write is a fire-and-forget channel poke; read is
 * a plain authenticated scry GET. (No SSE: we don't need live subscriptions.)
 *
 * Mirrors talon's SettingsSyncImpl: %settings val is a cord, so complex
 * values are stored JSON-stringified.
 */
class SettingsClient(private val session: UrbitSession) {

    private val json = Json { ignoreUnknownKeys = true }
    private val mediaType = "application/json".toMediaType()
    private val channelId = "lattice-${System.currentTimeMillis()}-${Random.nextLong().toString(16).take(6)}"
    private val nextId = AtomicLong(1)

    /** put-entry: store [value] (a JSON string) at desk/bucket/entry in %settings. */
    suspend fun putEntry(desk: String, bucket: String, entry: String, value: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val base = session.baseUrl ?: error("not logged in")
                val ship = (session.shipName ?: error("no ship")).removePrefix("~")
                val batch = buildJsonArray {
                    add(buildJsonObject {
                        put("id", nextId.getAndIncrement())
                        put("action", "poke")
                        put("ship", ship)
                        put("app", "settings")
                        put("mark", "settings-event")
                        put("json", buildJsonObject {
                            put("put-entry", buildJsonObject {
                                put("desk", desk)
                                put("bucket-key", bucket)
                                put("entry-key", entry)
                                put("value", JsonPrimitive(value))
                            })
                        })
                    })
                }
                val url = base.newBuilder().addPathSegments("~/channel/$channelId").build()
                val req = Request.Builder().url(url)
                    .put(batch.toString().toRequestBody(mediaType)).build()
                session.http.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) error("channel PUT HTTP ${resp.code}")
                }
            }
        }

    /** Read one entry's string value, or null if absent. */
    suspend fun readEntry(desk: String, bucket: String, entry: String): String? =
        withContext(Dispatchers.IO) {
            runCatching {
                val base = session.baseUrl ?: return@runCatching null
                val url = base.newBuilder().addPathSegments("~/scry/settings/desk/$desk.json").build()
                val req = Request.Builder().url(url).get().build()
                session.http.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return@use null
                    val root = json.parseToJsonElement(resp.body!!.string()).jsonObject
                    // {"desk": {bucket: {entry: value}}} (or the desk map directly)
                    val deskMap = (root["desk"] as? JsonObject) ?: root
                    val buc = deskMap[bucket] as? JsonObject ?: return@use null
                    buc[entry]?.jsonPrimitive?.contentOrNull
                }
            }.getOrNull()
        }
}
