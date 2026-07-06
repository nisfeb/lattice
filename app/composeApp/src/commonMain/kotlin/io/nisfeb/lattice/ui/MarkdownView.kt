package io.nisfeb.lattice.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import io.nisfeb.lattice.gemtext.UrbUrl
import io.nisfeb.lattice.markdown.MdBlock
import io.nisfeb.lattice.markdown.MdSpan
import io.nisfeb.lattice.openInBrowser

/**
 * Renders parsed markdown ([MdBlock]s). Inline styles become an AnnotatedString;
 * links resolve like gemtext (urb:// → [onNavigate], web → the OS browser); web
 * images load via Coil. [currentUrl] is the page being shown, for relative link
 * resolution.
 */
@Composable
fun MarkdownView(
    blocks: List<MdBlock>,
    currentUrl: String,
    onNavigate: (String) -> Unit,
    linkColor: Color,
    bodyFont: FontFamily = FontFamily.Default,
    listState: LazyListState = rememberLazyListState(),
    modifier: Modifier = Modifier,
) {
    val body = MaterialTheme.typography.bodyLarge.copy(fontFamily = bodyFont)
    val codeBg = MaterialTheme.colorScheme.surfaceVariant
    val onLink: (String) -> Unit = { href ->
        val resolved = UrbUrl.resolve(currentUrl, href)
        when {
            resolved != null -> onNavigate(resolved)
            href.startsWith("http://", true) || href.startsWith("https://", true) -> openInBrowser(href)
            else -> {}  // inert (unknown scheme)
        }
    }

    LazyColumn(state = listState, modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        items(blocks) { block ->
            when (block) {
                is MdBlock.Heading -> Text(
                    render(block.spans, linkColor, codeBg, onLink),
                    style = when (block.level) {
                        1 -> MaterialTheme.typography.headlineMedium
                        2 -> MaterialTheme.typography.titleLarge
                        else -> MaterialTheme.typography.titleMedium
                    }.copy(fontFamily = bodyFont),
                    modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                )

                is MdBlock.Paragraph -> Text(
                    render(block.spans, linkColor, codeBg, onLink),
                    style = body,
                    modifier = Modifier.padding(vertical = 3.dp),
                )

                is MdBlock.Bullet -> Row(Modifier.padding(start = 8.dp, top = 2.dp, bottom = 2.dp)) {
                    Text("•  ", style = body)
                    Text(render(block.spans, linkColor, codeBg, onLink), style = body)
                }

                is MdBlock.Numbered -> Row(Modifier.padding(start = 8.dp, top = 2.dp, bottom = 2.dp)) {
                    Text("${block.number}.  ", style = body)
                    Text(render(block.spans, linkColor, codeBg, onLink), style = body)
                }

                is MdBlock.Quote -> Surface(
                    color = codeBg,
                    shape = RoundedCornerShape(4.dp),
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                ) {
                    Text(
                        render(block.spans, linkColor, codeBg, onLink),
                        style = body.copy(fontStyle = FontStyle.Italic),
                        modifier = Modifier.padding(8.dp),
                    )
                }

                is MdBlock.Code -> Surface(
                    color = codeBg,
                    shape = RoundedCornerShape(4.dp),
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                ) {
                    Column(Modifier.padding(8.dp)) {
                        if (block.lang.isNotBlank()) {
                            Text(block.lang, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                        }
                        Text(
                            block.text,
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                            modifier = Modifier.horizontalScroll(rememberScrollState()),
                        )
                    }
                }

                is MdBlock.Image -> Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    if (isWebImage(block.src)) {
                        AsyncImage(model = block.src, contentDescription = block.alt, modifier = Modifier.fillMaxWidth())
                    } else {
                        // urb:// / relative images aren't fetchable yet — show a labelled placeholder.
                        Text("🖼 ${block.alt.ifBlank { block.src }}", style = body.copy(color = MaterialTheme.colorScheme.outline))
                    }
                    if (block.alt.isNotBlank() && isWebImage(block.src)) {
                        Text(block.alt, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(top = 2.dp))
                    }
                }

                MdBlock.Rule -> HorizontalDivider(Modifier.padding(vertical = 8.dp))
            }
        }
    }
}

private fun isWebImage(src: String): Boolean =
    src.startsWith("http://", true) || src.startsWith("https://", true) || src.startsWith("data:", true)

/** Flatten inline spans into a styled, link-annotated string. */
private fun render(spans: List<MdSpan>, linkColor: Color, codeBg: Color, onLink: (String) -> Unit): AnnotatedString =
    buildAnnotatedString {
        fun walk(list: List<MdSpan>) {
            for (s in list) when (s) {
                is MdSpan.Text -> append(s.text)
                is MdSpan.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { walk(s.inner) }
                is MdSpan.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { walk(s.inner) }
                is MdSpan.Strike -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { walk(s.inner) }
                is MdSpan.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg)) { append(s.text) }
                is MdSpan.Link -> {
                    val link = LinkAnnotation.Clickable(
                        tag = s.href,
                        styles = TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)),
                    ) { onLink(s.href) }
                    withLink(link) { append(s.label.ifBlank { s.href }) }
                }
                is MdSpan.Image -> withStyle(SpanStyle(color = linkColor)) { append(s.alt.ifBlank { "[image]" }) }
            }
        }
        walk(spans)
    }
