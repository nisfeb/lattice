package io.nisfeb.lattice.markdown

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MarkdownTest {

    @Test fun parsesBlockStructure() {
        val src = """
            # Title

            some text

            - a
            - b

            1. one
            2. two

            ```kotlin
            val x = 1
            ```

            > a quote

            ---

            ![alt text](https://ex.com/y.png)
        """.trimIndent()
        val blocks = Markdown.parse(src)
        val h = blocks.first() as MdBlock.Heading
        assertEquals(1, h.level)
        assertEquals("Title", (h.spans.single() as MdSpan.Text).text)
        assertTrue(blocks.any { it is MdBlock.Paragraph })
        assertEquals(2, blocks.count { it is MdBlock.Bullet })
        val nums = blocks.filterIsInstance<MdBlock.Numbered>()
        assertEquals(listOf(1, 2), nums.map { it.number })
        val code = blocks.filterIsInstance<MdBlock.Code>().single()
        assertEquals("kotlin", code.lang)
        assertEquals("val x = 1", code.text)
        assertTrue(blocks.any { it is MdBlock.Quote })
        assertTrue(blocks.any { it is MdBlock.Rule })
        val img = blocks.filterIsInstance<MdBlock.Image>().single()
        assertEquals("alt text", img.alt)
        assertEquals("https://ex.com/y.png", img.src)
    }

    @Test fun parsesInlineStyles() {
        val spans = Markdown.parseInlines("**bold** and *it* and `c` and [lbl](urb://~zod/x)")
        assertTrue(spans[0] is MdSpan.Bold)
        assertEquals("bold", ((spans[0] as MdSpan.Bold).inner.single() as MdSpan.Text).text)
        assertTrue(spans.any { it is MdSpan.Italic })
        assertTrue(spans.any { it is MdSpan.Code })
        val link = spans.filterIsInstance<MdSpan.Link>().single()
        assertEquals("lbl", link.label)
        assertEquals("urb://~zod/x", link.href)
    }

    @Test fun bareUrlBecomesLink() {
        val spans = Markdown.parseInlines("see https://example.com now")
        val link = spans.filterIsInstance<MdSpan.Link>().single()
        assertEquals("https://example.com", link.href)
    }

    @Test fun inlineImageInParagraphKeepsAsSpan() {
        // an image with trailing text stays a paragraph (not a block image)
        val blocks = Markdown.parse("text ![a](https://x/y.png) more")
        val para = blocks.single() as MdBlock.Paragraph
        assertTrue(para.spans.any { it is MdSpan.Image })
    }

    @Test fun unterminatedFenceDoesNotEatDocument() {
        val blocks = Markdown.parse("```\nno close\n\nafter")
        // No code block swallowing everything; content survives as text.
        assertTrue(blocks.none { it is MdBlock.Code })
        assertTrue(blocks.any { it is MdBlock.Paragraph })
    }
}
