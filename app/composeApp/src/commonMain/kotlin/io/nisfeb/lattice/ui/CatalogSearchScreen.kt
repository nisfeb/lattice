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
import androidx.compose.material.icons.automirrored.filled.Label
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.urbit.CatalogPage
import io.nisfeb.lattice.urbit.LatticeClient
import kotlin.math.ln
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
    /** Epoch-ms of the last manual sweep (hoisted in App so it survives leaving
     *  the screen); drives the "Scan now" cooldown. */
    lastScanMillis: Long,
    /** Fire a one-shot sweep of contacts + follows (App records the timestamp). */
    onScanNow: () -> Unit,
) {
    var pages by remember { mutableStateOf<List<CatalogPage>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    var category by remember { mutableStateOf<String?>(null) }
    // Bump to reload the catalog (the agent re-serves the latest rows).
    var reloadNonce by remember { mutableStateOf(0) }
    // Body keyword search over the inverted index: url -> TF-IDF score, filled by
    // the debounced server search. Empty when the query is blank or has no
    // indexable words. `searching` gates the in-progress hint.
    var bodyScores by remember { mutableStateOf<Map<String, Double>>(emptyMap()) }
    var searching by remember { mutableStateOf(false) }
    // Author-declared summaries (url -> summary) from catalog-meta, shown as a
    // snippet under each result. Loaded alongside the catalog; best-effort.
    var summaries by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    // The live category vocabulary (catalog-vocab), suggested when categorizing.
    var vocab by remember { mutableStateOf<List<String>>(emptyList()) }
    // The page whose category is being edited (classify dialog open when non-null).
    var classifyPage by remember { mutableStateOf<CatalogPage?>(null) }

    LaunchedEffect(reloadNonce) {
        loading = true
        error = null
        client.catalogList()
            .onSuccess { pages = it }
            .onFailure { error = it.message ?: "couldn't load the catalog" }
        client.catalogMeta().onSuccess { summaries = it }  // best-effort snippets
        client.catalogVocab().onSuccess { vocab = it }      // category suggestions
        loading = false
    }

    // Category facets, derived from the loaded rows (drop the '' = unclassified
    // sentinel). Publishers aren't faceted as chips (there can be many) — they're
    // matched by the free-text box and shown on every row.
    val categories = remember(pages) {
        pages.mapNotNull { it.category.ifBlank { null } }.distinct().sorted()
    }
    // If a reload drops the selected category (its last page was deleted, or the
    // classifier re-labeled it), clear the now-orphaned filter — otherwise it
    // silently matches nothing with no chip left to tap off.
    LaunchedEffect(categories) {
        // "" is the Unclassified facet (never a real chip); keep it selectable.
        if (category != null && category != "" && category !in categories) category = null
    }

    // Debounced body keyword search over the inverted index. Splits the query
    // into normalized words, fires ONE server search per word (obelisk has no
    // OR), and combines them with TF-IDF: score(page) = Σ tf·idf where
    // idf = ln(total / docFreq). Restarting on each keystroke cancels the prior
    // in-flight search; the 300ms delay is the debounce. The local substring
    // filter (below) still runs instantly — this only ADDS body-content matches.
    LaunchedEffect(query, pages) {
        val q = query.trim()
        if (q.isBlank()) {
            bodyScores = emptyMap()
            searching = false
            return@LaunchedEffect
        }
        delay(300)
        val words = q.split(Regex("\\s+")).mapNotNull(::normalizeQueryTerm).distinct()
        if (words.isEmpty()) {
            bodyScores = emptyMap()
            searching = false
            return@LaunchedEffect
        }
        searching = true
        val total = pages.size.coerceAtLeast(1)
        val acc = HashMap<String, Double>()
        for (w in words) {
            val postings = client.catalogSearch(w).getOrDefault(emptyList())
            val df = postings.size.coerceAtLeast(1)
            val idf = ln(total.toDouble() / df.toDouble()).coerceAtLeast(0.01)
            for (po in postings) acc[po.url] = (acc[po.url] ?: 0.0) + po.tf * idf
        }
        bodyScores = acc
        searching = false
    }

    // Results = pages passing the category facet, ranked when a query is present:
    // a title/path/publisher substring scores high; a body keyword (TF-IDF) match
    // surfaces pages the substring filter alone would miss. Blank query → the
    // whole facet in load (newest-first) order.
    val results = remember(pages, query, category, bodyScores) {
        val q = query.trim().lowercase()
        val facet = pages.filter { category == null || it.category == category }
        if (q.isEmpty()) {
            facet
        } else {
            facet.mapNotNull { p ->
                val titleHit = p.title.lowercase().contains(q)
                val subHit = titleHit ||
                    p.path.lowercase().contains(q) ||
                    p.publisher.lowercase().contains(q)
                val body = bodyScores[p.url] ?: 0.0
                if (!subHit && body <= 0.0) {
                    null
                } else {
                    val score = (if (titleHit) 1_000.0 else 0.0) +
                        (if (subHit) 100.0 else 0.0) + body
                    p to score
                }
            }.sortedByDescending { it.second }.map { it.first }
        }
    }

    // "Scan now" cooldown: a 10-minute floor between manual sweeps so the button
    // can't be spammed into redundant background crawls (the periodic auto-sweep
    // runs every ~6h regardless). nowMs ticks only while a cooldown is active, so
    // the countdown stays live and the button re-enables when it elapses.
    val cooldownMs = 10L * 60_000L
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(lastScanMillis) {
        while (System.currentTimeMillis() - lastScanMillis < cooldownMs) {
            nowMs = System.currentTimeMillis()
            delay(5_000)
        }
        nowMs = System.currentTimeMillis()
    }
    val cooldownLeftMs = (lastScanMillis + cooldownMs - nowMs).coerceAtLeast(0L)
    val canScan = cooldownLeftMs == 0L

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
            label = { Text("search titles, content, ships") },
            singleLine = true,
            trailingIcon = {
                if (query.isNotEmpty()) {
                    IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, "Clear") }
                }
            },
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        )

        // Scan now + status. The sweep is fire-and-forget (runs server-side for
        // a while), so after firing we show a crawling hint + a 10-min cooldown
        // countdown on the button; results land as you ↻.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp),
        ) {
            Button(onClick = onScanNow, enabled = canScan) {
                Text(if (canScan) "Scan now" else "Scan in ${(cooldownLeftMs + 59_999L) / 60_000L}m")
            }
            Text(
                text = if (canScan) {
                    "${pages.size} ${if (pages.size == 1) "page" else "pages"} indexed"
                } else {
                    "Crawling your network — pull ↻ for new results"
                },
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                modifier = Modifier.weight(1f),
            )
        }

        val hasUnclassified = remember(pages) { pages.any { it.category.isBlank() } }
        if (categories.isNotEmpty() || hasUnclassified) {
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
                if (hasUnclassified) {
                    item {
                        FilterChip(
                            selected = category == "",
                            onClick = { category = if (category == "") null else "" },
                            label = { Text("Unclassified") },
                        )
                    }
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

            results.isEmpty() && searching -> EmptyNote("Searching content…")

            results.isEmpty() -> EmptyNote("No pages match \"$query\".")

            else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                item {
                    Text(
                        "${results.size} ${if (results.size == 1) "page" else "pages"}" +
                            if (searching) " · searching content…" else "",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 6.dp, horizontal = 4.dp),
                    )
                }
                items(results) { page ->
                    ResultRow(page, summaries[page.url], onClick = { onOpenUrl(page.url) }, onClassify = { classifyPage = page })
                }
            }
        }
    }

    classifyPage?.let { page ->
        ClassifyDialog(
            page = page,
            vocab = vocab,
            client = client,
            onClose = { classifyPage = null },
            onClassified = { classifyPage = null; reloadNonce++ },
        )
    }
}

/**
 * Set (or change) a page's catalog category. Suggests the live vocabulary as
 * chips and takes a free-typed category too — the classifier's own taxonomy is
 * user-grown, so new categories are first-class. Writes via catalog-classify
 * (cat-source 'manual'); the caller reloads on success.
 */
@Composable
private fun ClassifyDialog(
    page: CatalogPage,
    vocab: List<String>,
    client: LatticeClient,
    onClose: () -> Unit,
    onClassified: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var value by remember { mutableStateOf(page.category) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (!saving) onClose() },
        title = { Text("Categorize") },
        text = {
            Column {
                Text(page.label, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                OutlinedTextField(
                    value = value,
                    onValueChange = { value = it },
                    label = { Text("category") },
                    singleLine = true,
                    enabled = !saving,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
                if (vocab.isNotEmpty()) {
                    LazyRow(
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        items(vocab) { c ->
                            FilterChip(selected = value == c, onClick = { value = c }, label = { Text(c) })
                        }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 6.dp)) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !saving && value.isNotBlank(),
                onClick = {
                    saving = true; error = null
                    scope.launch {
                        client.catalogClassify(page.url, value.trim())
                            .onSuccess { onClassified() }
                            .onFailure { error = it.message ?: "failed"; saving = false }
                    }
                },
            ) { Text(if (saving) "Saving…" else "Save") }
        },
        dismissButton = { TextButton(enabled = !saving, onClick = onClose) { Text("Cancel") } },
    )
}

@Composable
private fun ResultRow(page: CatalogPage, summary: String?, onClick: () -> Unit, onClassify: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
    Column(
        modifier = Modifier
            .weight(1f)
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
        if (!summary.isNullOrBlank()) {
            Text(
                summary,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
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
        IconButton(onClick = onClassify) {
            Icon(Icons.AutoMirrored.Filled.Label, contentDescription = "Categorize")
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

/** Coarse client-side pre-filter for query words (lowercase, trim edge
 *  punctuation, drop <3 chars) to skip pointless round-trips. NOT authoritative:
 *  the agent re-normalizes every term server-side with its own +normalize-term,
 *  so the index/query match never depends on this reproducing it exactly. */
private fun normalizeQueryTerm(token: String): String? {
    val t = token.lowercase().trim { !it.isLetterOrDigit() }
    return if (t.length >= 3) t else null
}
