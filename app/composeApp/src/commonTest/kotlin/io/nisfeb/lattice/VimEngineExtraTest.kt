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
}
