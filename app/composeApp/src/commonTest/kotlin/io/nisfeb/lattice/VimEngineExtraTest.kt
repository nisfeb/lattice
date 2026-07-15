package io.nisfeb.lattice

import io.nisfeb.lattice.editor.VimEngine
import io.nisfeb.lattice.editor.VimKey
import io.nisfeb.lattice.editor.VimMode
import kotlin.test.Test
import kotlin.test.assertEquals

private fun VimEngine.keys(s: String): VimEngine = s.fold(this) { e, c -> e.handle(VimKey.Ch(c)) }

class VimEngineExtraTest {

    @Test fun countedDownMotion() {
        val e = VimEngine.of("1\n2\n3\n4\n5").keys("3j")
        assertEquals(3, e.row)
    }

    @Test fun deleteToEndOfLine() {
        // "hello": lll → col 3; D deletes to EOL
        val e = VimEngine.of("hello").keys("lll").keys("D")
        assertEquals("hel", e.text())
    }

    @Test fun pasteCharwiseAfterDeleteChar() {
        // x deletes 'a' (charwise yank), cursor on 'b'; p pastes after → "bac"
        val e = VimEngine.of("abc").keys("x").keys("p")
        assertEquals("bac", e.text())
    }

    @Test fun visualLinewiseDelete() {
        // v enters visual at (0,0); j extends to next line; d deletes both lines
        val e = VimEngine.of("a\nb\nc").keys("v").keys("j").keys("d")
        assertEquals("c", e.text())
        assertEquals(VimMode.NORMAL, e.mode)
    }

    @Test fun appendAtEndOfLine() {
        val e = VimEngine.of("hi").keys("A").keys("!").handle(VimKey.Esc)
        assertEquals("hi!", e.text())
    }

    @Test fun deleteEmojiRemovesWholeSurrogatePair() {
        // "plan 👍 done": w lands on the emoji; x must remove both UTF-16 units
        val e = VimEngine.of("plan 👍 done").keys("wx")
        assertEquals("plan  done", e.text())
    }

    @Test fun motionsStepOverSurrogatePairs() {
        // "a👍b" in UTF-16 units: a=0, pair=1..2, b=3
        val e = VimEngine.of("a👍b")
        assertEquals(1, e.keys("l").col)    // onto the pair start
        assertEquals(3, e.keys("ll").col)   // over the pair onto 'b'
        assertEquals(1, e.keys("llh").col)  // back onto the pair start, not mid-pair
    }

    @Test fun wordEndStepsPastSurrogatePairWord() {
        // "plan 👍 done": plan=0..3, pair=5..6, done=8..11. Repeated e must not
        // trap on the emoji word (regression: wordEnd stepped +1 unit, landing
        // mid-pair and snapping back forever).
        val e = VimEngine.of("plan 👍 done")
        assertEquals(3, e.keys("e").col)      // end of "plan"
        assertEquals(5, e.keys("ee").col)     // onto the emoji (its own word)
        assertEquals(11, e.keys("eee").col)   // past it, end of "done"
    }

    @Test fun deleteToEndOfFile() {
        // dG from line 1 deletes lines 1..end
        val e = VimEngine.of("a\nb\nc\nd\ne").keys("jdG")
        assertEquals("a", e.text())
    }

    @Test fun deleteToStartOfFile() {
        val e = VimEngine.of("a\nb\nc").keys("jdgg")
        assertEquals("c", e.text())
    }

    @Test fun yankToEndOfFile() {
        val e = VimEngine.of("a\nb\nc").keys("jyG")
        assertEquals(listOf("b", "c"), e.yankLines)
        assertEquals("a\nb\nc", e.text()) // yank doesn't modify
    }

    @Test fun countedLinewiseOperatorMotion() {
        // d2j deletes the current line plus the two below, like vim
        assertEquals("d", VimEngine.of("a\nb\nc\nd").keys("d2j").text())
        // count before the operator behaves the same
        assertEquals("d", VimEngine.of("a\nb\nc\nd").keys("2dj").text())
    }

    @Test fun emptyCharwisePasteIsNoOp() {
        // dh at column 0 leaves an empty charwise register; P must not push col to -1
        val e = VimEngine.of("ab").keys("dhP")
        assertEquals(0, e.col)
        assertEquals("xab", e.keys("ix").handle(VimKey.Esc).text())
    }
}
