package io.nisfeb.lattice.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Bookmarks
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.NotificationAdd
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.SaveAlt
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * The catalog of right-side browser-bar actions. Stable [id]s let the user's
 * inline/overflow preference (`ThemeSettings.overflowActions`) survive across
 * builds and theme switches. The browser supplies the live label/enabled/click
 * for each; this catalog gives Settings a representative label + icon to list.
 */
object ToolbarActions {
    data class Def(val id: String, val label: String, val icon: ImageVector)

    val all: List<Def> = listOf(
        Def("bookmark", "Bookmark", Icons.Filled.BookmarkBorder),
        Def("copy", "Copy to my ship", Icons.Filled.SaveAlt),
        Def("share", "Share link", Icons.Filled.Share),
        Def("bookmarks", "Bookmarks", Icons.Filled.Bookmarks),
        Def("edit", "Edit this page", Icons.Filled.Edit),
        Def("subscribe", "Subscribe", Icons.Filled.NotificationAdd),
        Def("updates", "Updates", Icons.Filled.Inbox),
        Def("discover", "Discover", Icons.Filled.Public),
        Def("files", "Files", Icons.Filled.Folder),
        Def("settings", "Settings", Icons.Filled.Settings),
        Def("logout", "Disconnect", Icons.AutoMirrored.Filled.Logout),
    )
}
