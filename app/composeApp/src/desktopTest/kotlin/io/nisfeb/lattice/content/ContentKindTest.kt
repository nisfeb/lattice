package io.nisfeb.lattice.content

import kotlin.test.Test
import kotlin.test.assertEquals

class ContentKindTest {

    @Test fun marksWin() {
        assertEquals(ContentKind.Gemtext, classifyContent("gmi"))
        assertEquals(ContentKind.Markdown, classifyContent("md"))
        assertEquals(ContentKind.Code, classifyContent("json"))
    }

    @Test fun fallsBackToExtension() {
        assertEquals(ContentKind.Markdown, classifyContent(mark = "", name = "readme.md"))
        assertEquals(ContentKind.Code, classifyContent(mark = "", name = "app/lib/foo.hoon"))
        assertEquals(ContentKind.Image, classifyContent(mark = "", name = "photo.PNG"))
        assertEquals(ContentKind.Text, classifyContent(mark = "", name = "notes.txt"))
    }

    @Test fun extensionlessCodeFilesByName() {
        assertEquals(ContentKind.Code, classifyContent(mark = "", name = "Makefile"))
        assertEquals(ContentKind.Code, classifyContent(mark = "", name = "some/Dockerfile"))
    }

    @Test fun unknownDefaultsToText() {
        assertEquals(ContentKind.Text, classifyContent(mark = "weird", name = "x.zzz"))
        assertEquals(ContentKind.Text, classifyContent(mark = "", name = ""))
    }

    @Test fun mdPathOverridesGmiMark() {
        // A markdown page is stored as a gmi grub whose PATH ends .md — the
        // extension must win so the reader renders markdown, not gemtext.
        assertEquals(ContentKind.Markdown, classifyContent("gmi", "urb://~zod/notes/idea.md"))
    }

    @Test fun plainPageStaysGemtext() {
        assertEquals(ContentKind.Gemtext, classifyContent("gmi", "urb://~zod/index"))
    }

    @Test fun dottedDirectoryIsNotAnExtension() {
        // Only the last path segment counts — a dotted directory must not read
        // as an extension.
        assertEquals(ContentKind.Gemtext, classifyContent("gmi", "urb://~zod/v1.2/notes/idea"))
    }
}
