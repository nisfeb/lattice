package io.nisfeb.lattice.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(ExperimentalTestApi::class)
class FileTreeUiTest {

    private val files = listOf("hello", "notes/intro")

    @Test fun clickingFolderDrillsIn() = runComposeUiTest {
        var dir: String? = null
        setContent {
            MaterialTheme {
                FileTree(files, dir = "", onDir = { dir = it }, onOpen = {}, onDelete = {}, onDuplicate = {}, onMove = {}, onCopyLink = {})
            }
        }
        onNodeWithText("notes/").performClick()
        assertEquals("notes", dir)
    }

    @Test fun clickingFileOpensIt() = runComposeUiTest {
        var opened: String? = null
        setContent {
            MaterialTheme {
                FileTree(files, dir = "", onDir = {}, onOpen = { opened = it }, onDelete = {}, onDuplicate = {}, onMove = {}, onCopyLink = {})
            }
        }
        onNodeWithText("hello").performClick()
        assertEquals("hello", opened)
    }

    @Test fun ellipsisMenuExposesActions() = runComposeUiTest {
        var deleted: String? = null
        setContent {
            MaterialTheme {
                FileTree(files, dir = "", onDir = {}, onOpen = {}, onDelete = { deleted = it }, onDuplicate = {}, onMove = {}, onCopyLink = {})
            }
        }
        onNodeWithContentDescription("Actions for hello").performClick()
        onNodeWithText("Delete").performClick()
        assertEquals("hello", deleted)
    }

    @Test fun ellipsisMenuCopyLinkFiresWithFullPath() = runComposeUiTest {
        var linked: String? = null
        setContent {
            MaterialTheme {
                FileTree(files, dir = "", onDir = {}, onOpen = {}, onDelete = {}, onDuplicate = {}, onMove = {}, onCopyLink = { linked = it })
            }
        }
        onNodeWithContentDescription("Actions for hello").performClick()
        onNodeWithText("Copy link").performClick()
        assertEquals("hello", linked)
    }
}
