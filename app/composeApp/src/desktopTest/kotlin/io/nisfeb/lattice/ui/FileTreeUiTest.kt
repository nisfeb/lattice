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
                FileTree(files, dir = "", onDir = { dir = it }, onOpen = {}, onDelete = {}, onDuplicate = {}, onMove = {})
            }
        }
        onNodeWithText("notes/").performClick()
        assertEquals("notes", dir)
    }

    @Test fun clickingFileOpensIt() = runComposeUiTest {
        var opened: String? = null
        setContent {
            MaterialTheme {
                FileTree(files, dir = "", onDir = {}, onOpen = { opened = it }, onDelete = {}, onDuplicate = {}, onMove = {})
            }
        }
        onNodeWithText("hello").performClick()
        assertEquals("hello", opened)
    }

    @Test fun ellipsisMenuExposesActions() = runComposeUiTest {
        var deleted: String? = null
        setContent {
            MaterialTheme {
                FileTree(files, dir = "", onDir = {}, onOpen = {}, onDelete = { deleted = it }, onDuplicate = {}, onMove = {})
            }
        }
        onNodeWithContentDescription("Actions for hello").performClick()
        onNodeWithText("Delete").performClick()
        assertEquals("hello", deleted)
    }
}
