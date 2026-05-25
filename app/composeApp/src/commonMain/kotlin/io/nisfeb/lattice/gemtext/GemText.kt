package io.nisfeb.lattice.gemtext

/** One parsed line of gemtext. */
sealed interface GemLine {
    data class Heading(val level: Int, val text: String) : GemLine
    data class Text(val text: String) : GemLine
    data class Link(val url: String, val desc: String) : GemLine
    data class Bullet(val text: String) : GemLine
    data class Quote(val text: String) : GemLine
    /** A preformatted block (between ``` fences). [alt] is the opening fence's text. */
    data class Pre(val lines: List<String>, val alt: String) : GemLine
}

/**
 * Minimal gemtext parser. Line-oriented per the gemtext spec:
 *   ```        toggles a preformatted block (alt text after the opener)
 *   =>         link line: "=> <url> [description]"
 *   #/##/###   heading (levels 1–3)
 *   "* "       bullet
 *   >          quote
 *   else       text
 */
object GemtextParser {
    fun parse(body: String): List<GemLine> {
        val out = mutableListOf<GemLine>()
        var inPre = false
        var preAlt = ""
        val preBuf = mutableListOf<String>()

        for (raw in body.split("\n")) {
            val line = raw.removeSuffix("\r")
            if (line.startsWith("```")) {
                if (inPre) {
                    out.add(GemLine.Pre(preBuf.toList(), preAlt))
                    preBuf.clear(); preAlt = ""; inPre = false
                } else {
                    inPre = true; preAlt = line.substring(3).trim()
                }
                continue
            }
            if (inPre) { preBuf.add(line); continue }

            when {
                line.startsWith("=>") -> {
                    val rest = line.substring(2).trimStart()
                    val sp = rest.indexOfFirst { it.isWhitespace() }
                    if (sp < 0) out.add(GemLine.Link(rest, ""))
                    else out.add(GemLine.Link(rest.substring(0, sp), rest.substring(sp).trim()))
                }
                line.startsWith("#") -> {
                    val n = line.takeWhile { it == '#' }.length.coerceIn(1, 3)
                    out.add(GemLine.Heading(n, line.dropWhile { it == '#' }.trim()))
                }
                line.startsWith("* ") -> out.add(GemLine.Bullet(line.substring(2).trim()))
                line.startsWith(">") -> out.add(GemLine.Quote(line.substring(1).trim()))
                else -> out.add(GemLine.Text(line))
            }
        }
        if (inPre) out.add(GemLine.Pre(preBuf.toList(), preAlt))
        return out
    }
}
