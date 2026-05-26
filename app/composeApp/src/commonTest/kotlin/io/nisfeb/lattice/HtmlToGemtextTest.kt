package io.nisfeb.lattice

import io.nisfeb.lattice.share.HtmlToGemtext
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HtmlToGemtextTest {

    @Test fun `headings map to gemtext levels`() {
        val gmi = HtmlToGemtext.convert("<h1>Title</h1><h2>Sub</h2><h4>Deep</h4>")
        assertContains(gmi, "# Title")
        assertContains(gmi, "## Sub")
        assertContains(gmi, "### Deep") // h4..h6 all clamp to ###
    }

    @Test fun `paragraphs become text lines and whitespace collapses`() {
        val gmi = HtmlToGemtext.convert("<p>hello   there\n  world</p>")
        assertContains(gmi, "hello there world")
    }

    @Test fun `anchor text stays inline and the link is emitted on its own line`() {
        val gmi = HtmlToGemtext.convert(
            """<p>see <a href="https://example.com/x">the docs</a> now</p>""",
        )
        assertContains(gmi, "see the docs now")
        assertContains(gmi, "=> https://example.com/x the docs")
    }

    @Test fun `relative links resolve against the base url`() {
        val gmi = HtmlToGemtext.convert(
            """<a href="/about">About</a> <a href="page.html">Page</a>""",
            baseUrl = "https://site.example/blog/post",
        )
        assertContains(gmi, "=> https://site.example/about About")
        assertContains(gmi, "=> https://site.example/blog/page.html Page")
    }

    @Test fun `list items become bullets`() {
        val gmi = HtmlToGemtext.convert("<ul><li>one</li><li>two</li></ul>")
        assertContains(gmi, "* one")
        assertContains(gmi, "* two")
    }

    @Test fun `blockquote becomes a quote line`() {
        val gmi = HtmlToGemtext.convert("<blockquote>wisdom here</blockquote>")
        assertContains(gmi, "> wisdom here")
    }

    @Test fun `pre is fenced and kept verbatim`() {
        val gmi = HtmlToGemtext.convert("<pre>line 1\n  line 2</pre>")
        assertContains(gmi, "```")
        assertContains(gmi, "line 1\n  line 2")
    }

    @Test fun `script and style content is dropped`() {
        val gmi = HtmlToGemtext.convert(
            "<style>.a{color:red}</style><script>alert(1)</script><p>visible</p>",
        )
        assertContains(gmi, "visible")
        assertFalse(gmi.contains("alert"))
        assertFalse(gmi.contains("color:red"))
    }

    @Test fun `entities are decoded`() {
        val gmi = HtmlToGemtext.convert("<p>Tom &amp; Jerry &lt;3 &#65; &#x42;</p>")
        assertContains(gmi, "Tom & Jerry <3 A B")
    }

    @Test fun `article region is preferred over nav and footer chrome`() {
        val gmi = HtmlToGemtext.convert(
            "<body><nav>menu junk</nav><article><p>real content</p></article><footer>foot</footer></body>",
        )
        assertContains(gmi, "real content")
        assertFalse(gmi.contains("menu junk"))
    }

    @Test fun `extractTitle reads the title tag then falls back to h1`() {
        assertEquals("Hello", HtmlToGemtext.extractTitle("<html><head><title>Hello</title></head></html>"))
        assertEquals("From H1", HtmlToGemtext.extractTitle("<body><h1>From H1</h1></body>"))
        assertTrue(HtmlToGemtext.extractTitle("<p>no title</p>") == null)
    }
}
