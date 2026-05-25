package io.nisfeb.lattice

import io.nisfeb.lattice.gemtext.GemLine
import io.nisfeb.lattice.gemtext.GemtextParser
import io.nisfeb.lattice.gemtext.UrbUrl
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GemtextTest {

    @Test
    fun classifiesLineTypes() {
        val lines = GemtextParser.parse(
            """
            # Title
            ### Deep
            plain text
            => /hello  Hello page
            => urb://~tyr/x
            * a bullet
            > a quote
            """.trimIndent()
        )
        assertEquals(GemLine.Heading(1, "Title"), lines[0])
        assertEquals(GemLine.Heading(3, "Deep"), lines[1])
        assertEquals(GemLine.Text("plain text"), lines[2])
        assertEquals(GemLine.Link("/hello", "Hello page"), lines[3])
        assertEquals(GemLine.Link("urb://~tyr/x", ""), lines[4])
        assertEquals(GemLine.Bullet("a bullet"), lines[5])
        assertEquals(GemLine.Quote("a quote"), lines[6])
    }

    @Test
    fun preformattedBlock() {
        val lines = GemtextParser.parse("```code\nline 1\n=> not a link\n```\nafter")
        assertEquals(GemLine.Pre(listOf("line 1", "=> not a link"), "code"), lines[0])
        assertEquals(GemLine.Text("after"), lines[1])
    }

    @Test
    fun handlesCrlf() {
        val lines = GemtextParser.parse("# H\r\ntext\r\n")
        assertEquals(GemLine.Heading(1, "H"), lines[0])
        assertEquals(GemLine.Text("text"), lines[1])
    }

    @Test
    fun resolvesLinks() {
        // absolute path against current ship
        assertEquals("urb://~zod/hello", UrbUrl.resolve("urb://~zod/", "/hello"))
        // relative against current directory
        assertEquals(
            "urb://~zod/notes/2026/intro",
            UrbUrl.resolve("urb://~zod/notes/2026/x", "intro"),
        )
        // .. climbs
        assertEquals("urb://~zod/a/d", UrbUrl.resolve("urb://~zod/a/b/c", "../d"))
        // absolute urb url passes through
        assertEquals("urb://~tyr/p", UrbUrl.resolve("urb://~zod/", "urb://~tyr/p"))
        // foreign scheme is not navigable
        assertNull(UrbUrl.resolve("urb://~zod/", "https://example.com"))
        assertTrue(UrbUrl.hasForeignScheme("mailto:x@y.z"))
    }
}
