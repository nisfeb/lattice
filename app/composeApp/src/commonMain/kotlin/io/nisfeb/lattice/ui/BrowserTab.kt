package io.nisfeb.lattice.ui

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.nisfeb.lattice.browser.CachedPage
import io.nisfeb.lattice.browser.PageCache
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
    /** The fetched page's grub mark (e.g. "gmi", "md"); drives which renderer
     *  the reader uses. Blank is treated as gemtext (pages are gemtext). */
    var mark by mutableStateOf("")
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var visited by mutableStateOf(setOf<String>())
    var job: Job? = null
    // Per-tab scroll, so switching tabs restores each one's position. Reassigned
    // (fresh, at top) on a new page load; preserved across tab switches.
    var listState by mutableStateOf(LazyListState())

    val current: String get() = history.getOrNull(cursor) ?: ""
    val canBack: Boolean get() = cursor > 0

    /** Bumped by [pushBody] whenever something outside the browser's own load
     *  path (the SSE live-update collector) replaces the body. A revalidation
     *  fetch captures this at start and hands it to [applyFetch], which then
     *  refuses to overwrite the newer pushed content with its older result. */
    var bodyGen = 0
        private set

    /** Replace the body from a live-update push, marking it newer than any
     *  fetch already in flight for this tab. */
    fun pushBody(newBody: String, newLines: List<GemLine>) {
        bodyGen += 1
        body = newBody; lines = newLines
    }

    /** Apply a completed (re)fetch that captured [gen] from [bodyGen] before it
     *  started. When [gen] is stale — [pushBody] landed while the fetch was in
     *  flight — neither the tab body nor [cache] may regress to the older
     *  fetched content. Otherwise the body swaps only when it actually changed;
     *  listState is left untouched, so the user's scroll is preserved across
     *  the swap (Compose clamps it if the new page is shorter). */
    fun applyFetch(url: String, newBody: String, newLines: List<GemLine>, newMark: String, gen: Int, cache: PageCache) {
        visited = visited + url
        mark = newMark
        if (bodyGen == gen) {
            cache[url] = CachedPage(newBody, newLines, newMark)
            if (newBody != body) { body = newBody; lines = newLines }
        }
        loading = false
    }

    /** Short label for the tab strip, derived from the current url. */
    fun title(): String = UrlPaths.tabTitle(current)
}

/** Active-tab index after closing tab [closed], given the remaining list's
 *  [lastIndex]: closing left of [active] shifts the rest down one (keep
 *  following the tab the user was viewing); closing the active tab selects
 *  its right neighbour, or the new last tab when it was rightmost. */
internal fun activeAfterClose(closed: Int, active: Int, lastIndex: Int): Int =
    if (closed < active) active - 1 else minOf(active, lastIndex)
