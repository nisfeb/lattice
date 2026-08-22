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
    //  a ship SWITCH must not inherit the previous ship's queue directory —
    //  its queued edits would replay into the new ship
    cfg.queue_key = crate::queue::key_after_connect(&cfg, &ship);
    cfg.url = url;
    //  remember the @p: the offline queue prefers it as its directory key, and
    //  it has to be known BEFORE the ship stops answering, which is exactly
    //  when the queue starts mattering
    cfg.ship = ship.clone();
    config::save(&app, &cfg)?;
    open_workspace(&app, true)?;
    Ok(ship)
}

/// manager page's "close" button (and Escape), back to the ship UI.
#[tauri::command]
pub fn go_home(app: AppHandle) -> Result<(), String> {
    open_workspace(&app, false)
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
    if !created || section.is_some() {
        let frag = section.map(|s| format!("#{s}")).unwrap_or_default();
        let url: tauri::Url = format!("tauri://localhost/manager.html{frag}")
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
}

/// The whole navigation policy, with no AppHandle and no window in it, so the
/// six branches read as one table instead of as plumbing.
///
/// `bridge` yields the live bridge port and `ship_url` the configured ship
/// base, both looked up only if the decision gets far enough to need them.
/// Laziness is the point: the preview iframe is srcdoc-based and some webkits
/// run every frame through this hook, so neither a mutex nor a config read
/// belongs on the path that answers those.
fn nav_decision(
    u: &tauri::Url,
    bridge: impl FnOnce() -> Option<u16>,
    ship_url: impl FnOnce() -> String,
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

fn new_workspace(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let handle = app.clone();
    // LATTICE_PROBE_JS=<path>: inject that file into the workspace page.
    //
    // The desktop-only paths are the ones that keep breaking in ways nothing
    // catches — the File menu's hiding, the capability grants, the backup
    // chain — because a browser test cannot reach any of them: no menubar, no
    // invoke, no bridge. scripts/desktop-matrix.sh drives the REAL binary and
    // needs a way to ask the page what it sees. Injecting from a file beats
    // editing the ship's app.js, which is what the throwaway versions of this
    // did and which meant the harness could not run against a ship it did not
    // own.
    //
    // Test-only and inert unless the variable is set. Setting it requires
    // already controlling this process's environment, the same bar as
    // LATTICE_AUTOCONNECT, which takes a +code.
    let probe = std::env::var("LATTICE_PROBE_JS")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok());
    let mut b = WebviewWindowBuilder::new(app, "workspace", WebviewUrl::App("manager.html".into()))
        .title("lattice — workspace")
        .inner_size(1200.0, 800.0);
    if let Some(js) = probe {
        dlog("probe script injected into the workspace");
        b = b.initialization_script(js);
    }
    let w = b
        // Tell the page this build HAS the File menu, so it can hide the
        // buttons that moved into it.
        //
        // __TAURI__ alone would be the wrong test: it answers "is this the
        // desktop", not "does this desktop have the menu". The UI is served by
        // the ship and the menu lives in this binary, so the two update
        // independently — a ship that has the new UI reaching an older build
        // would hide the buttons with no menubar to replace them, and new
        // page, new folder, upload and save would all be unreachable. Keying
        // on a flag only this build sets makes the order not matter.
        .initialization_script("window.__LATTICE_FILE_MENU__ = true;")
        // tauri's own drag-drop interception would swallow the HTML5 drop
        // events the ship UI's drag-to-upload listens for
        .disable_drag_drop_handler()
        // a webview without browser chrome has no other way to zoom
        .zoom_hotkeys_enabled(true)
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
            match nav_decision(u, bridge, || config::load(&handle).url) {
                Nav::Allow => true,
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
    std::fs::write(&path, &bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
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
#[tauri::command]
pub fn set_backup_schedules(
    app: AppHandle,
    schedules: Vec<crate::config::BackupSchedule>,
) -> Result<(), String> {
    let mut cfg = config::load(&app);
    let mut next = schedules;
    for s in next.iter_mut() {
        if let Some(old) = cfg.backups.iter().find(|o| o.id == s.id) {
            s.last_run = old.last_run;
        }
    }
    cfg.backups = next;
    config::save(&app, &cfg)
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
/// Async, like save_vault: the decode and the disk write handle whole
/// multi-MB archives, and holding the main thread for that freezes the UI.
#[tauri::command]
pub async fn backup_write(app: AppHandle, id: String, b64: String) -> Result<String, String> {
    let bytes = decode_archive(&b64)?;
    let mut cfg = config::load(&app);
    let at = crate::backup::now();
    let s = schedule(&cfg, &id)?.clone();
    let path = crate::backup::write_archive(&s, &bytes, at)?;
    if let Some(slot) = cfg.backups.iter_mut().find(|s| s.id == id) {
        slot.last_run = at;
    }
    config::save(&app, &cfg)?;
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
        let on_shell = w
            .url()
            .map(|u| u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost"))
            .unwrap_or(false);
        if on_shell {
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
mod tests {
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
        walk(&root, "notes", &exts, &mut out);
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
        push_file(&root.join("a.md"), "a.md".to_string(), &mut one);
        assert_eq!(one.len(), 1);
        assert_eq!((one[0].rel.as_str(), one[0].text.as_str()), ("a.md", "alpha"));

        std::fs::remove_dir_all(&base).ok();
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
