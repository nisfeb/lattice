package io.nisfeb.lattice.browser

/** Pure helpers mapping browser URLs to file paths, tab titles, and the
 *  responsive bar's inline/overflow split. Kept out of composables so they're
 *  unit-testable without a UI. */
object UrlPaths {

    /** Ship + path parts of a `urb://~ship/path` url (query stripped). */
    private fun shipAndPath(url: String): Pair<String, String> {
        val after = url.removePrefix("urb://").substringBefore('?')
        val slash = after.indexOf('/')
        val ship = if (slash >= 0) after.substring(0, slash) else after
        val path = if (slash >= 0) after.substring(slash + 1).trim('/') else ""
        return ship to path
    }

    /** Default destination path when copying a page to your ship.
     *  `urb://~tyr/notes/x` → "notes/x"; home `urb://~tyr/` → "tyr". */
    fun defaultDest(url: String): String {
        val (ship, path) = shipAndPath(url)
        return path.ifEmpty { ship.removePrefix("~") }
    }

    /** The editable source path for a page on your own ship, or null if the page
     *  belongs to another ship. Home (`ownPrefix`) maps to the "index" file. */
    fun editPathFor(url: String, ownPrefix: String): String? =
        if (url.startsWith(ownPrefix)) url.removePrefix(ownPrefix).substringBefore('?').ifEmpty { "index" } else null

    /** Short label for a browser tab: the last path segment, or the ship for a
     *  home page; "New tab" before any navigation. */
    fun tabTitle(url: String): String {
        if (url.isBlank()) return "New tab"
        val (ship, path) = shipAndPath(url)
        return if (path.isEmpty()) ship else path.substringAfterLast('/')
    }

    /**
     * How many of [count] right-side bar buttons render inline; the rest go in
     * the ⋮ overflow menu. Reserves [leftButtons]·[unitDp] for nav buttons and
     * [reservedDp] for the minimum URL field. When not all fit, one inline slot
     * is reserved for the overflow button itself.
     */
    fun inlineCount(maxWidthDp: Float, unitDp: Float, leftButtons: Int, reservedDp: Float, count: Int): Int {
        if (unitDp <= 0f) return count
        val avail = (maxWidthDp - unitDp * leftButtons - reservedDp).coerceAtLeast(0f)
        val fit = (avail / unitDp).toInt()
        return if (fit >= count) count else (fit - 1).coerceAtLeast(0)
    }
}
