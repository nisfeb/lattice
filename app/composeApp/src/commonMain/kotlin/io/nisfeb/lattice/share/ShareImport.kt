package io.nisfeb.lattice.share

/** Content handed to Lattice from the OS share sheet: shared [text] (a URL or
 *  the body of a text file) plus an optional [title] hint (EXTRA_SUBJECT /
 *  filename). */
data class SharedContent(val text: String, val title: String? = null)

/** Pure helpers for turning shared content into a gemtext file on the ship.
 *  Network fetch + conversion of web pages lives in [WebClipper]; this is the
 *  testable glue (classification, slugging, paths, plain-text wrapping). */
object ShareImport {

    /** Shared content is a single web URL we should fetch + convert, vs. text
     *  to drop in as-is. True only for a lone http(s) URL (no surrounding text). */
    fun isWebUrl(text: String): Boolean = WEB_URL_RE.matches(text.trim())

    /** Folder + slug path on the ship for a shared item titled [title]. */
    fun pathFor(title: String?): String = "shared/" + slugify(title)

    /** The urb:// URL a [path] on [ship] resolves to. */
    fun urbUrl(ship: String, path: String): String = "urb://$ship/$path"

    /** Upgrade a clipped page URL to https. The app's network-security policy
     *  forbids cleartext (to protect ship credentials), and virtually every site
     *  serves — or redirects to — https, so we fetch securely rather than fail. */
    fun secureUrl(url: String): String = url.replaceFirst(HTTP_RE, "https://")

    /** Wrap plain shared text as gemtext: a title heading (if any) then the body
     *  verbatim — text is already gemtext-compatible. */
    fun gemtextForText(title: String?, body: String): String {
        val head = title?.trim()?.takeIf { it.isNotEmpty() }?.let { "# $it\n\n" } ?: ""
        return head + body.trim() + "\n"
    }

    /** A display title derived from shared text when no subject was supplied:
     *  the first non-blank line, stripped of leading gemtext/markdown markers,
     *  capped in length. Null if the body is blank. */
    fun titleFromText(body: String): String? =
        body.lineSequence()
            .map { it.trim().trimStart('#', '>', '*', '-', ' ') }
            .firstOrNull { it.isNotBlank() }
            ?.take(80)

    /** A filesystem-safe slug from a title: lowercase, non-alphanumerics → '-',
     *  collapsed and trimmed, capped in length. Empty input → "clip". */
    fun slugify(title: String?): String {
        val s = (title ?: "").lowercase()
            .replace(NON_SLUG_RE, "-")
            .replace(DASHES_RE, "-")
            .trim('-')
            .take(60)
            .trim('-')
        return s.ifEmpty { "clip" }
    }

    private val WEB_URL_RE = Regex("""(?i)^https?://\S+$""")
    private val HTTP_RE = Regex("(?i)^http://")
    private val NON_SLUG_RE = Regex("[^a-z0-9]+")
    private val DASHES_RE = Regex("-{2,}")
}
