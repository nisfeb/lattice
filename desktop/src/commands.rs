//! Connect flow: one +code entry logs in both sides. The Rust login stores
//! the shared fuse cookie, and open_workspace drives the webview through the
//! ship's own /~/login form so eyre sets its session cookie first-party.

use lattice_fs::{default_cookie_path, EyreTransport, Transport};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::config;

/// stderr diagnostics, on when LATTICE_LOG is set. Costs nothing otherwise
/// and makes "it 403s on my machine" debuggable from a pasted terminal log.
pub fn dlog(msg: &str) {
    if std::env::var_os("LATTICE_LOG").is_some() {
        eprintln!("lattice: {msg}");
    }
}

/// Log the Rust side in (stores the shared fuse cookie), remember the url,
/// open the workspace, get the manager out of the way. Async: the blocking
/// login and the cookie-settle poll in open_workspace must run off the main
/// thread (a main-thread wait would deadlock the webview's async cookie add).
#[tauri::command]
pub async fn connect(app: AppHandle, url: String, code: String) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/').to_string();
    let t = EyreTransport::new(&url, &default_cookie_path());
    dlog(&format!("connect: logging in at {url}"));
    t.login(Some(code.clone())).map_err(|e| e.msg)?;
    dlog(&format!("connect: cookie stored at {}", default_cookie_path()));
    let ship = t.ship().map_err(|e| e.msg)?;
    dlog(&format!("connect: ship {ship}"));
    let mut cfg = config::load(&app);
    cfg.url = url;
    config::save(&app, &cfg)?;
    open_workspace(&app, true)?;
    Ok(ship)
}

/// manager page's "open lattice" button, back to the ship UI.
#[tauri::command]
pub fn go_home(app: AppHandle) -> Result<(), String> {
    open_workspace(&app, false)
}

/// Show the connection & mounts page IN the workspace window (single-window
/// app: the manager is a page, not a second window). Local shell pages live
/// at tauri://localhost on macOS but http://tauri.localhost on Linux.
pub fn show_manager(app: &AppHandle) -> Result<(), String> {
    let (w, created) = ensure_workspace(app)?;
    if !created {
        let url: tauri::Url = "tauri://localhost/manager.html"
            .parse()
            .map_err(|e| format!("{e}"))?;
        w.navigate(url).map_err(|e| e.to_string())?;
    }
    w.set_focus().ok();
    Ok(())
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

#[tauri::command]
pub fn get_config(app: AppHandle) -> config::Config {
    config::load(&app)
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
            let t = EyreTransport::new(&cfg.url, &default_cookie_path());
            let ship = t.ship().ok();
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

/// Native upload picker for the ship-served workspace (webkit2gtk has no
/// webkitdirectory, so the web folder picker is dead on Linux). Picks files
/// or a folder, reads only extensions the UI supports, returns the text.
/// The page never sees a path or fs handle. One user-driven dialog per call.
/// Async so the blocking dialog runs off the main thread.
#[tauri::command]
pub async fn pick_upload(app: AppHandle, dir: bool, exts: Vec<String>) -> Vec<PickedFile> {
    use tauri_plugin_dialog::DialogExt;
    let mut out = Vec::new();
    if dir {
        if let Some(folder) = app.dialog().file().blocking_pick_folder() {
            if let Ok(root) = folder.into_path() {
                let base = root
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                walk(&root, &base, &exts, &mut out);
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
                        push_file(&p, name, &mut out);
                    }
                }
            }
        }
    }
    out
}

fn walk(dir: &std::path::Path, rel: &str, exts: &[String], out: &mut Vec<PickedFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        // no symlink following: a looped link must not hang the walk
        let Ok(ft) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if ft.is_dir() {
            walk(&e.path(), &child, exts, out);
        } else if ft.is_file() {
            let ok = name
                .rsplit_once('.')
                .is_some_and(|(_, x)| exts.iter().any(|e| e.eq_ignore_ascii_case(x)));
            if ok {
                push_file(&e.path(), child, out);
            }
        }
    }
}

fn push_file(path: &std::path::Path, rel: String, out: &mut Vec<PickedFile>) {
    // non-UTF-8 (binary) files are skipped, same as the web KMAP filter
    if let Ok(text) = std::fs::read_to_string(path) {
        out.push(PickedFile { rel, text });
    }
}

/// Open (or reuse) the workspace on the localhost bridge. The webview only
/// ever talks to 127.0.0.1. The bridge relays to the ship with the fuse
/// session cookie attached Rust-side, so no webkit cookie behavior (site
/// pinning, third-party policy, SW-mediated fetch) can ever unauthenticate
/// a view again. `fresh` (a new connect) also clears browsing data so stale
/// service workers and caches from earlier sessions cannot linger.
pub fn open_workspace(app: &AppHandle, fresh: bool) -> Result<(), String> {
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
    dlog(&format!("navigate: {home}"));
    w.navigate(home).map_err(|e| e.to_string())?;
    w.set_focus().ok();
    Ok(())
}

fn new_workspace(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let handle = app.clone();
    let w = WebviewWindowBuilder::new(app, "workspace", WebviewUrl::App("manager.html".into()))
        .title("lattice — workspace")
        .inner_size(1200.0, 800.0)
        // tauri's own drag-drop interception would swallow the HTML5 drop
        // events the ship UI's drag-to-upload listens for
        .disable_drag_drop_handler()
        // a webview without browser chrome has no other way to zoom
        .zoom_hotkeys_enabled(true)
        // keep the workspace on the bridge (or the shell's own pages). Any
        // other top-level navigation opens in the system browser. The
        // webview has no back button or url bar to escape from
        .on_navigation(move |u| {
            // local shell pages: tauri:// (macOS) or http://tauri.localhost (Linux)
            if u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost") {
                return true;
            }
            // in-page pseudo-navigations (the preview iframe is srcdoc-based,
            // and some webkits run every frame through this policy hook).
            // Never route these to the system opener. That popups "Could not
            // read file about:src:doc."
            if matches!(u.scheme(), "about" | "blob" | "data") {
                return true;
            }
            let bridge = handle
                .state::<crate::proxy::Bridge>()
                .inner()
                .0
                .lock()
                .unwrap()
                .as_ref()
                .map(|(_, p)| *p);
            if u.host_str() == Some("127.0.0.1") && u.port() == bridge {
                return true;
            }
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
            let local = bridge.map(|p| format!("http://127.0.0.1:{p}"));
            // urb:// names stay in the app. The ship's reader resolves them
            if let (Some(local), "urb") = (&local, u.scheme()) {
                if let Ok(mut t) = format!("{local}/apps/lattice").parse::<tauri::Url>() {
                    t.query_pairs_mut().clear().append_pair("url", u.as_str());
                    renav(t);
                }
                return false;
            }
            // absolute links to the ship's real origin re-route through the
            // bridge. Hitting the ship directly would arrive cookieless
            let cfg = config::load(&handle);
            if tauri::Url::parse(&cfg.url).is_ok_and(|ship| ship.origin() == u.origin()) {
                if let Some(local) = &local {
                    let pq = &u.as_str()[u.origin().ascii_serialization().len()..];
                    if let Ok(t) = format!("{local}{pq}").parse::<tauri::Url>() {
                        renav(t);
                    }
                }
                return false;
            }
            // only things a system handler can sensibly open leave the app.
            // Anything else is silently blocked (an opener error is a popup)
            if matches!(u.scheme(), "http" | "https" | "mailto" | "tel") {
                use tauri_plugin_opener::OpenerExt;
                handle.opener().open_url(u.as_str(), None::<&str>).ok();
            }
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(w)
}
