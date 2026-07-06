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

    @Test fun fetchExplainsBodylessResponseAsMissingAgent() = runTest {
        // Eyre answers a bare body-less 404 when nothing is bound at
        // /apps/lattice (agent not installed / not running). Surface that as a
        // readable error, not a kotlinx EOF parse failure.
        server.enqueue(MockResponse().setResponseCode(404))
        val r = client.fetch("urb://~zod/hello")
        assertTrue(r.isFailure)
        val msg = r.exceptionOrNull()?.message.orEmpty()
        assertTrue("%lattice" in msg && "404" in msg, msg)
    }

    @Test fun fetchExplainsHtmlBodyAsStaleSession() = runTest {
        // An expired urbauth cookie redirects to /~/login; following it lands on
        // an HTML page. That means "log in again", not a JSON parse error.
        server.enqueue(MockResponse().setBody("<!doctype html><html><body>login</body></html>"))
        val r = client.fetch("urb://~zod/hello")
        assertTrue(r.isFailure)
        val msg = r.exceptionOrNull()?.message.orEmpty()
        assertTrue("log in" in msg, msg)
    }

    @Test fun catalogListExplainsBodylessResponseAsMissingAgent() = runTest {
        server.enqueue(MockResponse().setResponseCode(404))
        val r = client.catalogList()
        assertTrue(r.isFailure)
        val msg = r.exceptionOrNull()?.message.orEmpty()
        assertTrue("%lattice" in msg && "404" in msg, msg)
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

    @Test fun historyParsesRevisions() = runTest {
        server.enqueue(MockResponse().setBody("""{"path":"/notes/x","revisions":[{"rev":1,"updated":"~2026.1.1"},{"rev":3,"updated":"~2026.1.3"}]}"""))
        val revs = client.history("notes/x").getOrThrow()
        assertEquals(listOf(1, 3), revs.map { it.rev })
        assertEquals("~2026.1.3", revs[1].updated)
        val req = server.takeRequest()
        assertTrue(req.path!!.startsWith("/apps/lattice/pub-history"))
        assertEquals("notes/x", req.requestUrl!!.queryParameter("path"))
    }

    @Test fun historySurfacesNoHistoryError() = runTest {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"no history"}"""))
        val r = client.history("notes/x")
        assertTrue(r.isFailure)
        assertEquals("no history", r.exceptionOrNull()?.message)
    }

    @Test fun readAtReturnsBodyForRev() = runTest {
        server.enqueue(MockResponse().setBody("""{"body":"# old","rev":2,"mark":"gmi"}"""))
        assertEquals("# old", client.readAt("notes/x", 2).getOrThrow())
        val req = server.takeRequest()
        assertTrue(req.path!!.startsWith("/apps/lattice/pub-read-at"))
        assertEquals("2", req.requestUrl!!.queryParameter("rev"))
    }

    @Test fun restoreRevPostsPathAndRev() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.restoreRev("notes/x", 2).getOrThrow()
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertTrue(req.path!!.startsWith("/apps/lattice/pub-restore-rev"))
        assertEquals("notes/x", req.requestUrl!!.queryParameter("path"))
        assertEquals("2", req.requestUrl!!.queryParameter("rev"))
    }

    @Test fun prunePostsKeepAndParsesCounts() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"dropped":4,"kept":10}"""))
        val r = client.prune("notes/x", 10).getOrThrow()
        assertEquals(4, r.dropped)
        assertEquals(10, r.kept)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertTrue(req.path!!.startsWith("/apps/lattice/pub-prune"))
        assertEquals("10", req.requestUrl!!.queryParameter("keep"))
    }

    @Test fun browseParsesListingAndSortsDirsFirst() = runTest {
        server.enqueue(MockResponse().setBody("""{"ship":"~zod","path":"/apps","truncated":false,"children":[{"name":"z","type":"file","mark":"gmi"},{"name":"a","type":"dir"}]}"""))
        val l = client.browse("~zod", "/apps").getOrThrow()
        assertEquals("~zod", l.ship)
        assertEquals(listOf("a", "z"), l.children.map { it.name })
        assertTrue(l.children[0].isDir)
        val req = server.takeRequest()
        assertTrue(req.path!!.startsWith("/apps/lattice/browse"))
        assertEquals("~zod", req.requestUrl!!.queryParameter("ship"))
        assertEquals("/apps", req.requestUrl!!.queryParameter("path"))
    }

    @Test fun browseSurfacesUnreachableError() = runTest {
        server.enqueue(MockResponse().setResponseCode(504).setBody("""{"error":"unreachable or denied"}"""))
        val r = client.browse("~dead")
        assertTrue(r.isFailure)
        assertEquals("unreachable or denied", r.exceptionOrNull()?.message)
    }

    @Test fun browseFileParsesBody() = runTest {
        server.enqueue(MockResponse().setBody("""{"body":"hello","mark":"txt"}"""))
        val d = client.browseFile("~zod", "/apps/foo/readme").getOrThrow()
        assertEquals("hello", d.body)
        assertEquals("txt", d.mark)
        val req = server.takeRequest()
        assertTrue(req.path!!.startsWith("/apps/lattice/browse-file"))
        assertEquals("/apps/foo/readme", req.requestUrl!!.queryParameter("path"))
    }

    @Test fun browseFileSurfacesNotTextError() = runTest {
        server.enqueue(MockResponse().setResponseCode(415).setBody("""{"error":"not text"}"""))
        val r = client.browseFile("~zod", "/apps/foo/blob")
        assertTrue(r.isFailure)
        assertEquals("not text", r.exceptionOrNull()?.message)
    }

    @Test fun backlinksParsesRowsSortedByPosition() = runTest {
        server.enqueue(MockResponse().setBody("""{"columns":["source","publisher","path","label","is-internal","position"],"rows":[["~zod","~bel","/pub/b/gmi","see b","1","5"],["~zod","~cet","/pub/a/gmi","see a","0","2"]]}"""))
        val bl = client.catalogBacklinks("urb://~zod/pub/x/gmi").getOrThrow()
        assertEquals(listOf(2, 5), bl.map { it.position })
        assertEquals("urb://~cet/pub/a/gmi", bl[0].url)
        assertTrue(bl[1].isInternal)
        assertTrue(!bl[0].isInternal)
        val req = server.takeRequest()
        assertTrue(req.path!!.startsWith("/apps/lattice/catalog-backlinks"))
        assertEquals("urb://~zod/pub/x/gmi", req.requestUrl!!.queryParameter("url"))
    }

    @Test fun tocParsesHeadingsInOrder() = runTest {
        server.enqueue(MockResponse().setBody("""{"columns":["position","depth","text"],"rows":[["0","1","Intro"],["3","2","Details"]]}"""))
        val toc = client.catalogToc("urb://~zod/pub/x/gmi").getOrThrow()
        assertEquals(listOf("Intro", "Details"), toc.map { it.text })
        assertEquals(listOf(1, 2), toc.map { it.depth })
    }

    @Test fun byTagParsesKeysAndUrls() = runTest {
        server.enqueue(MockResponse().setBody("""{"columns":["source","publisher","path"],"rows":[["~zod","~bel","/pub/a/gmi"]]}"""))
        val refs = client.catalogByTag("Urbit").getOrThrow()
        assertEquals("urb://~bel/pub/a/gmi", refs.single().url)
        assertEquals("Urbit", server.takeRequest().requestUrl!!.queryParameter("tag"))
    }

    @Test fun pendingParsesPartialRows() = runTest {
        server.enqueue(MockResponse().setBody("""{"columns":["source","publisher","path","url","title","word-count","fetched"],"rows":[["~zod","~zod","/pub/a/gmi","urb://~zod/pub/a/gmi","Draft","12","~2026.1.1"]]}"""))
        val p = client.catalogPending().getOrThrow()
        assertEquals("Draft", p.single().title)
        assertEquals("", p.single().category)  // unclassified by definition
        assertEquals("/apps/lattice/catalog-pending", server.takeRequest().path)
    }

    @Test fun vocabDedupesDropsBlankAndSorts() = runTest {
        server.enqueue(MockResponse().setBody("""{"columns":["category"],"rows":[["notes"],[""],["ideas"],["notes"]]}"""))
        assertEquals(listOf("ideas", "notes"), client.catalogVocab().getOrThrow())
    }

    @Test fun classifyPostsUrlCategoryAndSource() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.catalogClassify("urb://~zod/pub/a/gmi", "notes", confidence = 0.9).getOrThrow()
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertTrue(req.path!!.startsWith("/apps/lattice/catalog-classify"))
        assertEquals("urb://~zod/pub/a/gmi", req.requestUrl!!.queryParameter("url"))
        assertEquals("notes", req.requestUrl!!.queryParameter("category"))
        assertEquals("manual", req.requestUrl!!.queryParameter("cat-source"))
        assertEquals("0.9", req.requestUrl!!.queryParameter("confidence"))
    }

    @Test fun classifySurfacesError() = runTest {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"bad urb:// url"}"""))
        val r = client.catalogClassify("nope", "notes")
        assertTrue(r.isFailure)
        assertEquals("bad urb:// url", r.exceptionOrNull()?.message)
    }
}
