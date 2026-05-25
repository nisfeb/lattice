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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.urbit.UpdateEvent

/** Recent pushed changes to files you follow. Tap one to open it. */
@Composable
fun UpdatesScreen(updates: List<UpdateEvent>, onBrowse: (String) -> Unit, onClose: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize().padding(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("Updates", style = MaterialTheme.typography.titleLarge)
        }
        HorizontalDivider()
        if (updates.isEmpty()) {
            Text(
                "No updates yet. Open a page on another ship and tap the bell to subscribe; "
                    + "you'll be notified here when it changes.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(12.dp),
            )
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(updates) { u ->
                    Column(
                        modifier = Modifier.fillMaxWidth()
                            .clickable { onBrowse("urb://${u.ship}${u.path}") }
                            .padding(vertical = 8.dp, horizontal = 4.dp),
                    ) {
                        Text("${u.ship}${u.path}", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary)
                        Text(
                            u.body.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty(),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}
