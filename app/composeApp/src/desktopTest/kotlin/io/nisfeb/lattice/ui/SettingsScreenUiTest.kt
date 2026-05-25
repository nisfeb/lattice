package io.nisfeb.lattice.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import io.nisfeb.lattice.theme.ThemeSettings
import kotlin.test.Test
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
        onNode(isToggleable()).performClick()
        assertTrue(settings.vimMode)
    }
}
