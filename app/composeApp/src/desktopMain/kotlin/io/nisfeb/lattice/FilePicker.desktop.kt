package io.nisfeb.lattice

import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.awt.FileDialog
import java.awt.Frame
import java.io.File

@Composable
actual fun rememberFileExporter(): (String, String) -> Unit {
    val scope = rememberCoroutineScope()
    return { name, content ->
        // FileDialog blocks; run it off the UI thread.
        scope.launch(Dispatchers.IO) {
            val dialog = FileDialog(null as Frame?, "Export lattice content", FileDialog.SAVE)
            dialog.file = name
            dialog.isVisible = true
            val d = dialog.directory
            val f = dialog.file
            if (d != null && f != null) runCatching { File(d, f).writeText(content) }
        }
    }
}

@Composable
actual fun rememberFileImporter(onPicked: (String) -> Unit): () -> Unit {
    val scope = rememberCoroutineScope()
    return {
        scope.launch(Dispatchers.IO) {
            val dialog = FileDialog(null as Frame?, "Import lattice content", FileDialog.LOAD)
            dialog.isVisible = true
            val d = dialog.directory
            val f = dialog.file
            if (d != null && f != null) {
                val text = runCatching { File(d, f).readText() }.getOrNull()
                if (text != null) withContext(Dispatchers.Main) { onPicked(text) }
            }
        }
    }
}
