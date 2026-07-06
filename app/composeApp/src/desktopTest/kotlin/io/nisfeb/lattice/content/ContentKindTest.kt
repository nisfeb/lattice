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
}
