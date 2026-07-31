//! Connect flow: one +code entry logs in both sides — the Rust login stores
//! the shared fuse cookie, and open_workspace drives the webview through the
//! ship's own /~/login form so eyre sets its session cookie first-party.

use lattice_fs::{default_cookie_path, EyreTransport, Transport};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::config;

/// stderr diagnostics, on when LATTICE_LOG is set — costs nothing otherwise
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
    open_workspace(&app, Some(&code))?;
    // connected: the workspace is the app now; the manager comes back when
    // the workspace closes (on_window_event in main.rs)
    if let Some(m) = app.get_webview_window("manager") {
        m.hide().ok();
    }
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

/// Open (or reuse) the workspace and log its webview in. With a +code, the
/// webview is driven through the ship's OWN /~/login page: navigate there,
/// fill the form via eval, submit. Eyre then sets the session cookie
/// first-party in the jar the network session actually uses — the only
/// arrangement webkit reliably honors. (Injecting the fuse cookie via
/// set_cookie looked right in cookies_for_url but was never attached to
/// real-domain requests; localhost ships masked it in every dev test.)
/// Without a code (relaunch), navigate straight to /~/login with a redirect:
/// a live jar session passes through instantly, a dead one shows eyre's own
/// login form, and the manager's connect flow remains the recovery path.
pub fn open_workspace(app: &AppHandle, code: Option<&str>) -> Result<(), String> {
    let cfg = config::load(app);
    if cfg.url.is_empty() {
        return Err("connect to a ship first".into());
    }
    let login: tauri::Url = format!("{}/~/login?redirect=/apps/lattice", cfg.url)
        .parse()
        .map_err(|e| format!("{e}"))?;
    let w = match app.get_webview_window("workspace") {
        Some(w) => w,
        None => new_workspace(app)?,
    };
    if code.is_some() {
        // fresh connect = clean slate: a service worker or cache installed
        // during a broken or unauthenticated session otherwise keeps serving
        // stale responses and makes every later fix look like "no change"
        dlog(&format!("clear browsing data: {:?}", w.clear_all_browsing_data()));
    }
    dlog(&format!("navigate: {login}"));
    w.navigate(login).map_err(|e| e.to_string())?;
    if let Some(code) = code {
        // +codes are [a-z-] only; anything else never left the Rust login alive
        if !code.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
            return Err("malformed +code".into());
        }
        // the page needs time to load and eval is fire-and-forget, so retry
        // the fill; the __lat guard makes it submit once, and after the
        // redirect there is no password field left to match.
        let fill = format!(
            "(function(){{var p=document.querySelector('input[type=password],input[name=password]');\
             if(p&&p.form&&!window.__lat){{window.__lat=1;p.value='{code}';p.form.submit();}}}})()"
        );
        for i in 0..10 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            dlog(&format!("login fill attempt {i}"));
            w.eval(&fill).ok();
        }
        // diagnostic only: whether eyre's cookie made it into the jar this
        // webview reports — the load-bearing question on machines where
        // non-public pages still 403 after login
        if let Ok(base) = cfg.url.parse::<tauri::Url>() {
            let names = w
                .cookies_for_url(base)
                .map(|cs| cs.iter().map(|c| c.name().to_string()).collect::<Vec<_>>());
            dlog(&format!("post-login jar: {names:?}"));
        }
    }
    w.set_focus().ok();
    Ok(())
}

fn new_workspace(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let handle = app.clone();
    let w = WebviewWindowBuilder::new(app, "workspace", WebviewUrl::App("login.html".into()))
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
        .map_err(|e| e.to_string())?;
    Ok(w)
}
