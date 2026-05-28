package io.nisfeb.lattice.net

import io.nisfeb.lattice.backup.BackupFile
import io.nisfeb.lattice.backup.BackupNote
import io.nisfeb.lattice.backup.ContentArchive
import io.nisfeb.lattice.backup.ContentBundle
import io.nisfeb.lattice.knowledge.KnowledgeClient
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
    private lateinit var knowledge: KnowledgeClient

    @BeforeTest fun setUp() {
        server = MockWebServer().also { it.start() }
        val s = loggedInSession(server)
        client = LatticeClient(s)
        knowledge = KnowledgeClient(s)
    }
    @AfterTest fun tearDown() { server.shutdown() }

    @Test fun exportGathersPagesThenKnowledgeIntoOneBundle() = runTest {
        server.enqueue(MockResponse().setBody("""{"files":["index","notes/2026/ok"]}"""))
        server.enqueue(MockResponse().setBody("""{"mark":"gmi","body":"# home"}"""))
        server.enqueue(MockResponse().setBody("""{"mark":"gmi","body":"a note"}"""))
        server.enqueue(MockResponse().setBody("""{"items":[{"key":"/proj/x","body":"kb","updated":"~2026.1.1","tags":["urbit","design"]}]}"""))

        val out = ContentArchive.export(client, knowledge, "~zod").getOrThrow()
        val bundle = Json.decodeFromString<ContentBundle>(out)

        assertEquals("~zod", bundle.ship)
        assertEquals(listOf("index", "notes/2026/ok"), bundle.files.map { it.path })
        assertEquals("a note", bundle.files.first { it.path == "notes/2026/ok" }.body)
        // knowledge is in the same bundle
        assertEquals(listOf("/proj/x"), bundle.notes.map { it.key })
        assertEquals("kb", bundle.notes[0].body)
        assertEquals(listOf("urbit", "design"), bundle.notes[0].tags)
        // request order: list, a fetch per page, then know-all
        assertTrue(server.takeRequest().path!!.contains("/apps/lattice/list"))
        assertTrue(server.takeRequest().path!!.contains("fetch"))
        server.takeRequest()
        assertTrue(server.takeRequest().path!!.contains("/apps/lattice/know-all"))
    }

    @Test fun importRestoresPagesAndNotesWithTags() = runTest {
        val bundle = Json.encodeToString(
            ContentBundle.serializer(),
            ContentBundle(
                ship = "~zod",
                files = listOf(BackupFile("index", "# home"), BackupFile("notes/x", "hi")),
                notes = listOf(BackupNote("/proj/x", "kb", listOf("urbit", "design"))),
            ),
        )
        repeat(5) { server.enqueue(MockResponse().setResponseCode(200)) }  // 2 saves + know-save + 2 tags

        val n = ContentArchive.import(client, knowledge, bundle).getOrThrow()
        assertEquals(2, n.files)
        assertEquals(1, n.notes)

        val r1 = server.takeRequest()
        assertTrue(r1.path!!.contains("save"))
        assertEquals("# home", r1.body.readUtf8())
        server.takeRequest()  // save notes/x
        assertTrue(server.takeRequest().path!!.contains("know-save"))
        assertTrue(server.takeRequest().path!!.contains("know-tag"))
    }

    @Test fun importsLegacyPagesOnlyBundle() = runTest {
        // a v1 bundle has no `notes` field — it must still import (0 notes).
        val v1 = """{"version":1,"ship":"~zod","files":[{"path":"index","body":"hi"}]}"""
        server.enqueue(MockResponse().setResponseCode(200))
        val n = ContentArchive.import(client, knowledge, v1).getOrThrow()
        assertEquals(1, n.files)
        assertEquals(0, n.notes)
    }

    @Test fun importRejectsNonBackupJson() = runTest {
        assertTrue(ContentArchive.import(client, knowledge, "not a backup").isFailure)
    }
}
