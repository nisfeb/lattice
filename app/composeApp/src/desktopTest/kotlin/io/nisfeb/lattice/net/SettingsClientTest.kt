package io.nisfeb.lattice.net

import io.nisfeb.lattice.urbit.SettingsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SettingsClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: SettingsClient

    @BeforeTest fun setUp() {
        server = MockWebServer().also { it.start() }
        client = SettingsClient(loggedInSession(server))
    }
    @AfterTest fun tearDown() { server.shutdown() }

    @Test fun putEntryPokesSettingsEvent() = runTest {
        server.enqueue(MockResponse().setResponseCode(200))
        client.putEntry("lattice", "themes", "saved", """["x"]""").getOrThrow()

        val req = server.takeRequest()
        assertEquals("PUT", req.method)
        assertTrue(req.path!!.startsWith("/~/channel/"))
        val msg = Json.parseToJsonElement(req.body.readUtf8()).jsonArray[0].jsonObject
        assertEquals("poke", msg["action"]!!.jsonPrimitive.content)
        assertEquals("zod", msg["ship"]!!.jsonPrimitive.content)            // bare patp
        assertEquals("settings", msg["app"]!!.jsonPrimitive.content)
        assertEquals("settings-event", msg["mark"]!!.jsonPrimitive.content)
        val pe = msg["json"]!!.jsonObject["put-entry"]!!.jsonObject
        assertEquals("lattice", pe["desk"]!!.jsonPrimitive.content)
        assertEquals("themes", pe["bucket-key"]!!.jsonPrimitive.content)
        assertEquals("saved", pe["entry-key"]!!.jsonPrimitive.content)
        assertEquals("""["x"]""", pe["value"]!!.jsonPrimitive.content)      // value is a cord
    }

    @Test fun readEntryScriesDeskAndExtractsValue() = runTest {
        server.enqueue(MockResponse().setBody("""{"desk":{"themes":{"saved":"[\"x\"]"}}}"""))
        assertEquals("""["x"]""", client.readEntry("lattice", "themes", "saved"))
        assertEquals("/~/scry/settings/desk/lattice.json", server.takeRequest().path)
    }

    @Test fun readEntryNullWhenAbsent() = runTest {
        server.enqueue(MockResponse().setBody("""{"desk":{}}"""))
        assertNull(client.readEntry("lattice", "themes", "saved"))
    }
}
