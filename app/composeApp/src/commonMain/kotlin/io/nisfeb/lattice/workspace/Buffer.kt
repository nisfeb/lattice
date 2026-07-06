package io.nisfeb.lattice.workspace

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Which store a buffer belongs to: a public gemtext page, or a private knowledge item. */
enum class Source { Public, Knowledge }

/**
 * One open editor buffer (a tab). [text] is the canonical content; [pane] is which
 * split pane (0 or 1) it's shown in.
 */
class Buffer(val path: String, val source: Source, val isNew: Boolean) {
    var text by mutableStateOf("")
    var loaded by mutableStateOf(isNew)
    var dirty by mutableStateOf(false)
    var pane by mutableStateOf(0)
    // knowledge buffers only: the item's tags (edited via the tag bar).
    var tags by mutableStateOf<List<String>>(emptyList())
    // true = show the rendered preview instead of the editable text.
    var preview by mutableStateOf(false)
}
