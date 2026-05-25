package io.nisfeb.lattice.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.editor.VimEngine
import io.nisfeb.lattice.editor.VimKey
import io.nisfeb.lattice.editor.VimMode
import kotlin.math.roundToInt

/**
 * Modal (vim) editor over hoisted [text]. Emits edits via [onText]; `:w` calls
 * [onSave], `:q` calls [onQuit]. The buffer text is the source of truth, so
 * the engine is seeded from [text] (caller keys this by buffer path).
 */
@Composable
fun VimEditor(
    text: String,
    onText: (String) -> Unit,
    onSave: () -> Unit,
    onQuit: () -> Unit,
    monoFamily: FontFamily,
    modifier: Modifier = Modifier,
) {
    var engine by remember { mutableStateOf(VimEngine.of(text)) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }

    fun feed(k: VimKey) {
        val before = engine.text()
        val next = engine.handle(k)
        if (next.saveRequested) onSave()
        if (next.quitRequested) { onQuit(); return }
        engine = next.consumeSignals()
        val after = engine.text()
        if (after != before) onText(after)
    }

    val mono = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily)
    val cursorBg = MaterialTheme.colorScheme.primary
    val cursorFg = MaterialTheme.colorScheme.background
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val cellW = remember(mono) {
        with(density) { measurer.measure(AnnotatedString("M"), mono).size.width.toDp() }
    }
    val cursorLayout = remember(engine.row) { mutableStateOf<TextLayoutResult?>(null) }

    Column(modifier = modifier.fillMaxSize()) {
        Surface(
            color = MaterialTheme.colorScheme.background,
            modifier = Modifier.weight(1f).fillMaxWidth()
                .focusRequester(focus).focusable()
                .onPreviewKeyEvent { ev ->
                    if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    val vk: VimKey? = when (ev.key) {
                        Key.Escape -> VimKey.Esc
                        Key.Enter, Key.NumPadEnter -> VimKey.Enter
                        Key.Backspace, Key.Delete -> VimKey.Backspace
                        else -> ev.utf16CodePoint.takeIf { it in 32..0xFFFE }?.let { VimKey.Ch(it.toChar()) }
                    }
                    if (vk != null) { feed(vk); true } else false
                },
        ) {
            Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(8.dp)) {
                engine.lines.forEachIndexed { r, line ->
                    if (r == engine.row) {
                        val cc = engine.col.coerceIn(0, line.length)
                        Box {
                            cursorLayout.value?.let { lr ->
                                val safe = cc.coerceIn(0, lr.layoutInput.text.length)
                                val rect = lr.getCursorRect(safe)
                                Box(
                                    Modifier
                                        .offset { IntOffset(rect.left.roundToInt(), rect.top.roundToInt()) }
                                        .size(cellW, with(density) { (rect.bottom - rect.top).toDp() })
                                        .background(cursorBg),
                                )
                            }
                            Text(
                                text = buildAnnotatedString {
                                    append(line.ifEmpty { " " })
                                    if (cc < line.length) addStyle(SpanStyle(color = cursorFg), cc, cc + 1)
                                },
                                style = mono,
                                onTextLayout = { cursorLayout.value = it },
                            )
                        }
                    } else {
                        Text(line.ifEmpty { " " }, style = mono)
                    }
                }
            }
        }
        Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
            Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)) {
                val modeLabel = when (engine.mode) {
                    VimMode.NORMAL -> "NORMAL"; VimMode.INSERT -> "-- INSERT --"; VimMode.VISUAL -> "-- VISUAL --"
                }
                Text(modeLabel, style = TextStyle(fontFamily = monoFamily), color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
                val tail = engine.ex?.let { ":$it" } ?: engine.message
                Text(tail, style = TextStyle(fontFamily = monoFamily), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
