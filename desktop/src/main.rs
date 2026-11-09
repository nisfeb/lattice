#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
#[cfg(feature = "urb-engine")]
mod boards;
mod commands;
mod config;
#[cfg(feature = "urb-engine")]
mod cometid;
#[cfg(feature = "urb-engine")]
mod engine;
#[cfg(feature = "urb-engine")]
mod follows;
#[cfg(feature = "urb-engine")]
mod history;
#[cfg(feature = "urb-engine")]
mod reader;
#[cfg(feature = "urb-engine")]
mod render;
mod install;
mod keys;
mod local;
mod mounts;
mod notify;
mod pandoc;
mod pdf;
mod proxy;
mod queue;
mod session;
mod stack;
mod store;
mod update;
mod urb;
#[cfg(test)]
mod testutil;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::Manager;

/// Restore saved mounts. Each one carries how it is reached (a lick socket, or
/// HTTP against the configured ship), so a local-pier mount survives a restart
/// with no session in play. A failure is reported and skipped. One dead pier
/// must not cost the other mounts.
///
/// The lock is taken PER MOUNT, never across the loop. Healing and spawning
/// both touch the filesystem and the network, and holding the map across them
/// meant every mount-related command from the webview queued behind the
/// slowest one. With a wedged mount that was forever, so the window came up
/// blank: the UI was not broken, it was waiting.
fn remount(handle: &tauri::AppHandle, cfg: &config::Config) {
    for spec in &cfg.mounts {
        mounts::heal_mountpoint(&spec.mountpoint);
        match mounts::projection_for(handle, &spec.root, &spec.sock, &spec.ship)
            .and_then(|p| {
                lattice_fs::spawn(p.clone(), &spec.mountpoint)
                    .map(|s| (p, s))
                    .map_err(|e| e.to_string())
            }) {
            Ok((proj, session)) => {
                let map = handle.state::<mounts::MountMap>();
                let mut m = map.0.lock().unwrap();
                m.insert(
                    spec.mountpoint.clone(),
                    mounts::Mount { root: spec.root.clone(), proj, session },
                );
            }
            Err(e) => eprintln!("remount {} failed: {e}", spec.mountpoint),
        }
    }
}

/// No menubar. Its commands live in the ship UI (the sidebar's buttons, the
/// palette, Settings) and its shortcuts in keys.rs.
///
/// macOS keeps a menu anyway, and it shows nothing a Mac does not always
/// show. A WKWebView only receives Cmd-C/V/X/A and undo through the
/// standard Edit items, which the OS routes to the focused responder, so
/// they need no handler; without them nobody could paste a +code on a
/// Mac. The leading submenu is the application menu, which holds Quit and
/// the shell's own shortcuts (keys.rs has no GTK window to listen on
/// there). Linux sets no menu at all, so there is no bar to draw.
#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let item = |id: &str, label: &str, key: &str| MenuItemBuilder::with_id(id, label).accelerator(key).build(app);
    let mut lattice = SubmenuBuilder::new(app, "lattice")
        .item(&item("reload", "Reload", "Cmd+Shift+R")?)
        .item(&item("zoom-in", "Zoom in", "Cmd+=")?)
        .item(&item("zoom-out", "Zoom out", "Cmd+-")?)
        .item(&item("zoom-reset", "Actual size", "Cmd+0")?);
    if cfg!(debug_assertions) {
        lattice = lattice.item(&item("devtools", "Inspector", "Cmd+Alt+I")?);
    }
    let lattice = lattice.separator().hide().hide_others().separator().quit().build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    app.set_menu(MenuBuilder::new(app).items(&[&lattice, &edit]).build()?)?;
    Ok(())
}

/// The backup tick. One minute is far finer than any period anyone
/// will set, and the work in a tick with nothing due is reading a
/// small json file, so the cost of checking often is nothing and it
/// means a schedule fires close to when it came due rather than up
/// to an hour late.
///
/// This also covers the app having been CLOSED: a schedule overdue
/// at launch is due on the first tick, so a laptop shut for a week
/// backs up when it comes back rather than skipping the period.
/// Nothing fires while the app is not running at all — that wants a
/// systemd timer driving the CLI, not a GUI that has to be open.
fn spawn_backup_scheduler(h: tauri::AppHandle) {
    std::thread::spawn(move || {
        // let the workspace finish booting before asking it to
        // export: a request into a half-loaded page is a no-op and
        // would burn the catch-up run
        std::thread::sleep(std::time::Duration::from_secs(45));
        loop {
            let cfg = config::load(&h);
            let now = backup::now();
            for s in cfg.backups.iter().filter(|s| backup::is_due(s, now)) {
                // Fire ONE per tick. Several schedules coming due
                // together (a fresh config, or a laptop opened
                // after a fortnight) would otherwise build several
                // whole-store archives at once, on a pier that
                // serialises, while someone is trying to type.
                commands::dlog(&format!("backup: {} is due", s.label));
                // no takeover: a scheduled run must not navigate the window
                // out from under whatever the user is doing, so it waits for
                // the app page instead
                if commands::request_backup(&h, &s.id, false) {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    });
}

/// Does this desktop prefer dark? The same signals WebKitGTK reads for
/// prefers-color-scheme, most authoritative first: the desktop portal's
/// color-scheme (1 = prefer dark), then gsettings' color-scheme, then a
/// gtk theme name containing "dark", then gtk-3.0/settings.ini. Shells out
/// rather than pulling in a dbus crate; every probe is optional and a
/// missing tool just means "no opinion".
#[cfg(target_os = "linux")]
fn prefers_dark() -> bool {
    let out = |cmd: &str, args: &[&str]| -> Option<String> {
        std::process::Command::new(cmd)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    // busctl prints "v v u 1"; gdbus prints "(<<uint32 1>>,)"
    if let Some(s) = out("busctl", &["--user", "call", "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Settings", "Read", "ss",
        "org.freedesktop.appearance", "color-scheme"])
    {
        if let Some(last) = s.split_whitespace().last() { return last == "1"; }
    }
    if let Some(s) = out("gdbus", &["call", "--session", "--dest", "org.freedesktop.portal.Desktop",
        "--object-path", "/org/freedesktop/portal/desktop", "--method",
        "org.freedesktop.portal.Settings.Read", "org.freedesktop.appearance", "color-scheme"])
    {
        return s.contains("uint32 1");
    }
    if let Some(s) = out("gsettings", &["get", "org.gnome.desktop.interface", "color-scheme"]) {
        if s.contains("prefer-dark") { return true; }
        if s.contains("prefer-light") { return false; }
    }
    if let Some(s) = out("gsettings", &["get", "org.gnome.desktop.interface", "gtk-theme"]) {
        if s.to_lowercase().contains("dark") { return true; }
    }
    let ini = std::env::var("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))
        .map(|c| c.join("gtk-3.0").join("settings.ini"));
    if let Ok(p) = ini {
        if let Ok(s) = std::fs::read_to_string(p) {
            if s.lines().any(|l| l.trim().replace(' ', "") == "gtk-application-prefer-dark-theme=true") {
                return true;
            }
        }
    }
    false
}

/// urb:// links from the OS (urb.rs). One that started this process is
/// already in get_current; later ones, forwarded from a second launch or
/// opened on macOS, come through on_open_url. Both go into the inbox before
/// any window exists, so a cold start opens its link once the ship page is up.
///
/// An AppImage has no installer to tell the desktop it handles urb://, and it
/// can move, so it registers itself on each launch. The .deb and the macOS
/// bundle declare the scheme at install time (tauri.conf.json), and a dev
/// build leaves the user's real handler alone.
fn listen_for_urb(handle: &tauri::AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;
    let dl = handle.deep_link();
    let h = handle.clone();
    dl.on_open_url(move |ev| {
        let urls = ev.urls();
        urb::arrive(&h, urls.iter().map(|u| u.as_str()));
    });
    if let Ok(Some(urls)) = dl.get_current() {
        urb::arrive(handle, urls.iter().map(|u| u.as_str()));
    }
    #[cfg(target_os = "linux")]
    if handle.env().appimage.is_some() {
        if let Err(e) = dl.register_all() {
            eprintln!("urb:// handler registration failed: {e}");
        }
    }
}

/// The shipless reader's listener, idle until it is opened (reader.rs).
#[cfg(feature = "urb-engine")]
fn reader_state() -> reader::Reader {
    reader::Reader(Mutex::new(None))
}
/// A build with no engine has no reader to keep.
#[cfg(not(feature = "urb-engine"))]
struct NoReader;
#[cfg(not(feature = "urb-engine"))]
fn reader_state() -> NoReader {
    NoReader
}

/// tauri.conf.json's identifier, which the single-instance name is built on
/// before the config is loaded (a test in urb.rs keeps the two equal).
const IDENTIFIER: &str = "org.lattice.desktop";

fn main() {
    // webkit2gtk's dmabuf renderer crashes some Wayland stacks outright
    // ("Error 71 (Protocol error) dispatching to Wayland display"). Opt out
    // there, but ONLY there. The fallback is software rendering, and paying
    // it on X11/XWayland sessions made the whole UI feel sluggish for nothing.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("GDK_BACKEND").is_none_or(|b| b != "x11")
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    // The AppImage launcher (linuxdeploy-plugin-gtk) exports
    // GTK_THEME="Adwaita:<variant>", and picks the variant by grepping the
    // word "dark" in gsettings' gtk-theme NAME. Modern desktops signal dark
    // through the separate color-scheme setting with the theme still called
    // "Adwaita", so the launcher forces LIGHT Adwaita, and a forced
    // GTK_THEME makes GTK ignore the prefer-dark switch that set_theme flips
    // later. WebKit's content follows the portal instead: a dark page under
    // a white menubar. Correct the variant here, before GTK initialises,
    // from the same signals WebKit reads. Only when the launcher's Adwaita
    // is what is set; a theme the user chose is left alone.
    #[cfg(target_os = "linux")]
    if let Ok(t) = std::env::var("GTK_THEME") {
        if (t == "Adwaita" || t == "Adwaita:" || t == "Adwaita:light") && prefers_dark() {
            std::env::set_var("GTK_THEME", "Adwaita:dark");
            commands::dlog("gtk theme: launcher forced Adwaita light, system prefers dark, using Adwaita:dark");
        }
    }
    tauri::Builder::default()
        // FIRST, as the plugin asks: a second launch must hand over its
        // arguments and exit before anything else in it starts. An urb://
        // link another app opens arrives that way when lattice is already
        // running. With the deep-link feature the plugin passes the link on
        // to deep-link's on_open_url (setup, below), so all this callback
        // has to do for a plain second launch is bring the window forward.
        //
        // One instance per config dir, not per user (urb::instance_id): a
        // copy started with its own XDG_CONFIG_HOME for another ship still
        // gets a window of its own.
        .plugin(
            tauri_plugin_single_instance::Builder::new()
                .callback(|app, _argv, _cwd| {
                    if let Some(w) = app.get_webview_window("workspace") {
                        w.unminimize().ok();
                        w.show().ok();
                        w.set_focus().ok();
                    }
                })
                .dbus_id(urb::instance_id(
                    IDENTIFIER,
                    std::env::var_os("XDG_CONFIG_HOME").as_deref(),
                    std::env::var_os("HOME").as_deref(),
                ))
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(mounts::MountMap(Mutex::new(HashMap::new())))
        .manage(proxy::Bridge(Mutex::new(None)))
        .manage(urb::Inbox(Mutex::new(Vec::new())))
        .manage(reader_state())
        .on_menu_event(|app, ev| keys::run(app, ev.id().as_ref()))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            build_menu(app)?;
            let handle = app.handle().clone();
            // One copy per data dir. The single-instance plugin is keyed on
            // the config dir, so a copy started with its own config dir still
            // shares this one: follows, my posts and the queue. It says so and
            // exits before it opens any of them (store.rs).
            let data = handle.path().app_data_dir()?;
            match store::lock_dir(&data) {
                Ok(held) => {
                    app.manage(held);
                }
                Err(msg) => {
                    eprintln!("lattice: {msg}");
                    commands::dlog(&format!("startup: {msg}; exiting"));
                    let h = handle.clone();
                    std::thread::spawn(move || {
                        use tauri_plugin_dialog::DialogExt;
                        h.dialog().message(format!("{msg}.\n\nClose it first, then start lattice again.")).title("lattice is already running").blocking_show();
                        h.exit(1);
                    });
                    return Ok(());
                }
            }
            // the urb engine (engine.rs)
            #[cfg(feature = "urb-engine")]
            app.manage(engine::Engine::new(handle.path().app_data_dir()?.join("urb")));
            listen_for_urb(&handle);
            let cfg = config::load(&handle);
            // with no ship, the reader gets ready (and reads the start list)
            // while the first-run page is up, reusing an identity an earlier
            // launch made; with a ship, no network for it, and an identity
            // nobody used is let go
            #[cfg(feature = "urb-engine")]
            {
                let e = app.state::<engine::Engine>();
                if cfg.url.is_empty() {
                    e.prewarm(Some(render::START_URL));
                } else {
                    e.drop_unclaimed();
                }
            }
            // before anything reads a session: older builds kept it in the
            // shared lattice-fs cookie file
            session::migrate_legacy(&cfg);
            if cfg.url.is_empty() {
                // first run: the single window opens on the connect page
                commands::show_manager(&handle, None)?;
            } else {
                // off-thread: bridge setup does network work that must not
                // block the main loop
                let h = handle.clone();
                std::thread::spawn(move || {
                    commands::open_workspace(&h, false, None).ok();
                });
            }
            spawn_backup_scheduler(handle.clone());
            update::spawn(handle.clone());
            // remount OUTSIDE the url check. A lick mount is a local pier and
            // needs no configured ship at all, so it must come back on launch
            // even when nothing is connected over HTTP.
            //
            // OFF the setup thread. Restoring a mount talks to a ship, and
            // doing that here meant a ship that never answered held up setup
            // itself: no window, and a process parked in the kernel that
            // SIGKILL could not touch. The window must not depend on a mount.
            let rh = handle.clone();
            let rcfg = cfg.clone();
            std::thread::spawn(move || {
                remount(&rh, &rcfg);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::connection_status,
            commands::go_home,
            commands::open_manager,
            commands::set_theme,
            commands::pick_upload,
            commands::open_external_url,
            commands::notify_share,
            commands::save_vault,
            commands::pick_vault,
            commands::backup_schedules,
            commands::set_backup_schedules,
            commands::pick_backup_dir,
            commands::backup_write,
            commands::run_backup_now,
            commands::verify_backup,
            pandoc::pandoc_probe,
            pandoc::convert_tex,
            pdf::export_pdf,
            queue::queue_list,
            queue::queue_get,
            queue::queue_put,
            queue::queue_del,
            queue::queue_ops,
            queue::queue_op_put,
            queue::queue_op_del,
            mounts::status,
            mounts::add_mount,
            mounts::remove_mount,
            mounts::list_mounts,
            local::local_ships,
            stack::stack_status,
            install::install_grubbery,
            urb::take_urb_links,
            commands::open_reader,
            commands::reader_status,
            commands::clear_reader_history,
            commands::export_reader_identity,
            commands::import_reader_identity,
        ])
        .build(tauri::generate_context!())
        .expect("error building lattice desktop")
        .run(|app, event| {
            // the manager rebuild destroys the only window and makes a new
            // one; the gap must not read as "last window closed"
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event {
                if commands::REBUILDING.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
            if let tauri::RunEvent::Exit = event {
                // Quiesce every lick socket, THEN drop every BackgroundSession
                // for a clean unmount before the process dies (drops of managed
                // state are not otherwise run). Quiescing first is what keeps a
                // mid-flight reply from becoming the broken pipe that crashes
                // the ship on an update-restart. Bounded so exit cannot hang.
                mounts::quiesce_and_clear(app.state::<mounts::MountMap>().inner());
                // libmesa's last save, if the engine ever ran. An
                // unclaimed reader identity is kept for the next launch
                #[cfg(feature = "urb-engine")]
                if let Some(e) = app.try_state::<engine::Engine>() {
                    e.close();
                }
            }
        });
}
