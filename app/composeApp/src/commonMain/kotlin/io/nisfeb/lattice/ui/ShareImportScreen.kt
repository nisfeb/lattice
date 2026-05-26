package io.nisfeb.lattice.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.copyToClipboard
import io.nisfeb.lattice.share.ShareImport
import io.nisfeb.lattice.share.SharedContent
import io.nisfeb.lattice.share.WebClipper
import io.nisfeb.lattice.urbit.LatticeClient

/**
 * Handles content shared into Lattice from the OS share sheet. Converts it to
 * gemtext (fetching + clipping a web page if the shared text is a URL), saves it
 * to the user's ship under `shared/<slug>`, copies the resulting urb:// URL to
 * the clipboard, and offers to open or edit it.
 */
@Composable
fun ShareImportScreen(
    client: LatticeClient,
    homeShip: String,
    content: SharedContent,
    onOpen: (String) -> Unit,
    onEdit: (String) -> Unit,
    onClose: () -> Unit,
    webClipper: WebClipper = remember { WebClipper() },
) {
    var state by remember { mutableStateOf<ImportState>(ImportState.Working) }

    LaunchedEffect(content) {
        state = ImportState.Working
        runCatching {
            val isUrl = ShareImport.isWebUrl(content.text)
            val title: String
            val gemtext: String
            if (isUrl) {
                val clip = webClipper.clip(ShareImport.secureUrl(content.text.trim()))
                title = clip.title
                gemtext = clip.gemtext
            } else {
                title = content.title?.takeIf { it.isNotBlank() }
                    ?: ShareImport.titleFromText(content.text)
                    ?: "shared text"
                gemtext = ShareImport.gemtextForText(content.title ?: title, content.text)
            }
            val path = ShareImport.pathFor(title)
            client.save(path, gemtext).getOrThrow()
            path to ShareImport.urbUrl(homeShip, path)
        }.fold(
            onSuccess = { (path, url) ->
                copyToClipboard(url)
                state = ImportState.Done(url = url, path = path)
            },
            onFailure = { state = ImportState.Failed(it.message ?: "import failed") },
        )
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.fillMaxSize().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            when (val s = state) {
                ImportState.Working -> {
                    CircularProgressIndicator()
                    Text(
                        "Converting and saving to your ship…",
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(top = 20.dp),
                    )
                }

                is ImportState.Done -> {
                    Icon(
                        Icons.Filled.CheckCircle,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(48.dp),
                    )
                    Text(
                        "Saved to your ship",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = 16.dp),
                    )
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
                    ) {
                        Text(
                            s.url,
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                            modifier = Modifier.padding(12.dp),
                        )
                    }
                    Text(
                        "Copied the link to your clipboard.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
                    ) {
                        Button(onClick = { onOpen(s.url) }) { Text("Open") }
                        OutlinedButton(onClick = { onEdit(s.path) }) { Text("Edit") }
                        TextButton(onClick = onClose) { Text("Done") }
                    }
                }

                is ImportState.Failed -> {
                    Icon(
                        Icons.Filled.ErrorOutline,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(48.dp),
                    )
                    Text(
                        "Couldn't save the shared content",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = 16.dp),
                    )
                    Text(
                        s.message,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                    TextButton(onClick = onClose, modifier = Modifier.padding(top = 24.dp)) { Text("Close") }
                }
            }
        }
    }
}

private sealed interface ImportState {
    data object Working : ImportState
    data class Done(val url: String, val path: String) : ImportState
    data class Failed(val message: String) : ImportState
}
