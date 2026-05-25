package io.nisfeb.lattice.net

import io.nisfeb.lattice.social.FollowRepository
import io.nisfeb.lattice.social.SubscriptionRepository
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

/**
 * The follow / subscription repos are %settings-synced string lists, identical
 * in shape to themes (see ThemeRepositoryTest) — push pokes the JSON-stringified
 * list to a bucket/entry, pull reads it back.
 */
class SocialReposTest {
    private lateinit var server: MockWebServer
    private val ser = ListSerializer(String.serializer())

    @BeforeTest fun setUp() { server = MockWebServer().also { it.start() } }
    @AfterTest fun tearDown() { server.shutdown() }

    private fun client() = SettingsClient(loggedInSession(server))

    private fun putEntryOf(reqBody: String) =
        Json.parseToJsonElement(reqBody).jsonArray[0].jsonObject["json"]!!
            .jsonObject["put-entry"]!!.jsonObject

    private fun settingsBody(bucket: String, entry: String, encoded: String) =
        buildJsonObject {
            put("desk", buildJsonObject { put(bucket, buildJsonObject { put(entry, encoded) }) })
        }.toString()

    @Test fun followPushPokesSerializedList() = runTest {
        server.enqueue(MockResponse().setResponseCode(200))
        val ships = listOf("~zod", "~bus")
        FollowRepository(client()).push(ships)
        val pe = putEntryOf(server.takeRequest().body.readUtf8())
        assertEquals("follows", pe["bucket-key"]!!.jsonPrimitive.content)
        assertEquals("ships", pe["entry-key"]!!.jsonPrimitive.content)
        assertEquals(ships, Json.decodeFromString(ser, pe["value"]!!.jsonPrimitive.content))
    }

    @Test fun followPullDecodes() = runTest {
        val ships = listOf("~zod", "~bus")
        server.enqueue(MockResponse().setBody(settingsBody("follows", "ships", Json.encodeToString(ser, ships))))
        assertEquals(ships, FollowRepository(client()).pull())
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
