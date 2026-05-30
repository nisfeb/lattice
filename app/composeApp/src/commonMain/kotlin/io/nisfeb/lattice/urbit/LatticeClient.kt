package io.nisfeb.lattice.urbit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl
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
 * One indexed page from the content catalog (a row of `catalog-list` /
 * `catalog-explore`). [url] is the canonical urb:// link to open the page.
 * Parsed positionally from the obelisk result's (columns, row) by name, so it
 * tolerates column reordering or a missing column (→ "").
 */
data class CatalogPage(
    val source: String,
    val publisher: String,
    val path: String,
    val url: String,
    val title: String,
    val category: String,
    val catSource: String,
    val wordCount: Int,
    val fetched: String,
) {
    /** Best human label: the page title, falling back to its path. */
    val label: String get() = title.ifBlank { path }

    companion object {
        fun fromRow(columns: List<String>, cells: List<String>): CatalogPage {
            fun col(name: String): String {
                val i = columns.indexOf(name)
                return if (i in cells.indices) cells[i] else ""
            }
            return CatalogPage(
                source = col("source"),
                publisher = col("publisher"),
                path = col("path"),
                url = col("url"),
                title = col("title"),
                category = col("category"),
                catSource = col("cat-source"),
                wordCount = col("word-count").toIntOrNull() ?: 0,
                fetched = col("fetched"),
            )
        }
    }
}

/**
 * One posting from the inverted index (a row of `catalog-search`): a page
 * (publisher, path) whose body contains a query term, with [tf] = the term's
 * in-page frequency. [url] reconstructs the canonical urb:// link so the
 * posting can be joined back to a [CatalogPage].
 */
data class CatalogPosting(val publisher: String, val path: String, val tf: Int) {
    val url: String get() = "urb://$publisher$path"
}

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

    /**
     * Every indexed page in the content catalog, newest-first. The agent has no
     * server-side text search (obelisk has no LIKE), so callers filter the
     * result client-side. One query loads the whole catalog; facets (category,
     * publisher) are derived from the rows. A failed Result carries the agent's
     * error text (e.g. obelisk absent).
     */
    suspend fun catalogList(): Result<List<CatalogPage>> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder().addPathSegments("apps/lattice/catalog-list").build()
            val o = obeliskResult(url)
            val cols = o["columns"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
            (o["rows"]?.jsonArray ?: kotlinx.serialization.json.JsonArray(emptyList())).map { rowEl ->
                CatalogPage.fromRow(cols, rowEl.jsonArray.map { it.jsonPrimitive.content })
            }
        }
    }

    /**
     * Trigger a one-shot crawl of every contact + follow (POST /catalog-sweep).
     * Fire-and-forget: the agent replies immediately and the crawl runs in the
     * background, so this returns as soon as the sweep is accepted (no held
     * connection — unlike the obelisk reads). A no-op server-side if a sweep is
     * already in progress.
     */
    suspend fun catalogSweep(): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder().addPathSegments("apps/lattice/catalog-sweep").build()
            val req = Request.Builder().url(url).post(ByteArray(0).toRequestBody(mediaType)).build()
            session.http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) error("catalog-sweep HTTP ${resp.code}")
            }
        }
    }

    /**
     * Keyword search over page BODIES via the inverted index: every page whose
     * body contains [term], with the term's in-page frequency. obelisk has no
     * IN/OR, so this queries ONE term; callers fan out a multi-word query and
     * combine (TF-IDF) client-side. [term] should be pre-normalized (lower-
     * cased, punctuation-trimmed) to match the stored postings.
     */
    suspend fun catalogSearch(term: String): Result<List<CatalogPosting>> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder()
                .addPathSegments("apps/lattice/catalog-search")
                .addQueryParameter("term", term).build()
            val o = obeliskResult(url)
            val cols = o["columns"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
            val pi = cols.indexOf("publisher")
            val pa = cols.indexOf("path")
            val ti = cols.indexOf("tf")
            (o["rows"]?.jsonArray ?: kotlinx.serialization.json.JsonArray(emptyList())).mapNotNull { rowEl ->
                val cells = rowEl.jsonArray.map { it.jsonPrimitive.content }
                val pub = cells.getOrNull(pi) ?: return@mapNotNull null
                val path = cells.getOrNull(pa) ?: return@mapNotNull null
                CatalogPosting(pub, path, cells.getOrNull(ti)?.toIntOrNull() ?: 0)
            }
        }
    }

    /**
     * Author-declared summaries (rows of catalog-meta): url -> summary, for the
     * search screen to join onto the catalog rows it already loaded. Best-effort
     * (a failed Result just means no snippets); only non-blank summaries kept.
     */
    suspend fun catalogMeta(): Result<Map<String, String>> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder().addPathSegments("apps/lattice/catalog-meta").build()
            val o = obeliskResult(url)
            val cols = o["columns"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
            val pi = cols.indexOf("publisher")
            val pa = cols.indexOf("path")
            val si = cols.indexOf("summary")
            val out = HashMap<String, String>()
            (o["rows"]?.jsonArray ?: kotlinx.serialization.json.JsonArray(emptyList())).forEach { rowEl ->
                val cells = rowEl.jsonArray.map { it.jsonPrimitive.content }
                val pub = cells.getOrNull(pi) ?: return@forEach
                val path = cells.getOrNull(pa) ?: return@forEach
                val summary = cells.getOrNull(si).orEmpty()
                if (summary.isNotBlank()) out["urb://$pub$path"] = summary
            }
            out
        }
    }

    /**
     * GET a catalog read endpoint and return the obelisk result object. The
     * catalog reads share ONE in-flight query slot on the agent and 429 when it
     * is busy (e.g. the Explore pane is mid-query); retry with a short backoff
     * rather than failing the search. Throws on the agent's `{error}` envelope
     * or a non-2xx (non-429) status.
     */
    private suspend fun obeliskResult(url: HttpUrl): JsonObject {
        var attempt = 0
        while (true) {
            // Use fetchClient (35s read / 40s call), NOT session.http: a catalog
            // read goes through the agent's async obelisk bridge, which HOLDS the
            // HTTP response open (sending nothing) until obelisk answers or its
            // ~s30 deadline fires. session.http's default 10s read timeout would
            // abort first — and a SocketTimeoutException is not a 429, so the
            // retry loop below wouldn't catch it; the load would spuriously fail
            // on a large/slow catalog. The extended timeouts outlast the agent.
            val o = fetchClient.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                if (resp.code == 429) return@use null
                val obj = json.parseToJsonElement(resp.body?.string().orEmpty()).jsonObject
                obj["error"]?.let { error(it.jsonPrimitive.content) }
                if (!resp.isSuccessful) error("catalog HTTP ${resp.code}")
                obj
            }
            if (o != null) return o
            if (++attempt >= 5) error("catalog query busy (429) — try again")
            delay(300L * attempt)
        }
    }

    private fun base() = session.baseUrl ?: error("not logged in")

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
