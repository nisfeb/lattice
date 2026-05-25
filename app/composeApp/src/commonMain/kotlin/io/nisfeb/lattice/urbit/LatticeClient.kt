package io.nisfeb.lattice.urbit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.time.Duration

/** A fetched gemtext document, or an error envelope, from /apps/lattice/fetch. */
@Serializable
data class GmiDoc(
    val mark: String = "",
    val body: String = "",
    val error: String? = null,
)

/**
 * Fetches gemtext via the active ship's %lattice agent. The session's
 * authenticated client carries the urbauth cookie, so a plain GET works.
 */
class LatticeClient(private val session: UrbitSession) {

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * GET {baseUrl}/apps/lattice/fetch?url=<urbUrl>. The agent returns
     * {"mark","body"} on success or {"error"} (with a 4xx) otherwise; we
     * surface the error as a failed Result.
     */
    suspend fun fetch(urbUrl: String): Result<GmiDoc> =
        withContext(Dispatchers.IO) {
            runCatching {
                val base = session.baseUrl ?: error("not logged in")
                val url = base.newBuilder()
                    .addPathSegments("apps/lattice/fetch")
                    .addQueryParameter("url", urbUrl)
                    .build()
                val request = Request.Builder().url(url).get().build()
                fetchClient.newCall(request).execute().use { resp ->
                    val text = resp.body?.string().orEmpty()
                    val doc = json.decodeFromString<GmiDoc>(text)
                    if (doc.error != null) error(doc.error)
                    doc
                }
            }
        }

    private val mediaType = "text/plain".toMediaType()

    /** List the /lib gmi files on our own ship (relative paths, no .gmi). */
    suspend fun list(): Result<List<String>> = withContext(Dispatchers.IO) {
        runCatching {
            val base = session.baseUrl ?: error("not logged in")
            val url = base.newBuilder().addPathSegments("apps/lattice/list").build()
            session.http.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                if (!resp.isSuccessful) error("list HTTP ${resp.code}")
                val root = json.parseToJsonElement(resp.body!!.string()).jsonObject
                root["files"]?.jsonArray?.map { it.jsonPrimitive.content }?.sorted() ?: emptyList()
            }
        }
    }

    /** Write (create/overwrite) a gmi file at the relative path on our ship. */
    suspend fun save(path: String, content: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val base = session.baseUrl ?: error("not logged in")
            val url = base.newBuilder()
                .addPathSegments("apps/lattice/save").addQueryParameter("path", path).build()
            val req = Request.Builder().url(url).post(content.toRequestBody(mediaType)).build()
            session.http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) error("save HTTP ${resp.code}")
            }
        }
    }

    /** Delete a gmi file at the relative path on our ship. */
    suspend fun delete(path: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val base = session.baseUrl ?: error("not logged in")
            val url = base.newBuilder()
                .addPathSegments("apps/lattice/delete").addQueryParameter("path", path).build()
            val req = Request.Builder().url(url).post(ByteArray(0).toRequestBody(mediaType)).build()
            session.http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) error("delete HTTP ${resp.code}")
            }
        }
    }

    private suspend fun post(action: String, query: String, value: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val base = session.baseUrl ?: error("not logged in")
            val url = base.newBuilder()
                .addPathSegments("apps/lattice/$action").addQueryParameter(query, value).build()
            val req = Request.Builder().url(url).post(ByteArray(0).toRequestBody(mediaType)).build()
            session.http.newCall(req).execute().use { resp -> if (!resp.isSuccessful) error("$action HTTP ${resp.code}") }
        }
    }

    /** Follow a remote file for change notifications (urb://~ship/path). */
    suspend fun subscribe(urbUrl: String): Result<Unit> = post("sub", "url", urbUrl)

    /** Stop following a remote file. */
    suspend fun unsubscribe(urbUrl: String): Result<Unit> = post("unsub", "url", urbUrl)

    /** Ship patps in our own %contacts rolodex (empty if none / not installed). */
    suspend fun contacts(): Result<List<String>> = withContext(Dispatchers.IO) {
        runCatching {
            val base = session.baseUrl ?: error("not logged in")
            val url = base.newBuilder().addPathSegments("apps/lattice/contacts").build()
            session.http.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                if (!resp.isSuccessful) error("contacts HTTP ${resp.code}")
                val root = json.parseToJsonElement(resp.body!!.string()).jsonObject
                root["ships"]?.jsonArray?.map { it.jsonPrimitive.content }?.sorted() ?: emptyList()
            }
        }
    }

    // The session client has no read timeout (SSE), so probes must be bounded:
    // a non-publishing ship's keen pends forever. callTimeout caps the whole call.
    private val probeClient by lazy { session.http.newBuilder().callTimeout(Duration.ofSeconds(8)).build() }

    // A no-&rev fetch is the desk's walk-to-latest: on a cold ames route it holds
    // the connection (sending nothing) until rev 1 resolves or the ~s30 deadline
    // fires. Wait a touch longer than that so a first-contact browse actually
    // lands instead of the client aborting first.
    private val fetchClient by lazy {
        session.http.newBuilder()
            .readTimeout(Duration.ofSeconds(35))
            .callTimeout(Duration.ofSeconds(40))
            .build()
    }

    /**
     * Does [ship] publish with lattice? Probes its discovery manifest — a
     * publication every lattice ship grows at a reserved spur. (An empty-path
     * probe can't work: no ship publishes the empty spur, so the remote scry
     * would pend forever.)
     */
    suspend fun publishes(ship: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val base = session.baseUrl ?: return@runCatching false
            val url = base.newBuilder()
                .addPathSegments("apps/lattice/fetch").addQueryParameter("url", "urb://$ship/manifest").build()
            probeClient.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                resp.isSuccessful && resp.body?.string()?.contains("\"mark\"") == true
            }
        }.getOrDefault(false)
    }
}
