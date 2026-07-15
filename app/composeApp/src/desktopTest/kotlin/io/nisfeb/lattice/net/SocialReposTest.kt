package io.nisfeb.lattice.net

import io.nisfeb.lattice.social.FollowRepository
import io.nisfeb.lattice.social.SubscriptionRepository
import io.nisfeb.lattice.urbit.LatticeClient
import io.nisfeb.lattice.urbit.SettingsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
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
import kotlin.test.assertTrue

/**
 * SubscriptionRepository is a %settings-synced string list, identical in shape
 * to themes (see ThemeRepositoryTest) — push pokes the JSON-stringified list to
 * a bucket/entry, pull reads it back. FollowRepository treats the SHIP's follow
 * set (GET /follows, POST /follow + /unfollow — the crawler's targets) as the
 * source of truth, with %settings kept as an offline / cross-install cache.
 */
class SocialReposTest {
    private lateinit var server: MockWebServer
    private val ser = ListSerializer(String.serializer())

    @BeforeTest fun setUp() { server = MockWebServer().also { it.start() } }
    @AfterTest fun tearDown() { server.shutdown() }

    private fun client() = SettingsClient(loggedInSession(server))

    private fun followRepo(): FollowRepository {
        val session = loggedInSession(server)
        return FollowRepository(LatticeClient(session), SettingsClient(session))
    }

    private fun putEntryOf(reqBody: String) =
        Json.parseToJsonElement(reqBody).jsonArray[0].jsonObject["json"]!!
            .jsonObject["put-entry"]!!.jsonObject

    private fun settingsBody(bucket: String, entry: String, encoded: String) =
        buildJsonObject {
            put("desk", buildJsonObject { put(bucket, buildJsonObject { put(entry, encoded) }) })
        }.toString()

    @Test fun followPullPrefersServerList() = runTest {
        server.enqueue(MockResponse().setBody("""["~bus","~zod"]"""))
        assertEquals(listOf("~bus", "~zod"), followRepo().pull())
        assertEquals("/apps/lattice/follows", server.takeRequest().path)
        assertEquals(1, server.requestCount) // no %settings read needed
    }

    @Test fun followPullMigratesCacheIntoEmptyServerSet() = runTest {
        val ships = listOf("~zod", "~bus")
        server.enqueue(MockResponse().setBody("[]")) // GET /follows: empty
        server.enqueue(MockResponse().setBody(settingsBody("follows", "ships", Json.encodeToString(ser, ships))))
        server.enqueue(MockResponse().setResponseCode(200)) // POST /follow ~zod
        server.enqueue(MockResponse().setResponseCode(200)) // POST /follow ~bus
        assertEquals(ships, followRepo().pull())
        server.takeRequest() // GET /follows
        server.takeRequest() // %settings scry
        for (ship in ships) {
            val req = server.takeRequest()
            assertEquals("POST", req.method)
            assertTrue(req.path!!.startsWith("/apps/lattice/follow"))
            assertEquals(ship, req.requestUrl!!.queryParameter("ship"))
        }
    }

    @Test fun followPullFallsBackToCacheWhenServerUnreachable() = runTest {
        val ships = listOf("~zod", "~bus")
        server.enqueue(MockResponse().setResponseCode(500)) // GET /follows fails
        server.enqueue(MockResponse().setBody(settingsBody("follows", "ships", Json.encodeToString(ser, ships))))
        assertEquals(ships, followRepo().pull())
    }

    @Test fun followPushMirrorsSettingsAndReconcilesServer() = runTest {
        server.enqueue(MockResponse().setResponseCode(200)) // %settings channel PUT
        server.enqueue(MockResponse().setBody("""["~zod","~wet"]""")) // GET /follows
        server.enqueue(MockResponse().setResponseCode(200)) // POST /follow ~bus
        server.enqueue(MockResponse().setResponseCode(200)) // POST /unfollow ~wet
        val ships = listOf("~zod", "~bus")
        followRepo().push(ships)
        val pe = putEntryOf(server.takeRequest().body.readUtf8())
        assertEquals("follows", pe["bucket-key"]!!.jsonPrimitive.content)
        assertEquals("ships", pe["entry-key"]!!.jsonPrimitive.content)
        assertEquals(ships, Json.decodeFromString(ser, pe["value"]!!.jsonPrimitive.content))
        assertEquals("/apps/lattice/follows", server.takeRequest().path)
        val add = server.takeRequest()
        assertTrue(add.path!!.startsWith("/apps/lattice/follow"))
        assertEquals("~bus", add.requestUrl!!.queryParameter("ship"))
        val drop = server.takeRequest()
        assertTrue(drop.path!!.startsWith("/apps/lattice/unfollow"))
        assertEquals("~wet", drop.requestUrl!!.queryParameter("ship"))
    }

    @Test fun subscriptionPushPokesSerializedList() = runTest {
        server.enqueue(MockResponse().setResponseCode(200))
        val urls = listOf("urb://~zod/a", "urb://~bus/b/c")
        SubscriptionRepository(client()).push(urls)
        val pe = putEntryOf(server.takeRequest().body.readUtf8())
        assertEquals("subs", pe["bucket-key"]!!.jsonPrimitive.content)
        assertEquals("urls", pe["entry-key"]!!.jsonPrimitive.content)
        assertEquals(urls, Json.decodeFromString(ser, pe["value"]!!.jsonPrimitive.content))
    }

    @Test fun subscriptionPullDecodes() = runTest {
        val urls = listOf("urb://~zod/a")
        server.enqueue(MockResponse().setBody(settingsBody("subs", "urls", Json.encodeToString(ser, urls))))
        assertEquals(urls, SubscriptionRepository(client()).pull())
    }
}
