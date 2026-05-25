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
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.painterResource

/** Sign in to a ship with its URL and +code. Calls [onLoggedIn] with the patp. */
@Composable
fun AddShipScreen(session: UrbitSession, onLoggedIn: (String) -> Unit) {
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
                        onFailure = { busy = false; error = it.message ?: "login failed" },
                    )
                }
            },
            enabled = !busy && code.isNotBlank(),
            modifier = Modifier.padding(top = 16.dp),
        ) { Text("Connect") }

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
