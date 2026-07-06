package io.nisfeb.lattice.net

import io.nisfeb.lattice.urbit.UpdatesChannel
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals

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
}
