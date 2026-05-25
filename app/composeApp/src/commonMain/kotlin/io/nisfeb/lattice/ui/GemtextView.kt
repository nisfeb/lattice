package io.nisfeb.lattice.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.gemtext.GemLine
import io.nisfeb.lattice.gemtext.UrbUrl

/**
 * Renders parsed gemtext. [currentUrl] is the page being shown (for relative
 * link resolution); [onNavigate] is called with a resolved absolute urb:// URL
 * when a navigable link is tapped.
 */
@Composable
fun GemtextView(
    lines: List<GemLine>,
    currentUrl: String,
    onNavigate: (String) -> Unit,
    linkColor: Color,
    visitedColor: Color,
    visited: Set<String>,
    modifier: Modifier = Modifier,
) {
    LazyColumn(modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        items(lines) { line ->
            when (line) {
                is GemLine.Heading -> Text(
                    line.text,
                    style = when (line.level) {
                        1 -> MaterialTheme.typography.headlineMedium
                        2 -> MaterialTheme.typography.titleLarge
                        else -> MaterialTheme.typography.titleMedium
                    },
                    modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                )

                is GemLine.Text ->
                    if (line.text.isBlank()) Text("", modifier = Modifier.padding(2.dp))
                    else Text(line.text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(vertical = 2.dp))

                is GemLine.Bullet -> Text(
                    "•  ${line.text}",
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(start = 8.dp, top = 2.dp, bottom = 2.dp),
                )

                is GemLine.Quote -> Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(4.dp),
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                ) {
                    Text(
                        line.text,
                        style = MaterialTheme.typography.bodyLarge.copy(fontStyle = FontStyle.Italic),
                        modifier = Modifier.padding(8.dp),
                    )
                }

                is GemLine.Pre -> Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(4.dp),
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                ) {
                    Text(
                        line.lines.joinToString("\n"),
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        modifier = Modifier.padding(8.dp),
                    )
                }

                is GemLine.Link -> {
                    val resolved = UrbUrl.resolve(currentUrl, line.url)
                    val label = line.desc.ifBlank { line.url }
                    if (resolved != null) {
                        val color = if (resolved in visited) visitedColor else linkColor
                        Row(modifier = Modifier.fillMaxWidth().clickable { onNavigate(resolved) }.padding(vertical = 4.dp)) {
                            Text("⇒ ", style = MaterialTheme.typography.bodyLarge, color = color)
                            Text(
                                label,
                                style = MaterialTheme.typography.bodyLarge,
                                color = color,
                                textDecoration = TextDecoration.Underline,
                            )
                        }
                    } else {
                        // Foreign scheme: inert, show the URL so it can be copied.
                        Column(modifier = Modifier.padding(vertical = 4.dp)) {
                            if (line.desc.isNotBlank())
                                Text(line.desc, style = MaterialTheme.typography.bodyLarge)
                            Text(line.url, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                        }
                    }
                }
            }
        }
    }
}
