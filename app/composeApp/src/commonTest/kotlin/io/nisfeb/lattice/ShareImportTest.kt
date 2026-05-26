package io.nisfeb.lattice

import io.nisfeb.lattice.share.ShareImport
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ShareImportTest {

    @Test fun `isWebUrl is true only for a lone http(s) url`() {
        assertTrue(ShareImport.isWebUrl("https://example.com/path"))
        assertTrue(ShareImport.isWebUrl("  http://example.com  ")) // trimmed
        assertFalse(ShareImport.isWebUrl("check out https://example.com"))
        assertFalse(ShareImport.isWebUrl("https://a.com and https://b.com"))
        assertFalse(ShareImport.isWebUrl("just some shared text"))
        assertFalse(ShareImport.isWebUrl("urb://~sampel-palnet/x"))
    }

    @Test fun `slugify lowercases, dashes non-alphanumerics, and trims`() {
        assertEquals("how-urbit-works", ShareImport.slugify("How Urbit Works!"))
        assertEquals("a-b-c", ShareImport.slugify("  a / b / c  "))
        assertEquals("clip", ShareImport.slugify(""))
        assertEquals("clip", ShareImport.slugify("***"))
        assertEquals("clip", ShareImport.slugify(null))
    }

    @Test fun `slugify caps length without a trailing dash`() {
        val slug = ShareImport.slugify("x".repeat(100))
        assertTrue(slug.length <= 60)
        assertFalse(slug.endsWith("-"))
    }

    @Test fun `pathFor groups under shared`() {
        assertEquals("shared/my-page", ShareImport.pathFor("My Page"))
    }

    @Test fun `secureUrl upgrades http to https and leaves https untouched`() {
        assertEquals("https://www.vatican.va/", ShareImport.secureUrl("http://www.vatican.va/"))
        assertEquals("https://www.vatican.va/", ShareImport.secureUrl("HTTP://www.vatican.va/"))
        assertEquals("https://example.com/x", ShareImport.secureUrl("https://example.com/x"))
        // Only the leading scheme is rewritten, not http in the path/query.
        assertEquals("https://a.com/?u=http://b.com", ShareImport.secureUrl("http://a.com/?u=http://b.com"))
    }

    @Test fun `urbUrl composes ship and path`() {
        assertEquals("urb://~sampel-palnet/shared/x", ShareImport.urbUrl("~sampel-palnet", "shared/x"))
    }

    @Test fun `gemtextForText prepends a title heading when present`() {
        val gmi = ShareImport.gemtextForText("My Note", "body line")
        assertContains(gmi, "# My Note")
        assertContains(gmi, "body line")
    }

    @Test fun `gemtextForText omits heading when title blank`() {
        val gmi = ShareImport.gemtextForText("  ", "just body")
        assertFalse(gmi.contains("#"))
        assertEquals("just body\n", gmi)
    }

    @Test fun `titleFromText uses first non-blank line stripped of markers`() {
        assertEquals("Heading", ShareImport.titleFromText("\n\n## Heading\nmore"))
        assertEquals("first", ShareImport.titleFromText("first\nsecond"))
        assertTrue(ShareImport.titleFromText("   \n  ") == null)
    }
}
