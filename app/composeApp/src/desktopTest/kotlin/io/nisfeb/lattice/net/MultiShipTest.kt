package io.nisfeb.lattice.net

import io.nisfeb.lattice.urbit.FileSessionStore
import io.nisfeb.lattice.urbit.SavedSession
import io.nisfeb.lattice.urbit.UrbitSession
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Safety net for the multi-ship refactor: locks the persistence contract on
 * SessionStore + the cookie-jar isolation invariant on UrbitSession. If either
 * regresses, the per-key rebuild that multi-ship relies on stops being safe.
 */
class MultiShipTest {
    private lateinit var tmp: File

    @BeforeTest fun setUp() {
        tmp = Files.createTempDirectory("lattice-mship-").toFile()
    }
    @AfterTest fun tearDown() { tmp.deleteRecursively() }

    // ── SessionStore round-trip ─────────────────────────────────────────────
    //
    // Active-pointer semantics are what the picker UI relies on:
    //   save(a, makeActive=true) → a is active
    //   save(b, makeActive=true) → b is active (a stays)
    //   setActive(a) → a is active
    //   remove(a) (the active one) → b auto-promotes
    //   remove(b) (the last one) → active is null
    @Test fun sessionStoreAutoPromotesOnRemove() {
        val store = FileSessionStore(dir = tmp)
        val a = SavedSession("http://a", "~a", "urbauth-~a", "ca", "a")
        val b = SavedSession("http://b", "~b", "urbauth-~b", "cb", "b")
        store.save(a, makeActive = true); assertEquals("~a", store.activeShip())
        store.save(b, makeActive = true); assertEquals("~b", store.activeShip())
        assertEquals(listOf("~a", "~b"), store.all().map { it.ship })

        store.setActive("~a"); assertEquals("~a", store.activeShip())

        // remove the active one → the other auto-promotes (talon-style)
        store.remove("~a"); assertEquals("~b", store.activeShip())

        // remove the last one → active clears
        store.remove("~b"); assertNull(store.activeShip())
        assertTrue(store.all().isEmpty())
    }

    @Test fun sessionStoreSurvivesRoundTripThroughFresh() {
        // a fresh FileSessionStore opened on the same dir sees what was written.
        FileSessionStore(dir = tmp).save(
            SavedSession("http://x", "~x", "urbauth-~x", "cx", "x"),
            makeActive = true,
        )
        val reopened = FileSessionStore(dir = tmp)
        assertEquals(listOf("~x"), reopened.all().map { it.ship })
        assertEquals("~x", reopened.activeShip())
    }

    // ── Cookie-jar isolation across UrbitSessions ───────────────────────────
    //
    // Each UrbitSession owns its own InMemoryCookieJar (UrbitSession.kt:27).
    // Restoring two sessions side-by-side must not leak ship A's urbauth to
    // ship B's host. The multi-ship `key(activeShip)` block in App.kt builds
    // a fresh UrbitSession per ship — this guards that path.
    @Test fun cookieJarsAreIsolatedAcrossSessions() {
        val mwA = MockWebServer().also { it.start() }
        val mwB = MockWebServer().also { it.start() }
        try {
            val storeA = FakeSessionStore().apply {
                save(SavedSession(mwA.url("/").toString().trimEnd('/'), "~a", "urbauth-~a", "tokA", mwA.hostName), true)
            }
            val storeB = FakeSessionStore().apply {
                save(SavedSession(mwB.url("/").toString().trimEnd('/'), "~b", "urbauth-~b", "tokB", mwB.hostName), true)
            }
            val parent = OkHttpClient()
            val sa = UrbitSession(parent, storeA).also { it.tryRestore() }
            val sb = UrbitSession(parent, storeB).also { it.tryRestore() }

            // Probe each against its own host. Each request must carry only its
            // own ship's cookie — never the other's.
            mwA.enqueue(MockResponse().setResponseCode(200))
            sa.http.newCall(Request.Builder().url(mwA.url("/probe")).build()).execute().close()
            val cookieOnA = mwA.takeRequest().getHeader("Cookie") ?: ""
            assertTrue(cookieOnA.contains("urbauth-~a=tokA"), "A's request missing its cookie: $cookieOnA")
            assertTrue(!cookieOnA.contains("urbauth-~b"), "A's request leaked ~b cookie: $cookieOnA")

            mwB.enqueue(MockResponse().setResponseCode(200))
            sb.http.newCall(Request.Builder().url(mwB.url("/probe")).build()).execute().close()
            val cookieOnB = mwB.takeRequest().getHeader("Cookie") ?: ""
            assertTrue(cookieOnB.contains("urbauth-~b=tokB"), "B's request missing its cookie: $cookieOnB")
            assertTrue(!cookieOnB.contains("urbauth-~a"), "B's request leaked ~a cookie: $cookieOnB")
        } finally {
            mwA.shutdown(); mwB.shutdown()
        }
    }
}
