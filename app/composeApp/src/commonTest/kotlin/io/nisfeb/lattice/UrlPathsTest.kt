package io.nisfeb.lattice

import io.nisfeb.lattice.browser.UrlPaths
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class UrlPathsTest {

    @Test fun defaultDest() {
        assertEquals("notes/x", UrlPaths.defaultDest("urb://~tyr/notes/x"))
        assertEquals("hello", UrlPaths.defaultDest("urb://~zod/hello"))
        assertEquals("tyr", UrlPaths.defaultDest("urb://~tyr/"))
        assertEquals("notes/x", UrlPaths.defaultDest("urb://~tyr/notes/x?ignored=1"))
    }

    @Test fun editPathForOwnShip() {
        val own = "urb://~zod/"
        assertEquals("hello", UrlPaths.editPathFor("urb://~zod/hello", own))
        assertEquals("notes/intro", UrlPaths.editPathFor("urb://~zod/notes/intro", own))
        assertEquals("index", UrlPaths.editPathFor("urb://~zod/", own))
        assertNull(UrlPaths.editPathFor("urb://~tyr/hello", own))
    }

    @Test fun tabTitle() {
        assertEquals("New tab", UrlPaths.tabTitle(""))
        assertEquals("~zod", UrlPaths.tabTitle("urb://~zod/"))
        assertEquals("intro", UrlPaths.tabTitle("urb://~zod/notes/intro"))
        assertEquals("hello", UrlPaths.tabTitle("urb://~zod/hello"))
    }

    @Test fun inlineCountFitsAllWhenWide() {
        assertEquals(7, UrlPaths.inlineCount(maxWidthDp = 2000f, unitDp = 34f, leftButtons = 3, reservedDp = 240f, count = 7))
    }

    @Test fun inlineCountReservesOverflowSlotWhenTight() {
        // avail = 600 - 34*3 - 240 = 258; fit = 7; >= 7 → all inline
        assertEquals(7, UrlPaths.inlineCount(600f, 34f, 3, 240f, 7))
        // avail = 500 - 102 - 240 = 158; fit = 4; < 7 → 4-1 = 3 inline (rest overflow)
        assertEquals(3, UrlPaths.inlineCount(500f, 34f, 3, 240f, 7))
        // very narrow → 0 inline, everything overflows
        assertEquals(0, UrlPaths.inlineCount(360f, 34f, 3, 240f, 7))
    }
}
