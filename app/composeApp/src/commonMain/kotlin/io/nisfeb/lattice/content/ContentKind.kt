package io.nisfeb.lattice.content

/** How a piece of content should be rendered. */
enum class ContentKind { Gemtext, Markdown, Image, Code, Text }

/**
 * Decide how to render content from its grub [mark] (e.g. "gmi", "md", "hoon")
 * and/or its file [name] (for the extension). Marks win over extensions; a
 * fetched page carries a mark and no name, a browsed file carries both. Falls
 * back to [ContentKind.Text] — the grubbery file reader only ever returns text
 * bytes, so "unknown" is safe to show as plain text.
 */
private val GEMTEXT = setOf("gmi", "gemini")
private val MARKDOWN = setOf("md", "markdown", "mdown", "mkd", "mdwn")
private val IMAGE = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif")
private val TEXT = setOf("txt", "text", "log", "csv", "tsv", "asc")
private val CODE = setOf(
    "hoon", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "rs", "go", "c", "cc", "cpp",
    "h", "hpp", "java", "kt", "kts", "gradle", "json", "yaml", "yml", "toml", "ini", "conf",
    "properties", "css", "scss", "sass", "less", "html", "htm", "xml", "svelte", "vue", "sh",
    "bash", "zsh", "fish", "sql", "php", "swift", "lua", "pl", "pm", "r", "scala", "clj", "cljs",
    "ex", "exs", "erl", "hs", "ml", "vim", "dockerfile", "makefile", "cmake", "diff", "patch",
)

fun classifyContent(mark: String, name: String = ""): ContentKind {
    val m = mark.trim().lowercase()
    val ext = name.substringAfterLast('.', "").lowercase()
    val base = name.substringAfterLast('/').lowercase()  // "Makefile", "Dockerfile"
    return when {
        m in MARKDOWN || ext in MARKDOWN -> ContentKind.Markdown
        m in GEMTEXT || ext in GEMTEXT -> ContentKind.Gemtext
        m in IMAGE || ext in IMAGE -> ContentKind.Image
        m in CODE || ext in CODE || base in CODE -> ContentKind.Code
        m in TEXT || ext in TEXT -> ContentKind.Text
        else -> ContentKind.Text
    }
}
