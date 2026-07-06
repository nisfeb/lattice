package io.nisfeb.lattice

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import io.nisfeb.lattice.bookmarks.Bookmark
import io.nisfeb.lattice.bookmarks.BookmarkRepository
import io.nisfeb.lattice.bookmarks.BookmarkStore
import io.nisfeb.lattice.browser.CachedPage
import io.nisfeb.lattice.browser.PageCache
import io.nisfeb.lattice.gemtext.GemtextParser
import io.nisfeb.lattice.share.SharedContent
import io.nisfeb.lattice.social.FollowRepository
import io.nisfeb.lattice.social.SubscriptionRepository
import io.nisfeb.lattice.theme.SavedTheme
import io.nisfeb.lattice.theme.ThemeRepository
import io.nisfeb.lattice.theme.ThemeSettings
import io.nisfeb.lattice.theme.ThemeStore
import io.nisfeb.lattice.ui.AddShipScreen
import io.nisfeb.lattice.ui.AppScreen
import io.nisfeb.lattice.ui.InstallAgentScreen
import io.nisfeb.lattice.knowledge.KnowledgeClient
import io.nisfeb.lattice.knowledge.obeliskInstalledFromProbe
import io.nisfeb.lattice.ui.BookmarksScreen
import io.nisfeb.lattice.ui.BrowserScreen
import io.nisfeb.lattice.ui.BrowserTab
import io.nisfeb.lattice.ui.CatalogSearchScreen
import io.nisfeb.lattice.ui.DiscoverScreen
import io.nisfeb.lattice.ui.LatticeTheme
import io.nisfeb.lattice.ui.SettingsScreen
import io.nisfeb.lattice.ui.ShareImportScreen
import io.nisfeb.lattice.ui.ShipBrowserScreen
import io.nisfeb.lattice.ui.UpdateBanner
import io.nisfeb.lattice.ui.UpdatesScreen
import io.nisfeb.lattice.ui.WorkspaceScreen
import io.nisfeb.lattice.update.UpdateState
import io.nisfeb.lattice.update.UpdateStatus
import io.nisfeb.lattice.urbit.AgentInstaller
import io.nisfeb.lattice.urbit.LatticeClient
import io.nisfeb.lattice.urbit.SessionStore
import io.nisfeb.lattice.urbit.SettingsClient
import io.nisfeb.lattice.urbit.UpdateEvent
import io.nisfeb.lattice.urbit.UpdatesChannel
import io.nisfeb.lattice.urbit.UrbitSession
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

@Composable
fun App(
    sessionStore: SessionStore,
    /** Per-ship store factories: built for the active ship so bookmarks/theme
     *  are scoped per ship (login as another ship → that ship's own data). */
    createBookmarkStore: (String) -> BookmarkStore,
    createThemeStore: (String) -> ThemeStore,
    /** A urb:// URL to open on launch — set when another app (e.g.
     *  Talon) hands off a link via the OS scheme handler. */
    initialUrl: String? = null,
    onUrlConsumed: () -> Unit = {},
    /** Drives the in-app update banner. */
    updateState: UpdateState? = null,
    /** Content shared into Lattice from the OS share sheet (Android). */
    initialShare: SharedContent? = null,
    onShareConsumed: () -> Unit = {},
    /** The root HTTP client — owned by the platform entry point. */
    httpClient: OkHttpClient = OkHttpClient(),
) {
    // ── App-level state: survives ship switches ─────────────────────────────
    //
    // The picker swaps `activeShip` and the `key(activeShip)` block below
    // rebuilds every per-ship singleton (UrbitSession, clients, repos,
    // installers, the updates SSE, agent-missing probes, themes/bookmarks).
    // Mirrors talon's pattern — the rebuild kills the cross-ship-contamination
    // class of bug at the source.
    var activeShip by remember { mutableStateOf(sessionStore.active()?.ship) }
    // When the user taps "Add ship", we set `activeShip=null` to mount the
    // login screen and remember the prior ship here so a Cancel can restore it
    // without forcing the user to re-pick from the (now empty) picker.
    var pendingActiveShip by remember { mutableStateOf<String?>(null) }
    var screen by remember { mutableStateOf<AppScreen>(AppScreen.Browse) }
    // System back (Android gesture/button): pop an open sub-screen back to
    // Browse. On Browse, BrowserScreen's own handler pops tab history; only when
    // logged in, on Browse, with no history left does Back fall through and
    // close the app (instead of closing it on the very first back, the bug).
    PlatformBackHandler(enabled = activeShip != null && screen != AppScreen.Browse) {
        screen = AppScreen.Browse
    }
    var editTarget by remember { mutableStateOf<String?>(null) }
    var browseTarget by remember { mutableStateOf<String?>(null) }
    var shareTarget by remember { mutableStateOf<SharedContent?>(null) }

    // Per-ship UI state preserved IN-MEMORY across switches (lost on app quit).
    // Switching ~zod → ~tyr → ~zod returns ~zod's tabs/scroll/cache intact.
    val tabsByShip = remember { mutableStateMapOf<String, SnapshotStateList<BrowserTab>>() }
    val tabsActiveByShip = remember { mutableStateMapOf<String, MutableState<Int>>() }
    val pageCacheByShip = remember { mutableStateMapOf<String, PageCache>() }

    // External urb:// handoff (OS scheme handler → MainActivity / desktop main).
    LaunchedEffect(initialUrl) {
        if (initialUrl != null && initialUrl.startsWith("urb://")) {
            browseTarget = initialUrl
            screen = AppScreen.Browse
            onUrlConsumed()
        }
    }

    // Content shared into the app from the OS share sheet (Android).
    LaunchedEffect(initialShare) {
        if (initialShare != null) {
            shareTarget = initialShare
            screen = AppScreen.Import
            onShareConsumed()
        }
    }

    key(activeShip ?: "__loggedout__") {
        // ── Per-ship singletons: rebuilt on switch ──────────────────────────
        val session = remember {
            // Pass the explicit ship — tryRestore() would otherwise fall back to
            // sessionStore.active(), which (in normal flow) matches activeShip
            // but isn't guaranteed to. The explicit form also re-asserts the
            // active pointer on the store, keeping it in sync with the UI.
            UrbitSession(httpClient, sessionStore).also { s ->
                activeShip?.let { s.tryRestore(it) }
            }
        }
        val client = remember { LatticeClient(session) }
        val knowledgeClient = remember { KnowledgeClient(session) }
        val settingsClient = remember { SettingsClient(session) }
        val followRepo = remember { FollowRepository(settingsClient) }
        val subRepo = remember { SubscriptionRepository(settingsClient) }
        val updatesChannel = remember { UpdatesChannel(session) }
        val latticeInstaller = remember {
            AgentInstaller(
                session,
                AgentInstaller.LATTICE_DESK,
                AgentInstaller.LATTICE_SOURCE,
                AgentInstaller.latticeProbe(session),
            )
        }
        // See +obeliskInstalledFromProbe — only the explicit "obelisk not installed"
        // error means absent; every other failure is "unknown → assume installed".
        val obeliskInstaller = remember {
            AgentInstaller(session, AgentInstaller.OBELISK_DESK, AgentInstaller.OBELISK_SOURCE) {
                obeliskInstalledFromProbe(knowledgeClient.query("SELECT 1;"))
            }
        }
        val scope = rememberCoroutineScope()

        // Per-ship local stores (null while logged out / adding a new ship).
        val themeStore: ThemeStore? = remember { activeShip?.let(createThemeStore) }
        val bookmarkStore: BookmarkStore? = remember { activeShip?.let(createBookmarkStore) }
        val themeRepo: ThemeRepository? = remember(themeStore) {
            themeStore?.let { ThemeRepository(it, settingsClient) }
        }
        val bookmarkRepo: BookmarkRepository? = remember(bookmarkStore) {
            bookmarkStore?.let { BookmarkRepository(it, settingsClient) }
        }
        var theme by remember { mutableStateOf(themeStore?.load() ?: ThemeSettings.Light) }
        var savedThemes by remember { mutableStateOf(themeStore?.loadSaved() ?: emptyList<SavedTheme>()) }
        var bookmarks by remember { mutableStateOf(bookmarkStore?.all() ?: emptyList<Bookmark>()) }
        var follows by remember { mutableStateOf(emptyList<String>()) }
        var subscriptions by remember { mutableStateOf(emptySet<String>()) }
        var updates by remember { mutableStateOf(emptyList<UpdateEvent>()) }
        var unread by remember { mutableStateOf(0) }
        var agentMissing by remember { mutableStateOf(false) }
        var obeliskMissing by remember { mutableStateOf(false) }
        // Epoch-ms of the last manual catalog sweep (per ship; survives screen
        // switches, so the Search screen's "Scan now" cooldown can't be reset
        // by leaving and re-entering). 0 = never scanned this session.
        var catalogLastScan by remember { mutableStateOf(0L) }

        // Browser tabs + page cache for the active ship: pulled from the
        // App-level maps so they SURVIVE ship switches. When activeShip is null
        // (login pending) we use throwaway empties — Browser isn't visible.
        val browserTabs: SnapshotStateList<BrowserTab> =
            activeShip?.let { tabsByShip.getOrPut(it) { mutableStateListOf() } }
                ?: remember { mutableStateListOf() }
        val browserActive: MutableState<Int> =
            activeShip?.let { tabsActiveByShip.getOrPut(it) { mutableStateOf(0) } }
                ?: remember { mutableStateOf(0) }
        val pageCache: PageCache =
            activeShip?.let { pageCacheByShip.getOrPut(it) { PageCache() } }
                ?: remember { PageCache() }

        // On ship entry: pull synced prefs, re-arm subscriptions, stream updates.
        LaunchedEffect(Unit) {
            if (activeShip == null) return@LaunchedEffect
            themeStore?.let { theme = it.load(); savedThemes = it.loadSaved() }
            bookmarkStore?.let { bookmarks = it.all() }
            themeRepo?.pull()?.let { savedThemes = it }
            bookmarkRepo?.pull()?.let { bookmarks = it }
            followRepo.pull()?.let { follows = it }
            subRepo.pull()?.let { subs ->
                subscriptions = subs.toSet()
                subs.forEach { scope.launch { client.subscribe(it) } } // re-arm the keen-follow loop
            }
            updatesChannel.updates()
                .retryWhen { _, _ -> delay(3000); true } // SSE drops → reconnect
                .collect { ev ->
                    val url = "urb://${ev.ship}/${ev.path.removePrefix("/")}"
                    val lines = GemtextParser.parse(ev.body)
                    pageCache[url] = CachedPage(ev.body, lines)
                    browserTabs.forEach { t ->
                        if (t.current == url) {
                            t.body = ev.body; t.lines = lines; t.visited = t.visited + url
                        }
                    }
                    // Every pub keep frame is one of our pages changing — feed the
                    // Updates list (the old remote-subscription gate no longer
                    // applies; /streams carries our own pub/know/follows only).
                    updates = (listOf(ev) + updates).take(50)
                    unread += 1
                }
        }

        // Detect missing %lattice / %obelisk on entry to this ship.
        LaunchedEffect(Unit) {
            if (activeShip == null) return@LaunchedEffect
            agentMissing = !latticeInstaller.isInstalled()
            if (!agentMissing) obeliskMissing = !obeliskInstaller.isInstalled()
        }

        fun addBookmark(bm: Bookmark) {
            bookmarks = bookmarks.filterNot { it.url == bm.url } + bm
            scope.launch { bookmarkRepo?.push(bookmarks) }
        }
        fun removeBookmark(url: String) {
            bookmarks = bookmarks.filterNot { it.url == url }
            scope.launch { bookmarkRepo?.push(bookmarks) }
        }
        fun setFollows(list: List<String>) { follows = list; scope.launch { followRepo.push(list) } }
        fun subscribe(url: String) {
            subscriptions = subscriptions + url
            scope.launch { subRepo.push(subscriptions.toList()); client.subscribe(url) }
        }
        fun unsubscribe(url: String) {
            subscriptions = subscriptions - url
            scope.launch { subRepo.push(subscriptions.toList()); client.unsubscribe(url) }
        }

        // ── Picker actions ──────────────────────────────────────────────────
        // sessionStore.all() does file I/O on every call (FileSessionStore reads
        // the JSON each time). Cache it for this key block — the list can only
        // change via login / switch / logout, all of which mutate activeShip
        // and force this key block to re-run from scratch.
        val ships = remember(activeShip) { sessionStore.all().map { it.ship } }
        fun onSwitchShip(s: String) {
            if (s != activeShip) {
                sessionStore.setActive(s)
                activeShip = s
            }
        }
        fun onAddShip() {
            pendingActiveShip = activeShip
            activeShip = null
        }
        fun onCancelAddShip() {
            activeShip = pendingActiveShip
            pendingActiveShip = null
        }
        fun onLogoutCurrent() {
            val s = activeShip ?: return
            sessionStore.remove(s)
            // SessionStore.remove auto-promotes the next saved ship; null if none.
            activeShip = sessionStore.activeShip()
            // Drop the removed ship's in-memory UI state too.
            tabsByShip.remove(s); tabsActiveByShip.remove(s); pageCacheByShip.remove(s)
        }

        LatticeTheme(theme) {
            // Match system-bar icon color to the background showing through edge-to-edge.
            SystemBarIcons(darkIcons = theme.backgroundColor.luminance() > 0.5f)
            Surface(modifier = Modifier.fillMaxSize()) {
                Column(modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.systemBars)) {
                    if (updateState != null) {
                        val updateStatus by updateState.status.collectAsState()
                        UpdateBanner(
                            status = updateStatus,
                            onTap = {
                                when (val s = updateStatus) {
                                    is UpdateStatus.Available -> updateState.startDownload(s.manifest)
                                    is UpdateStatus.Ready -> updateState.launchInstaller(s.apkPath)
                                    is UpdateStatus.Failed -> s.manifest?.let { updateState.startDownload(it) }
                                    else -> Unit
                                }
                            },
                            onDismiss = { updateState.dismiss() },
                        )
                    }
                    Box(modifier = Modifier.weight(1f).fillMaxSize()) {
                        val current = activeShip
                        if (current == null) {
                            AddShipScreen(
                                session = session,
                                onLoggedIn = {
                                    activeShip = it
                                    pendingActiveShip = null
                                    if (shareTarget == null) screen = AppScreen.Browse
                                },
                                onCancel = if (pendingActiveShip != null) ::onCancelAddShip else null,
                            )
                        } else if (agentMissing) {
                            InstallAgentScreen(
                                installer = latticeInstaller,
                                sourceShip = AgentInstaller.LATTICE_SOURCE,
                                onInstalled = {
                                    agentMissing = false
                                    scope.launch { obeliskMissing = !obeliskInstaller.isInstalled() }
                                },
                                onSkip = { agentMissing = false },
                            )
                        } else if (obeliskMissing) {
                            InstallAgentScreen(
                                installer = obeliskInstaller,
                                sourceShip = AgentInstaller.OBELISK_SOURCE,
                                title = "Add the knowledge index (optional)",
                                intro = "Obelisk powers the Explore tab's relational queries over your " +
                                    "knowledge index. The rest of Lattice works without it. Install it " +
                                    "from ${AgentInstaller.OBELISK_SOURCE}?",
                                skipLabel = "Not now",
                                onInstalled = { obeliskMissing = false },
                                onSkip = { obeliskMissing = false },
                            )
                        } else when (screen) {
                            AppScreen.Browse -> BrowserScreen(
                                client = client,
                                bookmarks = bookmarks,
                                onAddBookmark = { addBookmark(it) },
                                onRemoveBookmark = { removeBookmark(it) },
                                theme = theme,
                                homeShip = current,
                                ships = ships,
                                onSwitchShip = ::onSwitchShip,
                                onAddShip = ::onAddShip,
                                onLogoutCurrent = ::onLogoutCurrent,
                                onOpenSettings = { screen = AppScreen.Settings },
                                onOpenFiles = { screen = AppScreen.Workspace },
                                onEditPage = { editTarget = it; screen = AppScreen.Workspace },
                                onOpenDiscover = { screen = AppScreen.Discover },
                                onOpenSearch = { screen = AppScreen.Search },
                                onOpenShipBrowser = { screen = AppScreen.ShipBrowser },
                                openUrl = browseTarget,
                                onConsumedOpenUrl = { browseTarget = null },
                                subscriptions = subscriptions,
                                onSubscribe = { subscribe(it) },
                                onUnsubscribe = { unsubscribe(it) },
                                onOpenUpdates = { unread = 0; screen = AppScreen.Updates },
                                onOpenBookmarks = { screen = AppScreen.Bookmarks },
                                unreadUpdates = unread,
                                tabs = browserTabs,
                                activeState = browserActive,
                                pageCache = pageCache,
                            )
                            AppScreen.Workspace -> WorkspaceScreen(
                                client = client,
                                knowledge = knowledgeClient,
                                ship = current,
                                vimMode = theme.vimMode,
                                onClose = { screen = AppScreen.Browse },
                                initialOpen = editTarget,
                                onConsumedOpen = { editTarget = null },
                                newFileMarkdown = theme.newFileFormat == "md",
                            )
                            AppScreen.Settings -> SettingsScreen(
                                settings = theme,
                                onChange = { theme = it; themeStore!!.save(it) },
                                onClose = { screen = AppScreen.Browse },
                                savedThemes = savedThemes,
                                onSaveCurrent = { name ->
                                    val list = savedThemes.filterNot { it.name == name } + SavedTheme(name, theme)
                                    savedThemes = list
                                    scope.launch { themeRepo!!.push(list) }
                                },
                                onDeleteSaved = { name ->
                                    val list = savedThemes.filterNot { it.name == name }
                                    savedThemes = list
                                    scope.launch { themeRepo!!.push(list) }
                                },
                            )
                            AppScreen.Discover -> DiscoverScreen(
                                client = client,
                                follows = follows,
                                onFollow = { ship2 -> setFollows((follows + ship2).distinct().sorted()) },
                                onUnfollow = { ship2 -> setFollows(follows - ship2) },
                                onOpenUrl = { url -> browseTarget = url; screen = AppScreen.Browse },
                                onClose = { screen = AppScreen.Browse },
                            )
                            AppScreen.Search -> CatalogSearchScreen(
                                client = client,
                                onOpenUrl = { url -> browseTarget = url; screen = AppScreen.Browse },
                                onClose = { screen = AppScreen.Browse },
                                lastScanMillis = catalogLastScan,
                                onScanNow = {
                                    catalogLastScan = System.currentTimeMillis()
                                    scope.launch { client.catalogSweep() }
                                },
                            )
                            AppScreen.Updates -> UpdatesScreen(
                                updates = updates,
                                onBrowse = { url -> browseTarget = url; screen = AppScreen.Browse },
                                onClose = { screen = AppScreen.Browse },
                            )
                            AppScreen.Bookmarks -> BookmarksScreen(
                                bookmarks = bookmarks,
                                onRemove = { removeBookmark(it) },
                                onOpen = { url -> browseTarget = url; screen = AppScreen.Browse },
                                onClose = { screen = AppScreen.Browse },
                            )
                            AppScreen.ShipBrowser -> ShipBrowserScreen(
                                client = client,
                                homeShip = current,
                                follows = follows,
                                onClose = { screen = AppScreen.Browse },
                            )
                            AppScreen.Import -> {
                                val shared = shareTarget
                                if (shared == null) {
                                    LaunchedEffect(Unit) { screen = AppScreen.Browse }
                                } else {
                                    ShareImportScreen(
                                        client = client,
                                        homeShip = current,
                                        content = shared,
                                        onOpen = { url -> shareTarget = null; browseTarget = url; screen = AppScreen.Browse },
                                        onEdit = { path -> shareTarget = null; editTarget = path; screen = AppScreen.Workspace },
                                        onClose = { shareTarget = null; screen = AppScreen.Browse },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
