package io.nisfeb.lattice

import io.nisfeb.lattice.browser.CachedPage
import io.nisfeb.lattice.browser.PageCache
import io.nisfeb.lattice.gemtext.GemLine
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PageCacheTest {
    private fun page(s: String) = CachedPage(s, listOf(GemLine.Text(s)))

    @Test fun storesAndReturnsByUrl() {
        val c = PageCache()
        assertNull(c["urb://~zod/a"])
        c["urb://~zod/a"] = page("hello")
        assertEquals("hello", c["urb://~zod/a"]?.body)
    }

    @Test fun overwritesSameUrl() {
        val c = PageCache()
        c["urb://~zod/a"] = page("v1")
        c["urb://~zod/a"] = page("v2")
        assertEquals("v2", c["urb://~zod/a"]?.body)
    }

    @Test fun evictsOldestPastTheCap() {
        val c = PageCache(max = 2)
        c["a"] = page("1")
        c["b"] = page("2")
        c["c"] = page("3") // size would be 3 → evict the oldest (a)
        assertNull(c["a"])
        assertEquals("2", c["b"]?.body)
        assertEquals("3", c["c"]?.body)
    }

    @Test fun reSettingBumpsRecency() {
        val c = PageCache(max = 2)
        c["a"] = page("1")
        c["b"] = page("2")
        c["a"] = page("1b") // re-set a → b is now the oldest
        c["c"] = page("3")  // evict the oldest (b)
        assertNull(c["b"])
        assertEquals("1b", c["a"]?.body)
        assertEquals("3", c["c"]?.body)
    }
}
