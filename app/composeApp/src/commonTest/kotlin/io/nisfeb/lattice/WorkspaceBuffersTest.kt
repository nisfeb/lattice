package io.nisfeb.lattice

import io.nisfeb.lattice.workspace.Source
import io.nisfeb.lattice.workspace.WorkspaceBuffers
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class WorkspaceBuffersTest {

    @Test fun openAddsBufferAndMakesItActive() {
        val wb = WorkspaceBuffers()
        val b = wb.open("about", Source.Public)
        assertEquals(1, wb.buffers.size)
        assertSame(b, wb.activeIn(0))
        assertEquals(Source.Public, b.source)
        assertEquals(0, b.pane)
    }

    @Test fun reopeningSamePathFocusesNotDuplicates() {
        val wb = WorkspaceBuffers()
        val first = wb.open("notes/a", Source.Public)
        val other = wb.open("notes/b", Source.Public)
        assertSame(other, wb.activeIn(0))
        val again = wb.open("notes/a", Source.Public)
        assertSame(first, again)
        assertEquals(2, wb.buffers.size)        // no duplicate
        assertSame(first, wb.activeIn(0))       // focus moved back to it
    }

    @Test fun samePathDifferentSourceAreDistinctBuffers() {
        val wb = WorkspaceBuffers()
        val page = wb.open("dev/lattice", Source.Public)
        val note = wb.open("dev/lattice", Source.Knowledge)
        assertEquals(2, wb.buffers.size)
        assertFalse(page === note)
    }

    @Test fun closingActivePicksAnotherInThatPane() {
        val wb = WorkspaceBuffers()
        val a = wb.open("a", Source.Public)
        val b = wb.open("b", Source.Public)
        assertSame(b, wb.activeIn(0))
        wb.close(b)
        assertSame(a, wb.activeIn(0))           // fell back to the other buffer
        wb.close(a)
        assertNull(wb.activeIn(0))              // none left
        assertEquals(0, wb.buffers.size)
    }

    @Test fun closingNonActiveLeavesActiveUntouched() {
        val wb = WorkspaceBuffers()
        val a = wb.open("a", Source.Public)
        val b = wb.open("b", Source.Public)
        wb.select(0, a)
        wb.close(b)
        assertSame(a, wb.activeIn(0))
    }

    @Test fun newOpensLandInFocusedPane() {
        val wb = WorkspaceBuffers()
        wb.setSplit(true)
        wb.focus(1)
        val b = wb.open("right", Source.Knowledge)
        assertEquals(1, b.pane)
        assertSame(b, wb.activeIn(1))
        assertNull(wb.activeIn(0))
    }

    @Test fun moveToOtherPaneReassignsAndFixesActive() {
        val wb = WorkspaceBuffers()
        wb.setSplit(true)
        val a = wb.open("a", Source.Public)   // pane 0
        val b = wb.open("b", Source.Public)   // pane 0, active
        wb.moveToOtherPane(b)
        assertEquals(1, b.pane)
        assertSame(b, wb.activeIn(1))         // active in destination
        assertSame(a, wb.activeIn(0))         // source falls back to a
        assertEquals(1, wb.focusedPane)       // focus follows the move
    }

    @Test fun mergeReparentsPaneOneBuffersAndRecomputesActive() {
        val wb = WorkspaceBuffers()
        wb.setSplit(true)
        val a = wb.open("a", Source.Public)   // pane 0
        wb.focus(1)
        val b = wb.open("b", Source.Public)   // pane 1
        assertEquals(2, wb.splitCount)
        wb.setSplit(false)
        assertEquals(1, wb.splitCount)
        assertEquals(0, wb.focusedPane)
        assertEquals(0, b.pane)               // reparented to pane 0
        assertEquals(listOf(a, b), wb.inPane(0))
        assertNull(wb.activeIn(1))
        assertSame(a, wb.activeIn(0))         // pane-0 active preserved
    }

    @Test fun activeInIsNullAfterBufferClosedElsewhere() {
        val wb = WorkspaceBuffers()
        val a = wb.open("a", Source.Public)
        wb.buffers.remove(a)                  // removed without going through close()
        assertNull(wb.activeIn(0))            // activeIn guards against stale refs
    }

    @Test fun bufferTracksTextDirtyLoaded() {
        val wb = WorkspaceBuffers()
        val b = wb.open("a", Source.Public)         // non-new → not yet loaded
        assertFalse(b.loaded)
        b.text = "hello"
        b.dirty = true
        b.loaded = true
        assertEquals("hello", b.text)
        assertTrue(b.dirty)
        assertTrue(b.loaded)
        // a "new" buffer starts loaded (empty body, nothing to fetch)
        assertTrue(wb.open("fresh", Source.Knowledge, isNew = true).loaded)
    }

    @Test fun inPaneFiltersBySource() {
        val wb = WorkspaceBuffers()
        wb.open("p1", Source.Public)
        wb.open("k1", Source.Knowledge)
        assertEquals(2, wb.inPane(0).size)
        assertEquals(setOf("p1", "k1"), wb.inPane(0).map { it.path }.toSet())
    }
}
