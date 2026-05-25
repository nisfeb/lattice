package io.nisfeb.lattice.ui

import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DriveFileRenameOutline
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Split a flat list of `a/b/c` paths into the folders + files directly under [dir]. */
fun listDir(files: List<String>, dir: String): Pair<List<String>, List<String>> {
    val prefix = if (dir.isEmpty()) "" else "$dir/"
    val inDir = files.filter { it.startsWith(prefix) && it.length > prefix.length }
        .map { it.substring(prefix.length) }
    val folders = inDir.filter { it.contains('/') }.map { it.substringBefore('/') }.distinct().sorted()
    val here = inDir.filter { !it.contains('/') }.sorted()
    return folders to here
}

/**
 * Folder-aware file list: shows subfolders (drill in) and files (open) under
 * [dir]. [compact] tightens row height for desktop.
 */
@Composable
fun FileTree(
    files: List<String>,
    dir: String,
    onDir: (String) -> Unit,
    onOpen: (String) -> Unit,
    onDelete: (String) -> Unit,
    onDuplicate: (String) -> Unit,
    onMove: (String) -> Unit,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
    activePath: String? = null,
) {
    val (folders, here) = listDir(files, dir)
    val vpad = if (compact) 4.dp else 10.dp
    val rowMod = Modifier.fillMaxWidth().padding(vertical = vpad, horizontal = 6.dp)

    Column(modifier = modifier) {
        if (dir.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { onDir(dir.substringBeforeLast('/', "")) }
                    .padding(vertical = vpad, horizontal = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Folder, null, modifier = Modifier.size(18.dp).padding(end = 6.dp))
                Text("..", style = MaterialTheme.typography.bodyMedium)
            }
        }
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(folders) { f ->
                val full = if (dir.isEmpty()) f else "$dir/$f"
                Row(
                    modifier = rowMod.clickable { onDir(full) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.Folder, null, modifier = Modifier.size(18.dp).padding(end = 6.dp), tint = MaterialTheme.colorScheme.primary)
                    Text("$f/", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                }
            }
            items(here) { name ->
                val full = if (dir.isEmpty()) name else "$dir/$name"
                val selected = full == activePath
                Row(
                    modifier = rowMod.clickable { onOpen(full) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.AutoMirrored.Filled.InsertDriveFile, null, modifier = Modifier.size(18.dp).padding(end = 6.dp))
                    Text(
                        name,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.weight(1f),
                    )
                    Box {
                        var menuOpen by remember { mutableStateOf(false) }
                        IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(28.dp)) {
                            Icon(Icons.Filled.MoreVert, "Actions for $name", modifier = Modifier.size(16.dp))
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("Duplicate") },
                                leadingIcon = { Icon(Icons.Filled.ContentCopy, null) },
                                onClick = { menuOpen = false; onDuplicate(full) },
                            )
                            DropdownMenuItem(
                                text = { Text("Move / rename") },
                                leadingIcon = { Icon(Icons.Filled.DriveFileRenameOutline, null) },
                                onClick = { menuOpen = false; onMove(full) },
                            )
                            DropdownMenuItem(
                                text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                                leadingIcon = { Icon(Icons.Filled.Delete, null, tint = MaterialTheme.colorScheme.error) },
                                onClick = { menuOpen = false; onDelete(full) },
                            )
                        }
                    }
                }
            }
        }
    }
}
