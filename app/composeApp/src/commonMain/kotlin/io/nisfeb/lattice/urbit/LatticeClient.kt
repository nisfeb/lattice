package io.nisfeb.lattice.urbit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
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

/** A page that links TO another page (a row of `catalog-backlinks`): the linking
 *  page's key + the authored link [label] and [position] in that page. [isInternal]
 *  marks an urb:// (namespace) target vs an external one. [url] reconstructs the
 *  linking page's canonical link so it can be opened / joined to a [CatalogPage]. */
data class Backlink(
    val source: String,
    val publisher: String,
    val path: String,
    val label: String,
    val isInternal: Boolean,
    val position: Int,
) {
    val url: String get() = "urb://$publisher$path"
}

/** One heading in a page's table of contents (a row of `catalog-toc`), in
 *  document order. [depth] 1 = top-level (#), 2 = ## … ; [text] is the heading. */
data class Heading(val position: Int, val depth: Int, val text: String)

/** A page key (a row of `catalog-by-tag`): (source, publisher, path). [url] is the
 *  canonical urb:// link; join to a [CatalogPage] for its title. */
data class PageRef(val source: String, val publisher: String, val path: String) {
    val url: String get() = "urb://$publisher$path"
}

/** One entry in a cross-ship directory listing (a child of /browse). [type] is
 *  "dir" or "file"; [mark] is the file's grub mark (blank for dirs). */
data class BrowseChild(val name: String, val type: String, val mark: String = "") {
    val isDir: Boolean get() = type == "dir"
}

/** A shallow (one-level) listing of a remote ship's directory tree (/browse).
 *  [truncated] = the directory had more children than the server's fan cap. */
data class BrowseListing(
    val ship: String,
    val path: String,
    val truncated: Boolean,
    val children: List<BrowseChild>,
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
                    val obj = agentJson(json, resp.body?.string().orEmpty(), resp.code)
                    val doc = json.decodeFromJsonElement<GmiDoc>(obj)
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
     * A published page's revision history (every prior save is a firm grub
     * revision), oldest-first as pub-history returns. [path] is the same relative
     * path used by [save] / [fetch]. Empty history is a failed Result (404).
     */
    suspend fun history(path: String): Result<List<Revision>> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder()
                .addPathSegments("apps/lattice/pub-history").addQueryParameter("path", path).build()
            session.http.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                val o = agentJson(json, resp.body?.string().orEmpty(), resp.code)
                o["error"]?.let { error(it.jsonPrimitive.content) }
                if (!resp.isSuccessful) error("pub-history HTTP ${resp.code}")
                o["revisions"]?.jsonArray?.map { el ->
                    val r = el.jsonObject
                    Revision(
                        rev = r["rev"]?.jsonPrimitive?.intOrNull ?: 0,
                        updated = r["updated"]?.jsonPrimitive?.contentOrNull ?: "",
                    )
                } ?: emptyList()
            }
        }
    }

    /** A page's body AS OF [rev]; [rev] must be one returned by [history]. */
    suspend fun readAt(path: String, rev: Int): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder()
                .addPathSegments("apps/lattice/pub-read-at")
                .addQueryParameter("path", path).addQueryParameter("rev", rev.toString()).build()
            session.http.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                val o = agentJson(json, resp.body?.string().orEmpty(), resp.code)
                o["error"]?.let { error(it.jsonPrimitive.content) }
                if (!resp.isSuccessful) error("pub-read-at HTTP ${resp.code}")
                o["body"]?.jsonPrimitive?.contentOrNull ?: ""
            }
        }
    }

    /**
     * Restore [rev] by re-saving its body as a fresh revision (non-destructive —
     * the current body stays in history). [rev] must be one returned by [history].
     */
    suspend fun restoreRev(path: String, rev: Int): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder()
                .addPathSegments("apps/lattice/pub-restore-rev")
                .addQueryParameter("path", path).addQueryParameter("rev", rev.toString()).build()
            val req = Request.Builder().url(url).post(ByteArray(0).toRequestBody(mediaType)).build()
            session.http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) error("pub-restore-rev HTTP ${resp.code}")
            }
        }
    }

    /**
     * Prune a page's history to the newest [keep] revisions (default 10, floor 1).
     * DESTRUCTIVE + irreversible; the live revision is never dropped. Returns how
     * many were dropped vs kept.
     */
    suspend fun prune(path: String, keep: Int = 10): Result<PruneResult> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder()
                .addPathSegments("apps/lattice/pub-prune")
                .addQueryParameter("path", path).addQueryParameter("keep", keep.toString()).build()
            val req = Request.Builder().url(url).post(ByteArray(0).toRequestBody(mediaType)).build()
            session.http.newCall(req).execute().use { resp ->
                val o = agentJson(json, resp.body?.string().orEmpty(), resp.code)
                if (!resp.isSuccessful) error("pub-prune HTTP ${resp.code}")
                PruneResult(
                    dropped = o["dropped"]?.jsonPrimitive?.intOrNull ?: 0,
                    kept = o["kept"]?.jsonPrimitive?.intOrNull ?: 0,
                )
            }
        }
    }

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
     * Backlinks for [url] — the pages that link TO it, in document order. [url] is
     * matched VERBATIM against the authored link string (what the author wrote after
     * `=> `, e.g. urb://~pub/x or /x), so pass the page's canonical urb:// url. Each
     * result carries the linking page's key + the link text and whether it's a
     * namespace (urb://) link. A failed Result carries the agent's error.
     */
    suspend fun catalogBacklinks(url: String): Result<List<Backlink>> = withContext(Dispatchers.IO) {
        runCatching {
            val u = base().newBuilder()
                .addPathSegments("apps/lattice/catalog-backlinks").addQueryParameter("url", url).build()
            val (cols, rs) = catalogRows(obeliskResult(u))
            val si = cols.indexOf("source"); val pi = cols.indexOf("publisher"); val pa = cols.indexOf("path")
            val li = cols.indexOf("label"); val ii = cols.indexOf("is-internal"); val poi = cols.indexOf("position")
            rs.mapNotNull { c ->
                val pub = c.getOrNull(pi) ?: return@mapNotNull null
                val path = c.getOrNull(pa) ?: return@mapNotNull null
                Backlink(
                    source = c.getOrNull(si).orEmpty(), publisher = pub, path = path,
                    label = c.getOrNull(li).orEmpty(),
                    isInternal = c.getOrNull(ii) == "1",
                    position = c.getOrNull(poi)?.toIntOrNull() ?: 0,
                )
            }.sortedBy { it.position }
        }
    }

    /**
     * A page's table of contents — its headings in document order. [url] is the
     * page's canonical urb:// url. Only OUR crawled pages have a TOC (the analyzer
     * derives it), so a remote page returns empty. A failed Result carries the error.
     */
    suspend fun catalogToc(url: String): Result<List<Heading>> = withContext(Dispatchers.IO) {
        runCatching {
            val u = base().newBuilder()
                .addPathSegments("apps/lattice/catalog-toc").addQueryParameter("url", url).build()
            val (cols, rs) = catalogRows(obeliskResult(u))
            val poi = cols.indexOf("position"); val di = cols.indexOf("depth"); val ti = cols.indexOf("text")
            rs.map { c ->
                Heading(
                    position = c.getOrNull(poi)?.toIntOrNull() ?: 0,
                    depth = c.getOrNull(di)?.toIntOrNull() ?: 1,
                    text = c.getOrNull(ti).orEmpty(),
                )
            }
        }
    }

    /** Every catalog page carrying [tag] (case-folded server-side), as keys the
     *  caller joins to full [CatalogPage] rows. A failed Result carries the error. */
    suspend fun catalogByTag(tag: String): Result<List<PageRef>> = withContext(Dispatchers.IO) {
        runCatching {
            val u = base().newBuilder()
                .addPathSegments("apps/lattice/catalog-by-tag").addQueryParameter("tag", tag).build()
            val (cols, rs) = catalogRows(obeliskResult(u))
            val si = cols.indexOf("source"); val pi = cols.indexOf("publisher"); val pa = cols.indexOf("path")
            rs.mapNotNull { c ->
                val pub = c.getOrNull(pi) ?: return@mapNotNull null
                val path = c.getOrNull(pa) ?: return@mapNotNull null
                PageRef(c.getOrNull(si).orEmpty(), pub, path)
            }
        }
    }

    /** OUR unclassified pages (category = ''), newest-first — the classifier
     *  worklist. Rows are partial (no category), parsed as [CatalogPage]. */
    suspend fun catalogPending(): Result<List<CatalogPage>> = withContext(Dispatchers.IO) {
        runCatching {
            val u = base().newBuilder().addPathSegments("apps/lattice/catalog-pending").build()
            val (cols, rs) = catalogRows(obeliskResult(u))
            rs.map { CatalogPage.fromRow(cols, it) }
        }
    }

    /** The live category vocabulary — every category in use, deduped, '' dropped.
     *  Author-declared categories are excluded server-side (taxonomy hardening). */
    suspend fun catalogVocab(): Result<List<String>> = withContext(Dispatchers.IO) {
        runCatching {
            val u = base().newBuilder().addPathSegments("apps/lattice/catalog-vocab").build()
            val (cols, rs) = catalogRows(obeliskResult(u))
            val ci = cols.indexOf("category")
            rs.mapNotNull { it.getOrNull(ci)?.ifBlank { null } }.distinct().sorted()
        }
    }

    /**
     * Classify one of OUR pages: set its [category] on the catalog row. [url] is the
     * page's catalog url (urb://<pub>/<path>). [catSource] is the provenance
     * ('manual' by default); [confidence] 0.0–1.0 (defaulted server-side). Idempotent
     * multi-column UPDATE — never touches page content.
     */
    suspend fun catalogClassify(
        url: String,
        category: String,
        catSource: String = "manual",
        confidence: Double? = null,
    ): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val b = base().newBuilder().addPathSegments("apps/lattice/catalog-classify")
                .addQueryParameter("url", url).addQueryParameter("category", category)
                .addQueryParameter("cat-source", catSource)
            confidence?.let { b.addQueryParameter("confidence", it.toString()) }
            val req = Request.Builder().url(b.build()).post(ByteArray(0).toRequestBody(mediaType)).build()
            session.http.newCall(req).execute().use { resp ->
                val o = agentJson(json, resp.body?.string().orEmpty(), resp.code)
                o["error"]?.let { error(it.jsonPrimitive.content) }
                if (!resp.isSuccessful) error("catalog-classify HTTP ${resp.code}")
            }
        }
    }

    /** Split an obelisk result object into (column names, string cells per row).
     *  Shared by the catalog reads; a missing/absent column resolves to "". */
    private fun catalogRows(o: JsonObject): Pair<List<String>, List<List<String>>> {
        val cols = o["columns"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
        val rows = (o["rows"]?.jsonArray ?: kotlinx.serialization.json.JsonArray(emptyList()))
            .map { r -> r.jsonArray.map { it.jsonPrimitive.content } }
        return cols to rows
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
                val obj = agentJson(json, resp.body?.string().orEmpty(), resp.code)
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

    /**
     * List [ship]'s directory at [path] (shallow, one level) — the federated tree
     * reader. [path] "/" is the ship's root (its app list). Owner-authenticated;
     * an unreachable or permission-denied peer is a failed Result (504). Uses the
     * extended-timeout client because a remote peek can hold until the ~s30 deadline.
     */
    suspend fun browse(ship: String, path: String = "/"): Result<BrowseListing> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder()
                .addPathSegments("apps/lattice/browse")
                .addQueryParameter("ship", ship).addQueryParameter("path", path).build()
            fetchClient.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                val o = agentJson(json, resp.body?.string().orEmpty(), resp.code)
                o["error"]?.let { error(it.jsonPrimitive.content) }
                if (!resp.isSuccessful) error("browse HTTP ${resp.code}")
                BrowseListing(
                    ship = o["ship"]?.jsonPrimitive?.contentOrNull ?: ship,
                    path = o["path"]?.jsonPrimitive?.contentOrNull ?: path,
                    truncated = o["truncated"]?.jsonPrimitive?.booleanOrNull ?: false,
                    children = o["children"]?.jsonArray?.map { el ->
                        val c = el.jsonObject
                        BrowseChild(
                            name = c["name"]?.jsonPrimitive?.contentOrNull ?: "",
                            type = c["type"]?.jsonPrimitive?.contentOrNull ?: "",
                            mark = c["mark"]?.jsonPrimitive?.contentOrNull ?: "",
                        )
                    }?.sortedWith(compareByDescending<BrowseChild> { it.isDir }.thenBy { it.name }) ?: emptyList(),
                )
            }
        }
    }

    /**
     * Read one file on [ship] at the full [path] (its last element is the leaf).
     * Text only — a non-cord/binary body is a 415 failed Result. Returns the same
     * {mark, body} envelope as [fetch].
     */
    suspend fun browseFile(ship: String, path: String): Result<GmiDoc> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder()
                .addPathSegments("apps/lattice/browse-file")
                .addQueryParameter("ship", ship).addQueryParameter("path", path).build()
            fetchClient.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                val obj = agentJson(json, resp.body?.string().orEmpty(), resp.code)
                val doc = json.decodeFromJsonElement<GmiDoc>(obj)
                if (doc.error != null) error(doc.error)
                if (!resp.isSuccessful) error("browse-file HTTP ${resp.code}")
                doc
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
