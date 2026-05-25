package io.nisfeb.lattice.urbit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.time.Duration
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

/** A pushed change to a followed file (from the local %lattice agent's /updates). */
data class UpdateEvent(val ship: String, val path: String, val body: String)

/**
 * Subscribes to the local %lattice agent's /updates over an Eyre channel (SSE)
 * and emits [UpdateEvent]s as followed files change. Minimal: one subscription,
 * acks events so Eyre can release them.
 */
class UpdatesChannel(private val session: UrbitSession) {

    private val json = Json { ignoreUnknownKeys = true }
    private val media = "application/json".toMediaType()

    fun updates(): Flow<UpdateEvent> = channelFlow {
        val base = session.baseUrl ?: return@channelFlow
        val ship = (session.shipName ?: return@channelFlow).removePrefix("~")
        // A fresh channel id per (re)connect — Eyre treats a reused id as the
        // same channel, so reconnecting after a drop must mint a new one.
        val channelId = "lattice-updates-${System.currentTimeMillis()}-${Random.nextLong().toString(16).take(6)}"
        val nextId = AtomicLong(1)
        val channelUrl = base.newBuilder().addPathSegments("~/channel/$channelId").build()

        suspend fun putActions(build: () -> JsonObject) = withContext(Dispatchers.IO) {
            val req = Request.Builder().url(channelUrl)
                .put(buildJsonArray { add(build()) }.toString().toRequestBody(media)).build()
            runCatching { session.http.newCall(req).execute().use { } }
        }

        // SSE must stay open indefinitely; the session client's default read
        // timeout would kill it, so use a no-read-timeout variant for the stream.
        val sseClient = session.http.newBuilder().readTimeout(Duration.ZERO).build()

        val inbox = Channel<UpdateEvent>(Channel.UNLIMITED)
        val listener = object : EventSourceListener() {
            override fun onEvent(source: EventSource, id: String?, type: String?, data: String) {
                val obj = runCatching { json.parseToJsonElement(data).jsonObject }.getOrNull() ?: return
                if (obj["response"]?.jsonPrimitive?.contentOrNull == "diff") {
                    (obj["json"] as? JsonObject)?.let { u ->
                        val s = u["ship"]?.jsonPrimitive?.contentOrNull
                        if (s != null) inbox.trySend(
                            UpdateEvent(
                                ship = s,
                                path = u["path"]?.jsonPrimitive?.contentOrNull ?: "",
                                body = u["body"]?.jsonPrimitive?.contentOrNull ?: "",
                            ),
                        )
                    }
                }
                obj["id"]?.jsonPrimitive?.longOrNull?.let { evtId ->
                    launch { putActions { buildJsonObject { put("id", nextId.getAndIncrement()); put("action", "ack"); put("event-id", evtId) } } }
                }
            }
            override fun onFailure(source: EventSource, t: Throwable?, response: okhttp3.Response?) { inbox.close(t) }
            // A server-side close (Eyre evicting the channel) is not a clean
            // end-of-stream for us — close with an error so the collector's
            // retryWhen reconnects rather than silently stopping updates.
            override fun onClosed(source: EventSource) { inbox.close(java.io.IOException("SSE closed by server")) }
        }

        // The channel must exist before the SSE GET (a GET on a fresh id 404s),
        // so PUT the subscribe first; facts are buffered until the stream opens.
        putActions {
            buildJsonObject {
                put("id", nextId.getAndIncrement())
                put("action", "subscribe")
                put("ship", ship)
                put("app", "lattice")
                put("path", "/updates")
            }
        }
        val es = EventSources.createFactory(sseClient)
            .newEventSource(Request.Builder().url(channelUrl).header("Accept", "text/event-stream").build(), listener)

        val forwarder = launch { for (u in inbox) send(u); close() }
        awaitClose { es.cancel(); inbox.close(); forwarder.cancel() }
    }
}
