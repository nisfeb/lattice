package io.nisfeb.lattice.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.urbit.AgentInstaller
import kotlinx.coroutines.launch

/**
 * Shown after login when the %lattice agent isn't installed on the user's ship.
 * Offers to install it from the publisher (poke %hood/kiln-install), then polls
 * until its routes come up. The user can skip (the app just won't work until the
 * agent is present).
 */
@Composable
fun InstallAgentScreen(
    installer: AgentInstaller,
    sourceShip: String,
    onInstalled: () -> Unit,
    onSkip: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<InstallState>(InstallState.Prompt) }

    fun start() {
        state = InstallState.Installing
        scope.launch {
            installer.install().fold(
                onSuccess = {
                    if (installer.awaitInstalled()) {
                        onInstalled()
                    } else {
                        state = InstallState.Failed(
                            "It's taking a while. Make sure $sourceShip is online, then try again.",
                        )
                    }
                },
                onFailure = { state = InstallState.Failed(it.message ?: "couldn't start the install") },
            )
        }
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.fillMaxSize().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            when (val s = state) {
                InstallState.Prompt -> {
                    Icon(Icons.Filled.CloudDownload, null, modifier = Modifier.size(48.dp), tint = MaterialTheme.colorScheme.primary)
                    Text(
                        "Set up Lattice on your ship",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = 16.dp),
                    )
                    Text(
                        "Lattice needs its agent installed on your ship to browse and publish " +
                            "gemtext. Install it from $sourceShip?",
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
                    ) {
                        Button(onClick = { start() }) { Text("Install") }
                        TextButton(onClick = onSkip) { Text("Skip") }
                    }
                }

                InstallState.Installing -> {
                    CircularProgressIndicator()
                    Text(
                        "Setting up your ship…",
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(top = 20.dp),
                    )
                    Text(
                        "Fetching the agent from $sourceShip. This can take a minute.",
                        style = MaterialTheme.typography.bodySmall,
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }

                is InstallState.Failed -> {
                    Text(
                        "Install didn't finish",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        s.message,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
                    ) {
                        Button(onClick = { start() }) { Text("Retry") }
                        TextButton(onClick = onSkip) { Text("Skip") }
                    }
                }
            }
        }
    }
}

private sealed interface InstallState {
    data object Prompt : InstallState
    data object Installing : InstallState
    data class Failed(val message: String) : InstallState
}
