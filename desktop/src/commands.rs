//! Connect flow: one +code entry logs in both sides — the Rust login stores
//! the shared fuse cookie, and login.html re-posts the code to eyre so the
//! webview gets its own session cookie.

use std::sync::Mutex;

use lattice_fs::{default_cookie_path, EyreTransport, Transport};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::config;

/// (url, code) waiting for login.html to collect it. Held in memory only,
/// taken exactly once.
pub struct PendingLogin(pub Mutex<Option<(String, String)>>);

/// Log the Rust side in (stores the shared fuse cookie), remember the url,
/// stash the code for the webview's own form-POST login, open the workspace.
#[tauri::command]
pub fn connect(
    app: AppHandle,
    pending: State<PendingLogin>,
    url: String,
    code: String,
) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/').to_string();
    let t = EyreTransport::new(&url, &default_cookie_path());
    t.login(Some(code.clone())).map_err(|e| e.msg)?;
    let ship = t.ship().map_err(|e| e.msg)?;
    let mut cfg = config::load(&app);
    cfg.url = url.clone();
    config::save(&app, &cfg)?;
    *pending.0.lock().unwrap() = Some((url, code));
    open_workspace(&app)?;
    Ok(ship)
}

/// login.html pulls the pending (url, code) — once.
#[tauri::command]
pub fn take_login(pending: State<PendingLogin>) -> Option<(String, String)> {
    pending.0.lock().unwrap().take()
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
    if let Some(w) = app.get_webview_window("workspace") {
        // an already-open workspace may hold a stale session — reload through
        // login.html so a pending (url, code) gets used
        w.navigate("tauri://localhost/login.html".parse().map_err(|e| format!("{e}"))?)
            .map_err(|e| e.to_string())?;
        w.set_focus().ok();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "workspace", WebviewUrl::App("login.html".into()))
        .title("lattice — workspace")
        .inner_size(1200.0, 800.0)
        // tauri's own drag-drop interception would swallow the HTML5 drop
        // events the ship UI's drag-to-upload listens for
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
