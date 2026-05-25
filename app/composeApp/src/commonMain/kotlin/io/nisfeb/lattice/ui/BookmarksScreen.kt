package io.nisfeb.lattice.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.bookmarks.Bookmark
import io.nisfeb.lattice.bookmarks.BookmarkStore

/**
 * Full-page bookmarks list with search — replaces the cramped dropdown
 * that overlapped the browser bar buttons. Tap a row to open it in the
 * browser; the trailing trash icon removes it. Filtering matches both
 * the title and the urb:// url, case-insensitively.
 */
@Composable
fun BookmarksScreen(
    bookmarkStore: BookmarkStore,
    onOpen: (String) -> Unit,
    onClose: () -> Unit,
) {
    // Local mirror of the store so deletes refresh the list in place.
    var bookmarks by remember { mutableStateOf(bookmarkStore.all()) }
    var query by remember { mutableStateOf("") }

    val filtered = remember(bookmarks, query) {
        val q = query.trim()
        if (q.isEmpty()) bookmarks
        else bookmarks.filter {
            it.title.contains(q, ignoreCase = true) || it.url.contains(q, ignoreCase = true)
        }
    }

    Column(modifier = Modifier.fillMaxSize().padding(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("Bookmarks", style = MaterialTheme.typography.titleLarge)
        }
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            singleLine = true,
            label = { Text("Search bookmarks") },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            trailingIcon = {
                if (query.isNotEmpty()) {
                    IconButton(onClick = { query = "" }) {
                        Icon(Icons.Filled.Close, contentDescription = "Clear")
                    }
                }
            },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp),
        )
        HorizontalDivider()
        when {
            bookmarks.isEmpty() -> Text(
                "No bookmarks yet. Open a page and tap the bookmark icon in the browser bar to save it here.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(12.dp),
            )
            filtered.isEmpty() -> Text(
                "No bookmarks match \"$query\".",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(12.dp),
            )
            else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(filtered, key = { it.url }) { bm ->
                    BookmarkRow(
                        bm = bm,
                        onOpen = { onOpen(bm.url) },
                        onDelete = {
                            bookmarkStore.remove(bm.url)
                            bookmarks = bookmarkStore.all()
                        },
                    )
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun BookmarkRow(bm: Bookmark, onOpen: () -> Unit, onDelete: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(start = 4.dp),
    ) {
        Column(modifier = Modifier.weight(1f).padding(vertical = 8.dp)) {
            Text(
                bm.title,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            // Show the url subtitle only when it differs from the title
            // (bookmarks default title == url, so this avoids a dupe line).
            if (bm.url != bm.title) {
                Text(
                    bm.url,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        IconButton(onClick = onDelete) {
            Icon(Icons.Filled.Delete, contentDescription = "Delete bookmark")
        }
    }
}
