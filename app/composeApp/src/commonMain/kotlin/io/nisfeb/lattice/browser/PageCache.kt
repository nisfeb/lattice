package io.nisfeb.lattice.browser

import io.nisfeb.lattice.gemtext.GemLine

/** A rendered page kept for instant re-display on revisit (stale-while-revalidate).
 *  [mark] is the grub mark; blank is treated as gemtext (the common case). */
data class CachedPage(val body: String, val lines: List<GemLine>, val mark: String = "")

/**
 * Bounded, recency-ordered cache of fetched pages keyed by urb:// url. Read and
 * written only from the browser's load path + the live-update collector (main
 * thread), so it needn't be thread-safe or observable — the tab's own state
 * drives recomposition.
 */
class PageCache(private val max: Int = 200) {
    private val map = LinkedHashMap<String, CachedPage>()

    operator fun get(url: String): CachedPage? = map[url]

    operator fun set(url: String, page: CachedPage) {
        map.remove(url)        // re-insert at the end → most-recently used
        map[url] = page
        while (map.size > max) map.remove(map.keys.first())
    }
}
