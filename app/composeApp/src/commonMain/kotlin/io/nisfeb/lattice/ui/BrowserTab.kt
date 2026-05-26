package io.nisfeb.lattice.ui

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.nisfeb.lattice.browser.UrlPaths
import io.nisfeb.lattice.gemtext.GemLine
import kotlinx.coroutines.Job

/** One browser tab: its own history, current page, and load state. */
class BrowserTab {
    val history = mutableStateListOf<String>()
    var cursor by mutableStateOf(-1)
    var address by mutableStateOf("")
    var lines by mutableStateOf<List<GemLine>>(emptyList())
    var body by mutableStateOf("")
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var visited by mutableStateOf(setOf<String>())
    var job: Job? = null
    // Per-tab scroll, so switching tabs restores each one's position. Reassigned
    // (fresh, at top) on a new page load; preserved across tab switches.
    var listState by mutableStateOf(LazyListState())

    val current: String get() = history.getOrNull(cursor) ?: ""
    val canBack: Boolean get() = cursor > 0
    val canForward: Boolean get() = cursor < history.lastIndex

    /** Short label for the tab strip, derived from the current url. */
    fun title(): String = UrlPaths.tabTitle(current)
}
