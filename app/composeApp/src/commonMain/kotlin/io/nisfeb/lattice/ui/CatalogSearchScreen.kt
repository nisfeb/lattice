package io.nisfeb.lattice.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.urbit.CatalogPage
import io.nisfeb.lattice.urbit.LatticeClient

/**
 * Search the content catalog — the cross-publisher index the %lattice agent
 * builds by crawling everyone in your contact book (and follows). One
 * `catalog-list` query loads the whole index; we facet (category chips) and
 * free-text filter (title / path / publisher) entirely client-side, because
 * obelisk has no server-side substring search. Tapping a result opens that
 * page's urb:// url in the browser.
 */
@Composable
fun CatalogSearchScreen(
    client: LatticeClient,
    onOpenUrl: (String) -> Unit,
    onClose: () -> Unit,
) {
    var pages by remember { mutableStateOf<List<CatalogPage>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    var category by remember { mutableStateOf<String?>(null) }
    // Bump to reload the catalog (the agent re-serves the latest rows).
    var reloadNonce by remember { mutableStateOf(0) }

    LaunchedEffect(reloadNonce) {
        loading = true
        error = null
        client.catalogList()
            .onSuccess { pages = it }
            .onFailure { error = it.message ?: "couldn't load the catalog" }
        loading = false
    }

    // Category facets, derived from the loaded rows (drop the '' = unclassified
    // sentinel). Publishers aren't faceted as chips (there can be many) — they're
    // matched by the free-text box and shown on every row.
    val categories = remember(pages) {
        pages.mapNotNull { it.category.ifBlank { null } }.distinct().sorted()
    }
    val results = remember(pages, query, category) {
        val q = query.trim().lowercase()
        pages.filter { p ->
            (category == null || p.category == category) &&
                (
                    q.isEmpty() ||
                        p.title.lowercase().contains(q) ||
                        p.path.lowercase().contains(q) ||
                        p.publisher.lowercase().contains(q)
                    )
        }
    }

    Column(modifier = Modifier.fillMaxSize().padding(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("Search", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            IconButton(onClick = { if (!loading) reloadNonce++ }, enabled = !loading) {
                Icon(Icons.Filled.Refresh, "Reload catalog")
            }
        }

        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text("search titles, paths, ships") },
            singleLine = true,
            trailingIcon = {
                if (query.isNotEmpty()) {
                    IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, "Clear") }
                }
            },
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        )

        if (categories.isNotEmpty()) {
            LazyRow(
                modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                item {
                    FilterChip(
                        selected = category == null,
                        onClick = { category = null },
                        label = { Text("All") },
                    )
                }
                items(categories) { c ->
                    FilterChip(
                        selected = category == c,
                        onClick = { category = if (category == c) null else c },
                        label = { Text(c) },
                    )
                }
            }
        }

        HorizontalDivider()

        when {
            loading -> Column(
                modifier = Modifier.fillMaxSize().padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
            }

            error != null -> Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
                Text(
                    "Couldn't load the catalog: $error",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                TextButton(onClick = { reloadNonce++ }) { Text("Retry") }
            }

            pages.isEmpty() -> EmptyNote(
                "Your catalog is empty. It fills in as the periodic sweep crawls the " +
                    "publishers in your contact book — or scan one now from a publisher's page.",
            )

            results.isEmpty() -> EmptyNote("No pages match \"$query\".")

            else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                item {
                    Text(
                        "${results.size} ${if (results.size == 1) "page" else "pages"}",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 6.dp, horizontal = 4.dp),
                    )
                }
                items(results) { page -> ResultRow(page, onClick = { onOpenUrl(page.url) }) }
            }
        }
    }
}

@Composable
private fun ResultRow(page: CatalogPage, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 8.dp, horizontal = 4.dp),
    ) {
        Text(
            page.label,
            style = MaterialTheme.typography.bodyLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            "${page.publisher}${page.path}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (page.category.isNotBlank() || page.wordCount > 0) {
            Row(
                modifier = Modifier.padding(top = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (page.category.isNotBlank()) {
                    Text(
                        page.category,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                if (page.wordCount > 0) {
                    Text(
                        "${page.wordCount} words",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun EmptyNote(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(16.dp),
    )
}
