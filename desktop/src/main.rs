#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod install;
mod local;
mod mounts;
mod proxy;
mod queue;
mod stack;
#[cfg(test)]
mod testutil;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::Manager;

/// Restore saved mounts. Each one carries how it is reached (a lick socket, or
/// HTTP against the configured ship), so a local-pier mount survives a restart
/// with no session in play. A failure is reported and skipped. One dead pier
/// must not cost the other mounts.
/// Bring saved mounts back after a restart.
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
            .and_then(|p| lattice_fs::spawn(p, &spec.mountpoint).map_err(|e| e.to_string()))
        {
            Ok(s) => {
                let map = handle.state::<mounts::MountMap>();
                let mut m = map.0.lock().unwrap();
                m.insert(spec.mountpoint.clone(), (spec.root.clone(), s));
            }
            Err(e) => eprintln!("remount {} failed: {e}", spec.mountpoint),
        }
    }
}

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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(mounts::MountMap(Mutex::new(HashMap::new())))
        .manage(proxy::Bridge(Mutex::new(None)))
        .on_menu_event(|app, ev| {
            // single-window app: the manager is a page in the workspace
            if ev.id().as_ref() == "manager" {
                commands::show_manager(app).ok();
                return;
            }
            // The File menu drives the ship UI's OWN buttons instead of
            // reimplementing them here. The workspace webview is the lattice
            // page itself (the window navigates to the bridge, it does not
            // frame it), so a click on the real element runs the real handler
            // — one code path, and the upload picker, template dialog and
            // dirty-state logic keep working with no Rust counterpart to drift.
            let btn = match ev.id().as_ref() {
                "file-new" => "newfile",
                "file-new-folder" => "newfolder",
                "file-new-template" => "newtmpl",
                "file-upload-files" => "upfiles",
                "file-upload-folder" => "updir",
                "file-save" => "save",
                _ => return,
            };
            if let Some(w) = app.get_webview_window("workspace") {
                // The buttons are HIDDEN on desktop, not removed, precisely so
                // this keeps working. A missing element is a no-op rather than
                // an error: the menu exists before the page has finished
                // booting, and early clicks must not throw into the webview.
                let _ = w.eval(format!(
                    "(function(){{var b=document.getElementById('{btn}');if(b)b.click();}})()"
                ));
            }
        })
        .setup(|app| {
            // one menu, one item: mounts lived in an unreachable window once
            // the manager auto-hid after connect
            let sub = tauri::menu::SubmenuBuilder::new(app, "lattice")
                .text("manager", "connection && mounts…")
                .build()?;
            // A real File menu. These commands were sidebar buttons, which is
            // web convention, not desktop convention — in a window with a
            // menubar the first place anyone looks for "new file" is File.
            //
            // Accelerators only where the page does not already own the key.
            // ctrl-S is bound in the editor (45-templates.js), and registering
            // it natively as well risks one keypress driving both paths and
            // writing twice, so Save is menu-only here and the existing
            // shortcut keeps working exactly as it did.
            let file = tauri::menu::SubmenuBuilder::new(app, "File")
                .item(
                    &tauri::menu::MenuItemBuilder::with_id("file-new", "New page")
                        .accelerator("CmdOrCtrl+N")
                        .build(app)?,
                )
                .item(
                    &tauri::menu::MenuItemBuilder::with_id("file-new-folder", "New folder")
                        .accelerator("CmdOrCtrl+Shift+N")
                        .build(app)?,
                )
                .text("file-new-template", "New from template…")
                .separator()
                .text("file-upload-files", "Upload files…")
                .text("file-upload-folder", "Upload folder…")
                .separator()
                .text("file-save", "Save")
                .build()?;
            // "lattice" stays FIRST: on macOS the leading submenu becomes the
            // application menu, and putting File there would bury it.
            app.set_menu(tauri::menu::MenuBuilder::new(app).items(&[&sub, &file]).build()?)?;
            let handle = app.handle().clone();
            // LATTICE_AUTOCONNECT="url,+code": drive the real connect flow
            // without a display, the headless test harness's entry point.
            if let Ok(spec) = std::env::var("LATTICE_AUTOCONNECT") {
                if let Some((u, c)) = spec.split_once(',') {
                    let h = handle.clone();
                    let (u, c) = (u.to_string(), c.to_string());
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                        let r = tauri::async_runtime::block_on(commands::connect(h.clone(), u, c));
                        commands::dlog(&format!("autoconnect: {r:?}"));
                        // LATTICE_AUTOMANAGER=1: after connect, drive the
                        // menu's ship-page -> manager-page navigation, the
                        // headless check for the app-protocol round trip
                        if std::env::var_os("LATTICE_AUTOMANAGER").is_some() {
                            std::thread::sleep(std::time::Duration::from_secs(8));
                            commands::show_manager(&h).ok();
                        }
                        // LATTICE_AUTOSTACK=1: report what is installed on the
                        // ship we just logged in to, the headless check for
                        // the %mcp / %grubbery / lattice probe.
                        if std::env::var_os("LATTICE_AUTOSTACK").is_some() {
                            let s = tauri::async_runtime::block_on(stack::stack_status(h.clone()));
                            let _ = s;
                        }
                        // LATTICE_AUTONAV=/path: follow the connect with a
                        // fresh top-level navigation, the headless harness's
                        // regression check for the 403-on-navigation class
                        if let Ok(nav) = std::env::var("LATTICE_AUTONAV") {
                            std::thread::sleep(std::time::Duration::from_secs(8));
                            if let Some(w) = h.get_webview_window("workspace") {
                                if let Ok(cur) = w.url() {
                                    let t = format!("{}://{}:{}{nav}",
                                        cur.scheme(), cur.host_str().unwrap_or(""), cur.port().unwrap_or(80));
                                    commands::dlog(&format!("autonav: {t}"));
                                    w.navigate(t.parse().unwrap()).ok();
                                }
                            }
                        }
                    });
                }
            }
            let cfg = config::load(&handle);
            if cfg.url.is_empty() {
                // first run: the single window opens on the connect page
                commands::show_manager(&handle)?;
            } else {
                // off-thread: bridge setup does network work that must not
                // block the main loop
                let h = handle.clone();
                std::thread::spawn(move || {
                    commands::open_workspace(&h, false).ok();
                });
            }
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
            commands::get_config,
            commands::go_home,
            commands::pick_upload,
            commands::open_external_url,
            commands::save_vault,
            commands::pick_vault,
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
        ])
        .build(tauri::generate_context!())
        .expect("error building lattice desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // drop every BackgroundSession -> clean unmounts before the
                // process dies (drops of managed state are not otherwise run).
                app.state::<mounts::MountMap>().0.lock().unwrap().clear();
            }
        });
}
