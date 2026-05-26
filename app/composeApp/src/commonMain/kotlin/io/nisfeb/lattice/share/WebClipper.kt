package io.nisfeb.lattice.share

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.time.Duration

/**
 * Fetches a web page and converts it to gemtext.
 *
 * Uses its OWN cookieless [OkHttpClient] — never the ship session client — so
 * the urbauth cookie is never sent to a third-party site we're clipping.
 */
class WebClipper(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .followRedirects(true)
        .followSslRedirects(true)
        .connectTimeout(Duration.ofSeconds(15))
        .callTimeout(Duration.ofSeconds(30))
        .build(),
) {
    /** Fetch [url] and return (title, gemtext). Throws on network / HTTP error. */
    suspend fun clip(url: String): Clip = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(url)
            .header("User-Agent", "lattice-clipper/1.0 (+https://github.com/nisfeb/lattice)")
            .header("Accept", "text/html,application/xhtml+xml")
            .get()
            .build()
        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) error("HTTP ${resp.code} fetching the page")
            val ctype = resp.header("Content-Type").orEmpty().lowercase()
            if (ctype.isNotEmpty() && !ctype.contains("html") && !ctype.contains("xml") && !ctype.contains("text/")) {
                error("not a web page (Content-Type: $ctype)")
            }
            val html = resp.body?.string().orEmpty()
            val title = HtmlToGemtext.extractTitle(html) ?: url
            val body = HtmlToGemtext.convert(html, url)
            Clip(title = title, gemtext = "# $title\n\n$body")
        }
    }

    data class Clip(val title: String, val gemtext: String)
}
