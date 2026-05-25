package io.nisfeb.lattice.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** A plain text area over hoisted [text] (the default, non-vim editor). Ctrl/Cmd+S saves. */
@Composable
fun PlainEditor(
    text: String,
    onText: (String) -> Unit,
    onSave: () -> Unit,
    monoFamily: FontFamily,
    modifier: Modifier = Modifier,
) {
    var field by remember { mutableStateOf(TextFieldValue(text)) }
    BasicTextField(
        value = field,
        onValueChange = { field = it; onText(it.text) },
        textStyle = LocalTextStyle.current.copy(
            fontFamily = monoFamily,
            color = MaterialTheme.colorScheme.onBackground,
            fontSize = 14.sp,
        ),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        modifier = modifier.fillMaxSize().padding(8.dp).onPreviewKeyEvent { ev ->
            if (ev.type == KeyEventType.KeyDown && ev.isCtrlPressed && ev.key == Key.S) { onSave(); true } else false
        },
    )
}
