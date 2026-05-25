package io.nisfeb.lattice

import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.res.loadImageBitmap
import androidx.compose.ui.res.useResource
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import io.nisfeb.lattice.bookmarks.FileBookmarkStore
import io.nisfeb.lattice.theme.FileThemeStore
import io.nisfeb.lattice.urbit.FileSessionStore

fun main() = application {
    val icon = useResource("lattice.png") { BitmapPainter(loadImageBitmap(it)) }
    Window(
        onCloseRequest = ::exitApplication,
        title = "lattice",
        icon = icon,
    ) {
        App(FileSessionStore(), FileBookmarkStore(), FileThemeStore())
    }
}
