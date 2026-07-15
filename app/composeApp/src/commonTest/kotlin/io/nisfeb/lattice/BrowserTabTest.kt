package io.nisfeb.lattice

import io.nisfeb.lattice.browser.PageCache
import io.nisfeb.lattice.gemtext.GemLine
import io.nisfeb.lattice.ui.BrowserTab
import io.nisfeb.lattice.ui.activeAfterClose
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class BrowserTabTest {

    // ── which tab stays active after a close ──

    @Test fun closingLeftOfActiveFollowsTheSameTab() {
        // [A, B, C] viewing B (active=1); closing A leaves [B, C] — B is now 0.
        assertEquals(0, activeAfterClose(closed = 0, active = 1, lastIndex = 1))
    }

    @Test fun closingRightOfActiveKeepsActive() {
        // [A, B, C] viewing A; closing C leaves [A, B] — still viewing A.
        assertEquals(0, activeAfterClose(closed = 2, active = 0, lastIndex = 1))
    }

    @Test fun closingActiveSelectsRightNeighbour() {
        // [A, B, C] viewing B; closing B leaves [A, C] — C shifted into 1.
        assertEquals(1, activeAfterClose(closed = 1, active = 1, lastIndex = 1))
    }

    @Test fun closingActiveAtEndSelectsNewLast() {
        // [A, B, C] viewing C; closing C leaves [A, B] — select B.
        assertEquals(1, activeAfterClose(closed = 2, active = 2, lastIndex = 1))
    }

    // ── revalidation fetch vs SSE push race ──

    private fun lines(s: String) = listOf<GemLine>(GemLine.Text(s))

    private fun tabAt(url: String) = BrowserTab().apply { history.add(url); cursor = 0 }

    @Test fun staleFetchDoesNotClobberPushedBody() {
        val url = "urb://~zod/a"
        val tab = tabAt(url).apply { body = "pre-edit" }
        val cache = PageCache()
        val gen = tab.bodyGen                      // revalidation fetch starts
        tab.pushBody("edited", lines("edited"))    // SSE push lands mid-flight
        tab.applyFetch(url, "pre-edit", lines("pre-edit"), "", gen, cache)
        assertEquals("edited", tab.body)           // tab keeps the newer body
        assertNull(cache[url])                     // cache doesn't regress either
        assertFalse(tab.loading)                   // the fetch still completes
    }

    @Test fun freshFetchAppliesBodyAndCache() {
        val url = "urb://~zod/a"
        val tab = tabAt(url).apply { body = "old" }
        val cache = PageCache()
        tab.applyFetch(url, "new", lines("new"), "gmi", tab.bodyGen, cache)
        assertEquals("new", tab.body)
        assertEquals("gmi", tab.mark)
        assertEquals("new", cache[url]?.body)
        assertEquals(setOf(url), tab.visited)
    }

    @Test fun unchangedBodyKeepsLinesUntouched() {
        // Same content revalidated → no swap (preserves the reader's state),
        // but the cache entry is still refreshed.
        val url = "urb://~zod/a"
        val tab = tabAt(url).apply { body = "same"; lines = lines("original") }
        val cache = PageCache()
        tab.applyFetch(url, "same", lines("reparsed"), "", tab.bodyGen, cache)
        assertEquals(lines("original"), tab.lines)
        assertEquals("same", cache[url]?.body)
    }

    @Test fun pushBodyBumpsGenerationEachTime() {
        val tab = tabAt("urb://~zod/a")
        val g0 = tab.bodyGen
        tab.pushBody("v1", lines("v1"))
        tab.pushBody("v2", lines("v2"))
        assertEquals(g0 + 2, tab.bodyGen)
        assertEquals("v2", tab.body)
    }
}
