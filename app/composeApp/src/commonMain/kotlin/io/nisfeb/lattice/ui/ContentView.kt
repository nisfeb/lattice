package io.nisfeb.lattice.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.content.ContentKind
import io.nisfeb.lattice.content.classifyContent
import io.nisfeb.lattice.gemtext.GemtextParser
import io.nisfeb.lattice.markdown.Markdown

/**
 * Renders content by type. Dispatches on the grub [mark] and file [name]:
 * gemtext and markdown get their rich renderers; code and text get a
 * selectable monospace view (code scrolls horizontally for long lines); images
 * aren't fetchable from the namespace yet, so they show a placeholder. Provides
 * its own scrolling — don't wrap it in another scroll container.
 */
@Composable
fun ContentView(
    mark: String,
    name: String,
    body: String,
    currentUrl: String,
    onNavigate: (String) -> Unit,
    linkColor: Color,
    bodyFont: FontFamily = FontFamily.Default,
    modifier: Modifier = Modifier,
) {
    when (classifyContent(mark, name)) {
        ContentKind.Gemtext -> GemtextView(
            lines = GemtextParser.parse(body),
            currentUrl = currentUrl,
            onNavigate = onNavigate,
            linkColor = linkColor,
            visitedColor = linkColor,
            visited = emptySet(),
            bodyFont = bodyFont,
            modifier = modifier,
        )

        ContentKind.Markdown -> MarkdownView(
            blocks = Markdown.parse(body),
            currentUrl = currentUrl,
            onNavigate = onNavigate,
            linkColor = linkColor,
            bodyFont = bodyFont,
            modifier = modifier,
        )

        ContentKind.Code -> SelectionContainer {
            Text(
                body,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                modifier = modifier.fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .horizontalScroll(rememberScrollState())
                    .padding(12.dp),
            )
        }

        ContentKind.Text -> SelectionContainer {
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = bodyFont),
                modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
            )
        }

        ContentKind.Image -> Box(modifier.fillMaxSize().padding(24.dp), Alignment.Center) {
            Text(
                "Image preview from Urbit ships isn't supported yet.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
