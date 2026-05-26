package io.nisfeb.lattice.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import io.nisfeb.lattice.theme.ThemeSettings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class SettingsScreenUiTest {

    @Test fun vimToggleFiresOnChange() = runComposeUiTest {
        var settings = ThemeSettings()
        setContent {
            MaterialTheme {
                SettingsScreen(
                    settings = settings,
                    onChange = { settings = it },
                    onClose = {},
                    savedThemes = emptyList(),
                    onSaveCurrent = {},
                    onDeleteSaved = {},
                )
            }
        }
        // The vim-keybindings switch is the first toggle in the column.
        onAllNodes(isToggleable()).onFirst().performClick()
        assertTrue(settings.vimMode)
    }

    @Test fun toolbarActionToggleMovesToOverflow() = runComposeUiTest {
        var settings = ThemeSettings()
        setContent {
            MaterialTheme {
                SettingsScreen(
                    settings = settings,
                    onChange = { settings = it },
                    onClose = {},
                    savedThemes = emptyList(),
                    onSaveCurrent = {},
                    onDeleteSaved = {},
                )
            }
        }
        // Toggles, in order: [0] = vim, then one per ToolbarActions.all. Turning
        // the first toolbar switch off pins that action to the ⋮ overflow menu.
        onAllNodes(isToggleable())[1].performClick()
        assertEquals(listOf(ToolbarActions.all.first().id), settings.overflowActions)
    }
}
