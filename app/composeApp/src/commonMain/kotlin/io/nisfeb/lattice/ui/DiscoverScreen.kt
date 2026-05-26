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
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
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
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

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
    // Publishers found among contacts (populated live as probes finish).
    var found by remember { mutableStateOf<List<String>>(emptyList()) }
    // Non-null while probing: which ship we're checking and how far along.
    var probing by remember { mutableStateOf<Probe?>(null) }
    var newPatp by remember { mutableStateOf("") }
    // Bump to (re)run the probe. Keyed here — NOT on `follows` — so following a
    // contact (which mutates follows) doesn't restart the whole probe. The user
    // can re-probe on demand via the refresh button.
    var probeNonce by remember { mutableStateOf(0) }

    // Probe contacts we don't already follow, bounded-concurrently (each probe
    // can take up to ~8s, so sequential would be far too slow). State writes all
    // land on the composition dispatcher, so the counter/list updates are safe.
    LaunchedEffect(probeNonce) {
        found = emptyList()
        probing = null
        val contacts = client.contacts().getOrDefault(emptyList()).filter { it !in follows }
        if (contacts.isEmpty()) return@LaunchedEffect
        probing = Probe(current = null, done = 0, total = contacts.size)
        var done = 0
        val gate = Semaphore(8)
        coroutineScope {
            contacts.map { s ->
                async {
                    gate.withPermit {
                        probing = probing?.copy(current = s)
                        val publishes = client.publishes(s)
                        done += 1
                        if (publishes) found = found + s
                        probing = probing?.copy(done = done)
                    }
                }
            }.awaitAll()
        }
        probing = null
    }

    fun normalize(p: String): String = p.trim().let { if (it.startsWith("~")) it else "~$it" }

    Column(modifier = Modifier.fillMaxSize().padding(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("Discover", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            IconButton(onClick = { if (probing == null) probeNonce++ }, enabled = probing == null) {
                Icon(Icons.Filled.Refresh, "Re-probe contacts")
            }
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
            val p = probing
            if (p != null) item { ProbeProgress(p) }
            if (found.isNotEmpty()) {
                items(found) { ship ->
                    ShipRow(ship, onClick = { onBrowse(ship) }) {
                        // Follow + drop from the found list locally (it moves to the
                        // "Following" section) without restarting the probe.
                        TextButton(onClick = { onFollow(ship); found = found - ship }) { Text("Follow") }
                    }
                }
            } else if (p == null) {
                item {
                    Text(
                        "No publishing contacts found. Add a ship above, or share your follows so others can find you.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(8.dp),
                    )
                }
            }
        }
    }
}

/** Live state of the contact probe: the ship currently being checked, and how
 *  many of [total] have been processed. */
private data class Probe(val current: String?, val done: Int, val total: Int)

@Composable
private fun ProbeProgress(p: Probe) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp, horizontal = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            Text(
                "  Probing ${p.current ?: "contacts"}…",
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                modifier = Modifier.weight(1f).padding(start = 4.dp),
            )
            Text(
                "${p.done}/${p.total}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        LinearProgressIndicator(
            progress = { if (p.total == 0) 0f else p.done.toFloat() / p.total },
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
        )
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
