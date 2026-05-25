package io.nisfeb.lattice.net

import io.nisfeb.lattice.theme.SavedTheme
import io.nisfeb.lattice.theme.ThemeRepository
import io.nisfeb.lattice.theme.ThemeSettings
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

class ThemeRepositoryTest {
    private lateinit var server: MockWebServer
    private lateinit var store: FakeThemeStore
    private lateinit var repo: ThemeRepository
    private val ser = ListSerializer(SavedTheme.serializer())

    @BeforeTest fun setUp() {
        server = MockWebServer().also { it.start() }
        store = FakeThemeStore()
        repo = ThemeRepository(store, SettingsClient(loggedInSession(server)))
    }
    @AfterTest fun tearDown() { server.shutdown() }

    private val list = listOf(
        SavedTheme("Midnight", ThemeSettings(background = "#001018", link = "#00E5A0")),
        SavedTheme("Day", ThemeSettings.Light),
    )

    @Test fun pushCachesLocallyAndPokesSerializedList() = runTest {
        server.enqueue(MockResponse().setResponseCode(200))
        repo.push(list)

        assertEquals(list, store.saved) // local cache updated
        val msg = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonArray[0].jsonObject
        val value = msg["json"]!!.jsonObject["put-entry"]!!.jsonObject["value"]!!.jsonPrimitive.content
        assertEquals(list, Json.decodeFromString(ser, value)) // value is the JSON-stringified list
    }

    @Test fun pullDecodesFromSettingsAndUpdatesCache() = runTest {
        val encoded = Json.encodeToString(ser, list)
        val body = buildJsonObject {
            put("desk", buildJsonObject { put("themes", buildJsonObject { put("saved", encoded) }) })
        }.toString()
        server.enqueue(MockResponse().setBody(body))

        assertEquals(list, repo.pull())
        assertEquals(list, store.saved)
    }
}
