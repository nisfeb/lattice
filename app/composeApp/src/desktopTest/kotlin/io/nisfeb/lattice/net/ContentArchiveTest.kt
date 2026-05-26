package io.nisfeb.lattice.net

import io.nisfeb.lattice.backup.ContentArchive
import io.nisfeb.lattice.backup.ContentBundle
import io.nisfeb.lattice.urbit.LatticeClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ContentArchiveTest {
    private lateinit var server: MockWebServer
    private lateinit var client: LatticeClient

    @BeforeTest fun setUp() {
        server = MockWebServer().also { it.start() }
        client = LatticeClient(loggedInSession(server))
    }
    @AfterTest fun tearDown() { server.shutdown() }

    @Test fun exportListsThenFetchesEachIntoABundle() = runTest {
        server.enqueue(MockResponse().setBody("""{"files":["index","notes/2026/ok"]}"""))
        server.enqueue(MockResponse().setBody("""{"mark":"gmi","body":"# home"}"""))
        server.enqueue(MockResponse().setBody("""{"mark":"gmi","body":"a note"}"""))

        val out = ContentArchive.export(client, "~zod").getOrThrow()
        val bundle = Json.decodeFromString<ContentBundle>(out)

        assertEquals("~zod", bundle.ship)
        assertEquals(listOf("index", "notes/2026/ok"), bundle.files.map { it.path })
        assertEquals("a note", bundle.files.first { it.path == "notes/2026/ok" }.body)
        // first request is the list, then a fetch per file
        assertTrue(server.takeRequest().path!!.contains("/apps/lattice/list"))
        assertTrue(server.takeRequest().path!!.contains("fetch"))
    }

    @Test fun importSavesEveryFileAndCountsThem() = runTest {
        val bundle = Json.encodeToString(
            ContentBundle.serializer(),
            ContentBundle(ship = "~zod", files = listOf(
                io.nisfeb.lattice.backup.BackupFile("index", "# home"),
                io.nisfeb.lattice.backup.BackupFile("notes/x", "hi"),
            )),
        )
        server.enqueue(MockResponse().setResponseCode(200))
        server.enqueue(MockResponse().setResponseCode(200))

        assertEquals(2, ContentArchive.import(client, bundle).getOrThrow())
        val r1 = server.takeRequest()
        assertTrue(r1.path!!.contains("save"))
        assertEquals("# home", r1.body.readUtf8())
    }

    @Test fun importRejectsNonBackupJson() = runTest {
        val res = ContentArchive.import(client, "not a backup")
        assertTrue(res.isFailure)
    }
}
