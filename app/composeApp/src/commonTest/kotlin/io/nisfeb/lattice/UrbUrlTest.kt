package io.nisfeb.lattice

import io.nisfeb.lattice.gemtext.UrbUrl
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class UrbUrlTest {

    @Test fun parseSplitsShipAndPath() {
        assertEquals("~zod" to "/a/b", UrbUrl.parse("urb://~zod/a/b"))
        assertEquals("~zod" to "", UrbUrl.parse("urb://~zod"))
        assertEquals("~zod" to "/", UrbUrl.parse("urb://~zod/"))
        assertNull(UrbUrl.parse("https://example.com"))
    }

    @Test fun schemeDetection() {
        assertTrue(UrbUrl.isUrb("urb://~zod/x"))
        assertFalse(UrbUrl.isUrb("/x"))
        assertTrue(UrbUrl.hasForeignScheme("https://x"))
        assertTrue(UrbUrl.hasForeignScheme("mailto:a@b"))
        assertFalse(UrbUrl.hasForeignScheme("urb://~zod/x"))
        assertFalse(UrbUrl.hasForeignScheme("notes/intro"))
    }

    @Test fun resolveAbsoluteUrbPassThrough() {
        assertEquals("urb://~tyr/z", UrbUrl.resolve("urb://~zod/a", "urb://~tyr/z"))
    }

    @Test fun resolveRelativeAgainstDirectory() {
        assertEquals("urb://~zod/notes/hello", UrbUrl.resolve("urb://~zod/notes/intro", "hello"))
        assertEquals("urb://~zod/notes/a/b", UrbUrl.resolve("urb://~zod/notes/intro", "a/b"))
        assertEquals("urb://~zod/hello", UrbUrl.resolve("urb://~zod/", "hello"))
    }

    @Test fun resolveAbsolutePath() {
        assertEquals("urb://~zod/abs", UrbUrl.resolve("urb://~zod/notes/intro", "/abs"))
    }

    @Test fun resolveDotSegments() {
        assertEquals("urb://~zod/x", UrbUrl.resolve("urb://~zod/notes/intro", "../x"))
        assertEquals("urb://~zod/a/b/d", UrbUrl.resolve("urb://~zod/a/b/c", "./d"))
    }

    @Test fun resolveForeignSchemeIsNull() {
        assertNull(UrbUrl.resolve("urb://~zod/a", "https://example.com"))
        assertNull(UrbUrl.resolve("urb://~zod/a", "mailto:x@y"))
    }
}
