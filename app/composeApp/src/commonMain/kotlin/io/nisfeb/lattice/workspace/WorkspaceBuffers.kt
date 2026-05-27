package io.nisfeb.lattice.workspace

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.setValue

/**
 * The open editor buffers across one or two split panes, with per-pane active
 * selection and a focused pane (where new opens land). Pure state — no Compose
 * UI — so the pane juggling is unit-testable; [WorkspaceScreen] just renders it.
 */
class WorkspaceBuffers {
    val buffers = mutableStateListOf<Buffer>()

    /** Number of side-by-side panes: 1 (single) or 2 (split). */
    var splitCount by mutableIntStateOf(1)
        private set

    /** The pane that receives new opens / new files. */
    var focusedPane by mutableIntStateOf(0)
        private set

    // active buffer per pane (index 0 / 1), tracked by reference
    private val activeByPane = mutableStateListOf<Buffer?>(null, null)

    /** The active (selected) buffer in pane [p], or null if it has none. */
    fun activeIn(p: Int): Buffer? = activeByPane.getOrNull(p)?.takeIf { buffers.contains(it) && it.pane == p }

    /** The buffers currently assigned to pane [p]. */
    fun inPane(p: Int): List<Buffer> = buffers.filter { it.pane == p }

    fun bufferFor(source: Source, path: String): Buffer? =
        buffers.firstOrNull { it.source == source && it.path == path }

    /**
     * Open [path]/[source]: if already open, focus it (and its pane) without
     * duplicating; otherwise add a new buffer to the focused pane and select it.
     * Returns the buffer either way.
     */
    fun open(path: String, source: Source, isNew: Boolean = false): Buffer {
        bufferFor(source, path)?.let { existing ->
            focusedPane = existing.pane
            activeByPane[existing.pane] = existing
            return existing
        }
        val b = Buffer(path, source, isNew).also { it.pane = focusedPane }
        buffers.add(b)
        activeByPane[focusedPane] = b
        return b
    }

    /** Select [b] as pane [p]'s active buffer and focus that pane. */
    fun select(p: Int, b: Buffer) {
        if (buffers.contains(b)) {
            activeByPane[p] = b
            focusedPane = p
        }
    }

    fun focus(p: Int) {
        focusedPane = p
    }

    /** Close [b]; if it was its pane's active buffer, fall back to another in that pane. */
    fun close(b: Buffer) {
        val p = b.pane
        buffers.remove(b)
        if (activeByPane[p] === b) activeByPane[p] = buffers.firstOrNull { it.pane == p }
    }

    fun closeFor(source: Source, path: String) {
        bufferFor(source, path)?.let { close(it) }
    }

    /** Move [b] to the other pane, fixing the active selection in both panes. */
    fun moveToOtherPane(b: Buffer) {
        val from = b.pane
        val to = 1 - from
        b.pane = to
        if (activeByPane[from] === b) activeByPane[from] = buffers.firstOrNull { it.pane == from }
        activeByPane[to] = b
        focusedPane = to
    }

    /**
     * Split into two panes ([on] = true) or merge back to one. Merging reparents
     * every pane-1 buffer into pane 0 and recomputes the active selections.
     */
    fun setSplit(on: Boolean) {
        if (on) {
            splitCount = 2
        } else {
            buffers.filter { it.pane == 1 }.forEach { it.pane = 0 }
            if (activeByPane[0] == null) activeByPane[0] = buffers.firstOrNull { it.pane == 0 }
            activeByPane[1] = null
            focusedPane = 0
            splitCount = 1
        }
    }
}
