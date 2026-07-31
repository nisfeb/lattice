//! Connect flow: one +code entry logs in both sides — the Rust login stores
//! the shared fuse cookie, and open_workspace mirrors that cookie into the
//! webview's jar. One session, no second login. (The old cross-site
//! form-POST login died silently under webkitgtk's cookie policy.)

use lattice_fs::{default_cookie_path, EyreTransport, Transport};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::config;

/// Log the Rust side in (stores the shared fuse cookie), remember the url,
/// open the workspace.
#[tauri::command]
pub fn connect(app: AppHandle, url: String, code: String) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/').to_string();
    let t = EyreTransport::new(&url, &default_cookie_path());
    t.login(Some(code)).map_err(|e| e.msg)?;
    let ship = t.ship().map_err(|e| e.msg)?;
    let mut cfg = config::load(&app);
    cfg.url = url;
    config::save(&app, &cfg)?;
    open_workspace(&app)?;
    Ok(ship)
}

#[tauri::command]
pub fn get_config(app: AppHandle) -> config::Config {
    config::load(&app)
}

#[derive(serde::Serialize)]
pub struct PickedFile {
    /// slash-separated path relative to the pick, folder name included for
    /// folder picks — mirrors webkitRelativePath so the web upload path
    /// builds the same tree.
    pub rel: String,
    pub text: String,
}

/// Native upload picker for the ship-served workspace (webkit2gtk has no
/// webkitdirectory, so the web folder picker is dead on Linux). Picks files
/// or a folder, reads only extensions the UI supports, returns the text.
/// The page never sees a path or fs handle — one user-driven dialog per call.
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

pub fn open_workspace(app: &AppHandle) -> Result<(), String> {
    let cfg = config::load(app);
    if cfg.url.is_empty() {
        return Err("connect to a ship first".into());
    }
    let ship_page: tauri::Url = format!("{}/apps/lattice", cfg.url)
        .parse()
        .map_err(|e| format!("{e}"))?;
    let w = match app.get_webview_window("workspace") {
        Some(w) => w,
        None => new_workspace(app)?,
    };
    // mirror the fuse cookie into the webview's jar: one login covers both
    // sides, and no cross-site request is involved anywhere.
    if let Ok(line) = std::fs::read_to_string(default_cookie_path()) {
        if let Some((name, val)) = line.trim().split_once('=') {
            if let Some(host) = ship_page.host_str() {
                let mut c = tauri::webview::Cookie::new(name.to_string(), val.to_string());
                c.set_domain(host.to_string());
                c.set_path("/");
                c.set_http_only(true);
                c.set_secure(ship_page.scheme() == "https");
                w.set_cookie(c).map_err(|e| e.to_string())?;
            }
        }
    }
    w.navigate(ship_page).map_err(|e| e.to_string())?;
    w.set_focus().ok();
    Ok(())
}

fn new_workspace(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let handle = app.clone();
    WebviewWindowBuilder::new(app, "workspace", WebviewUrl::App("login.html".into()))
        .title("lattice — workspace")
        .inner_size(1200.0, 800.0)
        // tauri's own drag-drop interception would swallow the HTML5 drop
        // events the ship UI's drag-to-upload listens for
        .disable_drag_drop_handler()
        // a webview without browser chrome has no other way to zoom
        .zoom_hotkeys_enabled(true)
        // keep the workspace on the ship (or the shell's own pages); any
        // other top-level navigation opens in the system browser — the
        // webview has no back button or url bar to escape from
        .on_navigation(move |u| {
            // local shell pages: tauri:// (macOS) or http://tauri.localhost (Linux)
            if u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost") {
                return true;
            }
            let cfg = config::load(&handle);
            // urb:// names stay in the app — the ship's reader resolves them
            // (GET /apps/lattice?url=…), so navigate there instead
            if u.scheme() == "urb" {
                if let Ok(mut t) = tauri::Url::parse(&cfg.url) {
                    t.set_path("/apps/lattice");
                    t.query_pairs_mut().clear().append_pair("url", u.as_str());
                    let h = handle.clone();
                    // off-thread so the queued navigate never re-enters the
                    // policy callback we are currently inside
                    std::thread::spawn(move || {
                        let h2 = h.clone();
                        h.run_on_main_thread(move || {
                            if let Some(w) = h2.get_webview_window("workspace") {
                                w.navigate(t).ok();
                            }
                        })
                        .ok();
                    });
                }
                return false;
            }
            if tauri::Url::parse(&cfg.url).is_ok_and(|ship| ship.origin() == u.origin()) {
                return true;
            }
            use tauri_plugin_opener::OpenerExt;
            handle.opener().open_url(u.as_str(), None::<&str>).ok();
            false
        })
        .build()
        .map_err(|e| e.to_string())
}
