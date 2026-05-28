package io.nisfeb.lattice.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.knowledge.KnowledgeClient
import io.nisfeb.lattice.knowledge.QueryResult
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The Explore pane: a urQL query runner over the obelisk index, with preset
 * table views and a result table. Served by the agent's async know-query bridge,
 * so it works only when %obelisk is installed (errors surface inline). Writes are
 * allowed (full urQL) — they touch only the rebuildable mirror, never the
 * canonical store — with a warning for non-read queries; Reindex rebuilds it.
 */
@Composable
fun ExploreView(
    knowledge: KnowledgeClient,
    monoFamily: FontFamily,
    onOpenItem: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var queryText by remember { mutableStateOf("FROM knowledge SELECT *;") }
    var result by remember { mutableStateOf<QueryResult?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }

    fun run(q: String) {
        if (loading || q.isBlank()) return
        loading = true
        scope.launch {
            knowledge.query(q)
                .onSuccess { result = it; error = null }
                .onFailure { error = it.message ?: "query failed"; result = null }
            loading = false
        }
    }

    fun preset(q: String) { queryText = q; run(q) }

    val isRead = queryText.trimStart().let {
        it.startsWith("FROM", true) || it.startsWith("SELECT", true)
    }

    Column(modifier = modifier.padding(8.dp)) {
        // preset table views
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            AssistChip(onClick = { preset("FROM knowledge SELECT *;") }, label = { Text("knowledge") })
            AssistChip(onClick = { preset("FROM tags SELECT *;") }, label = { Text("tags") })
            AssistChip(
                onClick = { preset("FROM knowledge AS k JOIN tags AS t ON k.item = t.item SELECT k.item, t.tag;") },
                label = { Text("items + tags") },
            )
        }
        OutlinedTextField(
            value = queryText,
            onValueChange = { queryText = it },
            label = { Text("urQL") },
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = monoFamily),
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
        )
        if (!isRead && queryText.isNotBlank()) {
            Text(
                "Non-read query — writes affect only the obelisk mirror (rebuild with Reindex).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(onClick = { run(queryText) }, enabled = !loading && queryText.isNotBlank()) {
                Icon(Icons.Filled.PlayArrow, null, modifier = Modifier.width(18.dp))
                Spacer(Modifier.width(4.dp))
                Text("Run")
            }
            // reindex's create+populate pokes are fire-and-forget; give obelisk a
            // moment to apply them before re-running, else the query races the rebuild.
            TextButton(onClick = { scope.launch { knowledge.reindex(); delay(1500); run(queryText) } }, enabled = !loading) {
                Icon(Icons.Filled.Refresh, null, modifier = Modifier.width(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("Reindex")
            }
            if (loading) CircularProgressIndicator(modifier = Modifier.width(20.dp))
        }
        // status line
        when {
            error != null -> Text(
                error!!,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = monoFamily),
                color = MaterialTheme.colorScheme.error,
            )
            result != null -> {
                val r = result!!
                Text(
                    "${r.action} · ${r.relation.ifEmpty { "—" }} · ${r.count} row(s)",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        HorizontalDivider(modifier = Modifier.padding(vertical = 6.dp))
        result?.let { resultTable(it, monoFamily, onOpenItem) }
    }
}

// A scrollable column/row table. Clicking a row opens its `item` value (if any)
// as a knowledge note. Monospace so columns line up; horizontal scroll for width.
@Composable
private fun resultTable(r: QueryResult, monoFamily: FontFamily, onOpenItem: (String) -> Unit) {
    if (r.columns.isEmpty()) {
        Text("No columns.", style = MaterialTheme.typography.bodySmall)
        return
    }
    val itemCol = r.columns.indexOf("item")
    Box(modifier = Modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
        Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
            Row {
                r.columns.forEach { c ->
                    Text(
                        c,
                        style = MaterialTheme.typography.labelMedium.copy(fontFamily = monoFamily),
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.widthIn(min = 140.dp).padding(horizontal = 6.dp, vertical = 4.dp),
                    )
                }
            }
            HorizontalDivider()
            r.rows.forEach { row ->
                val open = itemCol >= 0 && itemCol < row.size
                Row(
                    modifier = if (open) Modifier.clickable { onOpenItem(row[itemCol].removePrefix("/")) } else Modifier,
                ) {
                    row.forEach { cell ->
                        Text(
                            cell,
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = monoFamily),
                            modifier = Modifier.widthIn(min = 140.dp).padding(horizontal = 6.dp, vertical = 3.dp),
                        )
                    }
                }
            }
        }
    }
}
