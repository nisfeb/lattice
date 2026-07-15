package io.nisfeb.lattice.net

import io.nisfeb.lattice.urbit.UpdatesChannel
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class UpdatesChannelTest {
    private lateinit var server: MockWebServer
    private lateinit var channel: UpdatesChannel

    @BeforeTest fun setUp() {
        server = MockWebServer().also { it.start() }
        channel = UpdatesChannel(loggedInSession(server))
    }
    @AfterTest fun tearDown() { server.shutdown() }

    @Test fun parsesPubKeepFramesSkippingSnapshotAndDelete() = runBlocking {
        // 1) /streams discovery
        server.enqueue(MockResponse().setBody("""{"streams":{"pub":"/grubbery/api/keep/apps/lattice.lattice_app/pub/vault?blot=/json"}}"""))
        // 2) the pub keep-SSE stream — old snapshot + add + upd + del
        val sse = buildString {
            append("id: 1\nevent: old /index/gmi\ndata: \"old snap\"\n\n")
            append("id: 2\nevent: add /guides/urbit/gmi\ndata: \"# New\\ncontent\"\n\n")
            append("id: 3\nevent: upd /notes/x/gmi\ndata: \"# Upd\"\n\n")
            append("id: 4\nevent: del /gone/gmi\ndata: \"# gone\"\n\n")
        }
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(sse))

        // Only the add + upd frames become events (old snapshot + del skipped).
        // The server closes the stream after the body → the flow ends with the
        // reconnect IOException (App retries on it); .catch lets us keep the
        // events delivered before it.
        val events = mutableListOf<io.nisfeb.lattice.urbit.UpdateEvent>()
        withTimeoutOrNull(10_000) {
            channel.updates().catch { }.collect { events.add(it) }
        }
        assertEquals(listOf("guides/urbit", "notes/x"), events.map { it.path })
        assertEquals("# New\ncontent", events[0].body)
        assertEquals("~zod", events[0].ship)

        // discovery hit /streams; the stream hit the keep endpoint.
        assertEquals("/apps/lattice/streams", server.takeRequest().path)
        val keep = server.takeRequest()
        assertEquals("text/event-stream", keep.getHeader("Accept"))
        assertEquals("/grubbery/api/keep/apps/lattice.lattice_app/pub/vault?blot=/json", keep.path)
    }

    @Test fun failedDiscoveryFailsTheFlowSoRetryCanReconnect() = runBlocking {
        // 1st attempt: /streams discovery 500s. The flow must FAIL — App's
        // retryWhen only re-arms on exceptions; a normal completion would kill
        // live updates for the rest of the ship session.
        server.enqueue(MockResponse().setResponseCode(500))
        // 2nd attempt (the retry): discovery + stream succeed.
        server.enqueue(MockResponse().setBody("""{"streams":{"pub":"/keep/pub?blot=/json"}}"""))
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream")
            .setBody("id: 1\nevent: add /notes/x/gmi\ndata: \"# A\"\n\n"))

        var retried = false
        val events = mutableListOf<io.nisfeb.lattice.urbit.UpdateEvent>()
        withTimeoutOrNull(10_000) {
            channel.updates()
                .retryWhen { _, attempt -> retried = true; attempt < 1 } // one retry, like App
                .catch { }
                .collect { events.add(it) }
        }
        assertTrue(retried, "discovery failure did not surface as a flow exception")
        assertEquals(listOf("notes/x"), events.map { it.path })
        assertEquals("/apps/lattice/streams", server.takeRequest().path) // failed discovery
        assertEquals("/apps/lattice/streams", server.takeRequest().path) // retried discovery
        assertEquals("/keep/pub?blot=/json", server.takeRequest().path)
    }

    @Test fun reconnectReplaysSnapshotEntriesThatChangedWhileDisconnected() = runBlocking {
        // 1st connection: `old /a` snapshot (recorded, skipped) + live add of
        // /b, then the server drops the stream.
        server.enqueue(MockResponse().setBody("""{"streams":{"pub":"/keep/pub?blot=/json"}}"""))
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(buildString {
            append("id: 1\nevent: old /a/gmi\ndata: \"a v1\"\n\n")
            append("id: 2\nevent: add /b/gmi\ndata: \"b v1\"\n\n")
        }))
        // 2nd connection (the reconnect): the keep replays everything as `old`.
        // /a was edited while disconnected and /c is new — both must be
        // emitted; /b is unchanged — skipped.
        server.enqueue(MockResponse().setBody("""{"streams":{"pub":"/keep/pub?blot=/json"}}"""))
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(buildString {
            append("id: 3\nevent: old /a/gmi\ndata: \"a v2\"\n\n")
            append("id: 4\nevent: old /b/gmi\ndata: \"b v1\"\n\n")
            append("id: 5\nevent: old /c/gmi\ndata: \"c v1\"\n\n")
        }))

        val events = mutableListOf<io.nisfeb.lattice.urbit.UpdateEvent>()
        withTimeoutOrNull(10_000) {
            channel.updates()
                .retryWhen { _, attempt -> attempt < 1 } // reconnect once, like App
                .catch { }
                .collect { events.add(it) }
        }
        assertEquals(
            listOf("b" to "b v1", "a" to "a v2", "c" to "c v1"),
            events.map { it.path to it.body },
        )
    }
}
