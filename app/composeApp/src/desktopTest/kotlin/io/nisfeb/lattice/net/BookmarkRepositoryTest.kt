package io.nisfeb.lattice.net

import io.nisfeb.lattice.bookmarks.Bookmark
import io.nisfeb.lattice.bookmarks.BookmarkRepository
import io.nisfeb.lattice.urbit.SettingsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals

class BookmarkRepositoryTest {
    private lateinit var server: MockWebServer
    private lateinit var store: FakeBookmarkStore
    private lateinit var repo: BookmarkRepository
    private val ser = ListSerializer(Bookmark.serializer())

    @BeforeTest fun setUp() {
        server = MockWebServer().also { it.start() }
        store = FakeBookmarkStore()
        repo = BookmarkRepository(store, SettingsClient(loggedInSession(server)))
    }
    @AfterTest fun tearDown() { server.shutdown() }

    private val list = listOf(
        Bookmark("urb://~ricsul-bilwyt/index", "Jackson's lattice"),
        Bookmark("urb://~zod/notes/x", "urb://~zod/notes/x"),
    )

    @Test fun pushCachesLocallyAndPokesSerializedList() = runTest {
        server.enqueue(MockResponse().setResponseCode(200))
        repo.push(list)

        assertEquals(list, store.list) // local cache updated
        val msg = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonArray[0].jsonObject
        val value = msg["json"]!!.jsonObject["put-entry"]!!.jsonObject["value"]!!.jsonPrimitive.content
        assertEquals(list, Json.decodeFromString(ser, value)) // value is the JSON-stringified list
    }

    @Test fun pullDecodesFromSettingsAndUpdatesCache() = runTest {
        val encoded = Json.encodeToString(ser, list)
        val body = buildJsonObject {
            put("desk", buildJsonObject { put("bookmarks", buildJsonObject { put("list", encoded) }) })
        }.toString()
        server.enqueue(MockResponse().setBody(body))

        assertEquals(list, repo.pull())
        assertEquals(list, store.list)
    }
}
