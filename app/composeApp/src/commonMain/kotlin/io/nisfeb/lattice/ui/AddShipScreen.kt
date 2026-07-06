package io.nisfeb.lattice.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.resources.Res
import io.nisfeb.lattice.resources.wordmark
import io.nisfeb.lattice.urbit.UrbitSession
import io.nisfeb.lattice.urbit.explainNetworkError
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.painterResource

/** Sign in to a ship with its URL and +code. Calls [onLoggedIn] with the patp.
 *  [onCancel] is supplied only when another ship is already logged in (the user
 *  tapped "Add ship" from the picker) — pressing it restores that ship without
 *  forcing a fresh login. Null on the first-ever login screen. */
@Composable
fun AddShipScreen(
    session: UrbitSession,
    onLoggedIn: (String) -> Unit,
    onCancel: (() -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf("http://localhost:8081") }
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Image(
            painter = painterResource(Res.drawable.wordmark),
            contentDescription = "lattice",
            modifier = Modifier.height(64.dp).padding(bottom = 16.dp),
        )
        Text("Connect a ship", style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            url, { url = it }, label = { Text("ship URL") }, singleLine = true,
            modifier = Modifier.fillMaxWidth().widthIn(max = 420.dp).padding(top = 16.dp),
        )
        OutlinedTextField(
            code, { code = it }, label = { Text("+code") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth().widthIn(max = 420.dp).padding(top = 8.dp),
        )
        Button(
            onClick = {
                scope.launch {
                    busy = true; error = null
                    session.login(url, code).fold(
                        onSuccess = { busy = false; onLoggedIn(it) },
                        onFailure = {
                            busy = false
                            // Distinguish a rejected +code (the ship answered) from
                            // a transport failure (couldn't reach the ship at all).
                            val m = it.message.orEmpty()
                            error = if ("login HTTP" in m || "urbauth cookie" in m) {
                                "Login rejected — check your +code, and that the URL points at your ship."
                            } else {
                                explainNetworkError(it, url)
                            }
                        },
                    )
                }
            },
            enabled = !busy && code.isNotBlank(),
            modifier = Modifier.padding(top = 16.dp),
        ) { Text("Connect") }

        if (onCancel != null && !busy) {
            TextButton(onClick = onCancel, modifier = Modifier.padding(top = 4.dp)) {
                Text("Cancel")
            }
        }

        if (busy) CircularProgressIndicator(modifier = Modifier.padding(top = 16.dp))
        error?.let {
            Text(
                it,
                color = androidx.compose.material3.MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = 12.dp),
            )
        }
    }
}
