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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DriveFileRenameOutline
import androidx.compose.material.icons.filled.FileDownload
import androidx.compose.material.icons.filled.FileUpload
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Publish
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
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
import io.nisfeb.lattice.backup.ContentArchive
import io.nisfeb.lattice.copyToClipboard
import io.nisfeb.lattice.isDesktop
import io.nisfeb.lattice.knowledge.KnowledgeClient
import io.nisfeb.lattice.rememberFileExporter
import io.nisfeb.lattice.rememberFileImporter
import io.nisfeb.lattice.resources.Res
import io.nisfeb.lattice.resources.dejavusansmono
import io.nisfeb.lattice.urbit.LatticeClient
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.Font

/**
 * File manager + editor for BOTH stores: public gemtext pages (urb:// pages) and
 * the private knowledge store. A Pages/Knowledge toggle swaps which namespace the
 * tree shows; tabs from either store coexist in the same editor (open a note in
 * one tab while drafting a page in another). Save/delete dispatch by the buffer's
 * [Source]; public delete is hard, knowledge delete is soft (→ recoverable trash).
 */
@Composable
fun WorkspaceScreen(
    client: LatticeClient,
    knowledge: KnowledgeClient,
    ship: String,
    vimMode: Boolean,
    onClose: () -> Unit,
    initialOpen: String? = null,
    onConsumedOpen: () -> Unit = {},
    initialTab: Source = Source.Public,
) {
    val scope = rememberCoroutineScope()
    val monoFamily = FontFamily(Font(Res.font.dejavusansmono))

    var ns by remember { mutableStateOf(initialTab) }
    var showTrash by remember { mutableStateOf(false) }

    var pubFiles by remember { mutableStateOf<List<String>>(emptyList()) }
    var knowFiles by remember { mutableStateOf<List<String>>(emptyList()) }
    var trashFiles by remember { mutableStateOf<List<String>>(emptyList()) }
    var pubDir by remember { mutableStateOf("") }
    var knowDir by remember { mutableStateOf("") }
    var newName by remember { mutableStateOf("") }
    val buffers = remember { mutableListOf<Buffer>().toMutableStateList() }
    var active by remember { mutableIntStateOf(-1) }
    var status by remember { mutableStateOf<String?>(null) }

    fun refreshPublic() = scope.launch { client.list().onSuccess { pubFiles = it } }
    // knowledge keys come back with a leading '/'; the tree wants plain a/b paths.
    fun refreshKnow() = scope.launch {
        knowledge.list().onSuccess { knowFiles = it.map { k -> k.key.removePrefix("/") } }
        knowledge.trash().onSuccess { trashFiles = it.map { k -> k.key.removePrefix("/") } }
    }
    LaunchedEffect(Unit) { refreshPublic(); refreshKnow() }

    val exportFile = rememberFileExporter()
    val importFile = rememberFileImporter { bundle ->
        scope.launch {
            ContentArchive.import(client, bundle)
                .onSuccess { n -> refreshPublic(); status = "Imported $n file(s)." }
                .onFailure { status = "Import failed: ${it.message}" }
        }
    }
    fun doExport() = scope.launch {
        ContentArchive.export(client, ship)
            .onSuccess { exportFile("lattice-${ship.removePrefix("~")}-backup.json", it) }
            .onFailure { status = "Export failed: ${it.message}" }
    }

    fun openBuffer(path: String, source: Source) {
        val existing = buffers.indexOfFirst { it.source == source && it.path == path }
        if (existing >= 0) { active = existing; return }
        val b = Buffer(path, source, isNew = false)
        buffers.add(b); active = buffers.lastIndex
        scope.launch {
            when (source) {
                Source.Public -> client.fetch("urb://$ship/$path").onSuccess { b.text = it.body }
                Source.Knowledge -> knowledge.read(path).onSuccess { b.text = it.body }
            }
            b.loaded = true
        }
    }

    fun newFile(name: String) {
        val base = if (ns == Source.Public) pubDir else knowDir
        val full = if (base.isEmpty()) name else "$base/$name"
        buffers.add(Buffer(full, ns, isNew = true)); active = buffers.lastIndex
    }

    fun closeTab(i: Int) {
        buffers.removeAt(i)
        active = if (buffers.isEmpty()) -1 else active.coerceAtMost(buffers.lastIndex)
    }
    fun closeBufferFor(source: Source, path: String) {
        buffers.indexOfFirst { it.source == source && it.path == path }.takeIf { it >= 0 }?.let { closeTab(it) }
    }

    fun save(b: Buffer) = scope.launch {
        when (b.source) {
            Source.Public -> client.save(b.path, b.text).onSuccess { b.dirty = false; refreshPublic() }
            Source.Knowledge -> knowledge.save(b.path, b.text).onSuccess { b.dirty = false; refreshKnow() }
        }
    }

    fun deleteKnow(key: String) = scope.launch {
        knowledge.delete(key)
            .onSuccess { closeBufferFor(Source.Knowledge, key); refreshKnow(); status = "Moved \"$key\" to trash." }
            .onFailure { status = "Delete failed: ${it.message}" }
    }
    fun restoreKnow(key: String) = scope.launch {
        knowledge.restore(key).onSuccess { refreshKnow(); status = "Restored \"$key\"." }
    }

    // dialogs
    var confirmDelete by remember { mutableStateOf<String?>(null) }
    var dupOf by remember { mutableStateOf<String?>(null) }
    var moveOf by remember { mutableStateOf<String?>(null) }
    var dialogName by remember { mutableStateOf("") }
    var copiedLink by remember { mutableStateOf<String?>(null) }
    var publishKey by remember { mutableStateOf<String?>(null) }
    var publishPath by remember { mutableStateOf("") }

    fun doDuplicate(src: String, dest: String) = scope.launch {
        client.fetch("urb://$ship/$src").onSuccess { client.save(dest, it.body).onSuccess { refreshPublic() } }
    }
    fun doMove(src: String, dest: String) = scope.launch {
        client.fetch("urb://$ship/$src").onSuccess {
            client.save(dest, it.body).onSuccess {
                client.delete(src).onSuccess { closeBufferFor(Source.Public, src); refreshPublic() }
            }
        }
    }

    LaunchedEffect(initialOpen) {
        if (initialOpen != null) { openBuffer(initialOpen, Source.Public); onConsumedOpen() }
    }

    val publicActions = listOf(
        FileAction("Copy link", Icons.Filled.Link) { val l = "urb://$ship/$it"; copyToClipboard(l); copiedLink = l },
        FileAction("Duplicate", Icons.Filled.ContentCopy) { dupOf = it; dialogName = "$it-copy" },
        FileAction("Move / rename", Icons.Filled.DriveFileRenameOutline) { moveOf = it; dialogName = it },
        FileAction("Delete", Icons.Filled.Delete, danger = true) { confirmDelete = it },
    )
    val knowLiveActions = listOf(
        FileAction("Publish to page", Icons.Filled.Publish) { publishKey = it; publishPath = it },
        FileAction("Delete (to trash)", Icons.Filled.Delete, danger = true) { deleteKnow(it) },
    )
    val knowTrashActions = listOf(
        FileAction("Restore", Icons.Filled.Restore) { restoreKnow(it) },
    )

    @Composable
    fun sidebar(modifier: Modifier) = Column(modifier = modifier) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            IconButton(onClick = onClose, modifier = Modifier.size(32.dp)) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to browser", modifier = Modifier.size(18.dp))
            }
            FilterChip(selected = ns == Source.Public, onClick = { ns = Source.Public }, label = { Text("Pages") })
            FilterChip(selected = ns == Source.Knowledge, onClick = { ns = Source.Knowledge }, label = { Text("Knowledge") })
        }
        if (ns == Source.Knowledge) {
            Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(selected = !showTrash, onClick = { showTrash = false }, label = { Text("Live (${knowFiles.size})") })
                FilterChip(selected = showTrash, onClick = { showTrash = true }, label = { Text("Trash (${trashFiles.size})") })
            }
        }
        if (!(ns == Source.Knowledge && showTrash)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                OutlinedTextField(
                    value = newName, onValueChange = { newName = it }, singleLine = true,
                    placeholder = { Text(if (ns == Source.Public) "new page" else "new note", style = MaterialTheme.typography.bodySmall) },
                    textStyle = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f),
                )
                IconButton(
                    onClick = { if (newName.isNotBlank()) { newFile(newName.trim()); newName = "" } },
                    enabled = newName.isNotBlank(), modifier = Modifier.size(32.dp),
                ) { Icon(Icons.Filled.Add, "New", modifier = Modifier.size(18.dp)) }
            }
        }
        val activeForNs = buffers.getOrNull(active)?.let { if (it.source == ns) it.path else null }
        FileTree(
            files = if (ns == Source.Public) pubFiles else if (showTrash) trashFiles else knowFiles,
            dir = if (ns == Source.Public) pubDir else knowDir,
            onDir = { if (ns == Source.Public) pubDir = it else knowDir = it },
            onOpen = {
                when {
                    ns == Source.Public -> openBuffer(it, Source.Public)
                    !showTrash -> openBuffer(it, Source.Knowledge)
                }
            },
            actions = when {
                ns == Source.Public -> publicActions
                showTrash -> knowTrashActions
                else -> knowLiveActions
            },
            compact = isDesktop, activePath = activeForNs,
            modifier = Modifier.weight(1f).fillMaxWidth(),
        )
        if (ns == Source.Public) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TextButton(onClick = { doExport() }) {
                    Icon(Icons.Filled.FileDownload, null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("Export", style = MaterialTheme.typography.bodySmall)
                }
                TextButton(onClick = { importFile() }) {
                    Icon(Icons.Filled.FileUpload, null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("Import", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }

    @Composable
    fun editorArea(modifier: Modifier) {
        val b = buffers.getOrNull(active)
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            when {
                b == null -> Text("Open or create a file", color = MaterialTheme.colorScheme.onSurfaceVariant)
                !b.loaded -> CircularProgressIndicator()
                else -> key(b.source, b.path, vimMode) {
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
                        modifier = Modifier.padding(start = 8.dp, end = 2.dp, top = 4.dp, bottom = 4.dp),
                    ) {
                        Icon(
                            if (b.source == Source.Public) Icons.Filled.Public else Icons.Filled.Lock,
                            if (b.source == Source.Public) "public page" else "private knowledge",
                            modifier = Modifier.size(13.dp).padding(end = 4.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
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
                    Icon(
                        if (b.source == Source.Public) Icons.Filled.Public else Icons.Filled.Lock,
                        null, modifier = Modifier.size(16.dp).padding(end = 4.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(b.path + if (b.dirty) " •" else "", modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                    IconButton(onClick = { save(b) }) { Icon(Icons.Filled.Save, "Save") }
                }
                editorArea(Modifier.fillMaxSize())
            }
        }
    }

    // ── dialogs ──
    status?.let { msg ->
        AlertDialog(
            onDismissRequest = { status = null },
            confirmButton = { TextButton(onClick = { status = null }) { Text("OK") } },
            title = { Text("Files") },
            text = { Text(msg) },
        )
    }
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
            title = { Text("Delete page?") },
            text = { Text("Delete \"$path\"? This can't be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = null
                    scope.launch { client.delete(path).onSuccess { closeBufferFor(Source.Public, path); refreshPublic() } }
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
    publishKey?.let { k ->
        AlertDialog(
            onDismissRequest = { publishKey = null },
            title = { Text("Publish to page") },
            text = {
                Column {
                    Text("Copies the private note \"$k\" into your public gemtext at this path.", style = MaterialTheme.typography.bodyMedium)
                    OutlinedTextField(
                        value = publishPath, onValueChange = { publishPath = it },
                        label = { Text("Page path") }, singleLine = true,
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val path = publishPath.trim().ifEmpty { null }
                    publishKey = null
                    scope.launch {
                        knowledge.publish(k, path)
                            .onSuccess { refreshPublic(); status = "Published \"$k\"." }
                            .onFailure { status = "Publish failed: ${it.message}" }
                    }
                }) { Text("Publish") }
            },
            dismissButton = { TextButton(onClick = { publishKey = null }) { Text("Cancel") } },
        )
    }
}
