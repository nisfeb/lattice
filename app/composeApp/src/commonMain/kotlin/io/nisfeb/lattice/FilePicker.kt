package io.nisfeb.lattice

import androidx.compose.runtime.Composable

/**
 * Returns a trigger that writes [content] to a user-chosen file, defaulting to
 * the name [suggestedName]. Android shows the SAF "create document" sheet;
 * desktop shows a native save dialog.
 */
@Composable
expect fun rememberFileExporter(): (suggestedName: String, content: String) -> Unit

/**
 * Returns a trigger that prompts the user to pick a file; its text contents are
 * delivered to [onPicked] (not called if the user cancels or the read fails).
 */
@Composable
expect fun rememberFileImporter(onPicked: (content: String) -> Unit): () -> Unit
