//! Connect flow: one +code entry logs in both sides. The Rust login stores
//! the session cookie for that ship's origin (session.rs), and the localhost
//! bridge attaches it to everything the webview sends.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::config;

/// stderr diagnostics, on when LATTICE_LOG is set. Costs nothing otherwise
/// and makes "it 403s on my machine" debuggable from a pasted terminal log.
pub fn dlog(msg: &str) {
    if std::env::var_os("LATTICE_LOG").is_some() {
        eprintln!("lattice: {msg}");
    }
}

/// Log the Rust side in, remember the url, open the workspace, get the
/// manager out of the way. Async: the blocking login and the cookie-settle
/// poll in open_workspace must run off the main thread (a main-thread wait
/// would deadlock the webview's async cookie add).
///
/// The URL rule runs before anything is sent, so the +code never goes over
/// plain http to a public host. Nothing is stored until the login worked.
/// The cookie then goes into the new origin's own file and only after that
/// is the url switched. A failure at any step leaves the old ship's url and
/// cookie exactly as they were, and since a cookie is only ever attached by
/// its own origin, neither ship can be sent the other's.
///
/// The ship page's Settings calls it too (Connection, under This computer),
/// so there it asks first in a native dialog naming the ship: a page the
/// ship serves must not be able to move this app onto another ship unseen.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    webview: tauri::Webview,
    url: String,
    code: String,
) -> Result<String, String> {
    let url = crate::session::check_ship_url(&url)?;
    ship_page_asks(
        &app,
        &webview,
        "Change ship",
        format!("Connect lattice on this computer to {url}?\n\nThe window switches to that ship."),
        "Connect",
    )?;
    dlog(&format!("connect: logging in at {url}"));
    // whose queue a legacy URL key is: the cookie stored for that URL before
    // this connect replaces it (queue::key_after_connect)
    let key_ship = {
        let old = config::load(&app);
        crate::session::cookie_for(&old.queue_key).and_then(|c| crate::session::ship_of(&c))
    };
    let cookie = crate::session::login(&url, &code)?;
    let ship = crate::session::ship_of(&cookie).ok_or("login: no urbauth cookie")?;
    let at = crate::session::store(&url, &cookie)?;
    dlog(&format!("connect: ship {ship}, cookie stored at {}", at.display()));
    let ship_for_cfg = ship.clone();
    config::update(&app, move |cfg| {
        //  a ship SWITCH must not inherit the previous ship's queue directory —
        //  its queued edits would replay into the new ship
        cfg.queue_key = crate::queue::key_after_connect(cfg, &ship_for_cfg, key_ship.as_deref());
        cfg.url = url;
        //  remember the @p: the offline queue prefers it as its directory key, and
        //  it has to be known BEFORE the ship stops answering, which is exactly
        //  when the queue starts mattering
        cfg.ship = ship_for_cfg;
    })?;
    // a reader identity made for the first-run page and never used goes
    #[cfg(feature = "urb-engine")]
    app.state::<crate::engine::Engine>().drop_unclaimed();
    open_workspace(&app, true, None)?;
    Ok(ship)
}

/// manager page's "close" button (and Escape), back to the ship UI, or with
/// no ship configured to the shipless reader's home. `settings` is one of
/// the manager's Lattice tabs (SETTINGS_TABS): the editor opens with that
/// tab of its Settings in front, so the two pages read as one.
#[tauri::command]
pub fn go_home(app: AppHandle, settings: Option<String>) -> Result<(), String> {
    let tab = settings_tab(settings.as_deref())?;
    // only once the reader has been used: a close on the first-run page is
    // not a request to read, and opening the reader makes its identity
    #[cfg(feature = "urb-engine")]
    if config::load(&app).url.is_empty() {
        if !reader_used(&app) {
            return Err("Connect your node, or use lattice anonymously.".into());
        }
        return open_reader(app, None);
    }
    open_workspace(&app, false, tab)
}

/// The tabs of the ship page's Settings (+settings-html in app.hoon) the
/// manager page may name on its way back.
const SETTINGS_TABS: &[&str] = &["appearance", "editing", "keys", "data", "clipping", "advanced"];

/// The Settings tab go_home lands on: none, or one of SETTINGS_TABS.
/// Anything else is refused rather than passed into the page URL.
fn settings_tab(tab: Option<&str>) -> Result<Option<&'static str>, String> {
    match tab {
        None => Ok(None),
        Some(t) => SETTINGS_TABS
            .iter()
            .find(|k| **k == t)
            .map(|k| Some(*k))
            .ok_or_else(|| format!("no settings tab {t}")),
    }
}

/// The sections of the manager page the ship page may ask for by name:
/// its tabs, which the ship page's Settings lists under "This computer".
const MANAGER_SECTIONS: &[&str] = &["connection", "files", "backups"];

/// The section open_manager lands on: none, or one of MANAGER_SECTIONS.
/// Anything else is refused rather than passed into the page URL.
fn manager_section(section: Option<&str>) -> Result<Option<&'static str>, String> {
    match section {
        None => Ok(None),
        Some(s) => MANAGER_SECTIONS
            .iter()
            .find(|k| **k == s)
            .map(|k| Some(*k))
            .ok_or_else(|| format!("no manager section {s}")),
    }
}

/// Settings > "Connection and mounts" and Settings > Backup > "Scheduled
/// backups" in the ship page. The ship page may call this
/// (capabilities/workspace-remote.json), and all it does is what the
/// Preferences menu does: show this app's own manager page, at its top or
/// at a named section. That page is a local origin, so the ship page
/// cannot script it. The editor asks about unsaved work before calling it
/// (latOpenManager in 24-tools.js).
#[tauri::command]
pub fn open_manager(app: AppHandle, section: Option<String>) -> Result<(), String> {
    show_manager(&app, manager_section(section.as_deref())?)
}

/// Show the connection & mounts page IN the workspace window (single-window
/// app: the manager is a page, not a second window). Local shell pages live
/// at tauri://localhost on macOS but http://tauri.localhost on Linux.
///
/// `section` is an anchor on the page. A menu item named for one section
/// should land looking at it, not at the top with three sections to scroll
/// past. A freshly created window is already on the page but at its top, so
/// a requested section still navigates.
pub fn show_manager(app: &AppHandle, section: Option<&str>) -> Result<(), String> {
    let (w, created) = ensure_workspace(app)?;
    let frag = section.map(|s| format!("#{s}")).unwrap_or_default();
    // A window sitting on the ship page is REBUILT, not navigated back.
    //
    // Tauri judges every invoke local or remote from the origin the webview
    // reports. On macOS, after navigating from the ship page to
    // tauri://localhost, that origin can still be the ship page's, so the
    // manager fell under the ship page's capability and every manager
    // command was refused ("command pick_backup_dir not allowed by acl" on
    // the choose button; backup_schedules and list_mounts failed silently).
    // A window born on manager.html is the one state that provably works
    // on every platform, and the window is born there anyway, so: destroy
    // it, wait for the label to free (destroy is asynchronous), and make a
    // fresh one. The user is leaving the ship page either way.
    // macOS only: the origin confusion below is a macOS webview quirk. On
    // other platforms navigating the existing window works, so rebuilding it
    // just loses the window's position and icon and flashes a new window.
    if cfg!(target_os = "macos") && !created && !on_shell_page(&w) {
        // destroying the ONLY window asks the app to exit; main.rs vetoes
        // that while this flag is up
        dlog("manager: the window is on the ship page, rebuilding it");
        REBUILDING.store(true, Ordering::SeqCst);
        if let Err(e) = w.destroy() {
            REBUILDING.store(false, Ordering::SeqCst);
            return Err(e.to_string());
        }
        let h = app.clone();
        std::thread::spawn(move || {
            for _ in 0..100 {
                if h.get_webview_window("workspace").is_none() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            let h2 = h.clone();
            h.run_on_main_thread(move || {
                // retry once: the only window was already destroyed above, so a
                // failed rebuild here would leave the app running with no UI. A
                // transient webview-builder error must not strand the user.
                let made = new_workspace(&h2).or_else(|e| {
                    dlog(&format!("manager: rebuild failed ({e}); retrying once"));
                    new_workspace(&h2)
                });
                REBUILDING.store(false, Ordering::SeqCst);
                dlog(&format!("manager: rebuilt the window: {}", made.is_ok()));
                match made {
                    Ok(w) => {
                        if !frag.is_empty() {
                            if let Ok(u) = format!("tauri://localhost/manager.html{frag}").parse() {
                                w.navigate(u).ok();
                            }
                        }
                        w.set_focus().ok();
                    }
                    Err(e) => {
                        dlog(&format!("manager: rebuilding the window failed after retry: {e}"));
                    }
                }
            })
            .ok();
        });
        return Ok(());
    }
    if !created || section.is_some() {
        let url: tauri::Url = format!("tauri://localhost/manager.html{frag}")
            .parse()
            .map_err(|e| format!("{e}"))?;
        w.navigate(url).map_err(|e| e.to_string())?;
    }
    w.set_focus().ok();
    Ok(())
}

/// The page mirrors its colour scheme into the window. The native surfaces
/// (the GTK menubar, and WebKitGTK's own scrollbars in any frame that does
/// not style them) follow the WINDOW theme, not the page, and on Linux the
/// window theme is GTK's light default whatever the desktop portal says.
/// The page does know prefers-color-scheme, so it tells us, on load and
/// whenever it changes. macOS honours the same call.
///
/// The ship page also sends `vars`, the CSS variables its theme resolved to
/// (theme.js), and they are kept for the manager page (status hands them
/// back), which is another origin and may have no ship to ask. Only the
/// variables theme.js sets are kept, each only with a value of its own
/// shape, so a hostile page can at worst give the manager odd colours.
/// The manager itself sends none, and a ship older than this sends none:
/// both leave the stored theme as it is.
#[tauri::command]
pub fn set_theme(
    app: AppHandle,
    dark: bool,
    vars: Option<std::collections::BTreeMap<String, String>>,
) -> Result<(), String> {
    if let Some(v) = vars {
        let v = theme_vars(v);
        if config::load(&app).theme != v {
            if let Err(e) = config::update(&app, move |c| c.theme = v) {
                dlog(&format!("set_theme: keeping the theme failed: {e}"));
            }
        }
    }
    let Some(w) = app.get_webview_window("workspace") else { return Ok(()) };
    w.set_theme(Some(if dark { tauri::Theme::Dark } else { tauri::Theme::Light }))
        .map_err(|e| e.to_string())
}

/// The theme variables worth keeping: theme.js's KEYS, colours as hex,
/// color-scheme light or dark, the font as a plain family list.
fn theme_vars(v: std::collections::BTreeMap<String, String>) -> std::collections::BTreeMap<String, String> {
    const COLOURS: &[&str] = &[
        "--bg", "--text", "--muted", "--pop", "--accent", "--accent-deep", "--on-accent",
        "--accent-tint", "--secondary", "--tertiary", "--link", "--raised", "--error",
        "--selection", "--border", "--border-soft",
    ];
    let hex = |s: &str| {
        s.strip_prefix('#')
            .is_some_and(|h| matches!(h.len(), 3 | 4 | 6 | 8) && h.bytes().all(|b| b.is_ascii_hexdigit()))
    };
    let font = |s: &str| {
        !s.is_empty() && s.len() <= 200
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || b" ,\"-_.".contains(&b))
    };
    v.into_iter()
        .filter(|(k, val)| match k.as_str() {
            "color-scheme" => val == "light" || val == "dark",
            "--font" => font(val),
            k => COLOURS.contains(&k) && hex(val),
        })
        .take(32)
        .collect()
}

/// Up while show_manager is between destroying the workspace window and
/// making its replacement. The window is the app's only one, so its
/// destruction reads as "last window closed, exit"; main.rs checks this
/// and vetoes that exit.
pub static REBUILDING: AtomicBool = AtomicBool::new(false);

/// Is the window showing one of the shell's own pages (the manager, login)
/// rather than the ship-served app?
pub fn on_shell_page(w: &tauri::WebviewWindow) -> bool {
    w.url()
        .map(|u| u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost"))
        .unwrap_or(false)
}

/// The single window is always BORN on manager.html. The app-page protocol
/// handler only attaches to webviews created on an app URL, and a window
/// born on the bridge origin cannot navigate back to the shell's pages
/// ("Could not connect to tauri.localhost").
fn ensure_workspace(app: &AppHandle) -> Result<(tauri::WebviewWindow, bool), String> {
    match app.get_webview_window("workspace") {
        Some(w) => Ok((w, false)),
        None => Ok((new_workspace(app)?, true)),
    }
}

#[derive(serde::Serialize)]
pub struct ConnStatus {
    pub url: String,
    /// the ship we are logged in to, when the session actually works
    pub ship: Option<String>,
    pub connected: bool,
    /// set when we could not reach the ship at all (as opposed to being
    /// reachable but unauthenticated). The two need different advice
    pub error: Option<String>,
}

/// What the connection page shows. A configured URL is NOT the same as being
/// logged in, which is exactly what the page used to get wrong. It rendered
/// the login form whenever it had nothing better to say, so an already-
/// connected ship looked logged out. Async: this makes a real request.
#[tauri::command]
pub async fn connection_status(app: AppHandle) -> ConnStatus {
    let cfg = config::load(&app);
    if cfg.url.is_empty() {
        return ConnStatus { url: String::new(), ship: None, connected: false, error: None };
    }
    match crate::proxy::probe(&cfg.url) {
        Ok(true) => {
            // name the ship only when the session is real, so the page never
            // claims a ship it cannot actually reach
            let ship = crate::session::cookie_for(&cfg.url)
                .and_then(|c| crate::session::ship_of(&c));
            dlog(&format!("status: connected to {:?}", ship));
            ConnStatus { url: cfg.url, ship, connected: true, error: None }
        }
        Ok(false) => {
            dlog("status: reachable but not authenticated");
            ConnStatus { url: cfg.url, ship: None, connected: false, error: None }
        }
        Err(e) => {
            dlog(&format!("status: unreachable: {e}"));
            ConnStatus { url: cfg.url, ship: None, connected: false, error: Some(e) }
        }
    }
}

#[derive(serde::Serialize)]
pub struct PickedFile {
    /// slash-separated path relative to the pick, folder name included for
    /// folder picks. Mirrors webkitRelativePath so the web upload path
    /// builds the same tree.
    pub rel: String,
    pub text: String,
}

/// Schemes a system handler can sensibly open, and the ONLY ones that leave
/// the app. This is a trust boundary, not a convenience check: the workspace
/// webview renders ship-served content and can reach `open_external_url`, so a
/// page could ask us to hand any string to the desktop's URL dispatcher.
/// Refusing here rather than in the page's javascript is the difference
/// between a policy and a suggestion.
///
/// Control characters are refused too. The URL is passed as one argv element
/// so no shell parses it, but a handler further down the chain might, and a
/// newline is how a single argument becomes two.
pub fn openable(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else { return false };
    if rest.is_empty() {
        return false;
    }
    if !matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "mailto" | "tel"
    ) {
        return false;
    }
    !url.contains(|c: char| c.is_control())
}

/// Hand a vetted URL to the desktop's own dispatcher.
///
/// This replaces tauri-plugin-opener, which cost ~35 crates (an entire async
/// executor: async-io, polling, blocking, rustix) to run what is one process
/// spawn. No shell is involved: Command passes argv directly.
pub fn open_external(url: &str) -> Result<(), String> {
    if !openable(url) {
        return Err(format!("refused to open {url:?}"));
    }
    let bin = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let child = std::process::Command::new(bin)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("{bin}: {e}"))?;
    // reap it. The handler exits immediately after handing off to the
    // browser, and an unwaited child stays a zombie for the life of the app.
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(())
}

/// The webview's route to the same policy. Named for what it does rather than
/// mirroring the plugin's `open_url`, since the allowlist is ours now.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    open_external(&url)
}

/// Extensions a page can be uploaded from. Mirrors EXT_KIND in
/// ui-src/lattice/30-tree.js, and scripts/kind-parity.mjs checks the two agree.
/// The page's own list is cut down to these, so a page cannot widen the pick
/// to files that are not pages (a key file, a .env).
const PAGE_EXTS: &[&str] = &["md", "gmi", "html", "htm", "txt", "text", "js", "css", "hoon", "tex", "latex", "fodt"];

/// How much one pick may read and hand the page. A folder pick reads every
/// matching file under it, so picking a home directory must not pull the
/// whole disk into memory and over IPC.
const PICK_MAX_FILES: usize = 5000;
const PICK_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Native upload picker for the ship-served workspace (webkit2gtk has no
/// webkitdirectory, so the web folder picker is dead on Linux). Picks files
/// or a folder, reads only extensions the UI supports, returns the text.
/// The page never sees a path or fs handle. One user-driven dialog per call.
/// Async so the blocking dialog runs off the main thread.
#[tauri::command]
pub async fn pick_upload(app: AppHandle, dir: bool, exts: Vec<String>) -> Result<Vec<PickedFile>, String> {
    use tauri_plugin_dialog::DialogExt;
    let exts = page_exts(exts);
    let mut out = Vec::new();
    if exts.is_empty() {
        return Ok(out);
    }
    let mut bytes = 0;
    if dir {
        if let Some(folder) = app.dialog().file().blocking_pick_folder() {
            if let Ok(root) = folder.into_path() {
                let base = root
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                walk(&root, &base, &exts, &mut out, &mut bytes)?;
            }
        }
    } else {
        let ext_refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        if let Some(files) = app
            .dialog()
            .file()
            .add_filter("lattice pages", &ext_refs)
            .blocking_pick_files()
        {
            for f in files {
                if let Ok(p) = f.into_path() {
                    if let Some(name) = p.file_name().map(|s| s.to_string_lossy().into_owned()) {
                        if has_ext(&name, &exts) {
                            push_file(&p, name, &mut out, &mut bytes)?;
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

/// The caller's extensions that are also page extensions.
fn page_exts(exts: Vec<String>) -> Vec<String> {
    exts.into_iter()
        .filter(|e| PAGE_EXTS.iter().any(|p| p.eq_ignore_ascii_case(e)))
        .collect()
}

fn has_ext(name: &str, exts: &[String]) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, x)| exts.iter().any(|e| e.eq_ignore_ascii_case(x)))
}

fn walk(
    dir: &std::path::Path,
    rel: &str,
    exts: &[String],
    out: &mut Vec<PickedFile>,
    bytes: &mut u64,
) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for e in entries.flatten() {
        // no symlink following: a looped link must not hang the walk
        let Ok(ft) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        // hidden files and dirs (.git, .ssh, .env) are never pages
        if name.starts_with('.') {
            continue;
        }
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if ft.is_dir() {
            walk(&e.path(), &child, exts, out, bytes)?;
        } else if ft.is_file() && has_ext(&name, exts) {
            push_file(&e.path(), child, out, bytes)?;
        }
    }
    Ok(())
}

fn push_file(path: &std::path::Path, rel: String, out: &mut Vec<PickedFile>, bytes: &mut u64) -> Result<(), String> {
    use std::io::Read;
    if out.len() >= PICK_MAX_FILES {
        return Err(format!("too many files: the limit is {PICK_MAX_FILES}"));
    }
    // read one byte past what is left, so going over the cap is seen
    // without reading the rest of a huge file
    let left = PICK_MAX_BYTES - *bytes;
    let mut raw = Vec::new();
    let Ok(f) = std::fs::File::open(path) else { return Ok(()) };
    if f.take(left + 1).read_to_end(&mut raw).is_err() {
        return Ok(());
    }
    if raw.len() as u64 > left {
        return Err(format!("too much data: the limit is {} MiB", PICK_MAX_BYTES >> 20));
    }
    // non-UTF-8 (binary) files are skipped, same as the web KMAP filter
    if let Ok(text) = String::from_utf8(raw) {
        *bytes += text.len() as u64;
        out.push(PickedFile { rel, text });
    }
    Ok(())
}

/// Open (or reuse) the workspace on the localhost bridge. The webview only
/// ever talks to 127.0.0.1. The bridge relays to the ship with the fuse
/// session cookie attached Rust-side, so no webkit cookie behavior (site
/// pinning, third-party policy, SW-mediated fetch) can ever unauthenticate
/// a view again. The one cookie the webview holds is the bridge's own
/// first-party token, which tells the bridge this window from any other
/// local process. `fresh` (a new connect) also clears browsing data so stale
/// service workers and caches from earlier sessions cannot linger.
pub fn open_workspace(app: &AppHandle, fresh: bool, settings: Option<&str>) -> Result<(), String> {
    let cfg = config::load(app);
    if cfg.url.is_empty() {
        return Err("connect to a ship first".into());
    }
    let local = crate::proxy::ensure(app.state::<crate::proxy::Bridge>().inner(), &cfg.url)?;
    // land on the editor, not the reader. This is a workspace. Opening the
    // reader first made reaching the editor a SECOND full document load
    // (16KB shell + 124KB of JS), so "first click" cost a whole page load.
    // urb:// links still route to the reader. See the navigation guard.
    let home: tauri::Url = format!("{local}/apps/lattice/app")
        .parse()
        .map_err(|e| format!("{e}"))?;
    // the bridge means the webview needs no cookies, so the window may be
    // born on the local manager page and freely navigate to the ship
    let (w, _) = ensure_workspace(app)?;
    if fresh {
        dlog(&format!("clear browsing data: {:?}", w.clear_all_browsing_data()));
    }
    // through the bridge's bootstrap first: it hands this window the
    // launch's token as an HttpOnly cookie, without which the bridge relays
    // nothing with the ship session, then redirects to the editor
    dlog(&format!("navigate: {home}"));
    // a Settings tab rides along as the one query the bootstrap passes on
    let to = match settings {
        Some(t) => format!("{}?settings={t}", home.path()),
        None => home.path().to_string(),
    };
    let boot: tauri::Url = crate::proxy::bootstrap_url(&local, &to)
        .parse()
        .map_err(|e| format!("{e}"))?;
    w.navigate(boot).map_err(|e| e.to_string())?;
    w.set_focus().ok();
    Ok(())
}

/// What to do with a top-level navigation the workspace attempted.
#[derive(Debug, PartialEq)]
enum Nav {
    /// stay in the webview as-is
    Allow,
    /// renavigate the workspace to this url instead
    Rewrite(tauri::Url),
    /// hand to the system opener, which applies openable()
    External,
    /// nothing to open and nothing to rewrite, so the navigation just stops
    Block,
    /// the shipless reader's "Connect a node": show the manager
    Manager,
}

/// The whole navigation policy, with no AppHandle and no window in it, so the
/// six branches read as one table instead of as plumbing.
///
/// `bridge` yields the live bridge port and `ship_url` the configured ship
/// base, both looked up only if the decision gets far enough to need them.
/// Laziness is the point: the preview iframe is srcdoc-based and some webkits
/// run every frame through this hook, so neither a mutex nor a config read
/// belongs on the path that answers those.
///
/// `reader(start)` yields the shipless reader's base (reader.rs), starting
/// it when `start` is true. With no ship configured an urb:// navigation
/// opens there, through its bootstrap so the window holds its token.
fn nav_decision(
    u: &tauri::Url,
    bridge: impl FnOnce() -> Option<u16>,
    reader: impl Fn(bool) -> Option<String>,
    ship_url: impl Fn() -> String,
) -> Nav {
    // local shell pages: tauri:// (macOS) or http://tauri.localhost (Linux)
    if u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost") {
        return Nav::Allow;
    }
    // in-page pseudo-navigations (the preview iframe is srcdoc-based,
    // and some webkits run every frame through this policy hook).
    // Never route these to the system opener. That popups "Could not
    // read file about:src:doc."
    if matches!(u.scheme(), "about" | "blob" | "data") {
        return Nav::Allow;
    }
    let bridge = bridge();
    if u.host_str() == Some("127.0.0.1") && u.port() == bridge {
        return Nav::Allow;
    }
    // the shipless reader's own origin; its Connect a node is the manager
    if u.host_str() == Some("127.0.0.1") {
        if let Some(r) = reader(false).and_then(|b| b.parse::<tauri::Url>().ok()) {
            if u.port() == r.port() {
                return if u.path() == "/connect" { Nav::Manager } else { Nav::Allow };
            }
        }
    }
    let local = bridge.map(|p| format!("http://127.0.0.1:{p}"));
    // urb:// names stay in the app. The ship's reader resolves them
    if let (Some(local), "urb") = (&local, u.scheme()) {
        return match format!("{local}/apps/lattice").parse::<tauri::Url>() {
            Ok(mut t) => {
                t.query_pairs_mut().clear().append_pair("url", u.as_str());
                Nav::Rewrite(t)
            }
            Err(_) => Nav::Block,
        };
    }
    // with no ship at all, the shipless reader reads them
    if u.scheme() == "urb" {
        if !ship_url().is_empty() {
            return Nav::Block;
        }
        return match reader(true) {
            Some(base) => reader_boot(&base, u.as_str()).map_or(Nav::Block, Nav::Rewrite),
            None => Nav::Block,
        };
    }
    // absolute links to the ship's real origin re-route through the
    // bridge. Hitting the ship directly would arrive cookieless
    if tauri::Url::parse(&ship_url()).is_ok_and(|ship| ship.origin() == u.origin()) {
        let Some(local) = &local else { return Nav::Block };
        let pq = &u.as_str()[u.origin().ascii_serialization().len()..];
        return match format!("{local}{pq}").parse::<tauri::Url>() {
            Ok(t) => Nav::Rewrite(t),
            Err(_) => Nav::Block,
        };
    }
    // only things a system handler can sensibly open leave the app.
    // Anything else is silently blocked (an opener error is a popup)
    Nav::External
}

/// The shipless reader's page for an urb:// address, through its bootstrap.
#[cfg(feature = "urb-engine")]
fn reader_boot(base: &str, urb: &str) -> Option<tauri::Url> {
    crate::reader::boot_url(base, &crate::render::read_href(urb)).parse().ok()
}
#[cfg(not(feature = "urb-engine"))]
fn reader_boot(_: &str, _: &str) -> Option<tauri::Url> {
    None
}

/// The shipless reader's base url: `start` starts it if it is not running.
/// None when it does not run (or this build has no engine).
#[cfg(feature = "urb-engine")]
pub fn reader_base(app: &AppHandle, start: bool) -> Option<String> {
    if start {
        return crate::reader::start(app).map_err(|e| dlog(&format!("reader: {e}"))).ok();
    }
    crate::reader::port(&app.state::<crate::reader::Reader>()).map(|p| format!("http://127.0.0.1:{p}"))
}
#[cfg(not(feature = "urb-engine"))]
pub fn reader_base(_: &AppHandle, _: bool) -> Option<String> {
    None
}

//  ── the shipless reader, from the manager ───────────────────────────────
//  Local windows only (capabilities/local.json). The reader's own pages get
//  no commands at all, and neither does the ship page.

/// What the manager is told about the shipless reader.
#[derive(serde::Serialize)]
pub struct ReaderStatus {
    /// off, booting, ready or failed
    pub engine: &'static str,
    /// the reader identity, once it runs
    pub our: Option<String>,
    pub error: Option<String>,
    /// what a start in progress is doing, in words
    pub step: Option<String>,
    /// the reader identity's @p, running or not, once there is one
    pub identity: Option<String>,
    /// when it was last exported (unix seconds): it may now run elsewhere
    pub exported: Option<u64>,
}

/// Has this install read without a ship before (is there a reader
/// identity on disk that was used)? One made at launch for the first-run
/// page does not count.
#[cfg(feature = "urb-engine")]
fn reader_used(app: &AppHandle) -> bool {
    app.state::<crate::engine::Engine>().claimed()
}

/// The address the manager's card was given, as the reader reads it: an
/// urb:// address, or a bare ~ship/path. Refused unless the gateway's
/// own parse takes it.
#[cfg(feature = "urb-engine")]
fn reader_address(given: &str) -> Result<String, String> {
    let g = given.trim();
    let u = if g.starts_with('~') { format!("urb://{g}") } else { g.to_string() };
    urb_render::gateway::de_urb(u.as_bytes())
        .map(|_| u)
        .map_err(|(_, w)| format!("That isn't an urb:// address: {}", String::from_utf8_lossy(&w)))
}

/// Open the shipless reader in the workspace window, at an address or at
/// its home, and start the engine so the reader identity is being made
/// while the page loads.
#[tauri::command]
pub fn open_reader(app: AppHandle, url: Option<String>) -> Result<(), String> {
    #[cfg(feature = "urb-engine")]
    {
        let to = match url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            Some(u) => crate::render::read_href(&reader_address(u)?),
            None => "/".to_string(),
        };
        let base = crate::reader::start(&app)?;
        app.state::<crate::engine::Engine>().start();
        let (w, _) = ensure_workspace(&app)?;
        let boot: tauri::Url = crate::reader::boot_url(&base, &to).parse().map_err(|e| format!("{e}"))?;
        dlog(&format!("reader: open {to}"));
        w.navigate(boot).map_err(|e| e.to_string())?;
        w.set_focus().ok();
        Ok(())
    }
    #[cfg(not(feature = "urb-engine"))]
    {
        let _ = (app, url);
        Err("this build has no shipless reader".into())
    }
}

/// Where the shipless reader's engine is, for the manager's card.
#[tauri::command]
pub fn reader_status(app: AppHandle) -> Result<ReaderStatus, String> {
    #[cfg(feature = "urb-engine")]
    {
        use crate::engine::Status;
        let e = app.state::<crate::engine::Engine>();
        let step = Some(e.step()).filter(|s| !s.is_empty()).map(String::from);
        let (identity, exported) = (e.identity(), e.exported_at());
        let (engine, our, error) = match e.status() {
            Status::Off => ("off", None, None),
            Status::Booting => ("booting", None, None),
            Status::Ready { our } => ("ready", Some(our), None),
            Status::Failed(m) => ("failed", None, Some(crate::engine::plain_boot(&m))),
        };
        Ok(ReaderStatus { engine, our, error, step, identity, exported })
    }
    #[cfg(not(feature = "urb-engine"))]
    {
        let _ = app;
        Err("this build has no shipless reader".into())
    }
}

/// Empty the shipless reader's local history (the Connection tab's button).
/// Asked in a native dialog when the ship page calls it, since what goes is
/// the user's and cannot come back. Async, for the dialog's wait.
#[tauri::command]
pub async fn clear_reader_history(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    #[cfg(feature = "urb-engine")]
    {
        ship_page_asks(
            &app,
            &webview,
            "Clear reading history",
            "Clear the pages you read anonymously on this computer?".into(),
            "Clear",
        )?;
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("urb");
        crate::history::History::open(&dir).clear()
    }
    #[cfg(not(feature = "urb-engine"))]
    {
        let _ = (app, webview);
        Err("this build has no shipless reader".into())
    }
}

/// Export the anonymous identity to a file the user picks in a native save
/// dialog, sealed with `passphrase` (cometid.rs). The path written, or an
/// empty string when the dialog was cancelled. The page never gets the
/// file's bytes: a ship page calling this gets a save dialog the user sees,
/// and a file only where they put it.
#[tauri::command]
pub async fn export_reader_identity(app: AppHandle, passphrase: String) -> Result<String, String> {
    #[cfg(feature = "urb-engine")]
    {
        use tauri_plugin_dialog::DialogExt;
        if passphrase.chars().count() < crate::cometid::MIN_PASSPHRASE {
            return Err(format!("Pick a passphrase of at least {} characters.", crate::cometid::MIN_PASSPHRASE));
        }
        let e = app.state::<crate::engine::Engine>().inner().clone();
        let short = e.identity().map(|s| short_name(&s)).unwrap_or_default();
        let Some(target) = app
            .dialog()
            .file()
            .set_title("Export your anonymous identity")
            .set_file_name(format!("lattice-identity-{short}.{}", crate::cometid::EXTENSION))
            .add_filter("lattice identity", &[crate::cometid::EXTENSION])
            .blocking_save_file()
        else {
            return Ok(String::new());
        };
        let path = target.into_path().map_err(|e| e.to_string())?;
        // the engine closes for the copy and the KDF takes a moment: off
        // the async runtime's threads
        let file = tauri::async_runtime::spawn_blocking(move || {
            let id = e.export_identity()?;
            let f = crate::cometid::seal(&id, &passphrase)?;
            crate::cometid::mark_exported(e.dir())?;
            Ok::<_, String>(f)
        })
        .await
        .map_err(|e| e.to_string())??;
        crate::session::write_private(&path, &file).map_err(|e| format!("could not write {e}"))?;
        dlog(&format!("reader: identity exported to {}", path.display()));
        Ok(path.display().to_string())
    }
    #[cfg(not(feature = "urb-engine"))]
    {
        let _ = (app, passphrase);
        Err("this build has no shipless reader".into())
    }
}

/// Import an anonymous identity from a file the user picks in a native
/// open dialog, unsealed with `passphrase`, in place of this computer's,
/// after a native confirmation naming both @ps (asked on every page, the
/// shell's own included: it replaces who the user is). The old identity is
/// moved aside, not deleted. The new @p, or an empty string when the user
/// cancelled the file dialog.
#[tauri::command]
pub async fn import_reader_identity(app: AppHandle, passphrase: String) -> Result<String, String> {
    #[cfg(feature = "urb-engine")]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let Some(picked) = app
            .dialog()
            .file()
            .set_title("Use an existing anonymous identity")
            .add_filter("lattice identity", &[crate::cometid::EXTENSION])
            .blocking_pick_file()
        else {
            return Ok(String::new());
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        let size = std::fs::metadata(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?.len();
        if size > crate::cometid::MAX_FILE {
            return Err(crate::cometid::OpenError::NotIdentity.to_string());
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
        let id = tauri::async_runtime::spawn_blocking(move || crate::cometid::open(&bytes, &passphrase))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let e = app.state::<crate::engine::Engine>().inner().clone();
        let old = e.identity();
        if old.as_deref() == Some(id.ship.as_str()) {
            return Err(format!("This computer already uses {}. Nothing changed.", id.ship));
        }
        let yes = app
            .dialog()
            .message(import_question(old.as_deref(), &id.ship))
            .title("Use an existing anonymous identity")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(format!("Use {}", short_name(&id.ship)), "Cancel".into()))
            .blocking_show();
        if !yes {
            return Err("cancelled, nothing changed".into());
        }
        let ship = id.ship.clone();
        tauri::async_runtime::spawn_blocking(move || e.import_identity(&id))
            .await
            .map_err(|e| e.to_string())??;
        dlog(&format!("reader: identity {ship} imported"));
        Ok(ship)
    }
    #[cfg(not(feature = "urb-engine"))]
    {
        let _ = (app, passphrase);
        Err("this build has no shipless reader".into())
    }
}

/// The import's confirmation, naming both identities.
#[cfg(feature = "urb-engine")]
fn import_question(old: Option<&str>, new: &str) -> String {
    let now = match old {
        Some(o) => format!(
            "Replace this computer's anonymous identity {o} with {new}?\n\n{o} is set aside on this computer, not deleted, but lattice stops using it: its comments keep its name."
        ),
        None => format!("Use {new} as this computer's anonymous identity?"),
    };
    format!(
        "{now}\n\nStop using {new} on the computer it came from. Two computers running one identity at once lose each other's comments and posts. And import from a fresh export: an older file can make your next messages go missing."
    )
}

/// A ship's name for a file name or a button: a comet's last two words.
#[cfg(feature = "urb-engine")]
fn short_name(ship: &str) -> String {
    let s = ship.trim_start_matches('~');
    let tail: Vec<&str> = s.rsplit('-').filter(|w| !w.is_empty()).take(2).collect();
    if s.len() > 14 && tail.len() == 2 {
        format!("~{}-{}", tail[1], tail[0])
    } else {
        format!("~{s}")
    }
}

fn new_workspace(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let handle = app.clone();
    // LATTICE_PROBE_JS=<path>: inject that file into the workspace page.
    //
    // The desktop-only paths are the ones that keep breaking in ways nothing
    // catches (the capability grants, the backup chain, the shortcuts),
    // because a browser test cannot reach any of them: no invoke, no bridge. scripts/desktop-matrix.sh drives the REAL binary and
    // needs a way to ask the page what it sees. Injecting from a file beats
    // editing the ship's app.js, which is what the throwaway versions of this
    // did and which meant the harness could not run against a ship it did not
    // own.
    //
    // Test-only and inert unless the variable is set, and compiled into
    // debug builds only (the harness drives target/debug). In a release
    // build an environment variable could put script into the privileged
    // workspace window, which a test hook has no business doing.
    let probe = cfg!(debug_assertions)
        .then(|| std::env::var("LATTICE_PROBE_JS").ok())
        .flatten()
        .and_then(|p| std::fs::read_to_string(p).ok());
    let mut b = WebviewWindowBuilder::new(app, "workspace", WebviewUrl::App("manager.html".into()))
        .title("lattice — workspace")
        .inner_size(1200.0, 800.0);
    if let Some(js) = probe {
        dlog("probe script injected into the workspace");
        b = b.initialization_script(js);
    }
    // Runtime-built windows carry no icon on Linux (config has no `windows`
    // entry to inherit from), so the workspace showed GTK's generic app icon.
    // The rebuild on opening settings made that obvious: a fresh, unbranded
    // window. Reuse the bundle icon the config already declares.
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone()).map_err(|e| e.to_string())?;
    }
    let w = b
        // tauri's own drag-drop interception would swallow the HTML5 drop
        // events the ship UI's drag-to-upload listens for
        .disable_drag_drop_handler()
        // keep the workspace on the bridge (or the shell's own pages). Any
        // other top-level navigation opens in the system browser. The
        // webview has no back button or url bar to escape from
        .on_navigation(move |u| {
            // renavigate the workspace ourselves, off-thread so the queued
            // navigate never re-enters the policy callback we are inside
            let renav = |t: tauri::Url| {
                let h = handle.clone();
                std::thread::spawn(move || {
                    let h2 = h.clone();
                    h.run_on_main_thread(move || {
                        if let Some(w) = h2.get_webview_window("workspace") {
                            w.navigate(t).ok();
                        }
                    })
                    .ok();
                });
            };
            let bridge = || {
                handle
                    .state::<crate::proxy::Bridge>()
                    .inner()
                    .0
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|(_, p)| *p)
            };
            let reader = |start: bool| reader_base(&handle, start);
            match nav_decision(u, bridge, reader, || config::load(&handle).url) {
                Nav::Allow => true,
                Nav::Manager => {
                    let h = handle.clone();
                    std::thread::spawn(move || {
                        let h2 = h.clone();
                        h.run_on_main_thread(move || {
                            show_manager(&h2, None).ok();
                        })
                        .ok();
                    });
                    false
                }
                Nav::Rewrite(t) => {
                    renav(t);
                    false
                }
                Nav::External => {
                    open_external(u.as_str()).ok();
                    false
                }
                Nav::Block => false,
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    // no menubar, so the window's shortcuts are caught here (keys.rs)
    crate::keys::attach(&w);
    Ok(w)
}

//  ── the vault archive, off and on to disk ────────────────────────────────
//  The shell has no download handling at all: no on_download, no save dialog,
//  nothing. So the web app's <a download> click had nothing to catch it and
//  "export vault" silently did nothing here, while restore had no way to read
//  a file at all. A backup feature that works only in a browser is not a
//  backup feature, and the desktop app is the surface that actually has a
//  disk to put one on.
//
//  Bytes cross the IPC base64-encoded. A multi-megabyte JSON array of numbers
//  is slow enough through the webview to read as a hang, and this is the one
//  path where the entire point is that the bytes arrive exactly as they left.

/// Decode an archive payload from the webview. Split out from the command so
/// the byte handling is testable without a dialog or a display.
fn decode_archive(b64: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("bad archive payload: {e}"))
}

/// Encode an archive read off disk for the trip back to the webview.
fn encode_archive(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Save a vault archive wherever the user says. Returns the path written, or
/// an empty string if they cancelled, which is not an error.
#[tauri::command]
pub async fn save_vault(app: AppHandle, name: String, b64: String) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let bytes = decode_archive(&b64)?;
    let Some(target) = app
        .dialog()
        .file()
        .set_file_name(name)
        .add_filter("tar archive", &["tar"])
        .blocking_save_file()
    else {
        return Ok(String::new());
    };
    let path = target.into_path().map_err(|e| e.to_string())?;
    // the whole vault: written 0600 through a fresh temp file, like backups
    crate::session::write_private(&path, &bytes).map_err(|e| format!("could not write {e}"))?;
    Ok(path.display().to_string())
}

/// The configured backup schedules.
#[tauri::command]
pub fn backup_schedules(app: AppHandle) -> Vec<crate::config::BackupSchedule> {
    config::load(&app).backups
}

/// Replace the whole schedule list.
///
/// Whole-list rather than per-schedule edits: the manager form owns the table,
/// and a partial update racing the scheduler's last_run write is how a backup
/// silently stops running. last_run is preserved from the stored copy by id,
/// so editing a schedule's keep or directory does not make it immediately due
/// again and re-backup on every save.
///
/// From the ship page every change is put to the user first in a native
/// dialog that lists it (schedule_changes). A page the ship serves could
/// otherwise add a schedule writing into any folder, or pause or remove the
/// ones there are, and backups would stop with nobody told. Async, for the
/// dialog's wait.
#[tauri::command]
pub async fn set_backup_schedules(
    app: AppHandle,
    webview: tauri::Webview,
    schedules: Vec<crate::config::BackupSchedule>,
) -> Result<(), String> {
    let changes = schedule_changes(&config::load(&app).backups, &schedules);
    if changes.is_empty() {
        return Ok(());
    }
    ship_page_asks(
        &app,
        &webview,
        "Scheduled backups",
        format!("Change the scheduled backups on this computer?\n\n{}", changes.join("\n")),
        "Change",
    )?;
    config::update(&app, move |cfg| {
        let mut next = schedules;
        for s in next.iter_mut() {
            if let Some(old) = cfg.backups.iter().find(|o| o.id == s.id) {
                s.last_run = old.last_run;
            }
        }
        cfg.backups = next;
    })
    .map(|_| ())
}

/// What a new schedule list changes, one line per schedule, for the dialog
/// set_backup_schedules shows the ship page. last_run is the scheduler's,
/// not the page's, so it is no change.
fn schedule_changes(
    old: &[crate::config::BackupSchedule],
    new: &[crate::config::BackupSchedule],
) -> Vec<String> {
    let mut out = Vec::new();
    let what = |s: &crate::config::BackupSchedule| {
        format!("{}, every {}h, keeping {}, into {}", s.label, s.every_hours, s.keep, s.dir)
    };
    for n in new {
        match old.iter().find(|o| o.id == n.id) {
            None => out.push(format!("add {}", what(n))),
            Some(o) if o.enabled && !n.enabled => out.push(format!("pause {}", n.label)),
            Some(o) if !o.enabled && n.enabled => out.push(format!("resume {}", n.label)),
            Some(o) if (o.label.as_str(), o.every_hours, o.keep, o.dir.as_str())
                != (n.label.as_str(), n.every_hours, n.keep, n.dir.as_str()) =>
            {
                out.push(format!("change {} to {}", o.label, what(n)))
            }
            _ => {}
        }
    }
    for o in old {
        if !new.iter().any(|n| n.id == o.id) {
            out.push(format!("remove {} (its archives stay)", o.label));
        }
    }
    out
}

/// Did a page the ship serves make this call, rather than one of the
/// shell's own pages? The ship page runs at the bridge origin, where every
/// command it is granted (capabilities/workspace-remote.json) is reachable
/// by anything the ship serves. An address that cannot be read counts as
/// the ship's, so a doubt asks rather than skips the question.
pub fn from_ship_page(w: &tauri::Webview) -> bool {
    w.url()
        .map(|u| !(u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")))
        .unwrap_or(true)
}

/// A change the ship page asked for, put to the user in a native dialog
/// first. The shell's own pages are not asked: only the user's clicks reach
/// them. Cancelled is an error, which the page shows where the change was.
/// It blocks until answered, so only an async command may call it.
pub fn ship_page_asks(
    app: &AppHandle,
    w: &tauri::Webview,
    title: &str,
    text: String,
    ok: &str,
) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if !from_ship_page(w) {
        return Ok(());
    }
    let yes = app
        .dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), "Cancel".into()))
        .blocking_show();
    if yes { Ok(()) } else { Err("cancelled, nothing changed".into()) }
}

/// The schedule with this id. One place, so "no backup schedule" reads the
/// same however the user arrived at it.
fn schedule<'a>(
    cfg: &'a config::Config,
    id: &str,
) -> Result<&'a crate::config::BackupSchedule, String> {
    cfg.backups
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("no backup schedule {id}"))
}

/// Pick a directory for a schedule to write into.
#[tauri::command]
pub async fn pick_backup_dir(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(String::new());
    };
    Ok(picked.into_path().map_err(|e| e.to_string())?.display().to_string())
}

/// The page hands back an archive it built for a schedule. Write it, prune
/// that schedule's older archives, and record that the schedule ran.
///
/// last_run is stamped only on SUCCESS. A failed write must leave the schedule
/// due, or one unwritable evening silently costs a whole period.
///
/// `complete` is false when the page could not read some pages, the memories
/// or the share modes. That archive is written as -INCOMPLETE, nothing is
/// pruned and last_run is not stamped, so the schedule stays due. A page
/// served by an older ship does not send it, and is taken as complete, which
/// is what every archive was before.
///
/// Async, like save_vault: the decode and the disk write handle whole
/// multi-MB archives, and holding the main thread for that freezes the UI.
#[tauri::command]
pub async fn backup_write(
    app: AppHandle,
    id: String,
    b64: String,
    complete: Option<bool>,
) -> Result<String, String> {
    let bytes = decode_archive(&b64)?;
    let at = crate::backup::now();
    let complete = complete.unwrap_or(true);
    // try_update, not update: a schedule that vanished out from under this
    // request, or an archive write that fails, must leave config.json
    // untouched rather than persist a last_run stamp for nothing written.
    let path = config::try_update(&app, move |cfg| {
        crate::backup::record(cfg, &id, &bytes, at, complete)
    })?;
    dlog(&format!("backup: wrote {}", path.display()));
    Ok(path.display().to_string())
}

/// Ask the workspace page to build an archive for this schedule.
///
/// Returns whether the request could be made at all. The archive lands
/// asynchronously via backup_write, and last_run is stamped only there, so a
/// request that reaches nothing leaves the schedule due.
///
/// `takeover` is the difference between the two callers. "back up now" is
/// clicked FROM the manager page, where the single window is by definition
/// not showing the app page, __latticeBackup is undefined, and the eval
/// used to succeed while doing nothing: the button could never produce a
/// backup. So the user-initiated path (true) navigates the workspace to the
/// app with ?backup=<id> when the hook is absent, and 78-export runs the
/// pending id once the page is up. The scheduler passes false: yanking the
/// manager page out from under a half-filled mount or schedule form costs
/// the user's input, backup.rs promises a due schedule waits, and waiting is
/// cheap because a later tick retries once the app page is back.
pub fn request_backup(app: &AppHandle, id: &str, takeover: bool) -> bool {
    let Some(w) = app.get_webview_window("workspace") else { return false };
    // the id is ours, not user text, but it still goes through a quoted JSON
    // string rather than being pasted raw into a script
    let arg = serde_json::to_string(id).unwrap_or_else(|_| "\"\"".into());
    if !takeover {
        // a shell page (the manager) has no hook to call, so skip the eval
        // entirely and say why the run is waiting
        if on_shell_page(&w) {
            dlog("backup: the manager page is showing, the schedule waits for a later tick");
            return false;
        }
        // on the app page the hook may still be a beat from existing (page
        // mid-boot). The guarded call is then a no-op and the schedule
        // stays due, which is the retry.
        return w
            .eval(format!(
                "(function(){{if(window.__latticeBackup){{window.__latticeBackup({arg});}}}})()"
            ))
            .is_ok();
    }
    let cfg = config::load(app);
    let dest = serde_json::to_string(&format!(
        "{}/apps/lattice/app?backup={}", cfg.url.trim_end_matches('/'), id
    ))
    .unwrap_or_else(|_| "\"\"".into());
    w.eval(format!(
        "(function(){{if(window.__latticeBackup){{window.__latticeBackup({arg});}}\
         else{{location.href={dest};}}}})()"
    ))
    .is_ok()
}

/// Read a schedule's newest archive back and report what is actually in it.
///
/// The drill, not a checksum file: it walks the tar the way a restore walks
/// it, so what passes here is what a restore would find. An archive that is
/// merely PRESENT proves nothing — the desktop export path was dead for weeks
/// and looked exactly like this feature working.
///
/// Async, like save_vault: it reads the newest archive whole, and a
/// multi-MB read belongs off the main thread.
#[tauri::command]
pub async fn verify_backup(app: AppHandle, id: String) -> Result<crate::backup::Report, String> {
    let cfg = config::load(&app);
    let s = schedule(&cfg, &id)?;
    let r = crate::backup::verify_newest(s)?;
    dlog(&format!(
        "verify {}: {} — {:?}",
        s.label,
        if r.ok() { "clean" } else { "PROBLEMS" },
        r
    ));
    Ok(r)
}

/// Run one schedule now, whatever its period says.
#[tauri::command]
pub fn run_backup_now(app: AppHandle, id: String) -> Result<(), String> {
    let cfg = config::load(&app);
    schedule(&cfg, &id)?;
    if !request_backup(&app, &id, true) {
        return Err("the workspace page is not open, so there is nothing to export from".into());
    }
    Ok(())
}

/// Read a vault archive the user picks. Empty string means they cancelled.
#[tauri::command]
pub async fn pick_vault(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("vault archive", &["tar"])
        .blocking_pick_file()
    else {
        return Ok(String::new());
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let bytes =
        std::fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    Ok(encode_archive(&bytes))
}

#[cfg(test)]
mod nav_tests {
    use super::{nav_decision, Nav};

    const SHIP: &str = "https://sampel-palnet.arvo.network";

    fn decide(u: &str, bridge: Option<u16>, ship: &str) -> Nav {
        let reader = |_: bool| Some("http://127.0.0.1:26520".to_string());
        nav_decision(&u.parse().unwrap(), || bridge, reader, || ship.to_string())
    }

    fn rewrite(n: Nav) -> String {
        match n {
            Nav::Rewrite(t) => t.to_string(),
            n => panic!("not a rewrite: {n:?}"),
        }
    }

    #[test]
    fn the_readers_origin_stays_and_its_connect_is_the_manager() {
        assert_eq!(decide("http://127.0.0.1:26520/read?url=x", None, ""), Nav::Allow);
        assert_eq!(decide("http://127.0.0.1:26520/raw?url=x&key=y", None, ""), Nav::Allow);
        assert_eq!(decide("http://127.0.0.1:26520/connect", None, ""), Nav::Manager);
        // any other loopback port is not the app's
        assert_eq!(decide("http://127.0.0.1:26521/read", None, ""), Nav::External);
        // and with no reader running, nothing on loopback is the reader
        let none = |_: bool| None;
        assert_eq!(
            nav_decision(&"http://127.0.0.1:26520/".parse().unwrap(), || None, none, String::new),
            Nav::External
        );
    }

    #[cfg(feature = "urb-engine")]
    #[test]
    fn with_no_ship_an_urb_link_opens_in_the_shipless_reader() {
        let t = rewrite(decide("urb://~nec/x/y", None, ""));
        assert!(t.starts_with("http://127.0.0.1:26520/boot?k="), "{t}");
        assert!(t.ends_with(&format!("&to={}", crate::render::enc("/read?url=urb%3A%2F%2F~nec%2Fx%2Fy"))), "{t}");
    }

    #[test]
    fn with_a_ship_urb_links_are_the_ships() {
        assert_eq!(
            rewrite(decide("urb://~nec/x", Some(26500), SHIP)),
            "http://127.0.0.1:26500/apps/lattice?url=urb%3A%2F%2F%7Enec%2Fx"
        );
        // configured but the bridge is not up yet: as before, nothing
        assert_eq!(decide("urb://~nec/x", None, SHIP), Nav::Block);
        assert_eq!(decide("http://127.0.0.1:26500/apps/lattice/app", Some(26500), SHIP), Nav::Allow);
        assert_eq!(
            rewrite(decide(&format!("{SHIP}/apps/lattice/app"), Some(26500), SHIP)),
            "http://127.0.0.1:26500/apps/lattice/app"
        );
        assert_eq!(decide("https://example.com/", Some(26500), SHIP), Nav::External);
        assert_eq!(decide("tauri://localhost/manager.html", None, ""), Nav::Allow);
        assert_eq!(decide("about:srcdoc", None, ""), Nav::Allow);
    }
}

#[cfg(all(test, feature = "urb-engine"))]
mod reader_address_tests {
    use super::reader_address;

    #[test]
    fn the_card_takes_urb_addresses_and_bare_ones() {
        assert_eq!(reader_address(" urb://~zod/notes ").unwrap(), "urb://~zod/notes");
        assert_eq!(reader_address("~zod/notes").unwrap(), "urb://~zod/notes");
        for bad in ["https://example.com", "zod/x", "urb://~not a ship/x", "urb://~zod/p/x"] {
            assert!(reader_address(bad).unwrap_err().starts_with("That isn't an urb:// address"), "{bad}");
        }
    }
}

#[cfg(test)]
mod theme_tests {
    use super::theme_vars;
    use std::collections::BTreeMap;

    #[test]
    fn only_theme_shaped_variables_are_kept() {
        let m = |kv: &[(&str, &str)]| -> BTreeMap<String, String> {
            kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
        };
        let good = m(&[
            ("color-scheme", "dark"), ("--bg", "#1a1a1a"), ("--accent-tint", "#4a7c5938"),
            ("--font", "\"Iosevka\", system-ui, sans-serif"),
        ]);
        assert_eq!(theme_vars(good.clone()), good);
        let bad = m(&[
            ("color-scheme", "dark;background:url(x)"), ("--bg", "red"), ("--accent", "#12"),
            ("--font", "x}body{display:none"), ("--evil", "#fff"), ("background", "#fff"),
        ]);
        assert!(theme_vars(bad).is_empty());
    }
}

#[cfg(test)]
mod manager_section_tests {
    use super::manager_section;

    #[test]
    fn only_known_sections_pass() {
        assert_eq!(manager_section(None), Ok(None));
        assert_eq!(manager_section(Some("backups")), Ok(Some("backups")));
        assert_eq!(manager_section(Some("files")), Ok(Some("files")));
        assert_eq!(manager_section(Some("connection")), Ok(Some("connection")));
        assert!(manager_section(Some("backups\"><script>")).is_err());
        assert!(manager_section(Some("")).is_err());
    }

    #[test]
    fn only_known_settings_tabs_pass() {
        use super::settings_tab;
        assert_eq!(settings_tab(None), Ok(None));
        assert_eq!(settings_tab(Some("keys")), Ok(Some("keys")));
        assert_eq!(settings_tab(Some("appearance")), Ok(Some("appearance")));
        assert!(settings_tab(Some("keys&name=x")).is_err());
        assert!(settings_tab(Some("files")).is_err());
        assert!(settings_tab(Some("")).is_err());
    }
}

#[cfg(test)]
mod tests {
    //  The ship-served client gets native commands only at the bridge
    //  origin. Any-host patterns granted them to every page the workspace
    //  window could reach (security audit run-1). A pattern that stopped
    //  matching the bridge would deny every command, and that failure reads
    //  as "Command not found", so pin both directions.
    #[test]
    fn workspace_commands_are_granted_only_at_the_bridge() {
        use tauri::utils::acl::RemoteUrlPattern;
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/workspace-remote.json")).unwrap();
        let pats: Vec<RemoteUrlPattern> = cap["remote"]["urls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u.as_str().unwrap().parse().unwrap())
            .collect();
        let hit = |u: &str| pats.iter().any(|p| p.test(&u.parse().unwrap()));
        for u in [
            "http://127.0.0.1:26500/apps/lattice/app",
            "http://127.0.0.1:26503/apps/lattice/app?name=notes#top",
            "http://127.0.0.1:26500/apps/lattice",
        ] {
            assert!(hit(u), "the client at {u} must keep its commands");
        }
        for u in [
            "https://evil.example/",
            "http://evil.example:26500/apps/lattice/app",
            "https://sampel-palnet.arvo.network/apps/lattice/app",
            "http://localhost:26500/apps/lattice/app",
            // the shipless reader's origin gets no commands at all
            "http://127.0.0.1:26520/read?url=urb%3A%2F%2F~zod%2Fx",
            "http://127.0.0.1:26520/raw?url=x&key=y",
            "http://127.0.0.1:26535/",
            "http://127.0.0.1:26516/",
        ] {
            assert!(!hit(u), "{u} must not get native commands");
        }
        // exactly the sixteen bridge ports
        let urls: Vec<&str> = cap["remote"]["urls"].as_array().unwrap().iter().map(|u| u.as_str().unwrap()).collect();
        let want: Vec<String> = (26500..26516).map(|p| format!("http://127.0.0.1:{p}")).collect();
        assert_eq!(urls, want);
        for p in 26500..26516 {
            assert!(hit(&format!("http://127.0.0.1:{p}/apps/lattice/app")));
        }
    }

    use super::openable;

    //  This allowlist is the only thing standing between a ship-served page
    //  and the desktop's URL dispatcher, so it is tested as a boundary rather
    //  than as a formatting helper.
    #[test]
    fn only_handler_safe_schemes_leave_the_app() {
        for ok in [
            "http://example.com/x",
            "https://example.com/x?q=1#f",
            "HTTPS://EXAMPLE.COM",
            "mailto:a@b.c",
            "tel:+15551234",
        ] {
            assert!(openable(ok), "should open: {ok}");
        }
        for bad in [
            //  the ones that turn "open a link" into "run something"
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>x</script>",
            "vscode://x",
            "smb://host/share",
            //  and the malformed shapes
            "not-a-url",
            "",
            "http",
            "http:",
            "://example.com",
        ] {
            assert!(!openable(bad), "should refuse: {bad}");
        }
    }

    #[test]
    fn a_control_character_cannot_ride_along() {
        //  argv carries the url as one element, but a handler downstream may
        //  split it, and a newline is how one argument becomes two
        assert!(!openable("http://example.com/\nmailto:x@y.z"));
        assert!(!openable("http://example.com/\r\nHeader: v"));
        assert!(!openable("http://example.com/\u{0}"));
    }

    #[test]
    fn a_leading_dash_cannot_look_like_a_flag() {
        //  xdg-open would read "-foo" as an option; the scheme requirement
        //  makes that unreachable, and this pins it
        assert!(!openable("-x"));
        assert!(!openable("--help"));
    }

    use super::{push_file, walk};

    #[test]
    fn a_folder_pick_reads_exactly_the_tree_the_ship_will_receive() {
        // The rel paths ARE the paths the upload writes to the ship, so a
        // silent change here either drops the user's files or files them
        // under the wrong names, overwriting pages that already exist.
        let base = std::env::temp_dir().join(format!("lattice-pick-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let root = base.join("notes");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a.md"), "alpha").unwrap();
        std::fs::write(root.join("sub/b.MD"), "bravo").unwrap();
        std::fs::write(root.join("skip.txt"), "not a page").unwrap();
        // a binary file with the right extension: read_to_string fails and it
        // must be skipped rather than pushed as mangled text
        std::fs::write(root.join("binary.md"), [0xffu8, 0xfe, 0x00]).unwrap();

        let exts = vec!["md".to_string()];
        let mut out = Vec::new();
        walk(&root, "notes", &exts, &mut out, &mut 0).unwrap();
        out.sort_by(|a, b| a.rel.cmp(&b.rel));

        let rels: Vec<&str> = out.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(
            rels,
            vec!["notes/a.md", "notes/sub/b.MD"],
            "rel mirrors webkitRelativePath: the picked folder, then the tree"
        );
        assert_eq!(out[0].text, "alpha", "the file's text must be what is uploaded");
        assert_eq!(out[1].text, "bravo");

        // a file pick names the file alone, no folder prefix
        let mut one = Vec::new();
        push_file(&root.join("a.md"), "a.md".to_string(), &mut one, &mut 0).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!((one[0].rel.as_str(), one[0].text.as_str()), ("a.md", "alpha"));

        std::fs::remove_dir_all(&base).ok();
    }
}

#[cfg(test)]
mod pick_tests {
    use super::{page_exts, push_file, walk, PICK_MAX_BYTES, PICK_MAX_FILES};

    fn tmp(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("lattice-pick-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn the_page_cannot_widen_the_extension_list() {
        let asked = ["md", "TeX", "pem", "env", "", "sh", "html"].map(String::from).to_vec();
        assert_eq!(page_exts(asked), ["md", "TeX", "html"]);
    }

    #[test]
    fn a_folder_walk_skips_hidden_names() {
        let root = tmp("dots");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join(".git/HEAD.md"), "x").unwrap();
        std::fs::write(root.join(".secret.md"), "x").unwrap();
        std::fs::write(root.join("notes/a.md"), "a").unwrap();
        std::fs::write(root.join("notes/b.pem"), "b").unwrap();
        let (mut out, mut bytes) = (Vec::new(), 0);
        walk(&root, "pick", &["md".to_string()], &mut out, &mut bytes).unwrap();
        let rels: Vec<_> = out.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, ["pick/notes/a.md"]);
        assert_eq!(bytes, 1);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_folder_walk_stops_at_the_file_cap() {
        let root = tmp("cap");
        for i in 0..=PICK_MAX_FILES {
            std::fs::write(root.join(format!("{i}.md")), "").unwrap();
        }
        let (mut out, mut bytes) = (Vec::new(), 0);
        let e = walk(&root, "", &["md".to_string()], &mut out, &mut bytes).unwrap_err();
        assert!(e.contains("too many files"), "{e}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_pick_stops_at_the_byte_cap() {
        let root = tmp("bytes");
        // sparse, so the test costs no disk
        let big = root.join("big.md");
        std::fs::File::create(&big).unwrap().set_len(PICK_MAX_BYTES).unwrap();
        std::fs::write(root.join("one.md"), "x").unwrap();
        let (mut out, mut bytes) = (Vec::new(), 0);
        push_file(&big, "big.md".into(), &mut out, &mut bytes).unwrap();
        assert_eq!(bytes, PICK_MAX_BYTES, "exactly the cap still fits");
        let e = push_file(&root.join("one.md"), "one.md".into(), &mut out, &mut bytes).unwrap_err();
        assert!(e.contains("too much data"), "{e}");
        assert_eq!(out.len(), 1);
        std::fs::remove_dir_all(&root).ok();
    }
}

#[cfg(test)]
mod vault_tests {
    use super::{decode_archive, encode_archive};

    //  A tar is arbitrary bytes, not text. Every value has to survive, and the
    //  three input lengths mod 3 are where a codec's padding goes wrong.
    #[test]
    fn every_byte_value_round_trips() {
        let all: Vec<u8> = (0..=255u8).collect();
        assert_eq!(decode_archive(&encode_archive(&all)).unwrap(), all);
    }

    #[test]
    fn every_padding_case_round_trips() {
        for len in 0..=48usize {
            let b: Vec<u8> = (0..len).map(|i| (i * 7 % 256) as u8).collect();
            let got = decode_archive(&encode_archive(&b)).unwrap();
            assert_eq!(got, b, "length {len} did not survive");
        }
    }

    //  the shapes a real archive is full of: NUL runs from header padding and
    //  the two zero blocks that end it, plus high bytes from utf-8 bodies
    #[test]
    fn archive_shaped_bytes_round_trip() {
        let mut b = vec![0u8; 1024];
        b.extend_from_slice("# héllo ⚡ 日本\n".as_bytes());
        b.extend_from_slice(&[0u8; 512]);
        b.extend_from_slice(&(0..=255u8).rev().collect::<Vec<u8>>());
        assert_eq!(decode_archive(&encode_archive(&b)).unwrap(), b);
    }

    #[test]
    fn a_payload_that_is_not_base64_is_refused_not_guessed() {
        //  restoring from a mangled payload by salvaging what parses would be
        //  worse than refusing: it writes a corrupt page over a good one
        assert!(decode_archive("not base64 !!!").is_err());
        assert!(decode_archive("QUJD===").is_err());
    }

    #[test]
    fn empty_is_empty_not_an_error() {
        assert_eq!(decode_archive("").unwrap(), Vec::<u8>::new());
    }
}

#[cfg(test)]
mod backup_race_tests {
    use crate::config::{self, BackupSchedule, Config};
    use std::sync::{Arc, Barrier};

    // per-process, per-test path: cargo runs test binaries (and cases within
    // this one) in parallel, and a shared filename would have them stomping
    // each other's config the same way the bug does
    fn tmp(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "lattice-cmd-race-{}-{tag}-{}.json",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ))
    }

    // Mirrors what backup_write and set_backup_schedules each do to the
    // config: load the whole thing, touch one field, save the whole thing
    // back, through config::update_at, the same helper every real writer
    // (connect, add_mount, remove_mount, queue_key, and these two) now goes
    // through, with no lock of its own to remember. A Barrier lines the two
    // threads up so their load-modify-save spans actually overlap instead of
    // happening to run one after the other on their own. Without update_at's
    // internal lock this is flaky: whichever save lands second wins outright
    // and the other thread's change vanishes even though its caller saw
    // Ok(()).
    #[test]
    fn a_schedule_edit_and_a_last_run_stamp_do_not_clobber_each_other() {
        let p = tmp("race");
        let start = Config {
            url: String::new(),
            ship: String::new(),
            queue_key: String::new(),
            theme: Default::default(),
            mounts: Vec::new(),
            backups: vec![BackupSchedule {
                id: "b1".into(),
                label: "daily".into(),
                every_hours: 24,
                keep: 7,
                dir: "/tmp/backups".into(),
                last_run: 0,
                enabled: true,
            }],
        };
        config::save_at(&p, &start).unwrap();

        let barrier = Arc::new(Barrier::new(2));

        let p1 = p.clone();
        let b1 = barrier.clone();
        let stamp_last_run = std::thread::spawn(move || {
            b1.wait();
            config::update_at(&p1, |c| {
                if let Some(s) = c.backups.iter_mut().find(|s| s.id == "b1") {
                    s.last_run = 12_345;
                }
            })
            .unwrap();
        });

        let p2 = p.clone();
        let b2 = barrier.clone();
        let edit_schedule = std::thread::spawn(move || {
            b2.wait();
            config::update_at(&p2, |c| {
                for s in c.backups.iter_mut() {
                    s.label = "renamed".into();
                }
            })
            .unwrap();
        });

        stamp_last_run.join().unwrap();
        edit_schedule.join().unwrap();

        let back = config::load_at(&p);
        assert_eq!(back.backups.len(), 1);
        assert_eq!(back.backups[0].last_run, 12_345, "the last_run stamp must survive");
        assert_eq!(back.backups[0].label, "renamed", "the schedule edit must survive");
        std::fs::remove_file(&p).ok();
    }
}

#[cfg(test)]
mod schedule_change_tests {
    use super::schedule_changes;
    use crate::config::BackupSchedule;

    fn s(id: &str, label: &str, dir: &str, enabled: bool) -> BackupSchedule {
        BackupSchedule {
            id: id.into(),
            label: label.into(),
            every_hours: 24,
            keep: 7,
            dir: dir.into(),
            last_run: 0,
            enabled,
        }
    }

    /// The ship page's dialog names every change, and a list that changes
    /// nothing (last_run aside) asks nothing.
    #[test]
    fn every_change_is_named() {
        let old = vec![s("a", "daily", "/b", true), s("b", "weekly", "/b", true), s("c", "old", "/b", true)];
        let mut same = old.clone();
        same[0].last_run = 99;
        assert!(schedule_changes(&old, &same).is_empty());
        let new = vec![
            s("a", "daily", "/elsewhere", true),
            s("b", "weekly", "/b", false),
            s("d", "new", "/n", true),
        ];
        let c = schedule_changes(&old, &new);
        assert_eq!(c.len(), 4, "{c:?}");
        assert!(c[0].starts_with("change daily") && c[0].contains("/elsewhere"));
        assert_eq!(c[1], "pause weekly");
        assert!(c[2].starts_with("add new") && c[2].contains("/n"));
        assert_eq!(c[3], "remove old (its archives stay)");
    }
}
