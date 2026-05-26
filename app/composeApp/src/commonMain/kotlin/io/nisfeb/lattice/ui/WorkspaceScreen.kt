package io.nisfeb.lattice.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.copyToClipboard
import io.nisfeb.lattice.isDesktop
import io.nisfeb.lattice.resources.Res
import io.nisfeb.lattice.resources.dejavusansmono
import io.nisfeb.lattice.urbit.LatticeClient
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.Font

/** File manager + editor. Desktop: sidebar tree + tabs. Mobile: tree → single editor. */
@Composable
fun WorkspaceScreen(
    client: LatticeClient,
    ship: String,
    vimMode: Boolean,
    onClose: () -> Unit,
    initialOpen: String? = null,
    onConsumedOpen: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val monoFamily = FontFamily(Font(Res.font.dejavusansmono))

    var files by remember { mutableStateOf<List<String>>(emptyList()) }
    var dir by remember { mutableStateOf("") }
    var newName by remember { mutableStateOf("") }
    val buffers = remember { mutableListOf<Buffer>().toMutableStateList() }
    var active by remember { mutableIntStateOf(-1) }

    fun refresh() = scope.launch { client.list().onSuccess { files = it } }
    LaunchedEffect(Unit) { refresh() }

    fun openFile(path: String) {
        val existing = buffers.indexOfFirst { it.path == path }
        if (existing >= 0) { active = existing; return }
        val b = Buffer(path, isNew = false)
        buffers.add(b); active = buffers.lastIndex
        scope.launch {
            client.fetch("urb://$ship/$path").onSuccess { b.text = it.body }
            b.loaded = true
        }
    }

    fun newFile(name: String) {
        val full = if (dir.isEmpty()) name else "$dir/$name"
        val b = Buffer(full, isNew = true)
        buffers.add(b); active = buffers.lastIndex
    }

    fun closeTab(i: Int) {
        buffers.removeAt(i)
        active = if (buffers.isEmpty()) -1 else active.coerceAtMost(buffers.lastIndex)
    }

    fun save(b: Buffer) = scope.launch {
        client.save(b.path, b.text).onSuccess { b.dirty = false; refresh() }
    }

    fun closeBufferFor(path: String) {
        buffers.indexOfFirst { it.path == path }.takeIf { it >= 0 }?.let { closeTab(it) }
    }

    // file-action dialogs (delete needs confirmation; duplicate/move prompt for a path)
    var confirmDelete by remember { mutableStateOf<String?>(null) }
    var dupOf by remember { mutableStateOf<String?>(null) }
    var moveOf by remember { mutableStateOf<String?>(null) }
    var dialogName by remember { mutableStateOf("") }
    // The urb:// link just copied to the clipboard (shown in a brief confirmation).
    var copiedLink by remember { mutableStateOf<String?>(null) }

    fun doDuplicate(src: String, dest: String) = scope.launch {
        client.fetch("urb://$ship/$src").onSuccess { client.save(dest, it.body).onSuccess { refresh() } }
    }
    fun doMove(src: String, dest: String) = scope.launch {
        client.fetch("urb://$ship/$src").onSuccess {
            client.save(dest, it.body).onSuccess {
                client.delete(src).onSuccess { closeBufferFor(src); refresh() }
            }
        }
    }

    // open a file requested from elsewhere (e.g. the browser's "Edit this page")
    LaunchedEffect(initialOpen) {
        if (initialOpen != null) { openFile(initialOpen); onConsumedOpen() }
    }

    @Composable
    fun sidebar(modifier: Modifier) = Column(modifier = modifier) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            IconButton(onClick = onClose, modifier = Modifier.size(32.dp)) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to browser", modifier = Modifier.size(18.dp))
            }
            OutlinedTextField(
                value = newName, onValueChange = { newName = it }, singleLine = true,
                placeholder = { Text("new file", style = MaterialTheme.typography.bodySmall) },
                textStyle = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            IconButton(
                onClick = { if (newName.isNotBlank()) { newFile(newName.trim()); newName = "" } },
                enabled = newName.isNotBlank(), modifier = Modifier.size(32.dp),
            ) { Icon(Icons.Filled.Add, "New file", modifier = Modifier.size(18.dp)) }
        }
        FileTree(
            files = files, dir = dir, onDir = { dir = it }, onOpen = { openFile(it) },
            onDelete = { confirmDelete = it },
            onDuplicate = { dupOf = it; dialogName = "$it-copy" },
            onMove = { moveOf = it; dialogName = it },
            onCopyLink = { val link = "urb://$ship/$it"; copyToClipboard(link); copiedLink = link },
            compact = isDesktop, activePath = buffers.getOrNull(active)?.path,
            modifier = Modifier.fillMaxSize(),
        )
    }

    @Composable
    fun editorArea(modifier: Modifier) {
        val b = buffers.getOrNull(active)
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            when {
                b == null -> Text("Open or create a file", color = MaterialTheme.colorScheme.onSurfaceVariant)
                !b.loaded -> CircularProgressIndicator()
                else -> key(b.path, vimMode) {
                    if (vimMode) VimEditor(
                        text = b.text, onText = { b.text = it; b.dirty = true },
                        onSave = { save(b) }, onQuit = { closeTab(active) }, monoFamily = monoFamily,
                    ) else PlainEditor(
                        text = b.text, onText = { b.text = it; b.dirty = true },
                        onSave = { save(b) }, monoFamily = monoFamily,
                    )
                }
            }
        }
    }

    @Composable
    fun tabs() {
        if (buffers.isEmpty()) return
        Row(modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            buffers.forEachIndexed { i, b ->
                val sel = i == active
                Surface(
                    color = if (sel) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.background,
                    modifier = Modifier.clickable { active = i },
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(start = 10.dp, end = 2.dp, top = 4.dp, bottom = 4.dp),
                    ) {
                        Text(
                            b.path.substringAfterLast('/') + if (b.dirty) " •" else "",
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (sel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                        )
                        IconButton(onClick = { closeTab(i) }, modifier = Modifier.size(24.dp)) {
                            Icon(Icons.Filled.Close, "Close", modifier = Modifier.size(14.dp))
                        }
                    }
                }
            }
        }
    }

    if (isDesktop) {
        Row(modifier = Modifier.fillMaxSize()) {
            sidebar(Modifier.width(240.dp).fillMaxHeight())
            VerticalDivider()
            Column(modifier = Modifier.weight(1f).fillMaxHeight()) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Box(Modifier.weight(1f)) { tabs() }
                    buffers.getOrNull(active)?.let { ab ->
                        IconButton(onClick = { save(ab) }, modifier = Modifier.size(36.dp)) {
                            Icon(
                                Icons.Filled.Save, "Save (Ctrl+S)", modifier = Modifier.size(20.dp),
                                tint = if (ab.dirty) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                editorArea(Modifier.fillMaxSize())
            }
        }
    } else {
        val b = buffers.getOrNull(active)
        if (b == null) {
            sidebar(Modifier.fillMaxSize())
        } else {
            Column(modifier = Modifier.fillMaxSize()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { closeTab(active) }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Close file")
                    }
                    Text(b.path + if (b.dirty) " •" else "", modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                    IconButton(onClick = { save(b) }) { Icon(Icons.Filled.Save, "Save") }
                }
                editorArea(Modifier.fillMaxSize())
            }
        }
    }

    // ── file-action dialogs ──
    copiedLink?.let { link ->
        AlertDialog(
            onDismissRequest = { copiedLink = null },
            confirmButton = { TextButton(onClick = { copiedLink = null }) { Text("OK") } },
            title = { Text("Link copied") },
            text = { Text(link) },
        )
    }
    confirmDelete?.let { path ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete file?") },
            text = { Text("Delete \"$path\"? This can't be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = null
                    scope.launch { client.delete(path).onSuccess { closeBufferFor(path); refresh() } }
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
    dupOf?.let { src ->
        AlertDialog(
            onDismissRequest = { dupOf = null },
            title = { Text("Duplicate") },
            text = {
                OutlinedTextField(
                    value = dialogName, onValueChange = { dialogName = it },
                    label = { Text("New path") }, singleLine = true,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val dest = dialogName.trim(); dupOf = null
                    if (dest.isNotBlank() && dest != src) doDuplicate(src, dest)
                }) { Text("Duplicate") }
            },
            dismissButton = { TextButton(onClick = { dupOf = null }) { Text("Cancel") } },
        )
    }
    moveOf?.let { src ->
        AlertDialog(
            onDismissRequest = { moveOf = null },
            title = { Text("Move / rename") },
            text = {
                OutlinedTextField(
                    value = dialogName, onValueChange = { dialogName = it },
                    label = { Text("New path") }, singleLine = true,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val dest = dialogName.trim(); moveOf = null
                    if (dest.isNotBlank() && dest != src) doMove(src, dest)
                }) { Text("Move") }
            },
            dismissButton = { TextButton(onClick = { moveOf = null }) { Text("Cancel") } },
        )
    }
}
