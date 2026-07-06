package io.nisfeb.lattice.markdown

/** One inline span within a markdown block. */
sealed interface MdSpan {
    data class Text(val text: String) : MdSpan
    data class Bold(val inner: List<MdSpan>) : MdSpan
    data class Italic(val inner: List<MdSpan>) : MdSpan
    data class Strike(val inner: List<MdSpan>) : MdSpan
    data class Code(val text: String) : MdSpan
    data class Link(val label: String, val href: String) : MdSpan
    data class Image(val alt: String, val src: String) : MdSpan
}

/** One block-level element of a markdown document. */
sealed interface MdBlock {
    data class Heading(val level: Int, val spans: List<MdSpan>) : MdBlock
    data class Paragraph(val spans: List<MdSpan>) : MdBlock
    data class Bullet(val spans: List<MdSpan>) : MdBlock
    data class Numbered(val number: Int, val spans: List<MdSpan>) : MdBlock
    data class Code(val text: String, val lang: String) : MdBlock
    data class Quote(val spans: List<MdSpan>) : MdBlock
    /** A standalone image (a paragraph whose only content is `![alt](src)`). */
    data class Image(val alt: String, val src: String) : MdBlock
    data object Rule : MdBlock
}

/**
 * A small, dependency-free markdown parser targeting a Compose render model.
 * Block structure (headings, lists, fenced code, blockquotes, rules, images)
 * plus the inline styles that show up in real documents (**bold**, *italic* /
 * _italic_, `code`, ~~strike~~, [label](url), ![alt](url), bare URLs). Anything
 * unrecognized passes through as plain text, so content is never dropped.
 *
 * Adapted from Talon's chat markdown tokenizer, retargeted from Tlon story JSON
 * to a render model and extended with image + list handling.
 */
object Markdown {

    fun parse(src: String): List<MdBlock> {
        val out = mutableListOf<MdBlock>()
        val lines = src.replace("\r\n", "\n").replace("\r", "\n").split('\n')
        val para = StringBuilder()

        fun flushParagraph() {
            val s = para.toString().trim()
            para.clear()
            if (s.isEmpty()) return
            val img = loneImage(s)
            if (img != null) out.add(MdBlock.Image(img.first, img.second))
            else out.add(MdBlock.Paragraph(parseInlines(s)))
        }

        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val t = line.trimStart()
            when {
                line.isBlank() -> { flushParagraph(); i++ }

                t.startsWith("```") -> {
                    // Need a closing fence; without one, treat as plain text so
                    // the rest of the document still renders.
                    val close = (i + 1 until lines.size).firstOrNull { lines[it].trimStart().startsWith("```") }
                    if (close == null) { appendLine(para, line); i++ }
                    else {
                        flushParagraph()
                        val lang = t.removePrefix("```").trim()
                        out.add(MdBlock.Code(lines.subList(i + 1, close).joinToString("\n"), lang))
                        i = close + 1
                    }
                }

                headingLevel(t) > 0 -> {
                    flushParagraph()
                    val lvl = headingLevel(t)
                    out.add(MdBlock.Heading(lvl.coerceAtMost(6), parseInlines(t.drop(lvl).trim())))
                    i++
                }

                t == "---" || t == "***" || t == "___" || t.matches(Regex("^([-*_])\\1{2,}$")) -> {
                    flushParagraph(); out.add(MdBlock.Rule); i++
                }

                t.startsWith("> ") || t == ">" -> {
                    flushParagraph()
                    val q = StringBuilder()
                    while (i < lines.size && lines[i].trimStart().let { it.startsWith("> ") || it == ">" }) {
                        appendLine(q, lines[i].trimStart().removePrefix(">").removePrefix(" "))
                        i++
                    }
                    out.add(MdBlock.Quote(parseInlines(q.toString().trim())))
                }

                isBullet(t) -> {
                    flushParagraph()
                    out.add(MdBlock.Bullet(parseInlines(t.drop(2).trim())))
                    i++
                }

                orderedPrefix(t) != null -> {
                    flushParagraph()
                    val (num, rest) = orderedPrefix(t)!!
                    out.add(MdBlock.Numbered(num, parseInlines(rest.trim())))
                    i++
                }

                else -> { appendLine(para, line); i++ }
            }
        }
        flushParagraph()
        return out
    }

    // ───────── block helpers ─────────

    private fun appendLine(sb: StringBuilder, line: String) {
        if (sb.isNotEmpty()) sb.append('\n')
        sb.append(line)
    }

    private fun headingLevel(t: String): Int {
        val n = t.takeWhile { it == '#' }.length
        return if (n in 1..6 && t.getOrNull(n) == ' ') n else 0
    }

    private fun isBullet(t: String): Boolean =
        (t.startsWith("- ") || t.startsWith("* ") || t.startsWith("+ "))

    /** "3. rest" → (3, "rest"); null if not an ordered-list item. */
    private fun orderedPrefix(t: String): Pair<Int, String>? {
        val dot = t.indexOf('.')
        if (dot <= 0 || dot > 9) return null
        val digits = t.substring(0, dot)
        if (!digits.all { it.isDigit() }) return null
        if (t.getOrNull(dot + 1) != ' ') return null
        return digits.toInt() to t.substring(dot + 2)
    }

    /** If [s] is exactly one image `![alt](src)`, return (alt, src). */
    private fun loneImage(s: String): Pair<String, String>? {
        if (!s.startsWith("![")) return null
        val alt = s.indexOf(']')
        if (alt < 0 || s.getOrNull(alt + 1) != '(') return null
        val close = s.indexOf(')', alt + 2)
        if (close != s.length - 1) return null  // trailing content → treat as paragraph
        return s.substring(2, alt) to s.substring(alt + 2, close)
    }

    // ───────── inline tokenizer ─────────

    fun parseInlines(text: String): List<MdSpan> {
        val out = mutableListOf<MdSpan>()
        var i = 0
        val len = text.length
        val plain = StringBuilder()
        fun flushPlain() { if (plain.isNotEmpty()) { out.add(MdSpan.Text(plain.toString())); plain.clear() } }

        while (i < len) {
            val c = text[i]

            // Inline code: `text`
            if (c == '`') {
                val end = text.indexOf('`', i + 1)
                if (end > i) { flushPlain(); out.add(MdSpan.Code(text.substring(i + 1, end))); i = end + 1; continue }
            }

            // Image: ![alt](src)
            if (c == '!' && i + 1 < len && text[i + 1] == '[') {
                val closeB = text.indexOf(']', i + 2)
                if (closeB > i && text.getOrNull(closeB + 1) == '(') {
                    val closeP = text.indexOf(')', closeB + 2)
                    if (closeP > closeB + 1) {
                        flushPlain()
                        out.add(MdSpan.Image(text.substring(i + 2, closeB), text.substring(closeB + 2, closeP)))
                        i = closeP + 1; continue
                    }
                }
            }

            // Bare URL autolink (http/https/urb), at a word boundary.
            if ((c == 'h' || c == 'H' || c == 'u' || c == 'U') && looksLikeUrlStart(text, i)) {
                val end = urlEndAt(text, i)
                if (end > i) {
                    flushPlain()
                    val url = text.substring(i, end)
                    out.add(MdSpan.Link(url, url)); i = end; continue
                }
            }

            // Link: [label](url)
            if (c == '[') {
                val closeB = text.indexOf(']', i + 1)
                if (closeB > i && text.getOrNull(closeB + 1) == '(') {
                    val closeP = text.indexOf(')', closeB + 2)
                    if (closeP > closeB + 1) {
                        flushPlain()
                        out.add(MdSpan.Link(text.substring(i + 1, closeB), text.substring(closeB + 2, closeP)))
                        i = closeP + 1; continue
                    }
                }
            }

            // Bold: **text**
            if (c == '*' && i + 1 < len && text[i + 1] == '*') {
                val end = text.indexOf("**", i + 2)
                if (end > i + 1) { flushPlain(); out.add(MdSpan.Bold(parseInlines(text.substring(i + 2, end)))); i = end + 2; continue }
            }

            // Italic: *text* or _text_
            if ((c == '*' || c == '_') && i + 1 < len && text[i + 1] != c) {
                val end = text.indexOf(c, i + 1)
                if (end > i && !isWordChar(text.getOrNull(end + 1))) {
                    flushPlain(); out.add(MdSpan.Italic(parseInlines(text.substring(i + 1, end)))); i = end + 1; continue
                }
            }

            // Strikethrough: ~~text~~
            if (c == '~' && i + 1 < len && text[i + 1] == '~') {
                val end = text.indexOf("~~", i + 2)
                if (end > i + 1) { flushPlain(); out.add(MdSpan.Strike(parseInlines(text.substring(i + 2, end)))); i = end + 2; continue }
            }

            plain.append(c); i++
        }
        flushPlain()
        return out
    }

    private fun isWordChar(c: Char?): Boolean = c != null && (c.isLetterOrDigit() || c == '_')

    private fun looksLikeUrlStart(text: String, i: Int): Boolean {
        if (i > 0 && isWordChar(text[i - 1])) return false
        return text.regionMatches(i, "http://", 0, 7, ignoreCase = true) ||
            text.regionMatches(i, "https://", 0, 8, ignoreCase = true) ||
            text.regionMatches(i, "urb://", 0, 6, ignoreCase = true)
    }

    private fun urlEndAt(text: String, i: Int): Int {
        var end = i
        while (end < text.length) {
            val ch = text[end]
            if (ch.isWhitespace() || ch == '<' || ch == '>' || ch == '"' || ch == '`' || ch == ']' || ch == ')') break
            end++
        }
        while (end > i) {
            val last = text[end - 1]
            if (last in charArrayOf('.', ',', ';', ':', '!', '?')) end-- else break
        }
        return end
    }
}
