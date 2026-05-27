package io.nisfeb.lattice.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.knowledge.KnowEntry
import io.nisfeb.lattice.knowledge.KnowItem
import io.nisfeb.lattice.knowledge.KnowledgeClient
import kotlinx.coroutines.launch

/**
 * Manage the ship's private knowledge store — the same items agents read and
 * write programmatically. View/edit/create items, soft-delete to a recoverable
 * trash, restore from it, and publish any item as a public gemtext page.
 *
 * Two modes: a searchable list (live items, or trash via the chip) and a
 * full-screen editor. Everything goes through [KnowledgeClient] over the
 * authenticated session.
 */
@Composable
fun KnowledgeScreen(client: KnowledgeClient, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()

    var items by remember { mutableStateOf<List<KnowItem>>(emptyList()) }
    var trash by remember { mutableStateOf<List<KnowItem>>(emptyList()) }
    var showTrash by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var status by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }

    // Editor state — non-null [editor] means we're editing; [isNew] allows the key field.
    var editor by remember { mutableStateOf<KnowEntry?>(null) }
    var isNew by remember { mutableStateOf(false) }
    var editKey by remember { mutableStateOf("") }
    var editBody by remember { mutableStateOf("") }

    var publishKey by remember { mutableStateOf<String?>(null) }
    var publishPath by remember { mutableStateOf("") }

    fun refresh() {
        scope.launch {
            loading = true
            client.list().onSuccess { items = it }.onFailure { status = "Load failed: ${it.message}" }
            client.trash().onSuccess { trash = it }
            loading = false
        }
    }

    // Initial load.
    remember {
        refresh(); true
    }

    fun open(key: String) {
        scope.launch {
            client.read(key)
                .onSuccess { e -> editor = e; isNew = false; editKey = e.key; editBody = e.body }
                .onFailure { status = "Open failed: ${it.message}" }
        }
    }

    fun closeEditor() {
        editor = null; isNew = false; editKey = ""; editBody = ""
    }

    // ---- Editor ----
    val ed = editor
    if (ed != null || isNew) {
        EditorView(
            isNew = isNew,
            keyText = editKey,
            bodyText = editBody,
            onKeyChange = { editKey = it },
            onBodyChange = { editBody = it },
            onBack = { closeEditor() },
            onSave = {
                val k = editKey.trim()
                if (k.isEmpty()) { status = "Key required"; return@EditorView }
                scope.launch {
                    client.save(k, editBody)
                        .onSuccess { status = "Saved $k"; closeEditor(); refresh() }
                        .onFailure { status = "Save failed: ${it.message}" }
                }
            },
            onDelete = if (isNew) null else {
                {
                    val k = editKey.trim()
                    scope.launch {
                        client.delete(k)
                            .onSuccess { status = "Moved $k to trash"; closeEditor(); refresh() }
                            .onFailure { status = "Delete failed: ${it.message}" }
                    }
                }
            },
            onPublish = if (isNew) null else {
                { publishKey = editKey.trim(); publishPath = editKey.trim() }
            },
            status = status,
        )
    } else {
        // ---- List ----
        val source = if (showTrash) trash else items
        val filtered = remember(source, query) {
            val q = query.trim()
            if (q.isEmpty()) source else source.filter { it.key.contains(q, ignoreCase = true) }
        }

        Column(modifier = Modifier.fillMaxSize().padding(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                Text("Knowledge", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                if (!showTrash) {
                    IconButton(onClick = { isNew = true; editKey = ""; editBody = "" }) {
                        Icon(Icons.Filled.Add, "New item")
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(selected = !showTrash, onClick = { showTrash = false }, label = { Text("Items (${items.size})") })
                FilterChip(selected = showTrash, onClick = { showTrash = true }, label = { Text("Trash (${trash.size})") })
            }

            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                singleLine = true,
                label = { Text("Search keys") },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                trailingIcon = {
                    if (query.isNotEmpty()) {
                        IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, "Clear") }
                    }
                },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp),
            )

            status?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
            }
            HorizontalDivider()

            when {
                loading -> Row(modifier = Modifier.fillMaxWidth().padding(24.dp), horizontalArrangement = Arrangement.Center) {
                    CircularProgressIndicator()
                }
                source.isEmpty() -> Text(
                    if (showTrash) "Trash is empty."
                    else "No knowledge items yet. Agents write here over MCP, or tap + to add one.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(12.dp),
                )
                filtered.isEmpty() -> Text(
                    "No keys match \"$query\".",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(12.dp),
                )
                else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(filtered, key = { it.key }) { item ->
                        KnowRow(
                            item = item,
                            inTrash = showTrash,
                            onClick = { if (!showTrash) open(item.key) },
                            onRestore = {
                                scope.launch {
                                    client.restore(item.key)
                                        .onSuccess { status = "Restored ${item.key}"; refresh() }
                                        .onFailure { status = "Restore failed: ${it.message}" }
                                }
                            },
                        )
                        HorizontalDivider()
                    }
                }
            }
        }
    }

    // ---- Publish dialog ----
    val pk = publishKey
    if (pk != null) {
        AlertDialog(
            onDismissRequest = { publishKey = null },
            title = { Text("Publish to public page") },
            text = {
                Column {
                    Text(
                        "Copies “$pk” into your public gemtext. Anyone can then read it at this path.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    OutlinedTextField(
                        value = publishPath,
                        onValueChange = { publishPath = it },
                        singleLine = true,
                        label = { Text("Page path") },
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    )
                }
            },
            confirmButton = {
                Button(onClick = {
                    val path = publishPath.trim().ifEmpty { null }
                    scope.launch {
                        client.publish(pk, path)
                            .onSuccess { status = "Published $pk" }
                            .onFailure { status = "Publish failed: ${it.message}" }
                    }
                    publishKey = null
                }) { Text("Publish") }
            },
            dismissButton = { TextButton(onClick = { publishKey = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun KnowRow(item: KnowItem, inTrash: Boolean, onClick: () -> Unit, onRestore: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 4.dp),
    ) {
        Column(modifier = Modifier.weight(1f).padding(vertical = 8.dp)) {
            Text(item.key, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "${item.bytes} bytes" + if (item.updated.isNotBlank()) " · ${item.updated}" else "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (inTrash) {
            TextButton(onClick = onRestore) { Text("Restore") }
        }
    }
}

@Composable
private fun EditorView(
    isNew: Boolean,
    keyText: String,
    bodyText: String,
    onKeyChange: (String) -> Unit,
    onBodyChange: (String) -> Unit,
    onBack: () -> Unit,
    onSave: () -> Unit,
    onDelete: (() -> Unit)?,
    onPublish: (() -> Unit)?,
    status: String?,
) {
    Column(modifier = Modifier.fillMaxSize().padding(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text(if (isNew) "New item" else keyText, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (isNew) {
            OutlinedTextField(
                value = keyText,
                onValueChange = onKeyChange,
                singleLine = true,
                label = { Text("Key (e.g. projects/lattice/notes)") },
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            )
        }
        OutlinedTextField(
            value = bodyText,
            onValueChange = onBodyChange,
            label = { Text("Body") },
            modifier = Modifier.fillMaxWidth().weight(1f).padding(vertical = 4.dp),
        )
        status?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(vertical = 2.dp))
        }
        Row(modifier = Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onSave) { Text("Save") }
            onPublish?.let { OutlinedButton(onClick = it) { Text("Publish") } }
            onDelete?.let {
                OutlinedButton(onClick = it) {
                    Icon(Icons.Filled.Delete, contentDescription = null)
                    Text("Delete")
                }
            }
        }
    }
}
