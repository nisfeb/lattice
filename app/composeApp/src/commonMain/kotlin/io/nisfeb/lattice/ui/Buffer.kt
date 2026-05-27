package io.nisfeb.lattice.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Which store a buffer belongs to: a public gemtext page, or a private knowledge item. */
enum class Source { Public, Knowledge }

/** One open editor buffer (a tab). [text] is the canonical content. */
class Buffer(val path: String, val source: Source, val isNew: Boolean) {
    var text by mutableStateOf("")
    var loaded by mutableStateOf(isNew)
    var dirty by mutableStateOf(false)
}
