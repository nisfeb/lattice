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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import io.nisfeb.lattice.bookmarks.BookmarkStore
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
import io.nisfeb.lattice.ui.BookmarksScreen
import io.nisfeb.lattice.ui.BrowserScreen
import io.nisfeb.lattice.ui.BrowserTab
import io.nisfeb.lattice.ui.DiscoverScreen
import io.nisfeb.lattice.ui.LatticeTheme
import io.nisfeb.lattice.ui.SettingsScreen
import io.nisfeb.lattice.ui.ShareImportScreen
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
     *  Talon) hands off a link via the OS scheme handler. Navigates
     *  the browser to it; consumed once so re-delivery of the same
     *  value (a later onNewIntent / open-URI event) re-fires. */
    initialUrl: String? = null,
    onUrlConsumed: () -> Unit = {},
    /** Drives the in-app update banner. Wired on Android (download + sideload
     *  install); null on desktop, where updates come via the installers. */
    updateState: UpdateState? = null,
    /** Content shared into Lattice from the OS share sheet (Android): a web URL
     *  or text. Converted to gemtext, saved to the ship under `shared/<slug>`,
     *  and the urb:// URL copied to the clipboard. Consumed once, like initialUrl. */
    initialShare: SharedContent? = null,
    onShareConsumed: () -> Unit = {},
    /** The root HTTP client. Owned by the platform entry point so desktop can
     *  tear it down on window close (its non-daemon dispatcher threads + the
     *  long-lived SSE connection otherwise keep the JVM alive after the window
     *  closes). All derived clients (session, fetch, SSE) share its dispatcher
     *  and connection pool via newBuilder(). */
    httpClient: OkHttpClient = OkHttpClient(),
) {
    val session = remember { UrbitSession(httpClient, sessionStore) }
    val client = remember { LatticeClient(session) }
    val settingsClient = remember { SettingsClient(session) }
    val followRepo = remember { FollowRepository(settingsClient) }
    val subRepo = remember { SubscriptionRepository(settingsClient) }
    val updatesChannel = remember { UpdatesChannel(session) }
    val agentInstaller = remember { AgentInstaller(session) }
    val scope = rememberCoroutineScope()

    var ship by remember { mutableStateOf(session.tryRestore()) }
    // Per-ship local stores (null when logged out). Rebuilt on ship change so a
    // login as another ship reads that ship's own bookmarks/theme.
    val themeStore: ThemeStore? = remember(ship) { ship?.let(createThemeStore) }
    val bookmarkStore: BookmarkStore? = remember(ship) { ship?.let(createBookmarkStore) }
    val themeRepo: ThemeRepository? = remember(themeStore) { themeStore?.let { ThemeRepository(it, settingsClient) } }
    var theme by remember { mutableStateOf(themeStore?.load() ?: ThemeSettings.Light) }
    var savedThemes by remember { mutableStateOf(themeStore?.loadSaved() ?: emptyList<SavedTheme>()) }
    var follows by remember { mutableStateOf(emptyList<String>()) }
    var subscriptions by remember { mutableStateOf(emptySet<String>()) }
    var updates by remember { mutableStateOf(emptyList<UpdateEvent>()) }
    var unread by remember { mutableStateOf(0) }
    var screen by remember { mutableStateOf<AppScreen>(AppScreen.Browse) }
    var editTarget by remember { mutableStateOf<String?>(null) }
    var browseTarget by remember { mutableStateOf<String?>(null) }
    // True when logged in but the %lattice agent isn't installed on the ship —
    // gates the app behind an offer to install it from the publisher.
    var agentMissing by remember { mutableStateOf(false) }
    // Content shared into the app; survives until consumed by ShareImportScreen,
    // so a share that arrives before login still imports once the user signs in.
    var shareTarget by remember { mutableStateOf<SharedContent?>(null) }
    // Browser tab state hoisted here so it survives the user visiting
    // Settings / Files / Discover and coming back — BrowserScreen
    // leaves the composition on those, which would otherwise discard
    // its open tabs and reset to the home page.
    val browserTabs = remember { mutableStateListOf<BrowserTab>() }
    val browserActive = remember { mutableStateOf(0) }

    // External urb:// handoff (OS scheme handler → MainActivity /
    // desktop main). Navigate the browser to the link. browseTarget
    // survives until BrowserScreen consumes it, so a handoff that
    // arrives before login still lands once the user signs in.
    LaunchedEffect(initialUrl) {
        if (initialUrl != null && initialUrl.startsWith("urb://")) {
            browseTarget = initialUrl
            screen = AppScreen.Browse
            onUrlConsumed()
        }
    }

    // Content shared into the app from the OS share sheet (Android). Route to
    // the import screen; survives until login if the user isn't signed in yet.
    LaunchedEffect(initialShare) {
        if (initialShare != null) {
            shareTarget = initialShare
            screen = AppScreen.Import
            onShareConsumed()
        }
    }

    // On login: pull synced prefs, re-arm desk subscriptions, and stream updates.
    LaunchedEffect(ship) {
        // Clear per-ship view state so a logout / account switch doesn't leak
        // the previous ship's notifications, follow/subscribe lists, or open tabs.
        updates = emptyList(); unread = 0
        follows = emptyList(); subscriptions = emptySet()
        browserTabs.clear(); browserActive.value = 0
        if (ship != null) {
            // Per-ship local cache first (instant, offline), then %settings sync.
            themeStore?.let { theme = it.load(); savedThemes = it.loadSaved() }
            themeRepo?.pull()?.let { savedThemes = it }
            followRepo.pull()?.let { follows = it }
            subRepo.pull()?.let { subs ->
                subscriptions = subs.toSet()
                subs.forEach { scope.launch { client.subscribe(it) } } // re-arm the keen-follow loop
            }
            updatesChannel.updates()
                .retryWhen { _, _ -> delay(3000); true } // SSE drops (network, idle) → reconnect
                .collect { ev ->
                    updates = (listOf(ev) + updates).take(50)
                    unread += 1
                }
        } else {
            // Logged out: drop the previous ship's theme so the login screen
            // and next ship don't inherit it.
            theme = ThemeSettings.Light
            savedThemes = emptyList()
        }
    }

    // Detect a missing %lattice agent on login so we can offer to install it.
    LaunchedEffect(ship) {
        agentMissing = false
        if (ship != null) agentMissing = !agentInstaller.isInstalled()
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

    LatticeTheme(theme) {
        // Match the system-bar icon color to the background showing through
        // edge-to-edge: dark icons on a light background, light on dark.
        SystemBarIcons(darkIcons = theme.backgroundColor.luminance() > 0.5f)
        // The Surface fills the screen (its color paints behind the status /
        // navigation bars edge-to-edge, so those areas read as the app
        // background), while the content Column is inset by the system bars so
        // interactive UI never sits under them. On desktop systemBars is empty,
        // so this is a no-op there.
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
            val current = ship
            if (current == null) {
                AddShipScreen(session, onLoggedIn = { ship = it; if (shareTarget == null) screen = AppScreen.Browse })
            } else if (agentMissing) {
                InstallAgentScreen(
                    installer = agentInstaller,
                    sourceShip = AgentInstaller.SOURCE_SHIP,
                    onInstalled = { agentMissing = false },
                    onSkip = { agentMissing = false },
                )
            } else when (screen) {
                AppScreen.Browse -> BrowserScreen(
                    client = client,
                    bookmarkStore = bookmarkStore!!,
                    theme = theme,
                    homeShip = current,
                    onLogout = { session.logout(); ship = null },
                    onOpenSettings = { screen = AppScreen.Settings },
                    onOpenFiles = { screen = AppScreen.Workspace },
                    onEditPage = { editTarget = it; screen = AppScreen.Workspace },
                    onOpenDiscover = { screen = AppScreen.Discover },
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
                )
                AppScreen.Workspace -> WorkspaceScreen(
                    client = client,
                    ship = current,
                    vimMode = theme.vimMode,
                    onClose = { screen = AppScreen.Browse },
                    initialOpen = editTarget,
                    onConsumedOpen = { editTarget = null },
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
                    onBrowse = { ship2 -> browseTarget = "urb://$ship2/"; screen = AppScreen.Browse },
                    onClose = { screen = AppScreen.Browse },
                )
                AppScreen.Updates -> UpdatesScreen(
                    updates = updates,
                    onBrowse = { url -> browseTarget = url; screen = AppScreen.Browse },
                    onClose = { screen = AppScreen.Browse },
                )
                AppScreen.Bookmarks -> BookmarksScreen(
                    bookmarkStore = bookmarkStore!!,
                    onOpen = { url -> browseTarget = url; screen = AppScreen.Browse },
                    onClose = { screen = AppScreen.Browse },
                )
                AppScreen.Import -> {
                    val shared = shareTarget
                    if (shared == null) {
                        // No payload (e.g. stale nav) — fall back to browsing.
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
