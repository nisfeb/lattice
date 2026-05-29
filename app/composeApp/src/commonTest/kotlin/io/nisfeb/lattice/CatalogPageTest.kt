package io.nisfeb.lattice

import io.nisfeb.lattice.urbit.CatalogPage
import kotlin.test.Test
import kotlin.test.assertEquals

/** Parsing of an obelisk catalog-list (columns, row) into a [CatalogPage]. */
class CatalogPageTest {

    // The canonical catalog-list column order (see +catalog-list-cols).
    private val cols = listOf(
        "source", "publisher", "path", "url", "title",
        "category", "cat-source", "word-count", "fetched",
    )

    @Test fun mapsEveryColumnByName() {
        val p = CatalogPage.fromRow(
            cols,
            listOf("~tyr", "~zod", "/notes/world", "urb://~zod/notes/world", "The World Note",
                "reference", "llm", "13", "~2026.5.29"),
        )
        assertEquals("~tyr", p.source)
        assertEquals("~zod", p.publisher)
        assertEquals("/notes/world", p.path)
        assertEquals("urb://~zod/notes/world", p.url)
        assertEquals("The World Note", p.title)
        assertEquals("reference", p.category)
        assertEquals("llm", p.catSource)
        assertEquals(13, p.wordCount)
        assertEquals("~2026.5.29", p.fetched)
    }

    @Test fun toleratesReorderedColumns() {
        // Same data, columns in a different order — mapping is by name, not index.
        val reordered = listOf("title", "url", "publisher", "path", "word-count", "category")
        val p = CatalogPage.fromRow(
            reordered,
            listOf("Hello", "urb://~zod/notes/hello", "~zod", "/notes/hello", "7", "note"),
        )
        assertEquals("Hello", p.title)
        assertEquals("~zod", p.publisher)
        assertEquals("/notes/hello", p.path)
        assertEquals(7, p.wordCount)
        assertEquals("note", p.category)
        assertEquals("", p.source) // absent column → ""
    }

    @Test fun missingOrShortRowYieldsBlanks() {
        // A row shorter than the column list must not throw; missing cells are "".
        val p = CatalogPage.fromRow(cols, listOf("~tyr", "~zod", "/p"))
        assertEquals("~zod", p.publisher)
        assertEquals("/p", p.path)
        assertEquals("", p.title)
        assertEquals("", p.category)
        assertEquals(0, p.wordCount) // unparseable/absent word-count → 0
    }

    @Test fun labelFallsBackToPathWhenTitleBlank() {
        val titled = CatalogPage.fromRow(cols, listOf("~tyr", "~zod", "/p", "u", "A Title"))
        assertEquals("A Title", titled.label)
        val untitled = CatalogPage.fromRow(cols, listOf("~tyr", "~zod", "/blog/x", "u", ""))
        assertEquals("/blog/x", untitled.label)
    }

    @Test fun nonNumericWordCountIsZero() {
        val p = CatalogPage.fromRow(listOf("word-count"), listOf("not-a-number"))
        assertEquals(0, p.wordCount)
    }
}
