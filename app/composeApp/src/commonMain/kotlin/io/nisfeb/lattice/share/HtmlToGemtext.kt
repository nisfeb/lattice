package io.nisfeb.lattice.share

/**
 * Best-effort HTML → gemtext converter for the share-to-Lattice flow. Web
 * pages are messy and the mapping is lossy by nature; this aims for a readable
 * gemtext rendering of article-like pages, not perfect fidelity.
 *
 * Rules:
 *  - `<h1>`→`#`, `<h2>`→`##`, `<h3>`..`<h6>`→`###`
 *  - `<p>`/`<div>`/`<br>` flush a paragraph; `<li>`→`* `; `<blockquote>`→`> `
 *  - `<pre>` is fenced with ``` and kept verbatim
 *  - anchor text stays inline in the prose; the link itself is emitted as a
 *    `=> href text` line after the block (gemtext links must be on their own
 *    line, so this is the standard "links collected per block" style)
 *  - `<script>`/`<style>`/`<head>`/`<svg>`/`<noscript>` and comments are dropped
 *  - HTML entities are decoded
 */
object HtmlToGemtext {

    fun convert(html: String, baseUrl: String? = null): String {
        val cleaned = stripNonContent(html)
        val region = contentRegion(cleaned)
        return Tokenizer(region, baseUrl).run()
    }

    /** Page title from `<title>`, falling back to the first `<h1>`. */
    fun extractTitle(html: String): String? {
        TITLE_RE.find(html)?.groupValues?.get(1)?.let { t ->
            val s = decodeEntities(stripTags(t)).trim()
            if (s.isNotEmpty()) return s
        }
        H1_RE.find(html)?.groupValues?.get(1)?.let { t ->
            val s = decodeEntities(stripTags(t)).trim()
            if (s.isNotEmpty()) return s
        }
        return null
    }

    // ───────── preprocessing ─────────

    private fun stripNonContent(html: String): String =
        html
            .replace(COMMENT_RE, " ")
            .replace(DROP_BLOCK_RE, " ")

    /** Prefer an <article> or <main> region; else <body>; else the whole doc. */
    private fun contentRegion(html: String): String {
        ARTICLE_RE.find(html)?.groupValues?.get(1)?.let { if (it.isNotBlank()) return it }
        MAIN_RE.find(html)?.groupValues?.get(1)?.let { if (it.isNotBlank()) return it }
        BODY_RE.find(html)?.groupValues?.get(1)?.let { if (it.isNotBlank()) return it }
        return html
    }

    // ───────── tokenizing state machine ─────────

    private class Tokenizer(private val src: String, private val baseUrl: String?) {
        private val out = StringBuilder()
        private val para = StringBuilder()
        private val links = mutableListOf<Pair<String, String>>()
        private var headingLevel: Int? = null
        private var pendingBullet = false
        private var quoteDepth = 0
        private var inPre = false
        private val pre = StringBuilder()
        private var anchorHref: String? = null
        private val anchorText = StringBuilder()

        fun run(): String {
            var i = 0
            val n = src.length
            while (i < n) {
                val c = src[i]
                if (c == '<') {
                    val end = src.indexOf('>', i + 1)
                    if (end < 0) break
                    handleTag(src.substring(i + 1, end))
                    i = end + 1
                } else {
                    val end = src.indexOf('<', i).let { if (it < 0) n else it }
                    appendText(src.substring(i, end))
                    i = end
                }
            }
            flushPara()
            return out.toString().replace(BLANKS_RE, "\n\n").trim() + "\n"
        }

        private fun appendText(raw: String) {
            val text = decodeEntities(raw)
            if (inPre) { pre.append(text); return }
            val target = if (anchorHref != null) anchorText else para
            target.append(text)
        }

        private fun handleTag(tag: String) {
            val closing = tag.startsWith("/")
            val name = tag.removePrefix("/").trimStart()
                .takeWhile { !it.isWhitespace() && it != '/' }
                .lowercase()
            when (name) {
                "h1", "h2", "h3", "h4", "h5", "h6" -> {
                    if (closing) { flushPara(); headingLevel = null }
                    else { flushPara(); headingLevel = name.substring(1).toInt() }
                }
                "li" -> { flushPara(); if (!closing) pendingBullet = true }
                "blockquote" -> { flushPara(); if (closing) quoteDepth = (quoteDepth - 1).coerceAtLeast(0) else quoteDepth++ }
                "pre" -> {
                    if (closing) { emitPre(); inPre = false } else { flushPara(); inPre = true; pre.clear() }
                }
                "a" -> {
                    if (closing) closeAnchor() else { flushAnchor(); anchorHref = resolve(attr(tag, "href")); anchorText.clear() }
                }
                "img" -> if (!closing) {
                    val src = resolve(attr(tag, "src"))
                    if (src != null) links.add(src to ("[image] " + attr(tag, "alt")).trim())
                }
                "br" -> if (!inPre) flushPara()
                "p", "div", "section", "article", "header", "footer", "main",
                "ul", "ol", "table", "tr", "hr", "figure", "figcaption", "nav", "aside" ->
                    if (!inPre) flushPara()
                // inline / ignored tags: span, b, i, em, strong, code, small, … — keep their text
            }
        }

        private fun closeAnchor() {
            val href = anchorHref ?: return
            val text = collapse(anchorText.toString()).trim()
            para.append(text.ifEmpty { href })
            links.add(href to text)
            anchorHref = null
            anchorText.clear()
        }

        // An <a> opened while one was already open (malformed) — salvage the first.
        private fun flushAnchor() { if (anchorHref != null) closeAnchor() }

        private fun emitPre() {
            val body = pre.toString().trim('\n')
            if (body.isBlank()) return
            out.append("```\n").append(body).append("\n```\n\n")
        }

        private fun flushPara() {
            val text = collapse(para.toString()).trim()
            para.clear()
            if (text.isNotEmpty()) {
                val prefix = when {
                    headingLevel != null -> "#".repeat(minOf(headingLevel!!, 3)) + " "
                    pendingBullet -> "* "
                    quoteDepth > 0 -> "> "
                    else -> ""
                }
                out.append(prefix).append(text).append("\n")
            }
            for ((href, t) in links) {
                val label = collapse(t).trim().ifBlank { href }
                out.append("=> ").append(href).append(' ').append(label).append("\n")
            }
            val wrote = text.isNotEmpty() || links.isNotEmpty()
            links.clear()
            if (wrote) out.append("\n")
            pendingBullet = false
        }

        private fun resolve(href: String?): String? {
            val h = href?.trim()?.takeIf { it.isNotEmpty() && !it.startsWith("#") && !it.startsWith("javascript:") } ?: return null
            val base = baseUrl ?: return h
            return when {
                Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(h) -> h     // absolute (has scheme)
                h.startsWith("//") -> base.substringBefore("://", "https") + "://" + h.removePrefix("//")
                h.startsWith("/") -> origin(base) + h
                else -> {
                    // Directory of the base path, computed after the origin so the
                    // scheme's "//" is never mistaken for a path separator.
                    val org = origin(base)
                    org + base.removePrefix(org).substringBeforeLast('/', "") + "/" + h
                }
            }
        }

        private fun origin(url: String): String {
            val schemeEnd = url.indexOf("://")
            if (schemeEnd < 0) return url
            val afterScheme = schemeEnd + 3
            val slash = url.indexOf('/', afterScheme)
            return if (slash < 0) url else url.substring(0, slash)
        }
    }

    // ───────── helpers ─────────

    private fun collapse(s: String): String = s.replace(WS_RE, " ")

    private fun attr(tag: String, name: String): String {
        val m = Regex("""\b${Regex.escape(name)}\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))""", RegexOption.IGNORE_CASE).find(tag)
            ?: return ""
        return decodeEntities(m.groupValues[2].ifEmpty { m.groupValues[3].ifEmpty { m.groupValues[4] } })
    }

    private fun stripTags(s: String): String = s.replace(TAG_RE, "")

    fun decodeEntities(s: String): String {
        if ('&' !in s) return s
        return s.replace(ENTITY_RE) { m ->
            val body = m.groupValues[1]
            when {
                body.startsWith("#x") || body.startsWith("#X") ->
                    body.substring(2).toIntOrNull(16)?.let { codePointToString(it) } ?: m.value
                body.startsWith("#") ->
                    body.substring(1).toIntOrNull()?.let { codePointToString(it) } ?: m.value
                else -> NAMED_ENTITIES[body] ?: m.value
            }
        }
    }

    private fun codePointToString(cp: Int): String = when {
        cp < 0 || cp > 0x10FFFF -> ""
        cp <= 0xFFFF -> cp.toChar().toString()
        else -> {
            val c = cp - 0x10000
            charArrayOf((0xD800 + (c shr 10)).toChar(), (0xDC00 + (c and 0x3FF)).toChar()).concatToString()
        }
    }

    private val COMMENT_RE = Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL)
    private val DROP_BLOCK_RE = Regex("<(script|style|head|svg|noscript)\\b[^>]*>.*?</\\1>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE))
    private val ARTICLE_RE = Regex("<article\\b[^>]*>(.*?)</article>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE))
    private val MAIN_RE = Regex("<main\\b[^>]*>(.*?)</main>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE))
    private val BODY_RE = Regex("<body\\b[^>]*>(.*?)</body>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE))
    private val TITLE_RE = Regex("<title\\b[^>]*>(.*?)</title>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE))
    private val H1_RE = Regex("<h1\\b[^>]*>(.*?)</h1>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE))
    private val TAG_RE = Regex("<[^>]+>")
    private val WS_RE = Regex("\\s+")
    private val BLANKS_RE = Regex("\n{3,}")
    private val ENTITY_RE = Regex("&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);")

    private val NAMED_ENTITIES = mapOf(
        "amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'",
        "nbsp" to " ", "mdash" to "—", "ndash" to "–", "hellip" to "…",
        "ldquo" to "“", "rdquo" to "”", "lsquo" to "‘", "rsquo" to "’",
        "copy" to "©", "reg" to "®", "trade" to "™", "deg" to "°",
        "middot" to "·", "bull" to "•", "eacute" to "é", "egrave" to "è",
    )
}
