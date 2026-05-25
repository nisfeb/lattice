package io.nisfeb.lattice

import io.nisfeb.lattice.ui.listDir
import kotlin.test.Test
import kotlin.test.assertEquals

class FileTreeTest {

    private val files = listOf("hello", "two", "notes/2026/intro", "notes/idea", "a/x", "a/y")

    @Test fun rootSplitsFoldersAndFiles() {
        val (folders, here) = listDir(files, "")
        assertEquals(listOf("a", "notes"), folders)
        assertEquals(listOf("hello", "two"), here)
    }

    @Test fun nestedDir() {
        val (folders, here) = listDir(files, "notes")
        assertEquals(listOf("2026"), folders)
        assertEquals(listOf("idea"), here)
    }

    @Test fun deepDir() {
        val (folders, here) = listDir(files, "notes/2026")
        assertEquals(emptyList(), folders)
        assertEquals(listOf("intro"), here)
    }

    @Test fun foldersAreDeduped() {
        val (folders, here) = listDir(listOf("a/x", "a/y", "a/z"), "")
        assertEquals(listOf("a"), folders)
        assertEquals(emptyList(), here)
    }
}
