package io.nisfeb.lattice.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DriveFileRenameOutline
import androidx.compose.material.icons.filled.FileDownload
import androidx.compose.material.icons.filled.FileUpload
import androidx.compose.material.icons.filled.Label
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Publish
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.VerticalSplit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
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
import io.nisfeb.lattice.workspace.Buffer
import io.nisfeb.lattice.workspace.Source
import io.nisfeb.lattice.workspace.WorkspaceBuffers
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.Font

/** Which top-level pane is showing: the two file stores, or the obelisk Explorer. */
enum class WorkspaceTab { Pages, Knowledge, Explore }

/**
 * File manager + editor for BOTH stores: public gemtext pages and the private
 * knowledge store. A Pages/Knowledge toggle swaps which namespace the tree shows;
 * tabs from either store coexist in the editor. On desktop the editor can SPLIT
 * into two side-by-side panes — each its own tab group — so you can read a note
 * in one pane while drafting a page in the other. Buffer/pane state lives in
 * [WorkspaceBuffers]; save/delete dispatch by the buffer's [Source] (public hard,
 * knowledge soft → recoverable trash).
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

    var tab by remember {
        mutableStateOf(if (initialTab == Source.Knowledge) WorkspaceTab.Knowledge else WorkspaceTab.Pages)
    }
    // Source for the Pages/Knowledge file UI (Explore has no buffers; defaults Public).
    val ns: Source = if (tab == WorkspaceTab.Knowledge) Source.Knowledge else Source.Public
    var showTrash by remember { mutableStateOf(false) }

    var pubFiles by remember { mutableStateOf<List<String>>(emptyList()) }
    var knowFiles by remember { mutableStateOf<List<String>>(emptyList()) }
    var trashFiles by remember { mutableStateOf<List<String>>(emptyList()) }
    var pubDir by remember { mutableStateOf("") }
    var knowDir by remember { mutableStateOf("") }
    var newName by remember { mutableStateOf("") }
    val wb = remember { WorkspaceBuffers() }
    var status by remember { mutableStateOf<String?>(null) }

    // Knowledge sidebar text filter (key/body substring). The horizontally-
    // scrolling facet chip row was removed for density — too long anyway —
    // along with the Any/All toggle. Filtering is text-only here; tag-driven
    // discovery moves to the Explore tab's urQL runner.
    var exploreQuery by remember { mutableStateOf("") }
    var exploreResults by remember { mutableStateOf<List<String>>(emptyList()) }
    val exploreActive = exploreQuery.isNotBlank()

    fun refreshPublic() = scope.launch { client.list().onSuccess { pubFiles = it } }
    fun refreshKnow() = scope.launch {
        knowledge.list().onSuccess { knowFiles = it.map { k -> k.key.removePrefix("/") } }
        knowledge.trash().onSuccess { trashFiles = it.map { k -> k.key.removePrefix("/") } }
    }
    LaunchedEffect(Unit) { refreshPublic(); refreshKnow() }
    // Re-run the text filter when its query or the store changes.
    LaunchedEffect(exploreQuery, knowFiles) {
        if (exploreActive) {
            knowledge.explore(emptyList(), false, exploreQuery)
                .onSuccess { exploreResults = it.map { k -> k.key.removePrefix("/") } }
        }
    }

    val exportFile = rememberFileExporter()
    val importFile = rememberFileImporter { bundle ->
        scope.launch {
            ContentArchive.import(client, knowledge, bundle)
                .onSuccess { n ->
                    refreshPublic(); refreshKnow()
                    status = "Imported ${n.files} page(s) and ${n.notes} note(s)."
                }
                .onFailure { status = "Import failed: ${it.message}" }
        }
    }
    fun doExport() = scope.launch {
        ContentArchive.export(client, knowledge, ship)
            .onSuccess { exportFile("lattice-${ship.removePrefix("~")}-backup.json", it) }
            .onFailure { status = "Export failed: ${it.message}" }
    }

    fun openBuffer(path: String, source: Source) {
        val b = wb.open(path, source)
        if (!b.loaded) scope.launch {
            when (source) {
                Source.Public -> client.fetch("urb://$ship/$path").onSuccess { b.text = it.body }
                Source.Knowledge -> knowledge.read(path).onSuccess { b.text = it.body; b.tags = it.tags }
            }
            b.loaded = true
        }
    }

    fun newFile(name: String) {
        val base = if (ns == Source.Public) pubDir else knowDir
        val full = if (base.isEmpty()) name else "$base/$name"
        wb.open(full, ns, isNew = true)
    }

    fun save(b: Buffer) = scope.launch {
        when (b.source) {
            Source.Public -> client.save(b.path, b.text).onSuccess { b.dirty = false; refreshPublic() }
            Source.Knowledge -> knowledge.save(b.path, b.text).onSuccess { b.dirty = false; refreshKnow() }
        }
    }

    fun deleteKnow(key: String) = scope.launch {
        knowledge.delete(key)
            .onSuccess { wb.closeFor(Source.Knowledge, key); refreshKnow(); status = "Moved \"$key\" to trash." }
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
        if (ns == Source.Knowledge) {
            // Knowledge has a real server-side move that preserves tags + the
            // obelisk index — unlike the public-file copy+delete below.
            knowledge.move(src, dest)
                .onSuccess { wb.closeFor(Source.Knowledge, src); refreshKnow(); status = "Renamed \"$src\" → \"$dest\"." }
                .onFailure { status = "Move failed: ${it.message}" }
        } else {
            client.fetch("urb://$ship/$src").onSuccess {
                client.save(dest, it.body).onSuccess {
                    client.delete(src).onSuccess { wb.closeFor(Source.Public, src); refreshPublic() }
                }
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
        FileAction("Move / rename", Icons.Filled.DriveFileRenameOutline) { moveOf = it; dialogName = it },
        FileAction("Delete (to trash)", Icons.Filled.Delete, danger = true) { deleteKnow(it) },
    )
    val knowTrashActions = listOf(
        FileAction("Restore", Icons.Filled.Restore) { restoreKnow(it) },
    )

    @Composable
    fun sidebar(modifier: Modifier) = Column(modifier = modifier) {
        // Slim top bar: back + overflow menu (Export/Import live here now —
        // they're rare, so they don't deserve a permanent row).
        var menuOpen by remember { mutableStateOf(false) }
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onClose, modifier = Modifier.size(32.dp)) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to browser", modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.weight(1f))
            Box {
                IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Filled.MoreVert, "Backup options", modifier = Modifier.size(18.dp))
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("Export all") },
                        leadingIcon = { Icon(Icons.Filled.FileDownload, null) },
                        onClick = { menuOpen = false; doExport() },
                    )
                    DropdownMenuItem(
                        text = { Text("Import all") },
                        leadingIcon = { Icon(Icons.Filled.FileUpload, null) },
                        onClick = { menuOpen = false; importFile() },
                    )
                }
            }
        }
        // Three equal-width tabs (icon over label). Replaces the FilterChip row
        // that was overflowing the 240dp sidebar and clipping "Explore".
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            TabButton(tab == WorkspaceTab.Pages, Icons.Filled.Public, "Pages", { tab = WorkspaceTab.Pages }, Modifier.weight(1f))
            TabButton(tab == WorkspaceTab.Knowledge, Icons.Filled.Lock, "Knowledge", { tab = WorkspaceTab.Knowledge }, Modifier.weight(1f))
            TabButton(tab == WorkspaceTab.Explore, Icons.Filled.Search, "Explore", { tab = WorkspaceTab.Explore }, Modifier.weight(1f))
        }
        if (tab != WorkspaceTab.Explore) {
            if (ns == Source.Knowledge) {
                Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FilterChip(selected = !showTrash, onClick = { showTrash = false }, label = { Text("Active ${knowFiles.size}") })
                    FilterChip(selected = showTrash, onClick = { showTrash = true }, label = { Text("Trash ${trashFiles.size}") })
                }
            }
            // Compact text filter (Knowledge active view only) — facet chips +
            // Any/All toggle removed for density; text search remains.
            if (ns == Source.Knowledge && !showTrash) {
                CompactField(
                    value = exploreQuery,
                    onChange = { exploreQuery = it },
                    placeholder = "search notes",
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 2.dp),
                    trailing = if (exploreActive) ({
                        IconButton(onClick = { exploreQuery = "" }, modifier = Modifier.size(24.dp)) {
                            Icon(Icons.Filled.Close, "clear filter", modifier = Modifier.size(14.dp))
                        }
                    }) else null,
                )
            }
            if (!(ns == Source.Knowledge && showTrash)) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    CompactField(
                        value = newName,
                        onChange = { newName = it },
                        placeholder = if (ns == Source.Public) "new page" else "new note",
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(
                        onClick = { if (newName.isNotBlank()) { newFile(newName.trim()); newName = "" } },
                        enabled = newName.isNotBlank(), modifier = Modifier.size(28.dp),
                    ) { Icon(Icons.Filled.Add, "New", modifier = Modifier.size(16.dp)) }
                }
            }
            val activeForNs = wb.activeIn(wb.focusedPane)?.let { if (it.source == ns) it.path else null }
            val knowVisible = if (exploreActive) exploreResults else knowFiles
            FileTree(
                files = if (ns == Source.Public) pubFiles else if (showTrash) trashFiles else knowVisible,
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
        }
    }

    @Composable
    fun bufferEditor(b: Buffer, modifier: Modifier) {
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            if (!b.loaded) CircularProgressIndicator()
            else key(b.source, b.path, vimMode) {
                if (vimMode) VimEditor(
                    text = b.text, onText = { b.text = it; b.dirty = true },
                    onSave = { save(b) }, onQuit = { wb.close(b) }, monoFamily = monoFamily,
                ) else PlainEditor(
                    text = b.text, onText = { b.text = it; b.dirty = true },
                    onSave = { save(b) }, monoFamily = monoFamily,
                )
            }
        }
    }

    // Tag bar for a knowledge buffer: existing tags as removable chips + an add
    // field. Re-reads the entry after each change to reflect normalization/sort.
    @Composable
    fun tagBar(b: Buffer) {
        var newTag by remember(b.path) { mutableStateOf("") }
        fun reload() = scope.launch { knowledge.read(b.path).onSuccess { b.tags = it.tags } }
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(Icons.Filled.Label, "tags", modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            b.tags.forEach { t ->
                InputChip(
                    selected = false,
                    onClick = {},
                    label = { Text(t, style = MaterialTheme.typography.bodySmall) },
                    trailingIcon = {
                        Icon(
                            Icons.Filled.Close, "remove $t",
                            modifier = Modifier.size(14.dp).clickable {
                                scope.launch { knowledge.untag(b.path, t).onSuccess { reload() } }
                            },
                        )
                    },
                )
            }
            OutlinedTextField(
                value = newTag, onValueChange = { newTag = it }, singleLine = true,
                placeholder = { Text("+tag", style = MaterialTheme.typography.bodySmall) },
                textStyle = MaterialTheme.typography.bodySmall,
                modifier = Modifier.width(110.dp),
            )
            IconButton(
                onClick = {
                    val t = newTag.trim()
                    if (t.isNotEmpty()) { newTag = ""; scope.launch { knowledge.tag(b.path, t).onSuccess { reload() } } }
                },
                enabled = newTag.isNotBlank(), modifier = Modifier.size(28.dp),
            ) { Icon(Icons.Filled.Add, "add tag", modifier = Modifier.size(16.dp)) }
        }
    }

    @Composable
    fun paneTabs(p: Int) {
        Row(modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            wb.inPane(p).forEach { b ->
                val sel = wb.activeIn(p) === b
                Surface(
                    color = if (sel) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.background,
                    modifier = Modifier.clickable { wb.select(p, b) },
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
                        IconButton(onClick = { wb.close(b) }, modifier = Modifier.size(24.dp)) {
                            Icon(Icons.Filled.Close, "Close", modifier = Modifier.size(14.dp))
                        }
                    }
                }
            }
        }
    }

    @Composable
    fun editorPane(p: Int, modifier: Modifier) {
        val b = wb.activeIn(p)
        Column(modifier = modifier) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().clickable { wb.focus(p) },
            ) {
                Box(Modifier.weight(1f)) { paneTabs(p) }
                if (wb.splitCount == 2 && b != null) {
                    IconButton(onClick = { wb.moveToOtherPane(b) }, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Filled.SwapHoriz, "Move to other pane", modifier = Modifier.size(18.dp))
                    }
                }
                b?.let { ab ->
                    IconButton(onClick = { save(ab) }, modifier = Modifier.size(36.dp)) {
                        Icon(
                            Icons.Filled.Save, "Save (Ctrl+S)", modifier = Modifier.size(20.dp),
                            tint = if (ab.dirty) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (p == 0) {
                    IconButton(onClick = { wb.setSplit(wb.splitCount == 1) }, modifier = Modifier.size(36.dp)) {
                        Icon(
                            Icons.Filled.VerticalSplit, if (wb.splitCount == 1) "Split editor" else "Merge editor",
                            modifier = Modifier.size(20.dp),
                            tint = if (wb.splitCount == 2) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            if (b == null) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        if (wb.splitCount == 2) "Open a file in this pane" else "Open or create a file",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                if (b.source == Source.Knowledge) tagBar(b)
                bufferEditor(b, Modifier.fillMaxSize())
            }
        }
    }

    // open a knowledge note from an Explore result row: switch to Knowledge + open.
    fun openItem(key: String) { tab = WorkspaceTab.Knowledge; openBuffer(key, Source.Knowledge) }

    if (isDesktop) {
        Row(modifier = Modifier.fillMaxSize()) {
            sidebar(Modifier.width(240.dp).fillMaxHeight())
            VerticalDivider()
            if (tab == WorkspaceTab.Explore) {
                ExploreView(knowledge, monoFamily, ::openItem, Modifier.weight(1f).fillMaxHeight())
            } else {
                Row(modifier = Modifier.weight(1f).fillMaxHeight()) {
                    editorPane(0, Modifier.weight(1f).fillMaxHeight())
                    if (wb.splitCount == 2) {
                        VerticalDivider()
                        editorPane(1, Modifier.weight(1f).fillMaxHeight())
                    }
                }
            }
        }
    } else if (tab == WorkspaceTab.Explore) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                FilterChip(selected = false, onClick = { tab = WorkspaceTab.Pages }, label = { Text("Pages") })
                FilterChip(selected = false, onClick = { tab = WorkspaceTab.Knowledge }, label = { Text("Knowledge") })
                FilterChip(selected = true, onClick = {}, label = { Text("Explore") })
            }
            ExploreView(knowledge, monoFamily, ::openItem, Modifier.weight(1f).fillMaxWidth())
        }
    } else {
        val b = wb.activeIn(0)
        if (b == null) {
            sidebar(Modifier.fillMaxSize())
        } else {
            Column(modifier = Modifier.fillMaxSize()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { wb.close(b) }) {
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
                if (b.source == Source.Knowledge) tagBar(b)
                bufferEditor(b, Modifier.fillMaxSize())
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
                    scope.launch { client.delete(path).onSuccess { wb.closeFor(Source.Public, path); refreshPublic() } }
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

// A compact equal-width tab button (icon over short label) for the sidebar's
// Pages/Knowledge/Explore strip — built ourselves because Material's FilterChip
// row was overflowing the 240dp sidebar and clipping "Explore".
@Composable
private fun TabButton(
    selected: Boolean,
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val bg = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface
    val fg = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
    Surface(
        color = bg, contentColor = fg, shape = RoundedCornerShape(6.dp),
        modifier = modifier.clickable(onClick = onClick),
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(vertical = 6.dp, horizontal = 4.dp),
        ) {
            Icon(icon, null, modifier = Modifier.size(18.dp))
            Text(label, style = MaterialTheme.typography.labelSmall, maxLines = 1)
        }
    }
}

// A compact single-line text field (~32dp) — much shorter than the default
// OutlinedTextField (~56dp) so the sidebar doesn't burn vertical real estate.
@Composable
private fun CompactField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    trailing: @Composable (() -> Unit)? = null,
) {
    Box(
        modifier = modifier
            .heightIn(min = 32.dp)
            .clip(RoundedCornerShape(6.dp))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(modifier = Modifier.weight(1f)) {
                BasicTextField(
                    value = value,
                    onValueChange = onChange,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodySmall.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (value.isEmpty()) {
                    Text(
                        placeholder,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            trailing?.invoke()
        }
    }
}
