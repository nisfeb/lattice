package io.nisfeb.lattice.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.theme.SavedTheme
import io.nisfeb.lattice.theme.ThemeSettings
import io.nisfeb.lattice.theme.colorFromHex

/** Theme editor: presets, saved (synced) themes, per-color hex fields, live preview. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(
    settings: ThemeSettings,
    onChange: (ThemeSettings) -> Unit,
    onClose: () -> Unit,
    savedThemes: List<SavedTheme>,
    onSaveCurrent: (String) -> Unit,
    onDeleteSaved: (String) -> Unit,
) {
    var newName by remember { mutableStateOf("") }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Theme", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
            IconButton(onClick = onClose) { Icon(Icons.Filled.Check, contentDescription = "Done") }
        }

        Text("Editor", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Vim keybindings", modifier = Modifier.weight(1f))
            Switch(checked = settings.vimMode, onCheckedChange = { onChange(settings.copy(vimMode = it)) })
        }

        Text("Reading font", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
        Row(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ThemeSettings.fonts.forEach { (key, label) ->
                FilterChip(
                    selected = settings.font == key,
                    onClick = { onChange(settings.copy(font = key)) },
                    label = { Text(label) },
                )
            }
        }

        Text("Presets", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
        Row(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ThemeSettings.presets.forEach { (name, preset) ->
                AssistChip(onClick = { onChange(preset.copy(vimMode = settings.vimMode, font = settings.font)) }, label = { Text(name) })
            }
        }

        // Saved themes — synced across this user's installs via %settings.
        Text("My themes (synced)", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
        if (savedThemes.isNotEmpty()) {
            FlowRow(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                savedThemes.forEach { saved ->
                    InputChip(
                        selected = saved.settings.copy(vimMode = settings.vimMode, font = settings.font) == settings,
                        onClick = { onChange(saved.settings.copy(vimMode = settings.vimMode, font = settings.font)) },
                        label = { Text(saved.name) },
                        trailingIcon = {
                            Icon(
                                Icons.Filled.Close,
                                contentDescription = "Delete ${saved.name}",
                                modifier = Modifier.size(18.dp).clickable { onDeleteSaved(saved.name) },
                            )
                        },
                    )
                }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = newName,
                onValueChange = { newName = it },
                label = { Text("Name") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Button(
                onClick = { if (newName.isNotBlank()) { onSaveCurrent(newName.trim()); newName = "" } },
                enabled = newName.isNotBlank(),
            ) { Text("Save current") }
        }

        ColorField("Background", settings.background) { onChange(settings.copy(background = it)) }
        ColorField("Surface / panels", settings.surface) { onChange(settings.copy(surface = it)) }
        ColorField("Text", settings.text) { onChange(settings.copy(text = it)) }
        ColorField("Link", settings.link) { onChange(settings.copy(link = it)) }
        ColorField("Visited link", settings.visited) { onChange(settings.copy(visited = it)) }
        ColorField("Accent (controls)", settings.accent) { onChange(settings.copy(accent = it)) }

        Text("Preview", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp, bottom = 8.dp))
        ThemePreview(settings)
    }
}

@Composable
private fun ColorField(label: String, hex: String, onHex: (String) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Surface(
            color = colorFromHex(hex) ?: Color.Gray,
            shape = RoundedCornerShape(8.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.3f)),
            modifier = Modifier.size(40.dp),
        ) {}
        OutlinedTextField(
            value = hex,
            onValueChange = onHex,
            label = { Text(label) },
            singleLine = true,
            isError = colorFromHex(hex) == null,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun ThemePreview(s: ThemeSettings) {
    Surface(
        color = s.backgroundColor,
        shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, Color.Gray.copy(alpha = 0.4f)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("# Sample page", color = s.textColor, style = MaterialTheme.typography.titleLarge.copy(fontFamily = s.fontFamily))
            Text(
                "Body text in the chosen text color. Gemtext renders headings, text, links, quotes and preformatted blocks.",
                color = s.textColor,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = s.fontFamily),
                modifier = Modifier.padding(vertical = 6.dp),
            )
            Text("⇒ an unvisited link", color = s.linkColor, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = s.fontFamily))
            Text("⇒ a visited link", color = s.visitedColor, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = s.fontFamily))
            Surface(
                color = s.surfaceColor,
                shape = RoundedCornerShape(4.dp),
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            ) {
                Text(
                    "  preformatted / quote panel",
                    color = s.textColor,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.padding(8.dp),
                )
            }
        }
    }
}
