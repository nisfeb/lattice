package io.nisfeb.lattice.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.urbit.BrowseListing
import io.nisfeb.lattice.urbit.LatticeClient
import io.nisfeb.lattice.urbit.explainNetworkError
import kotlinx.coroutines.launch

private fun normShip(s: String): String = s.trim().let { if (it.isEmpty() || it.startsWith("~")) it else "~$it" }
private fun joinPath(dir: String, name: String) = if (dir == "/") "/$name" else "$dir/$name"
private fun parentPath(p: String): String {
    val trimmed = p.trimEnd('/')
    val i = trimmed.lastIndexOf('/')
    return if (i <= 0) "/" else trimmed.substring(0, i)
}

private data class OpenFile(val name: String, val mark: String, val body: String)

/**
 * The federated tree reader: browse ANY grubbery ship's directory tree (shallow,
 * one level at a time) and read its files. Backed by /browse + /browse-file, which
 * are owner-authenticated remote peeks — an unreachable or permission-denied peer
 * reads as a 504. Directories drill in; files open in an inline text viewer.
 */
@Composable
fun ShipBrowserScreen(
    client: LatticeClient,
    homeShip: String,
    follows: List<String>,
    onClose: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var shipInput by remember { mutableStateOf(homeShip) }
    var activeShip by remember { mutableStateOf<String?>(null) }
    var path by remember { mutableStateOf("/") }
    var listing by remember { mutableStateOf<BrowseListing?>(null) }
    var openFile by remember { mutableStateOf<OpenFile?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun go(ship: String, p: String) {
        val s = normShip(ship)
        if (s.isEmpty()) return
        scope.launch {
            loading = true; error = null; openFile = null
            client.browse(s, p)
                .onSuccess { listing = it; activeShip = s; path = it.path }
                .onFailure { error = explainNetworkError(it, s); if (activeShip == null) listing = null }
            loading = false
        }
    }

    fun openLeaf(name: String) {
        val ship = activeShip ?: return
        scope.launch {
            loading = true; error = null
            client.browseFile(ship, joinPath(path, name))
                .onSuccess { openFile = OpenFile(name, it.mark, it.body) }
                .onFailure { error = explainNetworkError(it, ship) }
            loading = false
        }
    }

    Column(Modifier.fillMaxSize().padding(8.dp)) {
        // top bar
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Close") }
            Text("Ship files", style = MaterialTheme.typography.titleMedium)
        }
        // ship entry
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = shipInput,
                onValueChange = { shipInput = it },
                label = { Text("ship (~sampel-palnet)") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = { go(shipInput, "/") }, modifier = Modifier.padding(start = 8.dp)) { Text("Browse") }
        }
        // suggestions (follows) — quick-pick a ship
        if (follows.isNotEmpty() && activeShip == null) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                follows.take(6).forEach { f ->
                    TextButton(onClick = { shipInput = f; go(f, "/") }) { Text(f, style = MaterialTheme.typography.labelMedium) }
                }
            }
        }

        activeShip?.let { ship ->
            HorizontalDivider(Modifier.padding(vertical = 4.dp))
            // breadcrumb + up
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { go(ship, parentPath(path)) }, enabled = path != "/" && openFile == null) {
                    Icon(Icons.Filled.ArrowUpward, "Up")
                }
                Text("$ship $path", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            }
        }

        error?.let { Text("Error: $it", color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 4.dp)) }
        if (loading) Box(Modifier.fillMaxWidth().padding(16.dp), Alignment.Center) { CircularProgressIndicator() }

        val f = openFile
        if (f != null) {
            // inline file viewer
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { openFile = null }) { Text("← listing") }
                Text("${f.name}  ·  ${f.mark}", style = MaterialTheme.typography.labelMedium)
            }
            HorizontalDivider(Modifier.padding(vertical = 4.dp))
            // Render by type: markdown/gemtext get their rich views, code/text a
            // selectable monospace view. urb:// links in a browsed file are inert
            // (the file reader isn't a page browser); web links open externally.
            ContentView(
                mark = f.mark,
                name = f.name,
                body = f.body,
                currentUrl = activeShip?.let { "urb://$it${joinPath(path, f.name)}" } ?: "",
                onNavigate = {},
                linkColor = MaterialTheme.colorScheme.primary,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            listing?.let { l ->
                if (l.truncated) {
                    Text("(listing truncated — directory has more entries than shown)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                }
                if (l.children.isEmpty() && !loading) {
                    Text("Empty directory.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(8.dp))
                }
                LazyColumn(Modifier.fillMaxSize()) {
                    items(l.children) { c ->
                        Row(
                            Modifier.fillMaxWidth()
                                .clickable { if (c.isDir) go(l.ship, joinPath(path, c.name)) else openLeaf(c.name) }
                                .padding(horizontal = 6.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                if (c.isDir) Icons.Filled.Folder else Icons.Filled.Description,
                                if (c.isDir) "dir" else "file",
                                modifier = Modifier.size(20.dp),
                            )
                            Text(c.name, modifier = Modifier.padding(start = 10.dp).weight(1f))
                            if (!c.isDir && c.mark.isNotBlank()) {
                                Text(c.mark, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        HorizontalDivider()
                    }
                }
            }
        }
    }

    LaunchedEffect(Unit) { if (homeShip.isNotBlank()) go(homeShip, "/") }
}
