package io.nisfeb.lattice.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Bookmarks
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.NotificationAdd
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.SaveAlt
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import io.nisfeb.lattice.isDesktop
import io.nisfeb.lattice.shareText
import io.nisfeb.lattice.browser.UrlPaths
import io.nisfeb.lattice.bookmarks.Bookmark
import io.nisfeb.lattice.bookmarks.BookmarkStore
import io.nisfeb.lattice.gemtext.GemtextParser
import io.nisfeb.lattice.theme.ThemeSettings
import io.nisfeb.lattice.urbit.LatticeClient
import kotlinx.coroutines.launch

/** Tabbed browser: address bar, back/forward/home, bookmarks, and the rendered page. */
@Composable
fun BrowserScreen(
    client: LatticeClient,
    bookmarkStore: BookmarkStore,
    theme: ThemeSettings,
    homeShip: String,
    onLogout: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenFiles: () -> Unit,
    onEditPage: (String) -> Unit,
    onOpenDiscover: () -> Unit,
    openUrl: String? = null,
    onConsumedOpenUrl: () -> Unit = {},
    subscriptions: Set<String> = emptySet(),
    onSubscribe: (String) -> Unit = {},
    onUnsubscribe: (String) -> Unit = {},
    onOpenUpdates: () -> Unit = {},
    onOpenBookmarks: () -> Unit = {},
    unreadUpdates: Int = 0,
    // Hoisted by App so tabs + the active index survive this screen
    // leaving the composition (opening Settings, Files, etc.). Without
    // this the browser reset to the home page on every round-trip.
    tabs: SnapshotStateList<BrowserTab>,
    activeState: MutableState<Int>,
) {
    val scope = rememberCoroutineScope()
    val home = "urb://$homeShip/"
    var active by activeState
    var bookmarks by remember { mutableStateOf(bookmarkStore.all()) }
    val rootFocus = remember { FocusRequester() }
    var copyOpen by remember { mutableStateOf(false) }
    var copyDest by remember { mutableStateOf("") }
    var copyMsg by remember { mutableStateOf<String?>(null) }
    // Confirmation for share when the platform has no native UI (desktop copies
    // the link to the clipboard); null on Android, where the share sheet shows.
    var shareMsg by remember { mutableStateOf<String?>(null) }
    var overflowOpen by remember { mutableStateOf(false) }
    // Shown when the address bar gets a non-urb:// (web) address —
    // Lattice browses the Urbit network only, so we explain rather
    // than fire a doomed fetch that 400s with "bad urb:// url".
    var addrMsg by remember { mutableStateOf<String?>(null) }

    fun load(tab: BrowserTab, url: String) {
        tab.job?.cancel()
        tab.error = null; tab.loading = true; tab.address = url
        tab.job = scope.launch {
            client.fetch(url).fold(
                onSuccess = { tab.body = it.body; tab.lines = GemtextParser.parse(it.body); tab.loading = false; tab.visited = tab.visited + url },
                onFailure = { tab.error = it.message ?: "failed to load"; tab.loading = false },
            )
        }
    }

    fun navigate(tab: BrowserTab, url: String) {
        while (tab.history.size > tab.cursor + 1) tab.history.removeAt(tab.history.size - 1)
        tab.history.add(url); tab.cursor = tab.history.lastIndex; load(tab, url)
    }

    fun newTab() {
        val t = BrowserTab()
        tabs.add(t); active = tabs.lastIndex
        navigate(t, home)
    }

    fun openTab(url: String) {
        val t = BrowserTab()
        tabs.add(t); active = tabs.lastIndex
        navigate(t, url)
    }

    fun closeTab(i: Int) {
        tabs.getOrNull(i)?.job?.cancel()
        tabs.removeAt(i)
        if (tabs.isEmpty()) newTab() else active = active.coerceIn(0, tabs.lastIndex)
    }

    // Address-bar submit: navigate to a urb:// (or path) address, or
    // explain when the user typed a web URL (Lattice is urb-only).
    fun go(tab: BrowserTab, raw: String) {
        val addr = raw.trim()
        if (addr.isBlank()) return
        if (io.nisfeb.lattice.gemtext.UrbUrl.hasForeignScheme(addr)) {
            addrMsg = "Lattice browses Urbit addresses (urb://~ship/path), not the web."
        } else {
            navigate(tab, addr)
        }
    }

    LaunchedEffect(Unit) {
        if (tabs.isEmpty()) newTab()
        rootFocus.requestFocus()
    }
    // open a URL requested from elsewhere (e.g. Discover → browse a ship)
    LaunchedEffect(openUrl) {
        if (openUrl != null) { openTab(openUrl); onConsumedOpenUrl() }
    }

    val tab = tabs.getOrNull(active.coerceIn(0, maxOf(0, tabs.lastIndex)))
    val current = tab?.current.orEmpty()
    val bookmarked = bookmarks.any { it.url == current }
    val ownPrefix = "urb://$homeShip/"
    val editPath: String? = UrlPaths.editPathFor(current, ownPrefix)

    val ib = if (isDesktop) 34.dp else 48.dp
    val ic = if (isDesktop) 18.dp else 24.dp

    @OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
    @Composable
    fun barBtn(onClick: () -> Unit, icon: ImageVector, desc: String, enabled: Boolean = true) {
        // Hover (desktop) / long-press (mobile) tooltip naming the
        // button — the icon-only bar was ambiguous without it.
        TooltipBox(
            positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
            tooltip = { PlainTooltip { Text(desc) } },
            state = rememberTooltipState(),
        ) {
            IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(ib)) {
                Icon(icon, desc, modifier = Modifier.size(ic))
            }
        }
    }

    Column(
        modifier = Modifier.fillMaxSize()
            .focusRequester(rootFocus).focusable()
            .onPreviewKeyEvent { ev ->
                when {
                    ev.isCtrlPressed && ev.key == Key.T -> { if (ev.type == KeyEventType.KeyDown) newTab(); true }
                    ev.isCtrlPressed && ev.key == Key.W -> { if (ev.type == KeyEventType.KeyDown && tab != null) closeTab(active); true }
                    else -> false
                }
            },
    ) {
        // tab strip + new-tab button
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            tabs.forEachIndexed { i, t ->
                val sel = i == active
                Surface(
                    color = if (sel) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.background,
                    modifier = Modifier.widthIn(max = 200.dp).clickable { active = i },
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 10.dp, end = 2.dp, top = 3.dp, bottom = 3.dp)) {
                        Text(
                            t.title(),
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1,
                            color = if (sel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.widthIn(max = 160.dp),
                        )
                        IconButton(onClick = { closeTab(i) }, modifier = Modifier.size(22.dp)) {
                            Icon(Icons.Filled.Close, "Close tab", modifier = Modifier.size(13.dp))
                        }
                    }
                }
            }
            IconButton(onClick = { newTab() }, modifier = Modifier.size(30.dp)) {
                Icon(Icons.Filled.Add, "New tab (Ctrl+T)", modifier = Modifier.size(18.dp))
            }
        }

        // right-side actions. Order here is the inline priority (when space is
        // tight, later ones overflow first); the user can also pin any of them
        // to the ⋮ menu via Settings (theme.overflowActions). Ids match
        // ToolbarActions so the preference is stable.
        val allActions = listOf(
            BarAction(
                "bookmark",
                if (bookmarked) Icons.Filled.Bookmark else Icons.Filled.BookmarkBorder,
                if (bookmarked) "Remove bookmark" else "Add bookmark",
                current.isNotBlank(),
            ) {
                if (current.isNotBlank()) {
                    if (bookmarked) bookmarkStore.remove(current) else bookmarkStore.add(Bookmark(current, current))
                    bookmarks = bookmarkStore.all()
                }
            },
            BarAction("copy", Icons.Filled.SaveAlt, "Copy to my ship", tab?.body?.isNotBlank() == true) {
                copyDest = UrlPaths.defaultDest(current); copyOpen = true
            },
            BarAction("share", Icons.Filled.Share, "Share link", current.isNotBlank()) {
                if (current.isNotBlank()) shareText(current)?.let { shareMsg = it }
            },
            BarAction("bookmarks", Icons.Filled.Bookmarks, "Bookmarks", true) { onOpenBookmarks() },
            BarAction("edit", Icons.Filled.Edit, "Edit this page", editPath != null) { editPath?.let(onEditPage) },
            run {
                val subbed = current in subscriptions
                BarAction(
                    "subscribe",
                    if (subbed) Icons.Filled.NotificationsActive else Icons.Filled.NotificationAdd,
                    if (subbed) "Unsubscribe" else "Subscribe to this page",
                    current.isNotBlank(),
                ) { if (subbed) onUnsubscribe(current) else onSubscribe(current) }
            },
            BarAction("updates", Icons.Filled.Inbox, if (unreadUpdates > 0) "Updates ($unreadUpdates)" else "Updates", true) { onOpenUpdates() },
            BarAction("discover", Icons.Filled.Public, "Discover", true) { onOpenDiscover() },
            BarAction("files", Icons.Filled.Folder, "Files", true) { onOpenFiles() },
            BarAction("settings", Icons.Filled.Settings, "Settings", true) { onOpenSettings() },
            BarAction("logout", Icons.AutoMirrored.Filled.Logout, "Disconnect", true) { onLogout() },
        )
        // User-pinned overflow actions go to the ⋮ menu regardless of width;
        // the rest stay inline (then spill to ⋮ as space runs out, below).
        val rightActions = allActions.filter { it.id !in theme.overflowActions }
        val pinnedOverflow = allActions.filter { it.id in theme.overflowActions }

        // navigation / address bar (acts on the active tab) — keeps the URL bar a
        // minimum width; right buttons collapse into a ⋮ menu when space is tight
        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
            val n = UrlPaths.inlineCount(maxWidth.value, ib.value, leftButtons = 3, reservedDp = 240f, count = rightActions.size)
            val inline = rightActions.take(n)
            // Width-spilled inline actions, then the user-pinned ones.
            val overflow = rightActions.drop(n) + pinnedOverflow

            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = if (isDesktop) 2.dp else 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                barBtn({ tab?.let { if (it.canBack) { it.cursor--; load(it, it.history[it.cursor]) } } }, Icons.AutoMirrored.Filled.ArrowBack, "Back", tab?.canBack == true)
                barBtn({ tab?.let { if (it.canForward) { it.cursor++; load(it, it.history[it.cursor]) } } }, Icons.AutoMirrored.Filled.ArrowForward, "Forward", tab?.canForward == true)
                barBtn({ tab?.let { navigate(it, home) } }, Icons.Filled.Home, "Home")
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)),
                    modifier = Modifier.weight(1f).widthIn(min = 200.dp).height(if (isDesktop) 34.dp else 48.dp).padding(horizontal = 4.dp),
                ) {
                    Box(contentAlignment = Alignment.CenterStart, modifier = Modifier.padding(horizontal = 10.dp)) {
                        BasicTextField(
                            value = tab?.address.orEmpty(),
                            onValueChange = { tab?.address = it },
                            singleLine = true,
                            textStyle = LocalTextStyle.current.copy(color = MaterialTheme.colorScheme.onSurface),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                            keyboardActions = KeyboardActions(onGo = { tab?.let { go(it, it.address) } }),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                inline.forEach { a -> barBtn(a.onClick, a.icon, a.label, a.enabled) }
                Box {
                    if (overflow.isNotEmpty()) {
                        barBtn({ overflowOpen = true }, Icons.Filled.MoreVert, "More", true)
                        DropdownMenu(expanded = overflowOpen, onDismissRequest = { overflowOpen = false }) {
                            overflow.forEach { a ->
                                DropdownMenuItem(
                                    text = { Text(a.label) },
                                    leadingIcon = { Icon(a.icon, null) },
                                    enabled = a.enabled,
                                    onClick = { overflowOpen = false; a.onClick() },
                                )
                            }
                        }
                    }
                }
            }
        }

        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            when {
                tab == null -> {}
                tab.loading -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator()
                    TextButton(onClick = { tab.job?.cancel(); tab.loading = false; tab.error = "cancelled" }) { Text("Cancel") }
                }
                tab.error != null -> Text("⚠ ${tab.error}", color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
                else -> GemtextView(
                    lines = tab.lines,
                    currentUrl = current,
                    onNavigate = { tab.let { t -> navigate(t, it) } },
                    linkColor = theme.linkColor,
                    visitedColor = theme.visitedColor,
                    visited = tab.visited,
                    bodyFont = theme.fontFamily,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }

    // ── copy-to-my-ship dialog ──
    if (copyOpen) {
        AlertDialog(
            onDismissRequest = { copyOpen = false },
            title = { Text("Copy to my ship") },
            text = {
                Column {
                    Text("Save this page to your ship at:", style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(
                        value = copyDest, onValueChange = { copyDest = it },
                        label = { Text("path") }, singleLine = true,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val dest = copyDest.trim(); val body = tab?.body.orEmpty(); copyOpen = false
                    if (dest.isNotBlank()) scope.launch {
                        client.save(dest, body).fold(
                            onSuccess = { copyMsg = "Saved to \"$dest\" on your ship." },
                            onFailure = { copyMsg = "Copy failed: ${it.message}" },
                        )
                    }
                }) { Text("Copy") }
            },
            dismissButton = { TextButton(onClick = { copyOpen = false }) { Text("Cancel") } },
        )
    }
    copyMsg?.let { msg ->
        AlertDialog(
            onDismissRequest = { copyMsg = null },
            confirmButton = { TextButton(onClick = { copyMsg = null }) { Text("OK") } },
            text = { Text(msg) },
        )
    }
    shareMsg?.let { msg ->
        AlertDialog(
            onDismissRequest = { shareMsg = null },
            confirmButton = { TextButton(onClick = { shareMsg = null }) { Text("OK") } },
            text = { Text(msg) },
        )
    }
    addrMsg?.let { msg ->
        AlertDialog(
            onDismissRequest = { addrMsg = null },
            confirmButton = { TextButton(onClick = { addrMsg = null }) { Text("OK") } },
            text = { Text(msg) },
        )
    }
}

/** A right-side bar control, rendered inline as an icon or in the ⋮ overflow
 *  menu. [id] matches [ToolbarActions] so the inline/overflow preference is stable. */
private data class BarAction(
    val id: String,
    val icon: ImageVector,
    val label: String,
    val enabled: Boolean,
    val onClick: () -> Unit,
)
