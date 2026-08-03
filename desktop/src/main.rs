#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod install;
mod local;
mod mounts;
mod proxy;
mod stack;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::Manager;

/// Restore saved mounts. Each one carries how it is reached (a lick socket, or
/// HTTP against the configured ship), so a local-pier mount survives a restart
/// with no session in play. A failure is reported and skipped. One dead pier
/// must not cost the other mounts.
fn remount(handle: &tauri::AppHandle, cfg: &config::Config) {
    let map = handle.state::<mounts::MountMap>();
    let mut m = map.0.lock().unwrap();
    for spec in &cfg.mounts {
        mounts::heal_mountpoint(&spec.mountpoint);
        match mounts::projection_for(handle, &spec.root, &spec.sock, &spec.ship)
            .and_then(|p| lattice_fs::spawn(p, &spec.mountpoint).map_err(|e| e.to_string()))
        {
            Ok(s) => {
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
        .plugin(tauri_plugin_opener::init())
        .manage(mounts::MountMap(Mutex::new(HashMap::new())))
        .manage(proxy::Bridge(Mutex::new(None)))
        .on_menu_event(|app, ev| {
            // single-window app: the manager is a page in the workspace
            if ev.id().as_ref() == "manager" {
                commands::show_manager(app).ok();
            }
        })
        .setup(|app| {
            // one menu, one item: mounts lived in an unreachable window once
            // the manager auto-hid after connect
            let sub = tauri::menu::SubmenuBuilder::new(app, "lattice")
                .text("manager", "connection && mounts…")
                .build()?;
            app.set_menu(tauri::menu::MenuBuilder::new(app).items(&[&sub]).build()?)?;
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
            remount(&handle, &cfg);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::connection_status,
            commands::get_config,
            commands::go_home,
            commands::pick_upload,
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
