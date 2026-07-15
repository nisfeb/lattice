package io.nisfeb.lattice.urbit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Request
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap

/** A pushed change to one of our published pages (a live grubbery keep frame). */
data class UpdateEvent(val ship: String, val path: String, val body: String)

/**
 * Live updates for our own published pages, over grubbery's native keep-SSE.
 *
 * The retired gall agent pushed remote followed-page diffs on an Eyre channel at
 * /updates; the grubbery nexus replaced that with /streams — keep-SSE endpoints
 * for our subscribable directories (pub/know/follows). We subscribe to the `pub`
 * stream: each add/upd frame is one of our pages changing (edited here or on
 * another client), which keeps open tabs and the page cache live and drives the
 * Updates feed. Frames are standard SSE — okhttp parses them — where the event
 * field is "<old|add|upd|del> <name>" and data is the page body (a JSON string).
 * `del` frames are skipped; the `old` snapshot is skipped on the FIRST connect
 * only (the caller just fetched). On a reconnect, edits made while disconnected
 * exist only as `old` frames, so the snapshot entries whose body changed since
 * the last connection (or are new) ARE emitted — otherwise open tabs and the
 * page cache would keep the pre-disconnect body indefinitely.
 *
 * (Remote-subscription change pushes aren't exposed by /streams — those grubs are
 * named by an opaque hash with no ship/path — so subscribe/unsubscribe still keep
 * a fresh local mirror, but no longer push into this feed.)
 */
class UpdatesChannel(private val session: UrbitSession) {

    private val json = Json { ignoreUnknownKeys = true }

    // Body hashes by frame name, carried ACROSS connections of this channel: on
    // a reconnect they tell the replayed `old` snapshot apart — unchanged (skip)
    // vs edited-while-disconnected / new (emit). True once any connection has
    // opened, so the first snapshot (recorded, not emitted) isn't mistaken for
    // a replay. onEvent runs on OkHttp reader threads → concurrent map/volatile.
    private val seen = ConcurrentHashMap<String, Int>()
    @Volatile private var connectedOnce = false

    fun updates(): Flow<UpdateEvent> = channelFlow {
        val base = session.baseUrl ?: return@channelFlow
        val ship = session.shipName ?: return@channelFlow  // "~tyr" — the pub owner

        // Discover the pub keep endpoint from /streams (its path can change with
        // the nexus's grub layout, so we don't hardcode it). A failed discovery
        // must FAIL the flow, not complete it: the collector's retryWhen only
        // re-arms on exceptions, and a normal completion would kill live updates
        // for the rest of the session (e.g. ship rebooting, device offline).
        val streamsUrl = base.newBuilder().addPathSegments("apps/lattice/streams").build()
        val pubKeep = withContext(Dispatchers.IO) {
            session.http.newCall(Request.Builder().url(streamsUrl).get().build()).execute().use { resp ->
                if (!resp.isSuccessful) throw java.io.IOException("GET $streamsUrl → HTTP ${resp.code}")
                json.parseToJsonElement(resp.body!!.string()).jsonObject["streams"]
                    ?.jsonObject?.get("pub")?.jsonPrimitive?.contentOrNull
                    ?: throw java.io.IOException("no pub stream in $streamsUrl response")
            }
        }
        val keepUrl = base.resolve(pubKeep) ?: throw java.io.IOException("unresolvable pub keep url: $pubKeep")

        // SSE must stay open indefinitely; clear BOTH the read timeout and the
        // session client's per-call ceiling (which would otherwise cut the stream).
        val sseClient = session.http.newBuilder()
            .readTimeout(Duration.ZERO)
            .callTimeout(Duration.ZERO)
            .build()

        // Captured BEFORE this connection opens (onOpen flips the flag), so the
        // frames of the connection that first succeeds read it as false.
        val reconnect = connectedOnce
        val listener = object : EventSourceListener() {
            override fun onOpen(source: EventSource, response: okhttp3.Response) { connectedOnce = true }
            override fun onEvent(source: EventSource, id: String?, type: String?, data: String) {
                // type = "<op> <name>", e.g. "upd /guides/urbit/gmi".
                val t = type ?: return
                val sp = t.indexOf(' ')
                if (sp < 0) return
                val op = t.substring(0, sp)
                val name = t.substring(sp + 1)
                if (op == "del") { seen.remove(name); return }  // re-added later = changed
                if (op != "old" && op != "add" && op != "upd") return
                // data is the page body as a JSON string.
                val body = runCatching { json.parseToJsonElement(data).jsonPrimitive.content }.getOrNull() ?: return
                val changed = seen.put(name, body.hashCode()) != body.hashCode()
                // `old` frames are the connection snapshot: skip on first connect
                // (the caller just fetched), but on a reconnect they are the only
                // replay of edits made while disconnected — emit the changed ones.
                if (op == "old" && !(reconnect && changed)) return
                // name → browsable path: strip the leading / and the /gmi mark
                // suffix (matches what /list and /fetch use).
                val path = name.removePrefix("/").removeSuffix("/gmi")
                // Deliver synchronously on the reader thread: nothing is buffered,
                // so a disconnect right after a burst can't drop the last event.
                trySendBlocking(UpdateEvent(ship = ship, path = path, body = body))
            }
            override fun onFailure(source: EventSource, t: Throwable?, response: okhttp3.Response?) {
                close(t ?: java.io.IOException("SSE failed"))
            }
            // A server-side close (nexus reload / eviction) isn't a clean end for
            // us — close with an error so the collector's retryWhen reconnects.
            override fun onClosed(source: EventSource) { close(java.io.IOException("SSE closed by server")) }
        }

        val es = EventSources.createFactory(sseClient)
            .newEventSource(Request.Builder().url(keepUrl).header("Accept", "text/event-stream").build(), listener)

        awaitClose { es.cancel() }
    }
}
