package io.nisfeb.lattice.net

import io.nisfeb.lattice.urbit.LatticeClient
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class LatticeClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: LatticeClient

    @BeforeTest fun setUp() {
        server = MockWebServer().also { it.start() }
        client = LatticeClient(loggedInSession(server))
    }
    @AfterTest fun tearDown() { server.shutdown() }

    @Test fun fetchParsesGmiDoc() = runTest {
        server.enqueue(MockResponse().setBody("""{"mark":"gmi","body":"# Hi"}"""))
        val doc = client.fetch("urb://~zod/hello").getOrThrow()
        assertEquals("gmi", doc.mark)
        assertEquals("# Hi", doc.body)
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertTrue(req.path!!.startsWith("/apps/lattice/fetch"))
        assertEquals("urb://~zod/hello", req.requestUrl!!.queryParameter("url"))
    }

    @Test fun fetchSurfacesErrorField() = runTest {
        server.enqueue(MockResponse().setBody("""{"error":"not found"}"""))
        val r = client.fetch("urb://~zod/missing")
        assertTrue(r.isFailure)
        assertEquals("not found", r.exceptionOrNull()?.message)
    }

    @Test fun listParsesAndSorts() = runTest {
        server.enqueue(MockResponse().setBody("""{"files":["two","hello","notes/x"]}"""))
        assertEquals(listOf("hello", "notes/x", "two"), client.list().getOrThrow())
        assertEquals("/apps/lattice/list", server.takeRequest().path)
    }

    @Test fun savePostsBodyAndPath() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.save("notes/idea", "# Body\n").getOrThrow()
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertTrue(req.path!!.startsWith("/apps/lattice/save"))
        assertEquals("notes/idea", req.requestUrl!!.queryParameter("path"))
        assertEquals("# Body\n", req.body.readUtf8())
    }

    @Test fun saveFailsOnServerError() = runTest {
        server.enqueue(MockResponse().setResponseCode(500))
        assertTrue(client.save("x", "y").isFailure)
    }

    @Test fun contactsParsesShips() = runTest {
        server.enqueue(MockResponse().setBody("""{"ships":["~tyr","~bel"]}"""))
        assertEquals(listOf("~bel", "~tyr"), client.contacts().getOrThrow())
        assertEquals("/apps/lattice/contacts", server.takeRequest().path)
    }

    @Test fun deletePostsPath() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.delete("notes/idea").getOrThrow()
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertTrue(req.path!!.startsWith("/apps/lattice/delete"))
        assertEquals("notes/idea", req.requestUrl!!.queryParameter("path"))
    }
}
