package io.nisfeb.lattice

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

@Composable
actual fun rememberFileExporter(): (String, String) -> Unit {
    val ctx = LocalContext.current
    // CreateDocument hands back the URI only after the user picks a location, so
    // stash the content to write until the result arrives.
    var pending by remember { mutableStateOf<String?>(null) }
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/json"),
    ) { uri ->
        val data = pending
        pending = null
        if (uri != null && data != null) {
            runCatching {
                ctx.contentResolver.openOutputStream(uri)?.use { it.write(data.encodeToByteArray()) }
            }
        }
    }
    return { name, content ->
        pending = content
        launcher.launch(name)
    }
}

@Composable
actual fun rememberFileImporter(onPicked: (String) -> Unit): () -> Unit {
    val ctx = LocalContext.current
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri != null) {
            val text = runCatching {
                ctx.contentResolver.openInputStream(uri)?.use { it.readBytes().decodeToString() }
            }.getOrNull()
            if (text != null) onPicked(text)
        }
    }
    return { launcher.launch(arrayOf("application/json", "text/plain", "*/*")) }
}
