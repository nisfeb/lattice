package io.nisfeb.lattice.editor

enum class VimMode { NORMAL, INSERT, VISUAL }

/** A printable key, or a named special key, fed to the engine. */
sealed interface VimKey {
    data class Ch(val c: Char) : VimKey
    data object Esc : VimKey
    data object Enter : VimKey
    data object Backspace : VimKey
}

/**
 * Pure, immutable vim editor state machine — practical-core subset:
 * modes NORMAL/INSERT/VISUAL; motions h j k l w b e 0 $ gg G; edits
 * i a o O I A x dd yy p P u D C; operator+motion d/c/y; counts; ex :w/:q/:wq.
 *
 * UI-agnostic: feed it [VimKey]s, render [lines]/[row]/[col]/[mode]. Save/quit
 * are surfaced as one-shot flags ([saveRequested]/[quitRequested]) the host
 * consumes and clears via [consumeSignals].
 */
data class VimEngine(
    val lines: List<String> = listOf(""),
    val row: Int = 0,
    val col: Int = 0,
    val mode: VimMode = VimMode.NORMAL,
    val message: String = "",
    val dirty: Boolean = false,
    val ex: String? = null,                 // ex line being typed (null = not in ex)
    val pendingOp: Char? = null,            // 'd' 'c' 'y' awaiting a motion
    val pendingG: Boolean = false,          // saw leading 'g'
    val count: Int = 0,                     // numeric prefix (0 = none)
    val yankLines: List<String>? = null,    // linewise register
    val yankText: String? = null,           // charwise register
    val visAnchor: Pair<Int, Int>? = null,  // VISUAL selection origin
    val undo: List<Triple<List<String>, Int, Int>> = emptyList(),
    val saveRequested: Boolean = false,
    val quitRequested: Boolean = false,
) {
    val curLine: String get() = lines.getOrElse(row) { "" }

    fun text(): String = lines.joinToString("\n")

    fun consumeSignals(): VimEngine = copy(saveRequested = false, quitRequested = false)

    fun handle(key: VimKey): VimEngine = when (mode) {
        VimMode.INSERT -> insert(key)
        VimMode.NORMAL, VimMode.VISUAL -> if (ex != null) exKey(key) else normal(key)
    }

    // ───────── helpers ─────────

    private fun snapshot(): VimEngine = copy(undo = undo + Triple(lines, row, col))

    private fun clampNormal(r: Int, c: Int): VimEngine {
        val rr = r.coerceIn(0, lines.lastIndex)
        val len = lines[rr].length
        val cc = c.coerceIn(0, maxOf(0, if (mode == VimMode.INSERT) len else len - 1))
        return copy(row = rr, col = cc)
    }

    private fun withLines(newLines: List<String>, r: Int, c: Int): VimEngine {
        val ls = newLines.ifEmpty { listOf("") }
        return copy(lines = ls, dirty = true).let {
            val rr = r.coerceIn(0, ls.lastIndex)
            val len = ls[rr].length
            it.copy(row = rr, col = c.coerceIn(0, maxOf(0, if (mode == VimMode.INSERT) len else len - 1)))
        }
    }

    // ───────── INSERT ─────────

    private fun insert(key: VimKey): VimEngine = when (key) {
        is VimKey.Esc -> clampNormal(row, col - 1).copy(mode = VimMode.NORMAL)
        is VimKey.Ch -> {
            val l = curLine
            val nl = l.substring(0, col) + key.c + l.substring(col)
            copy(lines = lines.replace(row, nl), col = col + 1, dirty = true)
        }
        is VimKey.Enter -> {
            val l = curLine
            val before = l.substring(0, col)
            val after = l.substring(col)
            copy(lines = lines.replaceWith(row, listOf(before, after)), row = row + 1, col = 0, dirty = true)
        }
        is VimKey.Backspace -> when {
            col > 0 -> {
                val l = curLine
                copy(lines = lines.replace(row, l.removeRange(col - 1, col)), col = col - 1, dirty = true)
            }
            row > 0 -> {
                val prev = lines[row - 1]
                val merged = prev + curLine
                copy(lines = lines.merge(row - 1, row, merged), row = row - 1, col = prev.length, dirty = true)
            }
            else -> this
        }
    }

    // ───────── ex line ─────────

    private fun exKey(key: VimKey): VimEngine = when (key) {
        is VimKey.Esc -> copy(ex = null)
        is VimKey.Backspace -> {
            val e = ex ?: ""
            if (e.isEmpty()) copy(ex = null) else copy(ex = e.dropLast(1))
        }
        is VimKey.Ch -> copy(ex = (ex ?: "") + key.c)
        is VimKey.Enter -> runEx(ex ?: "")
    }

    private fun runEx(cmd: String): VimEngine = when (cmd.trim()) {
        "w" -> copy(ex = null, saveRequested = true, message = "saving…")
        "q" -> copy(ex = null, quitRequested = true)
        "wq", "x" -> copy(ex = null, saveRequested = true, quitRequested = true, message = "saving…")
        else -> copy(ex = null, message = "unknown command: $cmd")
    }

    // ───────── NORMAL / VISUAL ─────────

    private fun normal(key: VimKey): VimEngine {
        if (key is VimKey.Esc) return copy(mode = VimMode.NORMAL, pendingOp = null, pendingG = false, count = 0, visAnchor = null)
        if (key !is VimKey.Ch) return this
        val c = key.c
        val n = if (count == 0) 1 else count

        // numeric prefix (0 is a motion only when no count is building)
        if (c.isDigit() && !(c == '0' && count == 0)) {
            return copy(count = count * 10 + (c - '0'))
        }
        // pending 'g' (gg)
        if (pendingG) {
            return if (c == 'g') applyMotionOrOp(Motion.FileStart, n).copy(pendingG = false, count = 0)
            else copy(pendingG = false, count = 0)
        }
        // operator awaiting motion?
        pendingOp?.let { op ->
            val m = motionFor(c)
            return when {
                c == op -> applyLinewise(op, n).reset()           // dd/yy/cc
                m != null -> applyOperator(op, m, n).reset()
                else -> reset()                                    // invalid, cancel
            }
        }

        return when (c) {
            // motions
            'h', 'l', 'j', 'k', 'w', 'b', 'e', '0', '$' ->
                applyMotionOrOp(motionFor(c)!!, n).copy(count = 0)
            'G' -> applyMotionOrOp(Motion.FileEnd, if (count == 0) -1 else count).copy(count = 0)
            'g' -> copy(pendingG = true)
            // mode entry
            'i' -> copy(mode = VimMode.INSERT, count = 0)
            'I' -> clampInsert(firstNonBlank(curLine)).copy(mode = VimMode.INSERT, count = 0)
            'a' -> clampInsert(col + 1).copy(mode = VimMode.INSERT, count = 0)
            'A' -> clampInsert(curLine.length).copy(mode = VimMode.INSERT, count = 0)
            'o' -> snapshot().let {
                it.copy(lines = it.lines.replaceWith(row, listOf(curLine, "")), row = row + 1, col = 0, mode = VimMode.INSERT, dirty = true, count = 0)
            }
            'O' -> snapshot().let {
                it.copy(lines = it.lines.replaceWith(row, listOf("", curLine)), col = 0, mode = VimMode.INSERT, dirty = true, count = 0)
            }
            // edits
            'x' -> snapshot().deleteChars(n).copy(count = 0)
            'D' -> snapshot().copy(lines = lines.replace(row, curLine.take(col)), dirty = true, count = 0).clamp()
            'C' -> snapshot().copy(lines = lines.replace(row, curLine.take(col)), mode = VimMode.INSERT, dirty = true, count = 0)
            'p' -> paste(after = true).copy(count = 0)
            'P' -> paste(after = false).copy(count = 0)
            'u' -> undo().copy(count = 0)
            'd', 'c', 'y' ->
                if (mode == VimMode.VISUAL) applyVisual(c) else copy(pendingOp = c)
            'v' -> if (mode == VimMode.VISUAL) copy(mode = VimMode.NORMAL, visAnchor = null)
            else copy(mode = VimMode.VISUAL, visAnchor = row to col, count = 0)
            ':' -> copy(ex = "", count = 0)
            else -> copy(count = 0)
        }
    }

    private fun reset(): VimEngine = copy(pendingOp = null, pendingG = false, count = 0)
    private fun clamp(): VimEngine = clampNormal(row, col)
    private fun clampInsert(c: Int): VimEngine = copy(col = c.coerceIn(0, curLine.length))

    // ───────── motions ─────────

    private enum class Motion { Left, Right, Up, Down, WordFwd, WordBack, WordEnd, LineStart, LineEnd, FileStart, FileEnd }

    private fun motionFor(c: Char): Motion? = when (c) {
        'h' -> Motion.Left; 'l' -> Motion.Right; 'j' -> Motion.Down; 'k' -> Motion.Up
        'w' -> Motion.WordFwd; 'b' -> Motion.WordBack; 'e' -> Motion.WordEnd
        '0' -> Motion.LineStart; '$' -> Motion.LineEnd
        else -> null
    }

    /** Apply a bare motion [n] times (moves the cursor). */
    private fun applyMotionOrOp(m: Motion, n: Int): VimEngine {
        var s = this
        val times = if (m == Motion.FileEnd) 1 else n
        repeat(times) { s = s.moveOnce(m, n) }
        return s.clampNormal(s.row, s.col)
    }

    private fun moveOnce(m: Motion, n: Int): VimEngine = when (m) {
        Motion.Left -> copy(col = maxOf(0, col - 1))
        Motion.Right -> copy(col = minOf(maxOf(0, curLine.length - 1), col + 1))
        Motion.Up -> if (row > 0) clampNormal(row - 1, col) else this
        Motion.Down -> if (row < lines.lastIndex) clampNormal(row + 1, col) else this
        Motion.LineStart -> copy(col = 0)
        Motion.LineEnd -> copy(col = maxOf(0, curLine.length - 1))
        Motion.WordFwd -> wordForward()
        Motion.WordBack -> wordBackward()
        Motion.WordEnd -> wordEnd()
        Motion.FileStart -> clampNormal(0, 0)
        Motion.FileEnd -> clampNormal(if (n <= 0) lines.lastIndex else (n - 1), 0)
    }

    private fun firstNonBlank(s: String): Int = s.indexOfFirst { !it.isWhitespace() }.let { if (it < 0) 0 else it }

    private fun wordForward(): VimEngine {
        var r = row; var c = col
        val flat = lines
        // skip current word chars, then whitespace, landing on next word start
        fun ch(rr: Int, cc: Int): Char? = flat.getOrNull(rr)?.getOrNull(cc)
        var x = c
        val line = flat[r]
        while (x < line.length && !line[x].isWhitespace()) x++
        while (x < line.length && line[x].isWhitespace()) x++
        if (x >= line.length && r < flat.lastIndex) { r++; x = firstNonBlank(flat[r]) }
        return clampNormal(r, x)
    }

    private fun wordBackward(): VimEngine {
        var r = row; var x = col
        if (x == 0 && r > 0) { r--; x = lines[r].length }
        x = maxOf(0, x - 1)
        val line = lines[r]
        while (x > 0 && line[x].isWhitespace()) x--
        while (x > 0 && !line[x - 1].isWhitespace()) x--
        return clampNormal(r, x)
    }

    private fun wordEnd(): VimEngine {
        val line = curLine
        var x = col + 1
        while (x < line.length && line[x].isWhitespace()) x++
        while (x + 1 < line.length && !line[x + 1].isWhitespace()) x++
        return clampNormal(row, minOf(x, maxOf(0, line.length - 1)))
    }

    // ───────── edits ─────────

    private fun deleteChars(n: Int): VimEngine {
        val l = curLine
        if (l.isEmpty()) return this
        val end = minOf(l.length, col + n)
        val removed = l.substring(col, end)
        return copy(lines = lines.replace(row, l.removeRange(col, end)), yankText = removed, yankLines = null).clamp()
    }

    private fun applyLinewise(op: Char, n: Int): VimEngine {
        val end = minOf(lines.size, row + n)
        val taken = lines.subList(row, end).toList()
        return when (op) {
            'y' -> copy(yankLines = taken, yankText = null, message = "${taken.size} lines yanked")
            'd' -> snapshot().let {
                val rest = it.lines.toMutableList().apply { subList(row, end).clear() }
                it.copy(yankLines = taken, yankText = null).withLines(rest, row, 0)
            }
            'c' -> snapshot().let {
                val ml = it.lines.toMutableList()
                for (i in row until end) { /* clear */ }
                val rest = ml.apply { subList(row, end).clear(); add(row, "") }
                it.copy(yankLines = taken, yankText = null, mode = VimMode.INSERT).withLines(rest, row, 0)
            }
            else -> this
        }
    }

    private fun applyOperator(op: Char, m: Motion, n: Int): VimEngine {
        // line-oriented motions → linewise op
        if (m == Motion.Down || m == Motion.Up || m == Motion.FileStart || m == Motion.FileEnd) {
            val target = moveOnce(m, if (m == Motion.FileEnd) (if (count == 0) lines.lastIndex + 1 else count) else n)
            val lo = minOf(row, target.row); val hi = maxOf(row, target.row)
            return copy(row = lo).applyLinewise(op, hi - lo + 1)
        }
        // charwise: from cursor to motion target on (assume) same line
        var t = this
        repeat(n) { t = t.moveOnce(m, n) }
        val from = col; val to = t.col
        val l = curLine
        val lo = minOf(from, to); val hi = when (m) {
            Motion.WordEnd, Motion.LineEnd -> minOf(l.length, maxOf(from, to) + 1)
            else -> maxOf(from, to)
        }
        if (t.row != row) return reset() // multi-line charwise not supported; cancel
        val removed = l.substring(lo.coerceIn(0, l.length), hi.coerceIn(0, l.length))
        val base = snapshot().copy(lines = lines.replace(row, l.removeRange(lo.coerceIn(0, l.length), hi.coerceIn(0, l.length))), yankText = removed, yankLines = null)
        return when (op) {
            'd' -> base.copy(col = lo).clamp()
            'c' -> base.copy(col = lo, mode = VimMode.INSERT)
            'y' -> copy(yankText = removed, yankLines = null) // yank doesn't modify
            else -> this
        }
    }

    private fun applyVisual(op: Char): VimEngine {
        val a = visAnchor ?: return copy(mode = VimMode.NORMAL)
        val (ar, ac) = a
        // charwise within a line, else linewise across lines
        return if (ar == row) {
            val l = curLine
            val lo = minOf(ac, col); val hi = minOf(l.length, maxOf(ac, col) + 1)
            val removed = l.substring(lo, hi)
            when (op) {
                'y' -> copy(mode = VimMode.NORMAL, visAnchor = null, yankText = removed, yankLines = null, col = lo)
                'd' -> snapshot().copy(lines = lines.replace(row, l.removeRange(lo, hi)), yankText = removed, yankLines = null, mode = VimMode.NORMAL, visAnchor = null, col = lo).clamp()
                'c' -> snapshot().copy(lines = lines.replace(row, l.removeRange(lo, hi)), yankText = removed, yankLines = null, mode = VimMode.INSERT, visAnchor = null, col = lo)
                else -> this
            }
        } else {
            val lo = minOf(ar, row); val hi = maxOf(ar, row)
            copy(row = lo, mode = VimMode.NORMAL, visAnchor = null).applyLinewise(op, hi - lo + 1)
        }
    }

    private fun paste(after: Boolean): VimEngine = when {
        yankLines != null -> snapshot().let {
            val at = if (after) row + 1 else row
            val nl = it.lines.toMutableList().apply { addAll(at, yankLines) }
            it.withLines(nl, at, 0)
        }
        yankText != null -> snapshot().let {
            val l = curLine
            val at = if (after && l.isNotEmpty()) col + 1 else col
            it.copy(lines = it.lines.replace(row, l.substring(0, at) + yankText + l.substring(at)), col = at + yankText.length - 1, dirty = true)
        }
        else -> this
    }

    private fun undo(): VimEngine {
        val last = undo.lastOrNull() ?: return copy(message = "already at oldest change")
        return copy(lines = last.first, row = last.second, col = last.third, undo = undo.dropLast(1)).clamp()
    }

    companion object {
        fun of(text: String): VimEngine =
            VimEngine(lines = if (text.isEmpty()) listOf("") else text.split("\n"))
    }
}

// ── small list helpers ──
private fun List<String>.replace(i: Int, s: String): List<String> =
    toMutableList().also { it[i] = s }

private fun List<String>.replaceWith(i: Int, repl: List<String>): List<String> =
    toMutableList().also { it.removeAt(i); it.addAll(i, repl) }

private fun List<String>.merge(i: Int, j: Int, s: String): List<String> =
    toMutableList().also { it[i] = s; it.removeAt(j) }
