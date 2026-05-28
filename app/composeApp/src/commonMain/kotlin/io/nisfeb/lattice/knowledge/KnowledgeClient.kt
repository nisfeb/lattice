package io.nisfeb.lattice.knowledge

import io.nisfeb.lattice.urbit.UrbitSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** A knowledge item's metadata (list view). */
@Serializable
data class KnowItem(
    val key: String,
    val updated: String = "",
    val bytes: Int = 0,
    val tags: List<String> = emptyList(),
)

/** A tag and how many live items carry it (facet data). */
@Serializable
data class TagCount(val tag: String, val count: Int)

/** A urQL query result from the obelisk index (Explore pane). */
data class QueryResult(
    val columns: List<String>,
    val rows: List<List<String>>,
    val count: Int = 0,
    val relation: String = "",
    val action: String = "",
)

/** A knowledge item with its body + tags. */
@Serializable
data class KnowEntry(
    val key: String,
    val body: String = "",
    val updated: String = "",
    val tags: List<String> = emptyList(),
)

/**
 * CRUD over the ship's private knowledge store, via the %lattice agent's
 * /apps/lattice/know-* HTTP endpoints (same authenticated session as the rest
 * of the app). The store is owner-only and never published; `publish` copies an
 * item into the ship's public gemtext.
 */
class KnowledgeClient(private val session: UrbitSession) {
    private val json = Json { ignoreUnknownKeys = true }
    private val mediaType = "text/plain".toMediaType()

    private fun base() = session.baseUrl ?: error("not logged in")

    /** Live items (keys + metadata, no bodies). */
    suspend fun list(): Result<List<KnowItem>> = listAt("know-list")

    /** Soft-deleted items, recoverable via [restore]. */
    suspend fun trash(): Result<List<KnowItem>> = listAt("know-trash")

    private suspend fun listAt(action: String): Result<List<KnowItem>> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder().addPathSegments("apps/lattice/$action").build()
            session.http.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                if (!resp.isSuccessful) error("$action HTTP ${resp.code}")
                parseItems(resp.body!!.string())
            }
        }
    }

    /** Parse the shared know-list JSON shape ({count, keys:[...]}) into items. */
    private fun parseItems(bodyStr: String): List<KnowItem> {
        val root = json.parseToJsonElement(bodyStr).jsonObject
        return root["keys"]?.jsonArray?.map {
            val o = it.jsonObject
            KnowItem(
                key = o["key"]!!.jsonPrimitive.content,
                updated = o["updated"]?.jsonPrimitive?.contentOrNull ?: "",
                bytes = o["bytes"]?.jsonPrimitive?.intOrNull ?: 0,
                tags = o["tags"]?.jsonArray?.map { t -> t.jsonPrimitive.content } ?: emptyList(),
            )
        }?.sortedBy { it.key } ?: emptyList()
    }

    /**
     * Filter the live store by [tags] (AND when [matchAll], else OR) and/or a
     * case-insensitive [query] substring of the key or body. Served from the
     * agent's state — works whether or not the %obelisk index is installed.
     */
    suspend fun explore(
        tags: List<String> = emptyList(),
        matchAll: Boolean = false,
        query: String = "",
    ): Result<List<KnowItem>> = withContext(Dispatchers.IO) {
        runCatching {
            var b = base().newBuilder().addPathSegments("apps/lattice/know-explore")
            if (tags.isNotEmpty()) b = b.addQueryParameter("tags", tags.joinToString(","))
            if (matchAll) b = b.addQueryParameter("match", "all")
            if (query.isNotBlank()) b = b.addQueryParameter("q", query)
            session.http.newCall(Request.Builder().url(b.build()).get().build()).execute().use { resp ->
                if (!resp.isSuccessful) error("know-explore HTTP ${resp.code}")
                parseItems(resp.body!!.string())
            }
        }
    }

    /** The tag vocabulary with per-tag item counts (facets), count-desc order. */
    suspend fun tags(): Result<List<TagCount>> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder().addPathSegments("apps/lattice/know-tags").build()
            session.http.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                if (!resp.isSuccessful) error("know-tags HTTP ${resp.code}")
                val root = json.parseToJsonElement(resp.body!!.string()).jsonObject
                root["tags"]?.jsonArray?.map {
                    val o = it.jsonObject
                    TagCount(
                        tag = o["tag"]!!.jsonPrimitive.content,
                        count = o["count"]?.jsonPrimitive?.intOrNull ?: 0,
                    )
                } ?: emptyList()
            }
        }
    }

    /**
     * Run one urQL query against the obelisk index (Explore pane). Returns the
     * column/row table, or a failed Result carrying obelisk's error text when the
     * query is rejected (ok:false), obelisk is absent (503), or it times out (504).
     */
    suspend fun query(urql: String): Result<QueryResult> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder().addPathSegments("apps/lattice/know-query").build()
            val req = Request.Builder().url(url).post(urql.toRequestBody(mediaType)).build()
            session.http.newCall(req).execute().use { resp ->
                val o = json.parseToJsonElement(resp.body?.string().orEmpty()).jsonObject
                o["error"]?.let { error(it.jsonPrimitive.content) }
                if (!resp.isSuccessful) error("know-query HTTP ${resp.code}")
                QueryResult(
                    columns = o["columns"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
                    rows = o["rows"]?.jsonArray?.map { row ->
                        row.jsonArray.map { it.jsonPrimitive.content }
                    } ?: emptyList(),
                    count = o["count"]?.jsonPrimitive?.intOrNull ?: 0,
                    relation = o["relation"]?.jsonPrimitive?.contentOrNull ?: "",
                    action = o["action"]?.jsonPrimitive?.contentOrNull ?: "",
                )
            }
        }
    }

    /** Rebuild the obelisk index from the live store (Explore pane's Reindex). */
    suspend fun reindex(): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder().addPathSegments("apps/lattice/know-reindex").build()
            val req = Request.Builder().url(url).post("".toRequestBody(mediaType)).build()
            session.http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) error("know-reindex HTTP ${resp.code}")
            }
        }
    }

    /** One item's full body, or a failed Result if absent. */
    suspend fun read(key: String): Result<KnowEntry> = withContext(Dispatchers.IO) {
        runCatching {
            val url = base().newBuilder()
                .addPathSegments("apps/lattice/know-read").addQueryParameter("key", key).build()
            session.http.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                val o = json.parseToJsonElement(resp.body?.string().orEmpty()).jsonObject
                o["error"]?.let { error(it.jsonPrimitive.content) }
                KnowEntry(
                    key = o["key"]!!.jsonPrimitive.content,
                    body = o["body"]?.jsonPrimitive?.contentOrNull ?: "",
                    updated = o["updated"]?.jsonPrimitive?.contentOrNull ?: "",
                    tags = o["tags"]?.jsonArray?.map { t -> t.jsonPrimitive.content } ?: emptyList(),
                )
            }
        }
    }

    /** Create or overwrite an item. */
    suspend fun save(key: String, body: String): Result<Unit> = post("know-save", key, body)

    /** Soft-delete (moves to trash; recoverable). */
    suspend fun delete(key: String): Result<Unit> = post("know-delete", key, null)

    /** Restore a soft-deleted item. */
    suspend fun restore(key: String): Result<Unit> = post("know-restore", key, null)

    /** Add a cross-cutting tag (normalized lower-case by the agent). */
    suspend fun tag(key: String, tag: String): Result<Unit> = tagPost("know-tag", key, tag)

    /** Remove a tag. */
    suspend fun untag(key: String, tag: String): Result<Unit> = tagPost("know-untag", key, tag)

    private suspend fun tagPost(action: String, key: String, tag: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val url = base().newBuilder()
                    .addPathSegments("apps/lattice/$action")
                    .addQueryParameter("key", key).addQueryParameter("tag", tag).build()
                val req = Request.Builder().url(url).post("".toRequestBody(mediaType)).build()
                session.http.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) error("$action HTTP ${resp.code}")
                }
            }
        }

    /** Publish an item as a public gemtext page (defaults the page path to [key]). */
    suspend fun publish(key: String, path: String? = null): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            var b = base().newBuilder()
                .addPathSegments("apps/lattice/know-publish").addQueryParameter("key", key)
            if (path != null) b = b.addQueryParameter("path", path)
            val req = Request.Builder().url(b.build()).post("".toRequestBody(mediaType)).build()
            session.http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) error("publish HTTP ${resp.code}")
            }
        }
    }

    private suspend fun post(action: String, key: String, body: String?): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val url = base().newBuilder()
                    .addPathSegments("apps/lattice/$action").addQueryParameter("key", key).build()
                val req = Request.Builder().url(url).post((body ?: "").toRequestBody(mediaType)).build()
                session.http.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) error("$action HTTP ${resp.code}")
                }
            }
        }
}
