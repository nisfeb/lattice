package io.nisfeb.lattice

import io.nisfeb.lattice.editor.VimEngine
import io.nisfeb.lattice.editor.VimKey
import io.nisfeb.lattice.editor.VimMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private fun VimEngine.keys(s: String): VimEngine =
    s.fold(this) { e, c -> e.handle(VimKey.Ch(c)) }

private fun VimEngine.esc() = handle(VimKey.Esc)
private fun VimEngine.enter() = handle(VimKey.Enter)

class VimEngineTest {

    @Test fun insertText() {
        val e = VimEngine.of("").keys("i").keys("hello").esc()
        assertEquals("hello", e.text())
        assertEquals(VimMode.NORMAL, e.mode)
    }

    @Test fun openLineBelow() {
        val e = VimEngine.of("a").keys("o").keys("b").esc()
        assertEquals("a\nb", e.text())
    }

    @Test fun motionsAndAppend() {
        // "abc": ll → col 2 (on 'c'); 'a' appends after; type X → "abcX"
        val e = VimEngine.of("abc").keys("ll").keys("a").keys("X").esc()
        assertEquals("abcX", e.text())
    }

    @Test fun deleteChar() {
        val e = VimEngine.of("abc").keys("x")
        assertEquals("bc", e.text())
    }

    @Test fun deleteLine() {
        val e = VimEngine.of("one\ntwo\nthree").keys("j").keys("dd")
        assertEquals("one\nthree", e.text())
    }

    @Test fun deleteWord() {
        val e = VimEngine.of("foo bar baz").keys("dw")
        assertEquals("bar baz", e.text())
    }

    @Test fun changeToEndOfLine() {
        // "hello world": ll → col 2; C deletes to EOL ("he") + INSERT; type "LP"
        val e = VimEngine.of("hello world").keys("ll").keys("C").keys("LP").esc()
        assertEquals("heLP", e.text())
    }

    @Test fun yankPasteLine() {
        val e = VimEngine.of("a\nb").keys("yy").keys("p")
        assertEquals("a\na\nb", e.text())
    }

    @Test fun undo() {
        val e = VimEngine.of("keep").keys("dd").keys("u")
        assertEquals("keep", e.text())
    }

    @Test fun ggAndG() {
        val e = VimEngine.of("1\n2\n3").keys("G")
        assertEquals(2, e.row)
        val top = e.keys("gg")
        assertEquals(0, top.row)
    }

    @Test fun visualDelete() {
        // select first two chars and delete
        val e = VimEngine.of("abcdef").keys("v").keys("l").keys("d")
        assertEquals("cdef", e.text())
        assertEquals(VimMode.NORMAL, e.mode)
    }

    @Test fun exWriteSignals() {
        val e = VimEngine.of("x").keys(":").keys("w").enter()
        assertTrue(e.saveRequested)
        assertEquals(null, e.ex)
    }

    @Test fun countedDelete() {
        val e = VimEngine.of("a\nb\nc\nd").keys("2dd")
        assertEquals("c\nd", e.text())
    }
}
