//! Connect flow: one +code entry logs in both sides — the Rust login stores
//! the shared fuse cookie, and login.html re-posts the code to eyre so the
//! webview gets its own session cookie.

use std::sync::Mutex;

use lattice_fs::{default_cookie_path, EyreTransport};
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
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
