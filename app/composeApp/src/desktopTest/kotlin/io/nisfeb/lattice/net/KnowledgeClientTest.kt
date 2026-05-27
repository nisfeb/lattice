package io.nisfeb.lattice.net

import io.nisfeb.lattice.knowledge.KnowledgeClient
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class KnowledgeClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: KnowledgeClient

    @BeforeTest fun setUp() {
        server = MockWebServer().also { it.start() }
        client = KnowledgeClient(loggedInSession(server))
    }
    @AfterTest fun tearDown() { server.shutdown() }

    @Test fun listParsesAndSorts() = runTest {
        server.enqueue(MockResponse().setBody("""{"count":2,"keys":[{"key":"/b","updated":"~2026.1.2","bytes":5},{"key":"/a","updated":"~2026.1.1","bytes":3}]}"""))
        val items = client.list().getOrThrow()
        assertEquals(listOf("/a", "/b"), items.map { it.key })
        assertEquals(3, items[0].bytes)
        assertEquals("/apps/lattice/know-list", server.takeRequest().path)
    }

    @Test fun trashHitsTrashEndpoint() = runTest {
        server.enqueue(MockResponse().setBody("""{"count":0,"keys":[]}"""))
        assertTrue(client.trash().getOrThrow().isEmpty())
        assertEquals("/apps/lattice/know-trash", server.takeRequest().path)
    }

    @Test fun readParsesBody() = runTest {
        server.enqueue(MockResponse().setBody("""{"key":"/a","body":"hello","updated":"~2026.1.1"}"""))
        val e = client.read("/a").getOrThrow()
        assertEquals("hello", e.body)
        val req = server.takeRequest()
        assertTrue(req.path!!.startsWith("/apps/lattice/know-read"))
        assertEquals("/a", req.requestUrl!!.queryParameter("key"))
    }

    @Test fun readSurfacesErrorField() = runTest {
        server.enqueue(MockResponse().setBody("""{"error":"no such key"}"""))
        val r = client.read("/missing")
        assertTrue(r.isFailure)
        assertEquals("no such key", r.exceptionOrNull()?.message)
    }

    @Test fun readParsesTags() = runTest {
        server.enqueue(MockResponse().setBody("""{"key":"/a","body":"hi","updated":"~2026.1.1","tags":["urbit","design"]}"""))
        val e = client.read("/a").getOrThrow()
        assertEquals(listOf("urbit", "design"), e.tags)
    }

    @Test fun tagAndUntagPostKeyAndTag() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.tag("notes/x", "urbit").getOrThrow()
        val t = server.takeRequest()
        assertEquals("POST", t.method)
        assertTrue(t.path!!.startsWith("/apps/lattice/know-tag"))
        assertEquals("notes/x", t.requestUrl!!.queryParameter("key"))
        assertEquals("urbit", t.requestUrl!!.queryParameter("tag"))

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.untag("notes/x", "urbit").getOrThrow()
        val u = server.takeRequest()
        assertTrue(u.path!!.startsWith("/apps/lattice/know-untag"))
        assertEquals("urbit", u.requestUrl!!.queryParameter("tag"))
    }

    @Test fun savePostsKeyAndBody() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.save("notes/x", "body text").getOrThrow()
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertTrue(req.path!!.startsWith("/apps/lattice/know-save"))
        assertEquals("notes/x", req.requestUrl!!.queryParameter("key"))
        assertEquals("body text", req.body.readUtf8())
    }

    @Test fun deleteAndRestorePostKey() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.delete("notes/x").getOrThrow()
        assertTrue(server.takeRequest().path!!.startsWith("/apps/lattice/know-delete"))

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.restore("notes/x").getOrThrow()
        assertTrue(server.takeRequest().path!!.startsWith("/apps/lattice/know-restore"))
    }

    @Test fun publishPassesKeyAndPath() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.publish("notes/x", "pub/notes/x").getOrThrow()
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertTrue(req.path!!.startsWith("/apps/lattice/know-publish"))
        assertEquals("notes/x", req.requestUrl!!.queryParameter("key"))
        assertEquals("pub/notes/x", req.requestUrl!!.queryParameter("path"))
    }

    @Test fun publishOmitsPathWhenNull() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.publish("notes/x").getOrThrow()
        val req = server.takeRequest()
        assertEquals(null, req.requestUrl!!.queryParameter("path"))
    }

    @Test fun saveFailsOnServerError() = runTest {
        server.enqueue(MockResponse().setResponseCode(500))
        assertTrue(client.save("x", "y").isFailure)
    }
}
