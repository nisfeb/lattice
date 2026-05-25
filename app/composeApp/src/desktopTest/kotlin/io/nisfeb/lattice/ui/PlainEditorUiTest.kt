package io.nisfeb.lattice.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.text.font.FontFamily
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(ExperimentalTestApi::class)
class PlainEditorUiTest {

    @Test fun typingEmitsText() = runComposeUiTest {
        var captured = ""
        setContent {
            MaterialTheme {
                PlainEditor(text = "", onText = { captured = it }, onSave = {}, monoFamily = FontFamily.Monospace)
            }
        }
        onNode(hasSetTextAction()).performTextInput("hello")
        assertEquals("hello", captured)
    }
}
