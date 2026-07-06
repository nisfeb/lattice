package io.nisfeb.lattice.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.urbit.Backlink
import io.nisfeb.lattice.urbit.Heading
import io.nisfeb.lattice.urbit.LatticeClient

/**
 * Backlinks + table of contents for the page at [url], derived from OUR catalog
 * index. Backlinks are the pages that link TO this one (tap to open); the TOC is
 * this page's heading outline. Both are empty for a page we haven't crawled — the
 * dialog just says so rather than erroring.
 */
@Composable
fun PageInsightsDialog(
    url: String,
    client: LatticeClient,
    onNavigate: (String) -> Unit,
    onClose: () -> Unit,
) {
    var backlinks by remember { mutableStateOf<List<Backlink>?>(null) }
    var toc by remember { mutableStateOf<List<Heading>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(url) {
        backlinks = null; toc = null; error = null
        client.catalogToc(url).onSuccess { toc = it }.onFailure { error = it.message }
        client.catalogBacklinks(url).onSuccess { backlinks = it }.onFailure { error = it.message }
    }

    AlertDialog(
        onDismissRequest = onClose,
        confirmButton = { TextButton(onClick = onClose) { Text("Close") } },
        title = { Text("Links & outline") },
        text = {
            val loading = backlinks == null || toc == null
            when {
                error != null && loading -> Text("Couldn't load: $error", color = MaterialTheme.colorScheme.error)
                loading -> CircularProgressIndicator()
                else -> LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
                    val heads = toc.orEmpty()
                    val links = backlinks.orEmpty()
                    item {
                        Text("Outline", style = MaterialTheme.typography.titleSmall)
                        if (heads.isEmpty()) {
                            Text("No headings indexed for this page.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    items(heads) { h ->
                        Text(
                            h.text,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.fillMaxWidth().padding(start = ((h.depth - 1).coerceAtLeast(0) * 14).dp, top = 3.dp, bottom = 3.dp),
                        )
                    }
                    item {
                        HorizontalDivider(Modifier.padding(vertical = 8.dp))
                        Text("Linked from (${links.size})", style = MaterialTheme.typography.titleSmall)
                        if (links.isEmpty()) {
                            Text("No pages in your catalog link here.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    items(links) { b ->
                        Column(
                            Modifier.fillMaxWidth()
                                .clickable { onNavigate(b.url); onClose() }
                                .padding(vertical = 6.dp),
                        ) {
                            Text(b.label.ifBlank { b.url }, style = MaterialTheme.typography.bodyMedium)
                            Text(b.publisher, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        },
    )
}
