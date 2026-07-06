package io.nisfeb.lattice.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.knowledge.KnowledgeClient
import io.nisfeb.lattice.urbit.LatticeClient
import io.nisfeb.lattice.urbit.Revision
import io.nisfeb.lattice.workspace.Source
import kotlinx.coroutines.launch

/** Prettify a @da stamp (~2026.6.29..23.06.50..xxxx) to "2026.6.29 23:06:50". */
private fun prettyDa(s: String): String {
    val parts = s.removePrefix("~").split("..")
    val date = parts.getOrElse(0) { s }
    val time = parts.getOrElse(1) { "" }.replace('.', ':')
    return if (time.isEmpty()) date else "$date $time"
}

/**
 * Revision history for a versioned item — a public page or a knowledge entry.
 * Lists every stored revision newest-first; selecting one previews its body,
 * restores it as a fresh (non-destructive) revision, or prunes old revisions.
 * Dispatches to the right client by [source]; [path] is the page's relative path
 * or the note's key. [onRestored] lets the caller refresh the open buffer/list.
 */
@Composable
fun VersionHistoryDialog(
    title: String,
    source: Source,
    path: String,
    client: LatticeClient,
    knowledge: KnowledgeClient,
    onClose: () -> Unit,
    onRestored: () -> Unit,
    onStatus: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var revisions by remember { mutableStateOf<List<Revision>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<Int?>(null) }
    var preview by remember { mutableStateOf<String?>(null) }
    var previewLoading by remember { mutableStateOf(false) }
    var keepText by remember { mutableStateOf("10") }
    var confirmRestore by remember { mutableStateOf<Int?>(null) }

    suspend fun loadHistory(): List<Revision> = when (source) {
        Source.Public -> client.history(path)
        Source.Knowledge -> knowledge.history(path).map { it.revisions }
    }.getOrElse { error = it.message; emptyList() }.sortedByDescending { it.rev }

    suspend fun loadBody(rev: Int): String = when (source) {
        Source.Public -> client.readAt(path, rev)
        Source.Knowledge -> knowledge.readAt(path, rev).map { it.body }
    }.getOrElse { "(couldn't load revision: ${it.message})" }

    fun select(rev: Int) {
        selected = rev
        scope.launch { previewLoading = true; preview = loadBody(rev); previewLoading = false }
    }

    LaunchedEffect(path, source) {
        loading = true
        revisions = loadHistory()
        loading = false
        revisions.firstOrNull()?.let { select(it.rev) }
    }

    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("History · $title") },
        text = {
            Column(Modifier.fillMaxWidth()) {
                when {
                    loading -> Text("Loading…")
                    revisions.isEmpty() -> Text(error?.let { "No history ($it)." } ?: "No revisions yet.")
                    else -> {
                        Text("${revisions.size} revision(s)", style = MaterialTheme.typography.labelMedium)
                        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 150.dp)) {
                            items(revisions) { r ->
                                val sel = selected == r.rev
                                Row(
                                    Modifier.fillMaxWidth()
                                        .clickable { select(r.rev) }
                                        .background(if (sel) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                                        .padding(horizontal = 8.dp, vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text("rev ${r.rev}", style = MaterialTheme.typography.labelLarge, modifier = Modifier.width(64.dp))
                                    Text(prettyDa(r.updated), style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
                        HorizontalDivider(Modifier.padding(vertical = 6.dp))
                        Text("Preview", style = MaterialTheme.typography.labelMedium)
                        Column(Modifier.fillMaxWidth().heightIn(min = 60.dp, max = 180.dp).verticalScroll(rememberScrollState())) {
                            Text(
                                if (previewLoading) "Loading…" else preview.orEmpty(),
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                        HorizontalDivider(Modifier.padding(vertical = 6.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            OutlinedTextField(
                                value = keepText,
                                onValueChange = { keepText = it.filter(Char::isDigit).take(4) },
                                label = { Text("keep") }, singleLine = true,
                                modifier = Modifier.width(96.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            TextButton(onClick = {
                                val keep = keepText.toIntOrNull()?.coerceAtLeast(1) ?: 10
                                scope.launch {
                                    val r = when (source) {
                                        Source.Public -> client.prune(path, keep)
                                        Source.Knowledge -> knowledge.prune(path, keep)
                                    }
                                    r.onSuccess {
                                        onStatus("Pruned \"$path\": dropped ${it.dropped}, kept ${it.kept}.")
                                        revisions = loadHistory()
                                    }.onFailure { onStatus("Prune failed: ${it.message}") }
                                }
                            }) { Text("Prune old") }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = selected != null, onClick = { selected?.let { confirmRestore = it } }) {
                Text("Restore selected")
            }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Close") } },
    )

    confirmRestore?.let { rev ->
        AlertDialog(
            onDismissRequest = { confirmRestore = null },
            title = { Text("Restore rev $rev?") },
            text = { Text("Re-saves rev $rev as a new revision. Non-destructive — the current version stays in history.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmRestore = null
                    scope.launch {
                        val r = when (source) {
                            Source.Public -> client.restoreRev(path, rev)
                            Source.Knowledge -> knowledge.restoreRev(path, rev)
                        }
                        r.onSuccess { onStatus("Restored rev $rev of \"$path\"."); onRestored(); onClose() }
                            .onFailure { onStatus("Restore failed: ${it.message}") }
                    }
                }) { Text("Restore") }
            },
            dismissButton = { TextButton(onClick = { confirmRestore = null }) { Text("Cancel") } },
        )
    }
}
