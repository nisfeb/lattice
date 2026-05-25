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
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.urbit.LatticeClient
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

/** Find and follow other lattice publishers: your follows, publishing contacts, and add-by-patp. */
@Composable
fun DiscoverScreen(
    client: LatticeClient,
    follows: List<String>,
    onFollow: (String) -> Unit,
    onUnfollow: (String) -> Unit,
    onBrowse: (String) -> Unit,
    onClose: () -> Unit,
) {
    var suggested by remember { mutableStateOf<List<String>?>(null) }
    var newPatp by remember { mutableStateOf("") }

    // probe contacts (that we don't already follow) in parallel
    LaunchedEffect(follows) {
        suggested = null
        val contacts = client.contacts().getOrDefault(emptyList()).filter { it !in follows }
        suggested = coroutineScope {
            contacts.map { s -> async { s to client.publishes(s) } }.awaitAll()
        }.filter { it.second }.map { it.first }
    }

    fun normalize(p: String): String = p.trim().let { if (it.startsWith("~")) it else "~$it" }

    Column(modifier = Modifier.fillMaxSize().padding(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("Discover", style = MaterialTheme.typography.titleLarge)
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = newPatp,
                onValueChange = { newPatp = it },
                label = { Text("follow a ship (~sampel-palnet)") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Button(
                onClick = { if (newPatp.isNotBlank()) { onFollow(normalize(newPatp)); newPatp = "" } },
                enabled = newPatp.isNotBlank(),
            ) { Text("Follow") }
        }
        HorizontalDivider()
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            if (follows.isNotEmpty()) {
                item { Section("Following") }
                items(follows) { ship ->
                    ShipRow(ship, onClick = { onBrowse(ship) }) {
                        IconButton(onClick = { onUnfollow(ship) }, modifier = Modifier.size(32.dp)) {
                            Icon(Icons.Filled.Close, "Unfollow $ship", modifier = Modifier.size(18.dp))
                        }
                    }
                }
            }
            item { Section("From your contacts") }
            val sug = suggested
            when {
                sug == null -> item {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(8.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp))
                        Text("  probing contacts…", style = MaterialTheme.typography.bodyMedium)
                    }
                }
                sug.isEmpty() -> item {
                    Text(
                        "No publishing contacts found. Add a ship above, or share your follows so others can find you.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(8.dp),
                    )
                }
                else -> items(sug) { ship ->
                    ShipRow(ship, onClick = { onBrowse(ship) }) {
                        TextButton(onClick = { onFollow(ship) }) { Text("Follow") }
                    }
                }
            }
        }
    }
}

@Composable
private fun Section(title: String) {
    Text(
        title,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
    )
}

@Composable
private fun ShipRow(ship: String, onClick: () -> Unit, trailing: @Composable () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 6.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(ship, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        trailing()
    }
}
