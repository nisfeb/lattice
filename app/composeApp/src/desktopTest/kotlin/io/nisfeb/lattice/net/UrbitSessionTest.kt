package io.nisfeb.lattice.net

import io.nisfeb.lattice.urbit.UrbitSession
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class UrbitSessionTest {
    private lateinit var server: MockWebServer

    @BeforeTest fun setUp() { server = MockWebServer().also { it.start() } }
    @AfterTest fun tearDown() { server.shutdown() }

    @Test fun loginPostsCodeAndCapturesCookie() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).addHeader("Set-Cookie", "urbauth-~zod=tok; Path=/"))
        val store = FakeSessionStore()
        val session = UrbitSession(OkHttpClient(), store)

        val result = session.login(server.url("/").toString(), "+lidlut-tabwed-pillex-ridrup")

        assertEquals("~zod", result.getOrNull())
        assertEquals("~zod", session.shipName)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/~/login", req.path)
        assertEquals("password=lidlut-tabwed-pillex-ridrup", req.body.readUtf8())
        // session persisted
        assertEquals(1, store.entries.size)
        assertEquals("urbauth-~zod", store.entries[0].cookieName)
    }

    @Test fun loginFailsOn401() = runTest {
        server.enqueue(MockResponse().setResponseCode(401))
        val session = UrbitSession(OkHttpClient(), FakeSessionStore())
        val result = session.login(server.url("/").toString(), "bad")
        assertTrue(result.isFailure)
        assertEquals(null, session.shipName)
    }

    // Security: never send the +code/cookie in cleartext to a non-loopback host.
    @Test fun loginRejectsCleartextRemoteHost() = runTest {
        val session = UrbitSession(OkHttpClient(), FakeSessionStore())
        val result = session.login("http://example.com", "lidlut-tabwed-pillex-ridrup")
        assertTrue(result.isFailure)
        assertEquals(null, session.shipName)
    }

    @Test fun tryRestoreLoadsSavedSession() {
        val session = loggedInSession(server)
        assertEquals("~zod", session.shipName)
        assertEquals(server.url("/").toString().trimEnd('/'), session.baseUrl.toString().trimEnd('/'))
    }
}
