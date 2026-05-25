package io.nisfeb.lattice.gemtext

/**
 * `urb://~ship/path` URL helpers and link resolution.
 *
 * Link targets in gemtext may be: an absolute `urb://~ship/path`; an absolute
 * path `/foo` (resolves against the current ship); a relative `foo` (resolves
 * against the current URL's directory). Foreign schemes (https:, mailto:, …)
 * are not navigable.
 */
object UrbUrl {
    private val SCHEME = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:")

    fun isUrb(u: String): Boolean = u.startsWith("urb://")

    fun hasForeignScheme(u: String): Boolean = SCHEME.containsMatchIn(u) && !isUrb(u)

    /** Split `urb://~ship/a/b` → ("~ship", "/a/b"); path is "" for `urb://~ship`. */
    fun parse(u: String): Pair<String, String>? {
        if (!isUrb(u)) return null
        val rest = u.removePrefix("urb://")
        val slash = rest.indexOf('/')
        return if (slash < 0) rest to "" else rest.substring(0, slash) to rest.substring(slash)
    }

    /** A link is navigable if it's a urb:// URL or a (relative/absolute) path. */
    fun isNavigable(link: String): Boolean = isUrb(link) || !hasForeignScheme(link)

    /**
     * Resolve [link] found on page [current] to an absolute `urb://` URL, or
     * null if the link isn't navigable (foreign scheme).
     */
    fun resolve(current: String, link: String): String? {
        if (isUrb(link)) return link
        if (hasForeignScheme(link)) return null
        val (ship, path) = parse(current) ?: return null
        val combined = if (link.startsWith("/")) link else {
            val dir = path.substringBeforeLast('/', "")
            "$dir/$link"
        }
        return "urb://$ship${normalize(combined)}"
    }

    private fun normalize(p: String): String {
        val stack = ArrayDeque<String>()
        for (seg in p.split("/")) when (seg) {
            "", "." -> {}
            ".." -> if (stack.isNotEmpty()) stack.removeLast()
            else -> stack.addLast(seg)
        }
        return "/" + stack.joinToString("/")
    }
}
